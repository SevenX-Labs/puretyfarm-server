import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import {
  WalletCreditRequestStatus,
  WalletRefundStatus,
  WalletTransactionType,
  WalletTransactionReferenceType,
  WALLET_CREDIT_MIN_PAISE_DEFAULT,
  WALLET_CREDIT_MAX_PAISE_DEFAULT,
  WALLET_MAX_BALANCE_PAISE,
} from "./wallet.constants";
import { CreateCreditRequestDto } from "./dto/customer/create-credit-request.dto";
import { ListTransactionsQueryDto } from "./dto/customer/list-transactions-query.dto";
import { ListCreditRequestsQueryDto } from "./dto/customer/list-credit-requests-query.dto";
import { AdminListCreditRequestsQueryDto } from "./dto/admin/list-credit-requests-query.dto";
import { RejectCreditRequestDto } from "./dto/admin/reject-credit-request.dto";

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly minCreditPaise: number;
  private readonly maxCreditPaise: number;
  private readonly autoApproveEnabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.minCreditPaise = parseInt(
      this.config.get<string>("WALLET_CREDIT_MIN_PAISE") || String(WALLET_CREDIT_MIN_PAISE_DEFAULT),
      10,
    );
    this.maxCreditPaise = parseInt(
      this.config.get<string>("WALLET_CREDIT_MAX_PAISE") || String(WALLET_CREDIT_MAX_PAISE_DEFAULT),
      10,
    );
    this.autoApproveEnabled =
      this.config.get<string>("WALLET_AUTO_CREDIT_ENABLED")?.toLowerCase() === "true";
  }

  // ══════════════════════════════════════════════════════════════════
  //  CORE INVARIANT: SINGLE BALANCE-CHANGING PATH
  // ══════════════════════════════════════════════════════════════════

  private async applyBalanceChange(
    tx: Prisma.TransactionClient,
    walletId: string,
    type: WalletTransactionType,
    amountPaise: number,
    referenceType: WalletTransactionReferenceType,
    referenceId: string,
    creditRequestId?: string,
    description?: string,
  ): Promise<{ balanceAfterPaise: number; transactionId: string }> {
    const sign = type === WalletTransactionType.CREDIT ? 1 : -1;

    const result: { balance_paise: number }[] = await tx.$queryRaw`
      UPDATE "wallets"
      SET "balancePaise" = "balancePaise" + ${sign * amountPaise},
          "updatedAt" = NOW()
      WHERE "id" = ${walletId}
        AND "balancePaise" + ${sign * amountPaise} >= 0
      RETURNING "balancePaise" AS balance_paise
    `;

    if (result.length === 0) {
      throw new BadRequestException({
        error: "INSUFFICIENT_WALLET_BALANCE",
        message: "Insufficient wallet balance",
      });
    }

    const balanceAfterPaise = result[0].balance_paise;

    if (balanceAfterPaise > WALLET_MAX_BALANCE_PAISE) {
      throw new BadRequestException({
        error: "INVALID_CREDIT_AMOUNT",
        message: "Credit would exceed maximum wallet balance",
      });
    }

    const txn = await tx.walletTransaction.create({
      data: {
        walletId,
        type,
        amountPaise,
        balanceAfterPaise,
        referenceType,
        referenceId,
        creditRequestId: creditRequestId || null,
        description: description || null,
      },
    });

    return { balanceAfterPaise, transactionId: txn.id };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — GET WALLET (lazy create)
  // ══════════════════════════════════════════════════════════════════

  private async getOrCreateWallet(userId: string, tx?: Prisma.TransactionClient) {
    const client = tx || this.prisma;
    return client.wallet.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async getWallet(userId: string) {
    const wallet = await this.getOrCreateWallet(userId);
    return {
      balancePaise: wallet.balancePaise,
      currency: "INR",
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CREATE CREDIT REQUEST
  // ══════════════════════════════════════════════════════════════════

  async createCreditRequest(
    userId: string,
    dto: CreateCreditRequestDto,
    idempotencyKey: string,
  ) {
    const amountPaise = dto.amount;

    if (amountPaise < this.minCreditPaise || amountPaise > this.maxCreditPaise) {
      throw new BadRequestException({
        error: "INVALID_CREDIT_AMOUNT",
        message: `Amount must be between ${this.minCreditPaise} and ${this.maxCreditPaise} paise`,
      });
    }

    const requestHash = this.computeRequestHash(amountPaise);

    return this.prisma.$transaction(async (tx) => {
      const wallet = await this.getOrCreateWallet(userId, tx);

      // Lock the wallet row
      await tx.$queryRaw`SELECT 1 FROM "wallets" WHERE "id" = ${wallet.id} FOR UPDATE`;

      // Idempotency check
      const existing = await tx.walletCreditRequest.findUnique({
        where: { walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey } },
        include: { transaction: true },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            error: "IDEMPOTENCY_KEY_REUSED",
            message: "Idempotency key has already been used with different parameters",
          });
        }
        return this.formatCreditRequestResponse(existing, true);
      }

      const requiresApproval = await this.requiresApproval(wallet.id, tx);

      if (requiresApproval) {
        // Check for existing PENDING request (also enforced by partial unique index)
        const pendingExists = await tx.walletCreditRequest.findFirst({
          where: { walletId: wallet.id, status: WalletCreditRequestStatus.PENDING },
        });
        if (pendingExists) {
          throw new ConflictException({
            error: "WALLET_PENDING_REQUEST_EXISTS",
            message: "A credit request is already pending approval",
          });
        }

        const request = await tx.walletCreditRequest.create({
          data: {
            walletId: wallet.id,
            amountPaise,
            status: WalletCreditRequestStatus.PENDING,
            autoApproved: false,
            idempotencyKey,
            requestHash,
          },
        });

        return this.formatCreditRequestResponse(request, false);
      }

      // Auto-approve: credit immediately
      const request = await tx.walletCreditRequest.create({
        data: {
          walletId: wallet.id,
          amountPaise,
          status: WalletCreditRequestStatus.COMPLETED,
          autoApproved: true,
          idempotencyKey,
          requestHash,
          completedAt: new Date(),
        },
      });

      await this.applyBalanceChange(
        tx,
        wallet.id,
        WalletTransactionType.CREDIT,
        amountPaise,
        WalletTransactionReferenceType.CREDIT_REQUEST,
        request.id,
        request.id,
        "Wallet credit (auto-approved)",
      );

      const updated = await tx.walletCreditRequest.findUnique({
        where: { id: request.id },
        include: { transaction: true },
      });

      return this.formatCreditRequestResponse(updated!, false);
    });
  }

  private async requiresApproval(
    walletId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    if (!this.autoApproveEnabled) return true;

    const hasCompletedCredit = await tx.walletTransaction.findFirst({
      where: {
        walletId,
        type: WalletTransactionType.CREDIT,
        referenceType: WalletTransactionReferenceType.CREDIT_REQUEST,
      },
      select: { id: true },
    });

    return !hasCompletedCredit;
  }

  private computeRequestHash(amountPaise: number): string {
    return `amount:${amountPaise}`;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — LIST TRANSACTIONS
  // ══════════════════════════════════════════════════════════════════

  async getTransactions(userId: string, query: ListTransactionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const wallet = await this.getOrCreateWallet(userId);

    const where: any = { walletId: wallet.id };
    if (query.type) where.type = query.type;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setUTCDate(end.getUTCDate() + 1);
        where.createdAt.lt = end;
      }
    }

    const [transactions, total] = await Promise.all([
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletTransaction.count({ where }),
    ]);

    return {
      data: transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amountPaise: t.amountPaise,
        balanceAfterPaise: t.balanceAfterPaise,
        referenceType: t.referenceType,
        referenceId: t.referenceId,
        description: t.description,
        createdAt: t.createdAt,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — LIST CREDIT REQUESTS
  // ══════════════════════════════════════════════════════════════════

  async getCreditRequests(userId: string, query: ListCreditRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const wallet = await this.getOrCreateWallet(userId);

    const where: any = { walletId: wallet.id };
    if (query.status) where.status = query.status;

    const [requests, total] = await Promise.all([
      this.prisma.walletCreditRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.walletCreditRequest.count({ where }),
    ]);

    return {
      data: requests.map((r) => this.formatCustomerCreditRequest(r)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — APPROVE CREDIT REQUEST
  // ══════════════════════════════════════════════════════════════════

  async approveCreditRequest(requestId: string, adminId: string) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      // Atomic conditional update: PENDING -> COMPLETED
      const updated = await tx.walletCreditRequest.updateMany({
        where: { id: requestId, status: WalletCreditRequestStatus.PENDING },
        data: {
          status: WalletCreditRequestStatus.COMPLETED,
          reviewedByAdminId: adminId,
          reviewedAt: now,
          completedAt: now,
        },
      });

      if (updated.count === 0) {
        const exists = await tx.walletCreditRequest.findUnique({
          where: { id: requestId },
        });
        if (!exists) {
          throw new NotFoundException({
            error: "CREDIT_REQUEST_NOT_FOUND",
            message: "Credit request not found",
          });
        }
        throw new ConflictException({
          error: "CREDIT_REQUEST_ALREADY_PROCESSED",
          message: `Credit request has already been ${exists.status.toLowerCase()}`,
        });
      }

      const request = await tx.walletCreditRequest.findUnique({
        where: { id: requestId },
      });

      await this.applyBalanceChange(
        tx,
        request!.walletId,
        WalletTransactionType.CREDIT,
        request!.amountPaise,
        WalletTransactionReferenceType.CREDIT_REQUEST,
        request!.id,
        request!.id,
        "Wallet credit (admin-approved)",
      );

      return {
        success: true,
        message: "Credit request approved and wallet credited.",
        request: {
          id: request!.id,
          status: WalletCreditRequestStatus.COMPLETED,
          amountPaise: request!.amountPaise,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — REJECT CREDIT REQUEST
  // ══════════════════════════════════════════════════════════════════

  async rejectCreditRequest(
    requestId: string,
    adminId: string,
    dto: RejectCreditRequestDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const updated = await tx.walletCreditRequest.updateMany({
        where: { id: requestId, status: WalletCreditRequestStatus.PENDING },
        data: {
          status: WalletCreditRequestStatus.REJECTED,
          refundStatus: WalletRefundStatus.REFUND_PENDING,
          reviewedByAdminId: adminId,
          adminNote: dto.note,
          reviewedAt: now,
        },
      });

      if (updated.count === 0) {
        const exists = await tx.walletCreditRequest.findUnique({
          where: { id: requestId },
        });
        if (!exists) {
          throw new NotFoundException({
            error: "CREDIT_REQUEST_NOT_FOUND",
            message: "Credit request not found",
          });
        }
        throw new ConflictException({
          error: "CREDIT_REQUEST_ALREADY_PROCESSED",
          message: `Credit request has already been ${exists.status.toLowerCase()}`,
        });
      }

      return {
        success: true,
        message: "Credit request rejected.",
        request: {
          id: requestId,
          status: WalletCreditRequestStatus.REJECTED,
          refundStatus: WalletRefundStatus.REFUND_PENDING,
          adminNote: dto.note,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — LIST CREDIT REQUESTS
  // ══════════════════════════════════════════════════════════════════

  async getAdminCreditRequests(query: AdminListCreditRequestsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: any = {};
    if (query.status) where.status = query.status;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) where.createdAt.gte = new Date(query.startDate);
      if (query.endDate) {
        const end = new Date(query.endDate);
        end.setUTCDate(end.getUTCDate() + 1);
        where.createdAt.lt = end;
      }
    }
    if (query.customerSearch) {
      where.wallet = {
        user: {
          OR: [
            { mobile: { contains: query.customerSearch, mode: "insensitive" } },
            { email: { contains: query.customerSearch, mode: "insensitive" } },
            {
              customerProfile: {
                OR: [
                  { firstName: { contains: query.customerSearch, mode: "insensitive" } },
                  { lastName: { contains: query.customerSearch, mode: "insensitive" } },
                ],
              },
            },
          ],
        },
      };
    }

    const [requests, total] = await Promise.all([
      this.prisma.walletCreditRequest.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          wallet: {
            include: {
              user: {
                select: {
                  id: true,
                  mobile: true,
                  email: true,
                  customerProfile: { select: { firstName: true, lastName: true } },
                },
              },
            },
          },
          transaction: true,
        },
      }),
      this.prisma.walletCreditRequest.count({ where }),
    ]);

    return {
      data: requests.map((r) => ({
        id: r.id,
        amountPaise: r.amountPaise,
        status: r.status,
        refundStatus: r.refundStatus,
        autoApproved: r.autoApproved,
        adminNote: r.adminNote,
        reviewedAt: r.reviewedAt,
        completedAt: r.completedAt,
        createdAt: r.createdAt,
        customer: {
          id: r.wallet.user.id,
          mobile: r.wallet.user.mobile,
          email: r.wallet.user.email,
          name: r.wallet.user.customerProfile
            ? `${r.wallet.user.customerProfile.firstName} ${r.wallet.user.customerProfile.lastName}`
            : null,
        },
        transaction: r.transaction
          ? {
              id: r.transaction.id,
              amountPaise: r.transaction.amountPaise,
              balanceAfterPaise: r.transaction.balanceAfterPaise,
              createdAt: r.transaction.createdAt,
            }
          : null,
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — GET SINGLE CREDIT REQUEST
  // ══════════════════════════════════════════════════════════════════

  async getAdminCreditRequest(requestId: string) {
    const request = await this.prisma.walletCreditRequest.findUnique({
      where: { id: requestId },
      include: {
        wallet: {
          include: {
            user: {
              select: {
                id: true,
                mobile: true,
                email: true,
                customerProfile: { select: { firstName: true, lastName: true } },
              },
            },
          },
        },
        transaction: true,
      },
    });

    if (!request) {
      throw new NotFoundException({
        error: "CREDIT_REQUEST_NOT_FOUND",
        message: "Credit request not found",
      });
    }

    return {
      id: request.id,
      amountPaise: request.amountPaise,
      status: request.status,
      refundStatus: request.refundStatus,
      autoApproved: request.autoApproved,
      adminNote: request.adminNote,
      reviewedByAdminId: request.reviewedByAdminId,
      reviewedAt: request.reviewedAt,
      completedAt: request.completedAt,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
      customer: {
        id: request.wallet.user.id,
        mobile: request.wallet.user.mobile,
        email: request.wallet.user.email,
        name: request.wallet.user.customerProfile
          ? `${request.wallet.user.customerProfile.firstName} ${request.wallet.user.customerProfile.lastName}`
          : null,
      },
      walletBalancePaise: request.wallet.balancePaise,
      transaction: request.transaction
        ? {
            id: request.transaction.id,
            type: request.transaction.type,
            amountPaise: request.transaction.amountPaise,
            balanceAfterPaise: request.transaction.balanceAfterPaise,
            createdAt: request.transaction.createdAt,
          }
        : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — GET CUSTOMER WALLET
  // ══════════════════════════════════════════════════════════════════

  async getAdminCustomerWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            mobile: true,
            email: true,
            customerProfile: { select: { firstName: true, lastName: true } },
          },
        },
        transactions: {
          orderBy: { createdAt: "desc" },
          take: 10,
        },
      },
    });

    if (!wallet) {
      throw new NotFoundException("Customer wallet not found");
    }

    const [totalCredits, totalDebits] = await Promise.all([
      this.prisma.walletTransaction.aggregate({
        where: { walletId: wallet.id, type: WalletTransactionType.CREDIT },
        _sum: { amountPaise: true },
        _count: true,
      }),
      this.prisma.walletTransaction.aggregate({
        where: { walletId: wallet.id, type: WalletTransactionType.DEBIT },
        _sum: { amountPaise: true },
        _count: true,
      }),
    ]);

    return {
      customer: {
        id: wallet.user.id,
        mobile: wallet.user.mobile,
        email: wallet.user.email,
        name: wallet.user.customerProfile
          ? `${wallet.user.customerProfile.firstName} ${wallet.user.customerProfile.lastName}`
          : null,
      },
      balancePaise: wallet.balancePaise,
      summary: {
        totalCreditsPaise: totalCredits._sum.amountPaise ?? 0,
        totalCreditsCount: totalCredits._count,
        totalDebitsPaise: totalDebits._sum.amountPaise ?? 0,
        totalDebitsCount: totalDebits._count,
      },
      recentTransactions: wallet.transactions.map((t) => ({
        id: t.id,
        type: t.type,
        amountPaise: t.amountPaise,
        balanceAfterPaise: t.balanceAfterPaise,
        referenceType: t.referenceType,
        referenceId: t.referenceId,
        description: t.description,
        createdAt: t.createdAt,
      })),
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  EXPORTED — DEBIT WALLET (for future Orders module)
  // ══════════════════════════════════════════════════════════════════

  async debitWallet(
    userId: string,
    amountPaise: number,
    referenceType: WalletTransactionReferenceType,
    referenceId: string,
    description?: string,
  ) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException({
        error: "INVALID_CREDIT_AMOUNT",
        message: "Debit amount must be a positive integer",
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const wallet = await tx.wallet.findUnique({ where: { userId } });
      if (!wallet) {
        throw new BadRequestException({
          error: "INSUFFICIENT_WALLET_BALANCE",
          message: "Wallet not found",
        });
      }

      const result = await this.applyBalanceChange(
        tx,
        wallet.id,
        WalletTransactionType.DEBIT,
        amountPaise,
        referenceType,
        referenceId,
        undefined,
        description,
      );

      return {
        success: true,
        balanceAfterPaise: result.balanceAfterPaise,
        transactionId: result.transactionId,
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  FORMATTING HELPERS
  // ══════════════════════════════════════════════════════════════════

  private formatCreditRequestResponse(request: any, isReplay: boolean) {
    const base: any = {
      id: request.id,
      amountPaise: request.amountPaise,
      status: request.status,
      autoApproved: request.autoApproved,
      createdAt: request.createdAt,
    };

    if (isReplay) {
      base.replayed = true;
    }

    if (request.status === WalletCreditRequestStatus.PENDING) {
      base.message = "Credit request submitted for admin approval.";
    } else if (request.status === WalletCreditRequestStatus.COMPLETED) {
      base.message = "Wallet credited successfully.";
    }

    return base;
  }

  private formatCustomerCreditRequest(r: any) {
    const result: any = {
      id: r.id,
      amountPaise: r.amountPaise,
      status: r.status,
      autoApproved: r.autoApproved,
      createdAt: r.createdAt,
    };

    if (r.status === WalletCreditRequestStatus.REJECTED) {
      result.adminNote = r.adminNote;
      result.refundStatus = r.refundStatus;
      result.reviewedAt = r.reviewedAt;
    }

    if (r.status === WalletCreditRequestStatus.COMPLETED) {
      result.completedAt = r.completedAt;
    }

    return result;
  }
}
