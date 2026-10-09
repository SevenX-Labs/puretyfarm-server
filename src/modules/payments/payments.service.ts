import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { WalletService } from '../wallet/wallet.service';
import { PlansService } from '../plans/plans.service';
import { PaymentStatus as OrderPaymentStatus } from '../orders/orders.constants';
import {
  WalletCreditRequestStatus,
  WalletRefundStatus,
  WalletTransactionReferenceType,
} from '../wallet/wallet.constants';
import { PAYMENT_PROVIDER } from './providers/payment-provider.interface';
// `import type` is required for a type used in a decorated constructor
// signature while emitDecoratorMetadata + isolatedModules are enabled.
import type {
  IPaymentProvider,
  ProviderVerificationResult,
} from './providers/payment-provider.interface';
import {
  CashCollectionStatus,
  PAYMENT_CURRENCY,
  PAYMENT_EXPIRY_MINUTES_DEFAULT,
  PAYMENT_FAILURE_FROM_STATUSES,
  PAYMENT_RETRYABLE_STATUSES,
  PAYMENT_SUCCESS_FROM_STATUSES,
  PAYMENT_TXNID_PREFIX,
  PAYMENT_WALLET_TOPUP_PRODUCT_INFO,
  PaymentMethod,
  PaymentProviderType,
  PaymentPurpose,
  PaymentTransactionStatus,
} from './payments.constants';
import { CreatePaymentDto } from './dto/customer/create-payment.dto';
import { VerifyPaymentDto } from './dto/customer/verify-payment.dto';
import { RetryPaymentDto } from './dto/customer/retry-payment.dto';
import { CustomerListPaymentsQueryDto } from './dto/customer/list-payments-query.dto';
import { AdminListPaymentsQueryDto } from './dto/admin/list-payments-query.dto';
import { AdminListCashCollectionsQueryDto } from './dto/admin/list-cash-collections-query.dto';
import { ConfirmCashCollectionDto } from './dto/admin/confirm-cash-collection.dto';
import { RejectCashCollectionDto } from './dto/admin/reject-cash-collection.dto';

/** Where a verified provider message arrived from. Logged, never trusted. */
export type VerifiedMessageSource =
  'CALLBACK_SUCCESS' | 'CALLBACK_FAILURE' | 'WEBHOOK' | 'VERIFY_ENDPOINT';

/** Normalised result of applying a verified provider message. */
export interface AppliedOutcome {
  /** APPLIED: state changed. DUPLICATE: already in this state. IGNORED: not actionable. */
  outcome: 'APPLIED' | 'DUPLICATE' | 'IGNORED';
  paymentId: string;
  transactionId: string;
  status: PaymentTransactionStatus;
  walletCredited: boolean;
  requiresAdminApproval: boolean;
  creditRequestStatus: WalletCreditRequestStatus | null;
}

