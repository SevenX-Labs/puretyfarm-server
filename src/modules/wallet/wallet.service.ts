import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import {
  WalletCreditRequestStatus,
  WalletRefundStatus,
  WalletTransactionType,
  WalletTransactionReferenceType,
  WALLET_CREDIT_MIN_PAISE_DEFAULT,
  WALLET_CREDIT_MAX_PAISE_DEFAULT,
  WALLET_MAX_BALANCE_PAISE,
} from './wallet.constants';
import { CreateCreditRequestDto } from './dto/customer/create-credit-request.dto';
import { ListTransactionsQueryDto } from './dto/customer/list-transactions-query.dto';
import { ListCreditRequestsQueryDto } from './dto/customer/list-credit-requests-query.dto';
import { AdminListCreditRequestsQueryDto } from './dto/admin/list-credit-requests-query.dto';
import { RejectCreditRequestDto } from './dto/admin/reject-credit-request.dto';
import { AdminManualWalletAdjustmentDto } from './dto/admin/manual-wallet-adjustment.dto';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);
  private readonly minCreditPaise: number;
  private readonly maxCreditPaise: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.minCreditPaise = parseInt(
      this.config.get<string>('WALLET_CREDIT_MIN_PAISE') ||
        String(WALLET_CREDIT_MIN_PAISE_DEFAULT),
      10,
    );
    this.maxCreditPaise = parseInt(
      this.config.get<string>('WALLET_CREDIT_MAX_PAISE') ||
        String(WALLET_CREDIT_MAX_PAISE_DEFAULT),
      10,
    );
    // Auto-credit is per-wallet (`Wallet.autoCreditEnabled`); there is no
    // longer a global on/off switch. The previous `WALLET_AUTO_CREDIT_ENABLED`
    // env variable is intentionally not read here.
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
        error: 'INSUFFICIENT_WALLET_BALANCE',
        message: 'Insufficient wallet balance',
      });
    }

    const balanceAfterPaise = result[0].balance_paise;

    if (balanceAfterPaise > WALLET_MAX_BALANCE_PAISE) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Credit would exceed maximum wallet balance',
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

  private async getOrCreateWallet(
    userId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx || this.prisma;
    try {
      return await client.wallet.upsert({
        where: { userId },
        create: { userId },
        update: {},
      });
    } catch (err) {
      // Prisma's upsert is find-then-insert-or-update at the application layer,
      // so two concurrent calls for the same user can both race past the find
      // and collide on the unique `userId` insert. The loser re-fetches.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const wallet = await client.wallet.findUnique({ where: { userId } });
        if (wallet) return wallet;
      }
      throw err;
    }
  }

  async getWallet(userId: string) {
    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      const now = new Date();
      return {
        balancePaise: 0,
        currency: 'INR',
        createdAt: now,
        updatedAt: now,
      };
    }
    return {
      balancePaise: wallet.balancePaise,
      currency: 'INR',
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

    if (
      amountPaise < this.minCreditPaise ||
      amountPaise > this.maxCreditPaise
    ) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
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
        where: {
          walletId_idempotencyKey: { walletId: wallet.id, idempotencyKey },
        },
        include: { transaction: true },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'Idempotency key has already been used with different parameters',
          });
        }
        return this.formatCreditRequestResponse(existing, true);
      }

      const requiresApproval = await this.requiresApproval(wallet.id, tx);

      if (requiresApproval) {
        // Check for existing PENDING request (also enforced by partial unique index)
        const pendingExists = await tx.walletCreditRequest.findFirst({
          where: {
            walletId: wallet.id,
            status: WalletCreditRequestStatus.PENDING,
          },
        });
        if (pendingExists) {
          throw new ConflictException({
            error: 'WALLET_PENDING_REQUEST_EXISTS',
            message: 'A credit request is already pending approval',
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
        'Wallet credit (auto-approved)',
      );

      const updated = await tx.walletCreditRequest.findUnique({
        where: { id: request.id },
        include: { transaction: true },
      });

      return this.formatCreditRequestResponse(updated!, false);
    });
  }

  /**
   * Decides whether a credit request on this wallet needs admin approval.
   *
   * The source of truth is the WALLET ROW's own `autoCreditEnabled` flag:
   *   false -> admin approval required (this is the default, and the state of
   *            every brand-new customer; also the state after a first
   *            rejection, since the flag was never flipped)
   *   true  -> may be auto-credited
   *
   * The flag is only set true as part of the transaction that completes the
   * customer's first wallet credit (see `approveCreditRequestWithin`), so a
   * `true` here always means that specific customer has previously completed
   * at least one admin-reviewed or cash-confirmed credit.
   *
   * Customer A's setting cannot affect customer B — each wallet carries its
   * own flag.
   */
  private async requiresApproval(
    walletId: string,
    tx: Prisma.TransactionClient,
  ): Promise<boolean> {
    const wallet = await tx.wallet.findUnique({
      where: { id: walletId },
      select: { autoCreditEnabled: true },
    });
    return !wallet?.autoCreditEnabled;
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

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

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
        orderBy: { createdAt: 'desc' },
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

    const wallet = await this.prisma.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      return {
        data: [],
        pagination: { page, limit, total: 0, totalPages: 0 },
      };
    }

    const where: any = { walletId: wallet.id };
    if (query.status) where.status = query.status;

    const [requests, total] = await Promise.all([
      this.prisma.walletCreditRequest.findMany({
        where,
        orderBy: { createdAt: 'desc' },
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
    return this.prisma.$transaction(async (tx) =>
      this.approveCreditRequestWithin(tx, requestId, adminId),
    );
  }

  /**
   * Transaction-scoped approval: atomic PENDING -> COMPLETED followed by the
   * single balance-changing path. Extracted so a caller that already owns a
   * transaction (the Payment module confirming physical cash) credits the
   * wallet through exactly this code rather than reimplementing it.
   *
   * The conditional `updateMany` guarded on `status: PENDING` is what makes a
   * second concurrent approval a no-op: it matches zero rows and throws.
   */
  private async approveCreditRequestWithin(
    tx: Prisma.TransactionClient,
    requestId: string,
    adminId: string,
    description = 'Wallet credit (admin-approved)',
  ) {
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
          error: 'CREDIT_REQUEST_NOT_FOUND',
          message: 'Credit request not found',
        });
      }
      throw new ConflictException({
        error: 'CREDIT_REQUEST_ALREADY_PROCESSED',
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
      description,
    );

    // Enable this customer's auto-credit atomically with the credit itself.
    // Conditional on the current false so the write is a no-op (and idempotent)
    // for a wallet that is already enabled, which keeps the second+ credit
    // path cheap. This is the ONLY place that flips the flag true, so cash
    // confirmation benefits automatically — it routes through here.
    await tx.wallet.updateMany({
      where: { id: request!.walletId, autoCreditEnabled: false },
      data: { autoCreditEnabled: true },
    });

    return {
      success: true,
      message: 'Credit request approved and wallet credited.',
      request: {
        id: request!.id,
        status: WalletCreditRequestStatus.COMPLETED,
        amountPaise: request!.amountPaise,
      },
    };
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
            error: 'CREDIT_REQUEST_NOT_FOUND',
            message: 'Credit request not found',
          });
        }
        throw new ConflictException({
          error: 'CREDIT_REQUEST_ALREADY_PROCESSED',
          message: `Credit request has already been ${exists.status.toLowerCase()}`,
        });
      }

      return {
        success: true,
        message: 'Credit request rejected.',
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
    if (query.source) where.source = query.source;
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
            { mobile: { contains: query.customerSearch, mode: 'insensitive' } },
            { email: { contains: query.customerSearch, mode: 'insensitive' } },
            {
              customerProfile: {
                OR: [
                  {
                    firstName: {
                      contains: query.customerSearch,
                      mode: 'insensitive',
                    },
                  },
                  {
                    lastName: {
                      contains: query.customerSearch,
                      mode: 'insensitive',
                    },
                  },
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
        orderBy: { createdAt: 'desc' },
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
                  customerProfile: {
                    select: { firstName: true, lastName: true },
                  },
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
        source: r.source,
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
                customerProfile: {
                  select: { firstName: true, lastName: true },
                },
              },
            },
          },
        },
        transaction: true,
      },
    });

    if (!request) {
      throw new NotFoundException({
        error: 'CREDIT_REQUEST_NOT_FOUND',
        message: 'Credit request not found',
      });
    }

    return {
      id: request.id,
      amountPaise: request.amountPaise,
      status: request.status,
      refundStatus: request.refundStatus,
      autoApproved: request.autoApproved,
      source: request.source,
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
          orderBy: { createdAt: 'desc' },
          take: 10,
        },
      },
    });

    if (!wallet) {
      throw new NotFoundException('Customer wallet not found');
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
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Debit amount must be a positive integer',
      });
    }

    return this.prisma.$transaction((tx) =>
      this.debitWalletWithin(
        tx,
        userId,
        amountPaise,
        referenceType,
        referenceId,
        description,
      ),
    );
  }

  /**
   * Transaction-scoped debit variant.
   *
   * Same contract as `debitWallet` but takes an existing transaction client
   * instead of opening its own, so a caller that must atomically couple the
   * debit with other writes (e.g. the Order payment path flipping
   * `Order.paymentStatus = PAID` in the same tx) can do so without a nested
   * transaction. Public callers that only need the debit continue to use
   * `debitWallet` and get its own transaction for free.
   *
   * Same safety as before:
   *  - amount must be a positive integer paise value
   *  - `applyBalanceChange` enforces the CHECK (balancePaise >= 0)
   *  - the unique `(type, referenceType, referenceId)` ledger index rejects a
   *    duplicate debit for the same reference at the DB level, so a repeated
   *    call for the same orderId cannot double-debit
   */
  async debitWalletWithin(
    tx: Prisma.TransactionClient,
    userId: string,
    amountPaise: number,
    referenceType: WalletTransactionReferenceType,
    referenceId: string,
    description?: string,
  ) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Debit amount must be a positive integer',
      });
    }

    const wallet = await tx.wallet.findUnique({ where: { userId } });
    if (!wallet) {
      throw new BadRequestException({
        error: 'INSUFFICIENT_WALLET_BALANCE',
        message: 'Wallet not found',
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
      walletId: wallet.id,
      balanceAfterPaise: result.balanceAfterPaise,
      transactionId: result.transactionId,
    };
  }

  /**
   * Credits the wallet within an existing transaction client.
   *
   * Mirrors debitWalletWithin: validates amount, resolves the wallet (lazy-creating
   * if not yet present), and invokes applyBalanceChange with type CREDIT.
   * Also ensures autoCreditEnabled is flipped to true for this customer upon verified credit.
   */
  async creditWalletWithin(
    tx: Prisma.TransactionClient,
    userId: string,
    amountPaise: number,
    referenceType: WalletTransactionReferenceType,
    referenceId: string,
    description?: string,
  ) {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Credit amount must be a positive integer',
      });
    }

    const wallet = await this.getOrCreateWallet(userId, tx);

    const result = await this.applyBalanceChange(
      tx,
      wallet.id,
      WalletTransactionType.CREDIT,
      amountPaise,
      referenceType,
      referenceId,
      undefined,
      description,
    );

    await tx.wallet.updateMany({
      where: { id: wallet.id, autoCreditEnabled: false },
      data: { autoCreditEnabled: true },
    });

    return {
      success: true,
      walletId: wallet.id,
      balanceAfterPaise: result.balanceAfterPaise,
      transactionId: result.transactionId,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  PAYMENT-BACKED CREDIT REQUESTS (consumed by the Payment module)
  //
  //  These exist because `createCreditRequest` above credits immediately when
  //  the customer is not a first-timer. That is correct for a direct wallet
  //  request, but it would credit money that PayU has not yet collected. The
  //  methods below split creation from settlement so a credit request can sit
  //  PENDING until the Payment module has VERIFIED the money arrived.
  //
  //  Every one of them takes the caller's transaction client: the Payment
  //  module updates the payment row and settles the wallet in one atomic unit.
  //  The wallet remains the only component that touches a balance or writes a
  //  ledger row — all of these funnel into `applyBalanceChange`.
  // ══════════════════════════════════════════════════════════════════

  /**
   * Validates a top-up amount against the wallet's configured bounds. Exposed
   * so the Payment module enforces the same limits without duplicating them.
   */
  validateCreditAmount(amountPaise: number): void {
    if (!Number.isInteger(amountPaise)) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Amount must be an integer number of paise',
      });
    }
    if (
      amountPaise < this.minCreditPaise ||
      amountPaise > this.maxCreditPaise
    ) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: `Amount must be between ${this.minCreditPaise} and ${this.maxCreditPaise} paise`,
      });
    }
  }

  /**
   * Creates a credit request that is funded by an external payment.
   *
   * ALWAYS lands in PENDING and NEVER credits the wallet, regardless of
   * WALLET_AUTO_CREDIT_ENABLED or whether the customer has credited before.
   * Settlement happens only via {@link settleAfterVerifiedPayment} (online,
   * after hash-verified success) or {@link creditConfirmedCashRequest} (cash,
   * after an admin confirms the physical money).
   *
   * Idempotency and the one-PENDING-per-wallet rule reuse the existing
   * constraints: `(walletId, idempotencyKey)` unique plus the partial unique
   * index on PENDING rows.
   */
  async createPaymentBackedCreditRequest(
    tx: Prisma.TransactionClient,
    params: {
      userId: string;
      amountPaise: number;
      source: 'ONLINE' | 'CASH';
      idempotencyKey: string;
    },
  ) {
    this.validateCreditAmount(params.amountPaise);

    const wallet = await this.getOrCreateWallet(params.userId, tx);

    // Serialise concurrent top-up attempts for this wallet so the pending
    // check below cannot be read-then-raced by a second request.
    await tx.$queryRaw`SELECT 1 FROM "wallets" WHERE "id" = ${wallet.id} FOR UPDATE`;

    const requestHash = this.computeRequestHash(params.amountPaise);

    const existing = await tx.walletCreditRequest.findUnique({
      where: {
        walletId_idempotencyKey: {
          walletId: wallet.id,
          idempotencyKey: params.idempotencyKey,
        },
      },
    });

    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new ConflictException({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'Idempotency key has already been used with different parameters',
        });
      }
      return { request: existing, walletId: wallet.id, replayed: true };
    }

    const pendingExists = await tx.walletCreditRequest.findFirst({
      where: { walletId: wallet.id, status: WalletCreditRequestStatus.PENDING },
      select: { id: true },
    });
    if (pendingExists) {
      throw new ConflictException({
        error: 'WALLET_PENDING_REQUEST_EXISTS',
        message: 'A credit request is already pending for this wallet',
      });
    }

    const request = await tx.walletCreditRequest.create({
      data: {
        walletId: wallet.id,
        amountPaise: params.amountPaise,
        status: WalletCreditRequestStatus.PENDING,
        autoApproved: false,
        source: params.source,
        idempotencyKey: params.idempotencyKey,
        requestHash,
      },
    });

    return { request, walletId: wallet.id, replayed: false };
  }

  /**
   * Settles a credit request whose ONLINE payment has been verified.
   *
   * Applies the existing, unchanged first-credit rule via `requiresApproval`:
   * the first ever credit — and every credit while WALLET_AUTO_CREDIT_ENABLED
   * is off — stays PENDING for an admin. Only a genuinely subsequent credit
   * with auto-credit enabled is credited here, through the same atomic
   * conditional update and the same ledger path as an admin approval.
   *
   * Safe to call twice: the second call finds no PENDING row and reports
   * `credited: false` rather than crediting again.
   */
  async settleAfterVerifiedPayment(
    tx: Prisma.TransactionClient,
    creditRequestId: string,
  ): Promise<{
    credited: boolean;
    requiresAdminApproval: boolean;
    status: WalletCreditRequestStatus;
    balanceAfterPaise: number | null;
    transactionId: string | null;
  }> {
    const request = await tx.walletCreditRequest.findUnique({
      where: { id: creditRequestId },
    });

    if (!request) {
      throw new NotFoundException({
        error: 'CREDIT_REQUEST_NOT_FOUND',
        message: 'Credit request not found',
      });
    }

    // Already settled or closed by a previous (possibly concurrent) call.
    if (request.status !== WalletCreditRequestStatus.PENDING) {
      return {
        credited: false,
        requiresAdminApproval: false,
        status: request.status as WalletCreditRequestStatus,
        balanceAfterPaise: null,
        transactionId: null,
      };
    }

    const requiresApproval = await this.requiresApproval(request.walletId, tx);

    if (requiresApproval) {
      // First credit, or auto-credit disabled: the money is collected but the
      // wallet stays untouched until an admin approves. This is the point at
      // which "Payment Successful" and "Wallet Credited" are different events.
      return {
        credited: false,
        requiresAdminApproval: true,
        status: WalletCreditRequestStatus.PENDING,
        balanceAfterPaise: null,
        transactionId: null,
      };
    }

    const now = new Date();
    const updated = await tx.walletCreditRequest.updateMany({
      where: {
        id: creditRequestId,
        status: WalletCreditRequestStatus.PENDING,
      },
      data: {
        status: WalletCreditRequestStatus.COMPLETED,
        autoApproved: true,
        completedAt: now,
      },
    });

    // Lost the race to a concurrent callback/webhook. The winner credited.
    if (updated.count === 0) {
      return {
        credited: false,
        requiresAdminApproval: false,
        status: WalletCreditRequestStatus.COMPLETED,
        balanceAfterPaise: null,
        transactionId: null,
      };
    }

    const result = await this.applyBalanceChange(
      tx,
      request.walletId,
      WalletTransactionType.CREDIT,
      request.amountPaise,
      WalletTransactionReferenceType.CREDIT_REQUEST,
      request.id,
      request.id,
      'Wallet credit (auto-credited after verified payment)',
    );

    // Defensive: the wallet is already enabled for this branch to run, but we
    // keep the invariant that any completed credit guarantees the flag is set.
    await tx.wallet.updateMany({
      where: { id: request.walletId, autoCreditEnabled: false },
      data: { autoCreditEnabled: true },
    });

    return {
      credited: true,
      requiresAdminApproval: false,
      status: WalletCreditRequestStatus.COMPLETED,
      balanceAfterPaise: result.balanceAfterPaise,
      transactionId: result.transactionId,
    };
  }

  /**
   * Credits a credit request whose PHYSICAL CASH an admin has just confirmed.
   *
   * Cash is never auto-credited: the admin confirmation IS the approval, so
   * this routes straight through the shared approval path. The first-credit
   * rule is satisfied by the same human gate.
   */
  async creditConfirmedCashRequest(
    tx: Prisma.TransactionClient,
    creditRequestId: string,
    adminId: string,
  ) {
    return this.approveCreditRequestWithin(
      tx,
      creditRequestId,
      adminId,
      'Wallet credit (cash collection confirmed)',
    );
  }

  /**
   * Closes a credit request whose funding never arrived: a failed, cancelled
   * or expired PayU payment, or a cancelled cash collection.
   *
   * CANCELLED — not REJECTED — because REJECTED means an admin refused money
   * that WAS received and therefore implies a refund obligation. CANCELLED
   * carries no refund semantics and releases the one-PENDING-per-wallet slot
   * so the customer can try again.
   *
   * Idempotent: a second call matches no PENDING row and returns false.
   */
  async cancelCreditRequest(
    tx: Prisma.TransactionClient,
    creditRequestId: string,
    reason: string,
  ): Promise<boolean> {
    const updated = await tx.walletCreditRequest.updateMany({
      where: {
        id: creditRequestId,
        status: WalletCreditRequestStatus.PENDING,
      },
      data: {
        status: WalletCreditRequestStatus.CANCELLED,
        adminNote: reason,
        reviewedAt: new Date(),
      },
    });
    return updated.count > 0;
  }

  /**
   * Marks the wallet-side refund outcome for a rejected credit request. Called
   * by the Payment module once PayU has CONFIRMED the refund — never
   * optimistically when the refund is merely requested.
   */
  async markRefundOutcome(
    tx: Prisma.TransactionClient,
    creditRequestId: string,
    refundStatus: WalletRefundStatus,
  ): Promise<void> {
    await tx.walletCreditRequest.updateMany({
      where: { id: creditRequestId },
      data: { refundStatus },
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
      base.message = 'Credit request submitted for admin approval.';
    } else if (request.status === WalletCreditRequestStatus.COMPLETED) {
      base.message = 'Wallet credited successfully.';
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

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — MANUAL WALLET ADJUSTMENTS (CREDIT / DEBIT)
  // ══════════════════════════════════════════════════════════════════

  async adminManualCredit(
    userId: string,
    adminId: string,
    dto: AdminManualWalletAdjustmentDto,
    idempotencyKey?: string,
  ) {
    const amountPaise = dto.amountPaise ?? dto.amount;
    if (!amountPaise || !Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException({
        error: 'INVALID_CREDIT_AMOUNT',
        message: 'Credit amount must be a positive integer in paise',
      });
    }

    const remark = dto.remark?.trim();
    if (!remark || remark.length < 3) {
      throw new BadRequestException({
        error: 'INVALID_REMARK',
        message: 'Remark must be at least 3 characters',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mobile: true, email: true },
    });
    if (!user) {
      throw new NotFoundException({
        error: 'CUSTOMER_NOT_FOUND',
        message: 'Customer user not found',
      });
    }

    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { id: true, email: true },
    });
    const adminTag = admin?.email || adminId;
    const description = `[Admin: ${adminTag}] ${remark}`;
    const referenceId = idempotencyKey?.trim() || crypto.randomUUID();

    return this.prisma.$transaction(async (tx) => {
      // Idempotency check
      const existing = await tx.walletTransaction.findUnique({
        where: {
          type_referenceType_referenceId: {
            type: WalletTransactionType.CREDIT,
            referenceType: WalletTransactionReferenceType.ADMIN_ADJUSTMENT,
            referenceId,
          },
        },
      });

      if (existing) {
        return {
          success: true,
          replayed: true,
          message: 'Manual credit replayed successfully',
          walletId: existing.walletId,
          balancePaise: existing.balanceAfterPaise,
          transaction: {
            id: existing.id,
            type: existing.type,
            amountPaise: existing.amountPaise,
            balanceAfterPaise: existing.balanceAfterPaise,
            createdAt: existing.createdAt,
            description: existing.description,
          },
        };
      }

      const result = await this.creditWalletWithin(
        tx,
        userId,
        amountPaise,
        WalletTransactionReferenceType.ADMIN_ADJUSTMENT,
        referenceId,
        description,
      );

      return {
        success: true,
        message: 'Wallet credited successfully',
        walletId: result.walletId,
        balancePaise: result.balanceAfterPaise,
        transactionId: result.transactionId,
      };
    });
  }

  async adminManualDebit(
    userId: string,
    adminId: string,
    dto: AdminManualWalletAdjustmentDto,
    idempotencyKey?: string,
  ) {
    const amountPaise = dto.amountPaise ?? dto.amount;
    if (!amountPaise || !Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new BadRequestException({
        error: 'INVALID_DEBIT_AMOUNT',
        message: 'Debit amount must be a positive integer in paise',
      });
    }

    const remark = dto.remark?.trim();
    if (!remark || remark.length < 3) {
      throw new BadRequestException({
        error: 'INVALID_REMARK',
        message: 'Remark must be at least 3 characters',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mobile: true, email: true },
    });
    if (!user) {
      throw new NotFoundException({
        error: 'CUSTOMER_NOT_FOUND',
        message: 'Customer user not found',
      });
    }

    const admin = await this.prisma.admin.findUnique({
      where: { id: adminId },
      select: { id: true, email: true },
    });
    const adminTag = admin?.email || adminId;
    const description = `[Admin: ${adminTag}] ${remark}`;
    const referenceId = idempotencyKey?.trim() || crypto.randomUUID();

    return this.prisma.$transaction(async (tx) => {
      // Idempotency check
      const existing = await tx.walletTransaction.findUnique({
        where: {
          type_referenceType_referenceId: {
            type: WalletTransactionType.DEBIT,
            referenceType: WalletTransactionReferenceType.ADMIN_ADJUSTMENT,
            referenceId,
          },
        },
      });

      if (existing) {
        return {
          success: true,
          replayed: true,
          message: 'Manual debit replayed successfully',
          walletId: existing.walletId,
          balancePaise: existing.balanceAfterPaise,
          transaction: {
            id: existing.id,
            type: existing.type,
            amountPaise: existing.amountPaise,
            balanceAfterPaise: existing.balanceAfterPaise,
            createdAt: existing.createdAt,
            description: existing.description,
          },
        };
      }

      const result = await this.debitWalletWithin(
        tx,
        userId,
        amountPaise,
        WalletTransactionReferenceType.ADMIN_ADJUSTMENT,
        referenceId,
        description,
      );

      return {
        success: true,
        message: 'Wallet debited successfully',
        walletId: result.walletId,
        balancePaise: result.balanceAfterPaise,
        transactionId: result.transactionId,
      };
    });
  }
}