/**
 * Generic payment business logic.
 *
 * Contains NO provider-specific hashing, field names or endpoints — all of
 * that lives behind {@link IPaymentProvider}. Contains NO wallet balance
 * arithmetic — all of that lives in {@link WalletService}.
 *
 * This class's single job is to verify and record money movement, and to gate
 * a WalletCreditRequest on that verification.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly expiryMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly walletService: WalletService,
    private readonly plansService: PlansService,
    @Inject(PAYMENT_PROVIDER)
    private readonly provider: IPaymentProvider,
  ) {
    const configured = parseInt(
      this.config.get<string>('PAYMENT_EXPIRY_MINUTES') ||
        String(PAYMENT_EXPIRY_MINUTES_DEFAULT),
      10,
    );
    this.expiryMinutes =
      Number.isFinite(configured) && configured > 0
        ? configured
        : PAYMENT_EXPIRY_MINUTES_DEFAULT;
  }

  // ══════════════════════════════════════════════════════════════════
  //  TRANSACTION ID
  // ══════════════════════════════════════════════════════════════════

  /**
   * Generates the merchant transaction id sent to PayU as `txnid`.
   *
   * Server-generated and unpredictable: a client never supplies or influences
   * it. Timestamp component keeps ids roughly sortable; 5 random bytes make
   * collisions practically impossible, and the DB unique constraint on
   * `transactionId` is the final backstop. Length stays well under PayU's
   * 25-character limit.
   */
  private generateTransactionId(): string {
    const stamp = Date.now().toString(36).toUpperCase();
    const random = randomBytes(5).toString('hex').toUpperCase();
    return `${PAYMENT_TXNID_PREFIX}${stamp}${random}`;
  }

  /** Fingerprint of the creation parameters, for idempotency-key reuse detection. */
  private computeRequestHash(dto: CreatePaymentDto): string {
    return `topup:${dto.amount}:${dto.paymentMethod}`;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — CREATE WALLET TOP-UP PAYMENT
  // ══════════════════════════════════════════════════════════════════

  /**
   * Starts a wallet top-up.
   *
   * ONLINE: creates a PENDING WalletCreditRequest + PENDING Payment, then
   * returns PayU Hosted Checkout fields. The wallet is NOT touched.
   *
   * CASH: creates a PENDING WalletCreditRequest + PENDING CashCollection and
   * NO Payment row — there is no online payment to verify, and the wallet is
   * not credited until an admin confirms the physical cash.
   */
  async createWalletTopUp(
    userId: string,
    dto: CreatePaymentDto,
    idempotencyKey: string,
  ) {
    // Re-validate against the wallet's own configured bounds rather than
    // duplicating limits here. The DTO only guarantees a positive integer.
    this.walletService.validateCreditAmount(dto.amount);

    const requestHash = this.computeRequestHash(dto);

    if (dto.paymentMethod === PaymentMethod.CASH) {
      return this.createCashTopUp(userId, dto, idempotencyKey);
    }
    return this.createOnlineTopUp(userId, dto, idempotencyKey, requestHash);
  }

  private async createOnlineTopUp(
    userId: string,
    dto: CreatePaymentDto,
    idempotencyKey: string,
    requestHash: string,
  ) {
    // Customer contact details are needed by PayU and must come from our own
    // records, never from the request body.
    const customer = await this.getCustomerForCheckout(userId);

    const created = await this.prisma.$transaction(async (tx) => {
      // Idempotent replay: same key + same parameters returns the original
      // payment; same key + different parameters is a conflict.
      const existing = await tx.payment.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'Idempotency key has already been used with different parameters',
          });
        }
        return { payment: existing, replayed: true };
      }

      const { request, replayed } =
        await this.walletService.createPaymentBackedCreditRequest(tx, {
          userId,
          amountPaise: dto.amount,
          source: 'ONLINE',
          idempotencyKey,
        });

      // The key resolved to an existing credit request that was NOT created
      // for an online payment. Reusing it would attach a PayU payment to a
      // cash top-up, so it is a parameter conflict, not a replay.
      if (replayed && request.source !== PaymentMethod.ONLINE) {
        throw new ConflictException({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'Idempotency key has already been used with different parameters',
        });
      }

      const payment = await tx.payment.create({
        data: {
          userId,
          walletCreditRequestId: request.id,
          provider: PaymentProviderType.PAYU,
          purpose: PaymentPurpose.WALLET_TOPUP,
          paymentMethod: PaymentMethod.ONLINE,
          transactionId: this.generateTransactionId(),
          amountPaise: dto.amount,
          currency: PAYMENT_CURRENCY,
          status: PaymentTransactionStatus.PENDING,
          idempotencyKey,
          requestHash,
          expiresAt: new Date(Date.now() + this.expiryMinutes * 60_000),
        },
      });

      return { payment, replayed: false };
    });

    const checkout = await this.provider.createPayment({
      transactionId: created.payment.transactionId,
      amountPaise: created.payment.amountPaise,
      productInfo: PAYMENT_WALLET_TOPUP_PRODUCT_INFO,
      customerFirstName: customer.firstName,
      customerEmail: customer.email,
      customerPhone: customer.mobile,
    });

    this.logger.log(
      `Online wallet top-up created paymentId=${created.payment.id} ` +
        `transactionId=${created.payment.transactionId} userId=${userId} ` +
        `amountPaise=${created.payment.amountPaise} replayed=${created.replayed}`,
    );

    return {
      payment: this.formatCustomerPayment(created.payment),
      walletCreditRequestId: created.payment.walletCreditRequestId,
      replayed: created.replayed || undefined,
      checkout,
      message:
        'Payment created. Submit the checkout fields to the payment gateway to complete it.',
    };
  }

  private async createCashTopUp(
    userId: string,
    dto: CreatePaymentDto,
    idempotencyKey: string,
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      // An idempotency key is bound to one payment method. If this key already
      // produced an online Payment, reusing it for cash is a parameter
      // conflict rather than a replay.
      const onlinePayment = await tx.payment.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (onlinePayment) {
        throw new ConflictException({
          error: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'Idempotency key has already been used with different parameters',
        });
      }

      const { request, replayed } =
        await this.walletService.createPaymentBackedCreditRequest(tx, {
          userId,
          amountPaise: dto.amount,
          source: 'CASH',
          idempotencyKey,
        });

      if (replayed) {
        // The wallet already rejected a different AMOUNT for this key; what
        // remains to check is that the original request was a cash one.
        if (request.source !== PaymentMethod.CASH) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'Idempotency key has already been used with different parameters',
          });
        }
        const existingCollection = await tx.cashCollection.findUnique({
          where: { walletCreditRequestId: request.id },
        });
        if (existingCollection) {
          return { request, collection: existingCollection, replayed: true };
        }
      }

      const collection = await tx.cashCollection.create({
        data: {
          userId,
          walletCreditRequestId: request.id,
          amountPaise: dto.amount,
          status: CashCollectionStatus.PENDING,
        },
      });

      return { request, collection, replayed };
    });

    this.logger.log(
      `Cash wallet top-up requested cashCollectionId=${result.collection.id} ` +
        `creditRequestId=${result.request.id} userId=${userId} ` +
        `amountPaise=${result.collection.amountPaise}`,
    );

    return {
      cashCollection: {
        id: result.collection.id,
        amountPaise: result.collection.amountPaise,
        status: result.collection.status,
        createdAt: result.collection.createdAt,
      },
      walletCreditRequestId: result.request.id,
      replayed: result.replayed || undefined,
      message:
        'Cash collection requested. Your wallet is credited only after the cash is collected and confirmed by an admin.',
    };
  }

  /**
   * Loads the contact details PayU requires. Email is mandatory at PayU, so a
   * customer without one is told to add it rather than being sent to a
   * checkout that would be rejected.
   */
  private async getCustomerForCheckout(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        mobile: true,
        email: true,
        customerProfile: { select: { firstName: true } },
      },
    });

    if (!user) {
      throw new NotFoundException({
        error: 'CUSTOMER_NOT_FOUND',
        message: 'Customer not found',
      });
    }

    if (!user.email) {
      throw new BadRequestException({
        error: 'CUSTOMER_EMAIL_REQUIRED',
        message:
          'Add and verify an email address on your profile before paying online',
      });
    }

    return {
      mobile: user.mobile,
      email: user.email,
      firstName: user.customerProfile?.firstName || 'Customer',
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — VERIFY (server-to-server, authoritative)
  // ══════════════════════════════════════════════════════════════════

  /**
   * Re-checks a payment's real state directly with the provider.
   *
   * This exists so the app never has to believe the browser. The client says
   * only WHICH transaction to check; the status comes from the provider over a
   * server-to-server call and is applied through the same guarded state
   * machine as a webhook.
   */
  async verifyPayment(userId: string, dto: VerifyPaymentDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { transactionId: dto.transactionId },
    });

    if (!payment || payment.userId !== userId) {
      // Same response for "not yours" and "does not exist" so the endpoint
      // cannot be used to probe for other customers' transaction ids.
      throw new NotFoundException({
        error: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    const providerWithStatus = this.provider as IPaymentProvider & {
      fetchAuthoritativeStatus?: (transactionId: string) => Promise<{
        status: PaymentTransactionStatus | null;
        rawStatus: string | null;
        providerPaymentId: string | null;
        amountPaise: number | null;
      }>;
    };

    if (typeof providerWithStatus.fetchAuthoritativeStatus !== 'function') {
      // Provider cannot be queried; report what we have rather than guessing.
      return { payment: this.formatCustomerPayment(payment) };
    }

    const authoritative = await providerWithStatus.fetchAuthoritativeStatus(
      payment.transactionId,
    );

    if (!authoritative.status) {
      this.logger.log(
        `Verify returned no actionable status transactionId=${payment.transactionId} ` +
          `rawStatus=${authoritative.rawStatus ?? 'none'}`,
      );
      return { payment: this.formatCustomerPayment(payment) };
    }

    // A server-to-server verification is already authenticated by the
    // credentials used to make the call, so it is treated as signature-valid.
    const applied = await this.applyVerifiedOutcome(
      {
        signatureValid: true,
        transactionId: payment.transactionId,
        providerPaymentId: authoritative.providerPaymentId,
        amountPaise: authoritative.amountPaise,
        status: authoritative.status,
        rawStatus: authoritative.rawStatus,
        failureCode: null,
        failureMessage: null,
        sanitisedPayload: {
          source: 'verify_payment',
          status: authoritative.rawStatus,
        },
      },
      'VERIFY_ENDPOINT',
    );

    const fresh = await this.prisma.payment.findUnique({
      where: { id: applied.paymentId },
    });

    return {
      payment: this.formatCustomerPayment(fresh!),
      walletCredited: applied.walletCredited,
      requiresAdminApproval: applied.requiresAdminApproval,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — RETRY
  // ══════════════════════════════════════════════════════════════════

  /**
   * Retries a failed / cancelled / expired online top-up.
   *
   * The amount is re-read from the still-PENDING credit request, never taken
   * from the request body, so a retry cannot change what is owed. A brand new
   * Payment row and transaction id are generated; the partial unique index on
   * live payments per credit request guarantees the original attempt cannot
   * also still be claimable.
   */
  async retryPayment(
    userId: string,
    dto: RetryPaymentDto,
    idempotencyKey: string,
  ) {
    const customer = await this.getCustomerForCheckout(userId);

    const created = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.payment.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });
      if (existing) {
        return { payment: existing, replayed: true };
      }

      const previous = await tx.payment.findUnique({
        where: { transactionId: dto.transactionId },
        include: { walletCreditRequest: true },
      });

      if (!previous || previous.userId !== userId) {
        throw new NotFoundException({
          error: 'PAYMENT_NOT_FOUND',
          message: 'Payment not found',
        });
      }

      if (
        !PAYMENT_RETRYABLE_STATUSES.includes(
          previous.status as PaymentTransactionStatus,
        )
      ) {
        throw new ConflictException({
          error: 'PAYMENT_NOT_RETRYABLE',
          message: `A payment in status ${previous.status} cannot be retried`,
        });
      }

      if (
        !previous.walletCreditRequestId ||
        !previous.walletCreditRequest ||
        previous.walletCreditRequest.status !==
          WalletCreditRequestStatus.PENDING
      ) {
        throw new ConflictException({
          error: 'CREDIT_REQUEST_NOT_PENDING',
          message:
            'The wallet credit request for this payment is no longer open. Start a new top-up.',
        });
      }

      const payment = await tx.payment.create({
        data: {
          userId,
          walletCreditRequestId: previous.walletCreditRequestId,
          provider: PaymentProviderType.PAYU,
          purpose: PaymentPurpose.WALLET_TOPUP,
          paymentMethod: PaymentMethod.ONLINE,
          transactionId: this.generateTransactionId(),
          // Authoritative amount: the open credit request, not the client.
          amountPaise: previous.walletCreditRequest.amountPaise,
          currency: PAYMENT_CURRENCY,
          status: PaymentTransactionStatus.PENDING,
          idempotencyKey,
          requestHash: previous.requestHash,
          expiresAt: new Date(Date.now() + this.expiryMinutes * 60_000),
        },
      });

      return { payment, replayed: false };
    });

    const checkout = await this.provider.createPayment({
      transactionId: created.payment.transactionId,
      amountPaise: created.payment.amountPaise,
      productInfo: PAYMENT_WALLET_TOPUP_PRODUCT_INFO,
      customerFirstName: customer.firstName,
      customerEmail: customer.email,
      customerPhone: customer.mobile,
    });

    this.logger.log(
      `Payment retried newPaymentId=${created.payment.id} ` +
        `newTransactionId=${created.payment.transactionId} ` +
        `previousTransactionId=${dto.transactionId} userId=${userId}`,
    );

    return {
      payment: this.formatCustomerPayment(created.payment),
      replayed: created.replayed || undefined,
      checkout,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CORE STATE MACHINE — APPLY A VERIFIED PROVIDER MESSAGE
  // ══════════════════════════════════════════════════════════════════

  /**
   * The single entry point through which a payment's status ever changes as a
   * result of provider communication. Callbacks, webhooks and the verify
   * endpoint all funnel through here, so the guarantees below hold for all of
   * them without being reimplemented three times.
   *
   * Guarantees:
   *  - An unverified signature is rejected before anything is looked up.
   *  - An unknown transaction id is rejected.
   *  - A reported amount that differs from the stored amount is rejected; the
   *    stored amount is always the one of record.
   *  - Every transition is a conditional `updateMany` guarded on the set of
   *    legal source statuses, and the affected row count decides the outcome.
   *    A duplicate message therefore matches zero rows and does nothing.
   *  - The wallet is only ever touched through WalletService, inside the same
   *    database transaction as the payment transition.
   */
  async applyVerifiedOutcome(
    verification: ProviderVerificationResult,
    source: VerifiedMessageSource,
  ): Promise<AppliedOutcome> {
    if (!verification.signatureValid) {
      this.logger.warn(
        `Rejected provider message with invalid signature source=${source} ` +
          `transactionId=${verification.transactionId ?? 'unknown'}`,
      );
      throw new ForbiddenException({
        error: 'PAYMENT_SIGNATURE_INVALID',
        message: 'Payment signature verification failed',
      });
    }

    if (!verification.transactionId) {
      throw new BadRequestException({
        error: 'PAYMENT_TRANSACTION_ID_MISSING',
        message: 'Transaction id missing from provider message',
      });
    }

    const payment = await this.prisma.payment.findUnique({
      where: { transactionId: verification.transactionId },
    });

    if (!payment) {
      this.logger.warn(
        `Verified provider message for unknown transaction source=${source} ` +
          `transactionId=${verification.transactionId}`,
      );
      throw new NotFoundException({
        error: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    // Amount check against our own record. A signature-valid message whose
    // amount does not match means the provider and our ledger disagree; we
    // never settle on it.
    if (
      verification.amountPaise !== null &&
      verification.amountPaise !== payment.amountPaise
    ) {
      this.logger.error(
        `Payment amount mismatch source=${source} paymentId=${payment.id} ` +
          `transactionId=${payment.transactionId} ` +
          `expectedPaise=${payment.amountPaise} reportedPaise=${verification.amountPaise}`,
      );
      throw new BadRequestException({
        error: 'PAYMENT_AMOUNT_MISMATCH',
        message: 'Reported payment amount does not match the recorded amount',
      });
    }

    switch (verification.status) {
      case PaymentTransactionStatus.SUCCESS:
        return this.applySuccess(payment.id, verification, source);
      case PaymentTransactionStatus.FAILED:
        return this.applyFailure(payment.id, verification, source);
      case PaymentTransactionStatus.REFUNDED:
        return this.applyRefunded(payment.id, verification, source);
      case PaymentTransactionStatus.PROCESSING:
        return this.applyProcessing(payment.id, verification, source);
      default:
        this.logger.log(
          `Provider message not actionable source=${source} paymentId=${payment.id} ` +
            `rawStatus=${verification.rawStatus ?? 'none'}`,
        );
        return {
          outcome: 'IGNORED',
          paymentId: payment.id,
          transactionId: payment.transactionId,
          status: payment.status as PaymentTransactionStatus,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
    }
  }

  /**
   * PENDING|PROCESSING -> SUCCESS, then settle the wallet credit request.
   *
   * The conditional update is the duplicate-webhook guard: the first verified
   * success flips the row and credits once; a second one matches no row,
   * returns DUPLICATE and performs no wallet operation at all.
   */
  private async applySuccess(
    paymentId: string,
    verification: ProviderVerificationResult,
    source: VerifiedMessageSource,
  ): Promise<AppliedOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: PAYMENT_SUCCESS_FROM_STATUSES } },
        data: {
          status: PaymentTransactionStatus.SUCCESS,
          providerPaymentId: verification.providerPaymentId,
          providerResponse:
            verification.sanitisedPayload as Prisma.InputJsonValue,
          completedAt: now,
          failureCode: null,
          failureMessage: null,
        },
      });

      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      if (updated.count === 0) {
        this.logger.log(
          `Duplicate success ignored source=${source} paymentId=${paymentId} ` +
            `transactionId=${payment.transactionId} currentStatus=${payment.status}`,
        );
        return {
          outcome: 'DUPLICATE' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: payment.status as PaymentTransactionStatus,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }

      // Shared settlement branches on PURPOSE. The payment-side state
      // transition is identical for both; what differs is which downstream
      // ledger the money moves through.
      if (payment.purpose === PaymentPurpose.WALLET_TOPUP) {
        if (!payment.walletCreditRequestId) {
          return {
            outcome: 'APPLIED' as const,
            paymentId,
            transactionId: payment.transactionId,
            status: PaymentTransactionStatus.SUCCESS,
            walletCredited: false,
            requiresAdminApproval: false,
            creditRequestStatus: null,
          };
        }

        const settlement = await this.walletService.settleAfterVerifiedPayment(
          tx,
          payment.walletCreditRequestId,
        );

        this.logger.log(
          `Payment success applied source=${source} paymentId=${paymentId} ` +
            `purpose=WALLET_TOPUP transactionId=${payment.transactionId} ` +
            `userId=${payment.userId} amountPaise=${payment.amountPaise} ` +
            `walletCredited=${settlement.credited} ` +
            `requiresAdminApproval=${settlement.requiresAdminApproval}`,
        );

        return {
          outcome: 'APPLIED' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.SUCCESS,
          walletCredited: settlement.credited,
          requiresAdminApproval: settlement.requiresAdminApproval,
          creditRequestStatus: settlement.status,
        };
      }

      // ─── ORDER settlement ──────────────────────────────────────────────
      // Verified SUCCESS for an order payment. The Payment row is already
      // flipped to SUCCESS and amount == Payment.amountPaise was verified
      // above. Now re-check against Order.totalPaise and try the atomic
      // conditional Order update. If 0 rows match the order was already PAID
      // (likely by a parallel wallet payment) — route this payment to
      // REFUND_PENDING; the existing refund machinery drives it to REFUNDED
      // on the provider's confirmed webhook. The order and wallet are not
      // touched on that path.
      if (!payment.orderId) {
        this.logger.error(
          `ORDER payment missing orderId paymentId=${paymentId}`,
        );
        return {
          outcome: 'APPLIED' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.SUCCESS,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }

      const order = await tx.order.findUnique({
        where: { id: payment.orderId },
        select: { id: true, totalPaise: true, paymentStatus: true },
      });

      if (!order) {
        this.logger.error(
          `ORDER payment references unknown order paymentId=${paymentId} ` +
            `orderId=${payment.orderId}`,
        );
        return {
          outcome: 'APPLIED' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.SUCCESS,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }

      if (payment.amountPaise !== order.totalPaise) {
        this.logger.error(
          `ORDER payment amount drift paymentId=${paymentId} ` +
            `orderId=${order.id} paymentPaise=${payment.amountPaise} ` +
            `orderPaise=${order.totalPaise}`,
        );
        return this.sendPaymentToRefundPending(
          tx,
          payment.id,
          'order-amount-mismatch',
          payment.transactionId,
        );
      }

      const orderUpdate = await tx.order.updateMany({
        where: {
          id: payment.orderId,
          paymentStatus: OrderPaymentStatus.PENDING,
        },
        data: { paymentStatus: OrderPaymentStatus.PAID },
      });

      if (orderUpdate.count === 0) {
        this.logger.log(
          `ORDER already PAID; routing late PayU success to refund ` +
            `source=${source} paymentId=${paymentId} orderId=${order.id} ` +
            `transactionId=${payment.transactionId}`,
        );
        return this.sendPaymentToRefundPending(
          tx,
          payment.id,
          'order-already-paid',
          payment.transactionId,
        );
      }

      this.logger.log(
        `ORDER payment success applied source=${source} paymentId=${paymentId} ` +
          `orderId=${order.id} transactionId=${payment.transactionId} ` +
          `userId=${payment.userId} amountPaise=${payment.amountPaise}`,
      );

      return {
        outcome: 'APPLIED' as const,
        paymentId,
        transactionId: payment.transactionId,
        status: PaymentTransactionStatus.SUCCESS,
        walletCredited: false,
        requiresAdminApproval: false,
        creditRequestStatus: null,
      };
    });
  }

  /**
   * SUCCESS -> REFUND_PENDING in-transaction. Used for the late-arrival
   * case where PayU's verified SUCCESS lands AFTER the wallet already settled
   * the order. The actual PayU refund call is fired after commit so a slow
   * provider does not hold DB locks. If the process dies between commit and
   * provider call, the Payment row stays REFUND_PENDING and the admin can
   * retry via POST /admin/payments/order/:id/refund (see initiateOrderRefund).
   */
  private async sendPaymentToRefundPending(
    tx: Prisma.TransactionClient,
    paymentId: string,
    reason: string,
    transactionId: string,
  ): Promise<AppliedOutcome> {
    const claim = await tx.payment.updateMany({
      where: { id: paymentId, status: PaymentTransactionStatus.SUCCESS },
      data: { status: PaymentTransactionStatus.REFUND_PENDING },
    });

    if (claim.count > 0) {
      setImmediate(() => {
        this.callProviderRefundForPayment(paymentId).catch((error) => {
          this.logger.error(
            `Late refund call failed paymentId=${paymentId} ` +
              `reason=${reason} transactionId=${transactionId} ` +
              `error=${error instanceof Error ? error.name : 'UnknownError'}`,
          );
        });
      });
    }

    return {
      outcome: 'APPLIED' as const,
      paymentId,
      transactionId,
      status: PaymentTransactionStatus.REFUND_PENDING,
      walletCredited: false,
      requiresAdminApproval: false,
      creditRequestStatus: null,
    };
  }

  /**
   * Common PayU refund call shared by:
   *   - the credit-request rejection path (initiateRefundForRejectedCreditRequest)
   *   - the late-arrival ORDER success -> REFUND_PENDING path
   *   - the admin initiateOrderRefund retry
   *
   * Expects the Payment row to already be in REFUND_PENDING when called.
   * Does not change state further; the provider's webhook flips it to REFUNDED.
   */
  private async callProviderRefundForPayment(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });
    if (!payment) return;
    if (payment.status !== PaymentTransactionStatus.REFUND_PENDING) return;
    if (!payment.providerPaymentId) {
      this.logger.error(
        `Refund skipped: providerPaymentId missing paymentId=${paymentId}`,
      );
      return;
    }

    const result = await this.provider.refundPayment({
      transactionId: payment.transactionId,
      providerPaymentId: payment.providerPaymentId,
      amountPaise: payment.amountPaise,
      reason: 'late-arrival-or-admin-initiated',
    });

    if (result.providerRefundId) {
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentTransactionStatus.REFUND_PENDING,
        },
        data: { providerRefundId: result.providerRefundId },
      });
    }

    if (!result.accepted) {
      this.logger.error(
        `Provider rejected refund paymentId=${payment.id} ` +
          `transactionId=${payment.transactionId}`,
      );
    } else {
      this.logger.log(
        `Refund requested paymentId=${payment.id} ` +
          `transactionId=${payment.transactionId} ` +
          `providerRefundId=${result.providerRefundId ?? 'none'}`,
      );
    }
  }

  /**
   * PENDING|PROCESSING -> FAILED, and close the credit request as CANCELLED so
   * the one-PENDING-per-wallet slot is released and the customer can retry.
   * No wallet credit and no ledger entry are ever produced on this path.
   */
  private async applyFailure(
    paymentId: string,
    verification: ProviderVerificationResult,
    source: VerifiedMessageSource,
  ): Promise<AppliedOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, status: { in: PAYMENT_FAILURE_FROM_STATUSES } },
        data: {
          status: PaymentTransactionStatus.FAILED,
          providerPaymentId: verification.providerPaymentId,
          providerResponse:
            verification.sanitisedPayload as Prisma.InputJsonValue,
          failureCode: verification.failureCode,
          failureMessage: verification.failureMessage,
        },
      });

      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      if (updated.count === 0) {
        this.logger.log(
          `Duplicate failure ignored source=${source} paymentId=${paymentId} ` +
            `currentStatus=${payment.status}`,
        );
        return {
          outcome: 'DUPLICATE' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: payment.status as PaymentTransactionStatus,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }

      if (payment.walletCreditRequestId) {
        await this.walletService.cancelCreditRequest(
          tx,
          payment.walletCreditRequestId,
          'Online payment failed',
        );
      }

      this.logger.log(
        `Payment failure applied source=${source} paymentId=${paymentId} ` +
          `transactionId=${payment.transactionId} userId=${payment.userId} ` +
          `failureCode=${verification.failureCode ?? 'none'}`,
      );

      return {
        outcome: 'APPLIED' as const,
        paymentId,
        transactionId: payment.transactionId,
        status: PaymentTransactionStatus.FAILED,
        walletCredited: false,
        requiresAdminApproval: false,
        creditRequestStatus: WalletCreditRequestStatus.CANCELLED,
      };
    });
  }

  /**
   * SUCCESS|REFUND_PENDING -> REFUNDED. This is the ONLY place a refund is
   * marked complete, and it runs only from a verified provider message —
   * never when a refund is merely requested.
   */
  private async applyRefunded(
    paymentId: string,
    verification: ProviderVerificationResult,
    source: VerifiedMessageSource,
  ): Promise<AppliedOutcome> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const updated = await tx.payment.updateMany({
        where: {
          id: paymentId,
          status: {
            in: [
              PaymentTransactionStatus.SUCCESS,
              PaymentTransactionStatus.REFUND_PENDING,
            ],
          },
        },
        data: {
          status: PaymentTransactionStatus.REFUNDED,
          providerResponse:
            verification.sanitisedPayload as Prisma.InputJsonValue,
          refundedAt: now,
        },
      });

      const payment = await tx.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });

      if (updated.count === 0) {
        this.logger.log(
          `Duplicate refund ignored source=${source} paymentId=${paymentId} ` +
            `currentStatus=${payment.status}`,
        );
        return {
          outcome: 'DUPLICATE' as const,
          paymentId,
          transactionId: payment.transactionId,
          status: payment.status as PaymentTransactionStatus,
          walletCredited: false,
          requiresAdminApproval: false,
          creditRequestStatus: null,
        };
      }

      if (payment.walletCreditRequestId) {
        await this.walletService.markRefundOutcome(
          tx,
          payment.walletCreditRequestId,
          WalletRefundStatus.REFUNDED,
        );
      }

      this.logger.log(
        `Refund confirmed source=${source} paymentId=${paymentId} ` +
          `transactionId=${payment.transactionId} amountPaise=${payment.amountPaise}`,
      );

      return {
        outcome: 'APPLIED' as const,
        paymentId,
        transactionId: payment.transactionId,
        status: PaymentTransactionStatus.REFUNDED,
        walletCredited: false,
        requiresAdminApproval: false,
        creditRequestStatus: null,
      };
    });
  }

  /** PENDING -> PROCESSING. Informational only; never credits anything. */
  private async applyProcessing(
    paymentId: string,
    verification: ProviderVerificationResult,
    source: VerifiedMessageSource,
  ): Promise<AppliedOutcome> {
    const updated = await this.prisma.payment.updateMany({
      where: { id: paymentId, status: PaymentTransactionStatus.PENDING },
      data: {
        status: PaymentTransactionStatus.PROCESSING,
        providerPaymentId: verification.providerPaymentId,
        providerResponse:
          verification.sanitisedPayload as Prisma.InputJsonValue,
      },
    });

    const payment = await this.prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
    });

    this.logger.log(
      `Payment processing source=${source} paymentId=${paymentId} ` +
        `applied=${updated.count > 0}`,
    );

    return {
      outcome: updated.count > 0 ? 'APPLIED' : 'DUPLICATE',
      paymentId,
      transactionId: payment.transactionId,
      status: payment.status as PaymentTransactionStatus,
      walletCredited: false,
      requiresAdminApproval: false,
      creditRequestStatus: null,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ORDER PAYMENTS
  //
  //  Two entry points, one settlement:
  //    - payOrderFromWallet(userId, orderId)
  //         ONE transaction: conditional Order PENDING→PAID + wallet DEBIT.
  //         If either step fails, both roll back. Does NOT touch any live
  //         PayU Order payment — the shared SUCCESS settlement handles those
  //         via the late-arrival REFUND_PENDING path.
  //    - createOrderPayment(userId, orderId, idempotencyKey)
  //         Creates a Payment row (purpose=ORDER, orderId) and returns PayU
  //         Hosted Checkout fields. The partial unique index
  //         `payments_one_live_payment_per_order` prevents two live PayU
  //         payments for the same order.
  //
  //  Shared SUCCESS settlement is in applySuccess above.
  //  Expiry / FAILED / CANCELLED stay on their existing per-purpose paths
  //  (applyFailure for ORDER-purpose simply leaves the Order PENDING).
  // ══════════════════════════════════════════════════════════════════

  async payOrderFromWallet(userId: string, orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      // Load order under the same tx. Owner-scoped 404 — same shape as
      // 'order not found' so a probe cannot distinguish the two.
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          id: true,
          userId: true,
          totalPaise: true,
          paymentStatus: true,
          status: true,
        },
      });

      if (!order || order.userId !== userId) {
        throw new NotFoundException({
          error: 'ORDER_NOT_FOUND',
          message: 'Order not found',
        });
      }

      if (order.paymentStatus !== OrderPaymentStatus.PENDING) {
        throw new ConflictException({
          error: 'ORDER_ALREADY_PROCESSED',
          message: `Order is already ${order.paymentStatus.toLowerCase()}`,
        });
      }

      // Debit the wallet THROUGH the same-tx variant. The ledger unique
      // (type, referenceType, referenceId) index means a repeated call for
      // the same orderId is a hard DB-level duplicate.
      await this.walletService.debitWalletWithin(
        tx,
        userId,
        order.totalPaise,
        WalletTransactionReferenceType.ORDER,
        order.id,
        `Order payment (${order.id})`,
      );

      // Atomic conditional Order update. If a parallel PayU success raced us
      // and already marked the order PAID, we'd match 0 rows here — but the
      // debit above would have succeeded, so we'd be double-paying. Throwing
      // rolls back the whole transaction including the ledger row.
      //
      // In practice the DB-level unique on (type, referenceType, referenceId)
      // would prevent a second DEBIT regardless; this is the belt-and-braces
      // in-code assertion.
      const updated = await tx.order.updateMany({
        where: {
          id: order.id,
          paymentStatus: OrderPaymentStatus.PENDING,
        },
        data: { paymentStatus: OrderPaymentStatus.PAID },
      });

      if (updated.count === 0) {
        throw new ConflictException({
          error: 'ORDER_ALREADY_PROCESSED',
          message: 'Order was settled by another request',
        });
      }

      this.logger.log(
        `Order paid via wallet orderId=${order.id} userId=${userId} ` +
          `amountPaise=${order.totalPaise}`,
      );

      return {
        success: true,
        orderId: order.id,
        paymentMethod: 'WALLET',
        paymentStatus: OrderPaymentStatus.PAID,
        orderStatus: order.status,
      };
    });
  }

  async createOrderPayment(
    userId: string,
    orderId: string,
    idempotencyKey: string,
  ) {
    const customer = await this.getCustomerForCheckout(userId);

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        userId: true,
        totalPaise: true,
        paymentStatus: true,
        orderNumber: true,
      },
    });

    if (!order || order.userId !== userId) {
      throw new NotFoundException({
        error: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }

    if (order.paymentStatus !== OrderPaymentStatus.PENDING) {
      throw new ConflictException({
        error: 'ORDER_ALREADY_PROCESSED',
        message: `Order is already ${order.paymentStatus.toLowerCase()}`,
      });
    }

    const requestHash = `order:${order.id}:${order.totalPaise}`;

    const created = await this.prisma.$transaction(async (tx) => {
      // Idempotency replay across the Payments-level idempotency key.
      const existing = await tx.payment.findUnique({
        where: { userId_idempotencyKey: { userId, idempotencyKey } },
      });

      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new ConflictException({
            error: 'IDEMPOTENCY_KEY_REUSED',
            message:
              'Idempotency key has already been used with different parameters',
          });
        }
        return { payment: existing, replayed: true };
      }

      // The partial unique index payments_one_live_payment_per_order kicks in
      // here if a concurrent request has already produced a live Payment for
      // this order. Catch and return it so the two concurrent callers both
      // see the same checkout.
      try {
        const payment = await tx.payment.create({
          data: {
            userId,
            orderId: order.id,
            provider: PaymentProviderType.PAYU,
            purpose: PaymentPurpose.ORDER,
            paymentMethod: PaymentMethod.ONLINE,
            transactionId: this.generateTransactionId(),
            amountPaise: order.totalPaise,
            currency: PAYMENT_CURRENCY,
            status: PaymentTransactionStatus.PENDING,
            idempotencyKey,
            requestHash,
            expiresAt: new Date(Date.now() + this.expiryMinutes * 60_000),
          },
        });
        return { payment, replayed: false };
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2002'
        ) {
          // Another concurrent request won the live-payment slot. Return it.
          const live = await tx.payment.findFirst({
            where: {
              orderId: order.id,
              status: {
                in: [
                  PaymentTransactionStatus.PENDING,
                  PaymentTransactionStatus.PROCESSING,
                  PaymentTransactionStatus.SUCCESS,
                  PaymentTransactionStatus.REFUND_PENDING,
                  PaymentTransactionStatus.REFUNDED,
                ],
              },
            },
            orderBy: { createdAt: 'desc' },
          });
          if (live) {
            return { payment: live, replayed: true };
          }
        }
        throw error;
      }
    });

    const checkout = await this.provider.createPayment({
      transactionId: created.payment.transactionId,
      amountPaise: created.payment.amountPaise,
      productInfo: `Order ${order.orderNumber}`,
      customerFirstName: customer.firstName,
      customerEmail: customer.email,
      customerPhone: customer.mobile,
    });

    this.logger.log(
      `Order PayU payment created paymentId=${created.payment.id} ` +
        `orderId=${order.id} transactionId=${created.payment.transactionId} ` +
        `userId=${userId} amountPaise=${created.payment.amountPaise} ` +
        `replayed=${created.replayed}`,
    );

    return {
      payment: this.formatCustomerPayment(created.payment),
      orderId: order.id,
      replayed: created.replayed || undefined,
      checkout,
      message:
        'Payment created. Submit the checkout fields to the payment gateway to complete it.',
    };
  }

  /**
   * Admin retry for an ORDER-purpose PayU refund. Not currently exposed as an
   * endpoint — kept for the future admin refund panel.
   */
  async initiateOrderRefund(orderId: string) {
    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        purpose: PaymentPurpose.ORDER,
        status: PaymentTransactionStatus.SUCCESS,
      },
    });

    if (!payment) {
      throw new ConflictException({
        error: 'NO_REFUNDABLE_PAYMENT',
        message:
          'No settled online payment exists for this order. Wallet-paid orders are not refunded through the gateway.',
      });
    }

    if (!payment.providerPaymentId) {
      throw new ConflictException({
        error: 'PROVIDER_PAYMENT_ID_MISSING',
        message: 'Provider payment reference is missing; cannot refund',
      });
    }

    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentTransactionStatus.SUCCESS },
      data: { status: PaymentTransactionStatus.REFUND_PENDING },
    });

    if (claimed.count === 0) {
      throw new ConflictException({
        error: 'REFUND_ALREADY_IN_PROGRESS',
        message: 'A refund for this payment is already in progress',
      });
    }

    try {
      await this.callProviderRefundForPayment(payment.id);
    } catch (error) {
      // Release the claim so the admin can retry.
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentTransactionStatus.REFUND_PENDING,
        },
        data: { status: PaymentTransactionStatus.SUCCESS },
      });
      throw error;
    }

    return {
      success: true,
      message:
        'Refund requested. It is marked REFUNDED only after the provider confirms it.',
      payment: {
        id: payment.id,
        transactionId: payment.transactionId,
        status: PaymentTransactionStatus.REFUND_PENDING,
        amountPaise: payment.amountPaise,
      },
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  REFUNDS
  // ══════════════════════════════════════════════════════════════════

  /**
   * Initiates a provider refund for a credit request an admin rejected.
   *
   * The Wallet module never calls the provider: it records REJECTED +
   * refundStatus=REFUND_PENDING, and this method turns that into an actual
   * refund request. The payment is moved to REFUND_PENDING only — it becomes
   * REFUNDED exclusively via a verified refund webhook.
   */
  /**
   * Fire-and-check variant of {@link initiateRefundForRejectedCreditRequest}
   * intended for the admin-reject orchestration.
   *
   * Returns `{ refundInitiated: false }` instead of throwing in the two
   * benign cases that come up on that path:
   *   - the credit request is a CASH top-up (no PayU payment exists), or
   *   - a previous reject already produced the refund request (idempotent
   *     retries).
   *
   * All other failures still bubble up so a genuine problem is not swallowed.
   */
  async initiateRefundIfApplicable(
    creditRequestId: string,
  ): Promise<{ refundInitiated: boolean; reason?: string }> {
    try {
      const result =
        await this.initiateRefundForRejectedCreditRequest(creditRequestId);
      return { refundInitiated: !!result?.success };
    } catch (error) {
      // Benign: cash requests have no settled online Payment to refund, and a
      // retried rejection may hit "already in progress".
      if (error && typeof error === 'object' && 'response' in error) {
        const code = ((error as { response: { error?: string } }).response
          ?.error) as string | undefined;
        if (
          code === 'NO_REFUNDABLE_PAYMENT' ||
          code === 'REFUND_ALREADY_IN_PROGRESS' ||
          code === 'CREDIT_REQUEST_NOT_REJECTED'
        ) {
          this.logger.log(
            `Refund skipped creditRequestId=${creditRequestId} reason=${code}`,
          );
          return { refundInitiated: false, reason: code };
        }
      }
      throw error;
    }
  }

  async initiateRefundForRejectedCreditRequest(creditRequestId: string) {
    const creditRequest = await this.prisma.walletCreditRequest.findUnique({
      where: { id: creditRequestId },
    });

    if (!creditRequest) {
      throw new NotFoundException({
        error: 'CREDIT_REQUEST_NOT_FOUND',
        message: 'Credit request not found',
      });
    }

    if (creditRequest.status !== WalletCreditRequestStatus.REJECTED) {
      throw new ConflictException({
        error: 'CREDIT_REQUEST_NOT_REJECTED',
        message: 'Only a rejected credit request can be refunded',
      });
    }

    const payment = await this.prisma.payment.findFirst({
      where: {
        walletCreditRequestId: creditRequestId,
        status: PaymentTransactionStatus.SUCCESS,
      },
    });

    if (!payment) {
      throw new ConflictException({
        error: 'NO_REFUNDABLE_PAYMENT',
        message:
          'No settled online payment exists for this credit request. Cash top-ups are refunded outside the payment gateway.',
      });
    }

    if (!payment.providerPaymentId) {
      throw new ConflictException({
        error: 'PROVIDER_PAYMENT_ID_MISSING',
        message: 'Provider payment reference is missing; cannot refund',
      });
    }

    // Claim the refund atomically so two admins cannot both call the provider.
    const claimed = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentTransactionStatus.SUCCESS },
      data: { status: PaymentTransactionStatus.REFUND_PENDING },
    });

    if (claimed.count === 0) {
      throw new ConflictException({
        error: 'REFUND_ALREADY_IN_PROGRESS',
        message: 'A refund for this payment is already in progress',
      });
    }

    try {
      const result = await this.provider.refundPayment({
        transactionId: payment.transactionId,
        providerPaymentId: payment.providerPaymentId,
        amountPaise: payment.amountPaise,
        reason: 'Wallet credit request rejected by admin',
      });

      if (!result.accepted) {
        // Release the claim so the refund can be retried.
        await this.prisma.payment.updateMany({
          where: {
            id: payment.id,
            status: PaymentTransactionStatus.REFUND_PENDING,
          },
          data: { status: PaymentTransactionStatus.SUCCESS },
        });
        await this.prisma.walletCreditRequest.updateMany({
          where: { id: creditRequestId },
          data: { refundStatus: WalletRefundStatus.REFUND_FAILED },
        });
        this.logger.error(
          `Provider rejected refund paymentId=${payment.id} ` +
            `transactionId=${payment.transactionId}`,
        );
        throw new ConflictException({
          error: 'REFUND_REJECTED_BY_PROVIDER',
          message: result.message || 'The payment provider rejected the refund',
        });
      }

      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { providerRefundId: result.providerRefundId },
      });

      this.logger.log(
        `Refund requested paymentId=${payment.id} ` +
          `transactionId=${payment.transactionId} amountPaise=${payment.amountPaise} ` +
          `providerRefundId=${result.providerRefundId ?? 'none'}`,
      );

      return {
        success: true,
        message:
          'Refund requested. It is marked REFUNDED only after the provider confirms it.',
        payment: {
          id: payment.id,
          transactionId: payment.transactionId,
          status: PaymentTransactionStatus.REFUND_PENDING,
          amountPaise: payment.amountPaise,
          providerRefundId: result.providerRefundId,
        },
      };
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      // Network/provider failure: release the claim so a retry is possible.
      await this.prisma.payment.updateMany({
        where: {
          id: payment.id,
          status: PaymentTransactionStatus.REFUND_PENDING,
        },
        data: { status: PaymentTransactionStatus.SUCCESS },
      });
      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  EXPIRY SWEEP
  // ══════════════════════════════════════════════════════════════════

  /**
   * Expires payments the customer never completed and releases their credit
   * requests, so an abandoned checkout does not hold the
   * one-PENDING-per-wallet slot forever.
   *
   * Conditional and idempotent: safe to run repeatedly and concurrently.
   */
  async expireStalePayments(): Promise<{ expired: number }> {
    const stale = await this.prisma.payment.findMany({
      where: {
        status: {
          in: [
            PaymentTransactionStatus.PENDING,
            PaymentTransactionStatus.PROCESSING,
          ],
        },
        expiresAt: { lt: new Date() },
      },
      select: { id: true, walletCreditRequestId: true },
      take: 500,
    });

    let expired = 0;
    for (const candidate of stale) {
      const didExpire = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.payment.updateMany({
          where: {
            id: candidate.id,
            status: {
              in: [
                PaymentTransactionStatus.PENDING,
                PaymentTransactionStatus.PROCESSING,
              ],
            },
          },
          data: { status: PaymentTransactionStatus.EXPIRED },
        });
        if (updated.count === 0) return false;

        if (candidate.walletCreditRequestId) {
          await this.walletService.cancelCreditRequest(
            tx,
            candidate.walletCreditRequestId,
            'Online payment expired before completion',
          );
        }
        return true;
      });
      if (didExpire) expired += 1;
    }

    if (expired > 0) {
      this.logger.log(`Expired ${expired} stale payment(s)`);
    }
    return { expired };
  }

  // ══════════════════════════════════════════════════════════════════
  //  CUSTOMER — READ
  // ══════════════════════════════════════════════════════════════════

  async getCustomerPayments(
    userId: string,
    query: CustomerListPaymentsQueryDto,
  ) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    // Always scoped to the authenticated customer; userId is never a filter
    // the client can supply.
    const where: Prisma.PaymentWhereInput = { userId };
    if (query.status) where.status = query.status;
    if (query.purpose) where.purpose = query.purpose;
    if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
    this.applyDateRange(where, query.startDate, query.endDate);

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: payments.map((p) => this.formatCustomerPayment(p)),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getCustomerPayment(userId: string, id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: { walletCreditRequest: true },
    });

    if (!payment || payment.userId !== userId) {
      throw new NotFoundException({
        error: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    return {
      ...this.formatCustomerPayment(payment),
      walletCredit: payment.walletCreditRequest
        ? {
            id: payment.walletCreditRequest.id,
            status: payment.walletCreditRequest.status,
            amountPaise: payment.walletCreditRequest.amountPaise,
            autoApproved: payment.walletCreditRequest.autoApproved,
            completedAt: payment.walletCreditRequest.completedAt,
            refundStatus: payment.walletCreditRequest.refundStatus,
          }
        : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — PAYMENTS (read-only)
  // ══════════════════════════════════════════════════════════════════

  async getAdminPayments(query: AdminListPaymentsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.PaymentWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.purpose) where.purpose = query.purpose;
    if (query.paymentMethod) where.paymentMethod = query.paymentMethod;
    if (query.transactionId) where.transactionId = query.transactionId;
    if (query.customerSearch) {
      where.user = this.customerSearchFilter(query.customerSearch);
    }
    this.applyDateRange(where, query.startDate, query.endDate);

    const [payments, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: this.customerSelect } },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: payments.map((p) => ({
        ...this.formatCustomerPayment(p),
        customer: this.formatCustomer(p.user),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getAdminPayment(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      include: {
        user: { select: this.customerSelect },
        walletCreditRequest: { include: { transaction: true } },
      },
    });

    if (!payment) {
      throw new NotFoundException({
        error: 'PAYMENT_NOT_FOUND',
        message: 'Payment not found',
      });
    }

    return {
      ...this.formatCustomerPayment(payment),
      customer: this.formatCustomer(payment.user),
      // Already stripped of hashes and card data at verification time.
      providerResponse: payment.providerResponse,
      walletCredit: payment.walletCreditRequest
        ? {
            id: payment.walletCreditRequest.id,
            status: payment.walletCreditRequest.status,
            amountPaise: payment.walletCreditRequest.amountPaise,
            autoApproved: payment.walletCreditRequest.autoApproved,
            refundStatus: payment.walletCreditRequest.refundStatus,
            adminNote: payment.walletCreditRequest.adminNote,
            completedAt: payment.walletCreditRequest.completedAt,
            transactionId: payment.walletCreditRequest.transaction?.id ?? null,
          }
        : null,
    };
  }

  // ══════════════════════════════════════════════════════════════════
  //  ADMIN — CASH COLLECTIONS
  // ══════════════════════════════════════════════════════════════════

  async getAdminCashCollections(query: AdminListCashCollectionsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.CashCollectionWhereInput = {};
    if (query.status) where.status = query.status;
    if (query.customerSearch) {
      where.user = this.customerSearchFilter(query.customerSearch);
    }
    this.applyDateRange(where, query.startDate, query.endDate);

    const [collections, total] = await Promise.all([
      this.prisma.cashCollection.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: { user: { select: this.customerSelect } },
      }),
      this.prisma.cashCollection.count({ where }),
    ]);

    return {
      data: collections.map((c: any) => ({
        id: c.id,
        amountPaise: c.amountPaise,
        status: c.status,
        purpose: c.walletCreditRequestId ? 'WALLET_TOPUP' : 'PLAN_PAYMENT',
        walletCreditRequestId: c.walletCreditRequestId,
        planSelectionId: c.planSelectionId,
        collectedAt: c.collectedAt,
        confirmedAt: c.confirmedAt,
        createdAt: c.createdAt,
        customer: this.formatCustomer(c.user),
      })),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getAdminCashCollection(id: string) {
    const collection = await this.prisma.cashCollection.findUnique({
      where: { id },
      include: {
        user: { select: this.customerSelect },
        walletCreditRequest: { include: { transaction: true } },
        planSelection: { select: { id: true, status: true, planType: true, paidAt: true } },
      },
    });

    if (!collection) {
      throw new NotFoundException({
        error: 'CASH_COLLECTION_NOT_FOUND',
        message: 'Cash collection not found',
      });
    }

    const result: any = {
      id: collection.id,
      amountPaise: collection.amountPaise,
      status: collection.status,
      purpose: collection.walletCreditRequestId ? 'WALLET_TOPUP' : 'PLAN_PAYMENT',
      collectedAt: collection.collectedAt,
      confirmedAt: collection.confirmedAt,
      confirmedByAdminId: collection.confirmedByAdminId,
      adminNote: collection.adminNote,
      createdAt: collection.createdAt,
      updatedAt: collection.updatedAt,
      customer: this.formatCustomer(collection.user),
    };

    if (collection.walletCreditRequest) {
      result.walletCredit = {
        id: collection.walletCreditRequest.id,
        status: collection.walletCreditRequest.status,
        amountPaise: collection.walletCreditRequest.amountPaise,
        completedAt: collection.walletCreditRequest.completedAt,
        transactionId: collection.walletCreditRequest.transaction?.id ?? null,
      };
    }

    if (collection.planSelection) {
      result.planSelection = {
        id: collection.planSelection.id,
        status: collection.planSelection.status,
        planType: collection.planSelection.planType,
        paidAt: collection.planSelection.paidAt,
      };
    }

    return result;
  }

  /**
   * Admin confirms the physical cash arrived, which credits the wallet.
   *
   * This is the operational gate for cash: nothing before it credits anything,
   * and WALLET_AUTO_CREDIT_ENABLED is irrelevant here because unverified
   * physical cash is never auto-credited. The confirming admin comes from
   * JWT.sub; `adminId` is not accepted from the body.
   *
   * Duplicate-safe: the conditional update means a second confirmation matches
   * no row and 409s without touching the wallet.
   */
  async confirmCashCollection(
    id: string,
    adminId: string,
    dto: ConfirmCashCollectionDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();

      const claimed = await tx.cashCollection.updateMany({
        where: {
          id,
          status: {
            in: [CashCollectionStatus.PENDING, CashCollectionStatus.COLLECTED],
          },
        },
        data: {
          status: CashCollectionStatus.CONFIRMED,
          collectedAt: now,
          confirmedAt: now,
          confirmedByAdminId: adminId,
          adminNote: dto.note ?? null,
        },
      });

      if (claimed.count === 0) {
        const existing = await tx.cashCollection.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException({
            error: 'CASH_COLLECTION_NOT_FOUND',
            message: 'Cash collection not found',
          });
        }
        throw new ConflictException({
          error: 'CASH_COLLECTION_ALREADY_PROCESSED',
          message: `Cash collection has already been ${existing.status.toLowerCase()}`,
        });
      }

      const collection = await tx.cashCollection.findUniqueOrThrow({
        where: { id },
      });

      // Route by purpose: wallet top-up vs plan payment.
      if (collection.walletCreditRequestId) {
        const credit = await this.walletService.creditConfirmedCashRequest(
          tx,
          collection.walletCreditRequestId,
          adminId,
        );

        this.logger.log(
          `Cash collection confirmed (wallet top-up) cashCollectionId=${collection.id} ` +
            `creditRequestId=${collection.walletCreditRequestId} ` +
            `userId=${collection.userId} amountPaise=${collection.amountPaise} ` +
            `adminId=${adminId}`,
        );

        return {
          success: true,
          message: 'Cash confirmed and wallet credited.',
          cashCollection: {
            id: collection.id,
            status: CashCollectionStatus.CONFIRMED,
            amountPaise: collection.amountPaise,
            confirmedAt: collection.confirmedAt,
          },
          walletCredit: credit.request,
        };
      }

      // Plan payment cash confirmation.
      if (collection.planSelectionId) {
        await this.plansService.confirmPlanAfterCashPayment(
          tx,
          collection.planSelectionId,
          { id: collection.id, amountPaise: collection.amountPaise },
        );

        this.logger.log(
          `Cash collection confirmed (plan payment) cashCollectionId=${collection.id} ` +
            `planSelectionId=${collection.planSelectionId} ` +
            `userId=${collection.userId} amountPaise=${collection.amountPaise} ` +
            `adminId=${adminId}`,
        );

        return {
          success: true,
          message: 'Cash confirmed and plan activated.',
          cashCollection: {
            id: collection.id,
            status: CashCollectionStatus.CONFIRMED,
            amountPaise: collection.amountPaise,
            confirmedAt: collection.confirmedAt,
          },
        };
      }

      throw new BadRequestException({
        error: 'CASH_COLLECTION_NO_PURPOSE',
        message: 'Cash collection has no linked purpose (neither wallet nor plan)',
      });
    });
  }

  /**
   * Admin cancels a cash collection: the cash was never received.
   *
   * No wallet credit and no refund obligation, so the linked credit request
   * moves to CANCELLED (not REJECTED) and the pending slot is released.
   */
  async cancelCashCollection(
    id: string,
    adminId: string,
    dto: RejectCashCollectionDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const cancelled = await tx.cashCollection.updateMany({
        where: {
          id,
          status: {
            in: [CashCollectionStatus.PENDING, CashCollectionStatus.COLLECTED],
          },
        },
        data: {
          status: CashCollectionStatus.CANCELLED,
          confirmedByAdminId: adminId,
          adminNote: dto.note,
        },
      });

      if (cancelled.count === 0) {
        const existing = await tx.cashCollection.findUnique({ where: { id } });
        if (!existing) {
          throw new NotFoundException({
            error: 'CASH_COLLECTION_NOT_FOUND',
            message: 'Cash collection not found',
          });
        }
        throw new ConflictException({
          error: 'CASH_COLLECTION_ALREADY_PROCESSED',
          message: `Cash collection has already been ${existing.status.toLowerCase()}`,
        });
      }

      const collection = await tx.cashCollection.findUniqueOrThrow({
        where: { id },
      });

      if (collection.walletCreditRequestId) {
        await this.walletService.cancelCreditRequest(
          tx,
          collection.walletCreditRequestId,
          dto.note,
        );
      }

      if (collection.planSelectionId) {
        await tx.planSelection.updateMany({
          where: { id: collection.planSelectionId, status: 'PENDING_PAYMENT' },
          data: { status: 'CANCELLED' },
        });
        await tx.planQuote.updateMany({
          where: {
            selections: { some: { id: collection.planSelectionId } },
            status: 'PENDING',
          },
          data: { status: 'CANCELLED' },
        });
      }

      this.logger.log(
        `Cash collection cancelled cashCollectionId=${collection.id} adminId=${adminId}`,
      );

      return {
        success: true,
        message: collection.planSelectionId
          ? 'Cash collection cancelled. Plan purchase cancelled.'
          : 'Cash collection cancelled. No wallet credit was made.',
        cashCollection: {
          id: collection.id,
          status: CashCollectionStatus.CANCELLED,
          amountPaise: collection.amountPaise,
          adminNote: collection.adminNote,
        },
      };
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  SHARED HELPERS
  // ══════════════════════════════════════════════════════════════════

  private readonly customerSelect = {
    id: true,
    mobile: true,
    email: true,
    customerProfile: { select: { firstName: true, lastName: true } },
  } as const;

  private customerSearchFilter(search: string): Prisma.UserWhereInput {
    return {
      OR: [
        { mobile: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
        {
          customerProfile: {
            OR: [
              { firstName: { contains: search, mode: 'insensitive' } },
              { lastName: { contains: search, mode: 'insensitive' } },
            ],
          },
        },
      ],
    };
  }

  private applyDateRange(
    where: { createdAt?: unknown },
    startDate?: string,
    endDate?: string,
  ): void {
    if (!startDate && !endDate) return;
    const range: { gte?: Date; lt?: Date } = {};
    if (startDate) range.gte = new Date(startDate);
    if (endDate) {
      // Inclusive end date: shift to the start of the following day.
      const end = new Date(endDate);
      end.setUTCDate(end.getUTCDate() + 1);
      range.lt = end;
    }
    where.createdAt = range;
  }

  private formatCustomer(
    user:
      | {
          id: string;
          mobile: string;
          email: string | null;
          customerProfile: { firstName: string; lastName: string } | null;
        }
      | null
      | undefined,
  ) {
    // Null-tolerant: a listing should degrade to a missing customer block
    // rather than 500 if a relation comes back unpopulated.
    if (!user) return null;
    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      name: user.customerProfile
        ? `${user.customerProfile.firstName} ${user.customerProfile.lastName}`
        : null,
    };
  }

  /**
   * Customer/admin-safe projection of a payment.
   *
   * Deliberately omits `idempotencyKey`, `requestHash` and the raw provider
   * payload, and there is no field anywhere in this object derived from
   * PAYU_SALT.
   */
  private formatCustomerPayment(payment: {
    id: string;
    transactionId: string;
    providerPaymentId: string | null;
    provider: string;
    purpose: string;
    paymentMethod: string;
    amountPaise: number;
    currency: string;
    status: string;
    failureCode: string | null;
    failureMessage: string | null;
    walletCreditRequestId: string | null;
    orderId: string | null;
    expiresAt: Date | null;
    completedAt: Date | null;
    refundedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: payment.id,
      transactionId: payment.transactionId,
      providerPaymentId: payment.providerPaymentId,
      provider: payment.provider,
      purpose: payment.purpose,
      paymentMethod: payment.paymentMethod,
      amountPaise: payment.amountPaise,
      currency: payment.currency,
      status: payment.status,
      failureCode: payment.failureCode,
      failureMessage: payment.failureMessage,
      walletCreditRequestId: payment.walletCreditRequestId,
      orderId: payment.orderId,
      expiresAt: payment.expiresAt,
      completedAt: payment.completedAt,
      refundedAt: payment.refundedAt,
      createdAt: payment.createdAt,
      updatedAt: payment.updatedAt,
    };
  }
}
