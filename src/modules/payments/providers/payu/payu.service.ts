import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PayuHashService } from './payu.hash.service';
import { PayuClient } from './payu.client';
import {
  PAYU_CHECKOUT_URL,
  PAYU_FAILURE_CALLBACK_PATH,
  PAYU_STATUS_FAILURE,
  PAYU_STATUS_IN_PROGRESS,
  PAYU_STATUS_PENDING,
  PAYU_STATUS_REFUNDED,
  PAYU_STATUS_SUCCESS,
  PAYU_SUCCESS_CALLBACK_PATH,
} from './payu.constants';
import { PayuCallbackPayload, PayuCheckoutFields } from './payu.types';
import {
  CreateProviderPaymentInput,
  IPaymentProvider,
  ProviderCheckoutInstruction,
  ProviderRefundResult,
  ProviderVerificationResult,
} from '../payment-provider.interface';
import {
  PaymentTransactionStatus,
  PROVIDER_RESPONSE_REDACTED_KEYS,
} from '../../payments.constants';

/**
 * Converts integer paise into the rupee-decimal string PayU expects.
 *
 * Done with integer arithmetic and string padding only — never via division
 * into a float — so 1 paise can never become 0.009999999999.
 */
export function paiseToRupeeString(amountPaise: number): string {
  if (!Number.isInteger(amountPaise) || amountPaise < 0) {
    throw new InternalServerErrorException('Invalid payment amount');
  }
  const rupees = Math.trunc(amountPaise / 100);
  const paise = amountPaise % 100;
  return `${rupees}.${String(paise).padStart(2, '0')}`;
}

/**
 * Parses a rupee-decimal string from PayU back into integer paise.
 *
 * Returns null for anything that is not a well-formed amount with at most two
 * decimal places, so a malformed or padded amount is rejected rather than
 * silently rounded. Parsing is string-based for the same reason as above.
 */
export function rupeeStringToPaise(amount: string): number | null {
  if (typeof amount !== 'string') return null;
  const trimmed = amount.trim();
  const match = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(trimmed);
  if (!match) return null;
  const rupees = Number(match[1]);
  const fraction = (match[2] ?? '').padEnd(2, '0');
  const paise = Number(fraction);
  if (!Number.isSafeInteger(rupees) || Number.isNaN(paise)) return null;
  return rupees * 100 + paise;
}

/**
 * PayU implementation of {@link IPaymentProvider}.
 *
 * Owns PayU-specific field names, status vocabulary and amount formatting.
 * All hashing is delegated to {@link PayuHashService}; all network I/O to
 * {@link PayuClient}. `PaymentsService` never sees anything in this file
 * except through the interface.
 */
@Injectable()
export class PayuService implements IPaymentProvider {
  private readonly logger = new Logger(PayuService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly hashService: PayuHashService,
    private readonly client: PayuClient,
  ) {}

  private getMerchantKey(): string {
    const key = this.configService.get<string>('PAYU_KEY');
    if (!key) {
      this.logger.error('PAYU_KEY is not configured');
      throw new InternalServerErrorException(
        'Payment provider is not configured',
      );
    }
    return key;
  }

  /**
   * Builds the `surl` / `furl` callback URLs from PUBLIC_API_BASE_URL so a
   * client can never point a payment result at a URL of its own choosing.
   */
  private buildCallbackUrl(path: string): string {
    const base = this.configService.get<string>('PUBLIC_API_BASE_URL');
    if (!base) {
      this.logger.error('PUBLIC_API_BASE_URL is not configured');
      throw new InternalServerErrorException(
        'Payment provider is not configured',
      );
    }
    return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
  }

  /**
   * Produces the Hosted Checkout form. No network call: PayU hosted checkout
   * is a signed browser form POST, so this is pure field assembly plus the
   * server-side request hash.
   *
   * The returned object contains the merchant key and hash, which are both
   * safe to expose. PAYU_SALT is not present anywhere in the result.
   */
  async createPayment(
    input: CreateProviderPaymentInput,
  ): Promise<ProviderCheckoutInstruction> {
    const key = this.getMerchantKey();
    const amount = paiseToRupeeString(input.amountPaise);

    // PayU rejects pipes in hashed fields because they would shift the hash
    // segments. Strip them rather than letting a hash mismatch happen later.
    const sanitise = (value: string): string =>
      value.replace(/\|/g, ' ').trim();

    const firstname = sanitise(input.customerFirstName);
    const productinfo = sanitise(input.productInfo);
    const email = sanitise(input.customerEmail);

    const hash = this.hashService.generateRequestHash({
      key,
      txnid: input.transactionId,
      amount,
      productinfo,
      firstname,
      email,
    });

    const fields: PayuCheckoutFields = {
      key,
      txnid: input.transactionId,
      amount,
      productinfo,
      firstname,
      email,
      phone: sanitise(input.customerPhone),
      surl: this.buildCallbackUrl(PAYU_SUCCESS_CALLBACK_PATH),
      furl: this.buildCallbackUrl(PAYU_FAILURE_CALLBACK_PATH),
      udf1: '',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: '',
      hash,
    };

    return {
      endpoint: PAYU_CHECKOUT_URL,
      method: 'POST',
      fields: { ...fields },
    };
  }

  /**
   * Verifies an untrusted PayU payload and normalises it.
   *
   * Returns `signatureValid: false` instead of throwing so callbacks, webhooks
   * and the verify endpoint all reject on one path. When the signature is
   * invalid NOTHING else in the result is trusted by callers.
   */
  async verifyPayment(
    payload: Record<string, unknown>,
  ): Promise<ProviderVerificationResult> {
    const typed = payload as PayuCallbackPayload;
    const signatureValid = this.hashService.verifyReverseHash(typed);

    const asString = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 ? value : null;

    const rawStatus = asString(typed.status);
    const amountPaise =
      typeof typed.amount === 'string'
        ? rupeeStringToPaise(typed.amount)
        : null;

    return {
      signatureValid,
      transactionId: asString(typed.txnid),
      providerPaymentId: asString(typed.mihpayid),
      amountPaise,
      status: this.mapStatus(rawStatus),
      rawStatus,
      failureCode: asString(typed.error) ?? asString(typed.error_code),
      failureMessage: asString(typed.error_Message) ?? asString(typed.field9),
      sanitisedPayload: this.sanitisePayload(payload),
    };
  }

  /**
   * Asks PayU to refund a settled payment.
   *
   * The refund token is derived from the merchant transaction id so repeated
   * refund attempts for the same payment are the same request to PayU rather
   * than two separate refunds.
   */
  async refundPayment(input: {
    transactionId: string;
    providerPaymentId: string;
    amountPaise: number;
    reason: string;
  }): Promise<ProviderRefundResult> {
    const result = await this.client.refund({
      providerPaymentId: input.providerPaymentId,
      refundToken: `RFND-${input.transactionId}`,
      amountRupees: paiseToRupeeString(input.amountPaise),
    });

    return {
      accepted: result.accepted,
      providerRefundId: result.requestId,
      message: result.message,
    };
  }

  /**
   * Server-to-server state check, used by the customer verify endpoint so the
   * authoritative status comes from PayU rather than from the browser.
   */
  async fetchAuthoritativeStatus(transactionId: string): Promise<{
    status: PaymentTransactionStatus | null;
    rawStatus: string | null;
    providerPaymentId: string | null;
    amountPaise: number | null;
  }> {
    const response = await this.client.verifyPayment(transactionId);

    // PayU nests the result under transaction_details[txnid].
    const details = response.transaction_details as
      Record<string, Record<string, unknown>> | undefined;
    const entry = details?.[transactionId];

    if (!entry) {
      return {
        status: null,
        rawStatus: null,
        providerPaymentId: null,
        amountPaise: null,
      };
    }

    const rawStatus = typeof entry.status === 'string' ? entry.status : null;
    const amountRaw = entry.amt ?? entry.amount;

    return {
      status: this.mapStatus(rawStatus),
      rawStatus,
      providerPaymentId:
        typeof entry.mihpayid === 'string' ? entry.mihpayid : null,
      amountPaise:
        typeof amountRaw === 'string'
          ? rupeeStringToPaise(amountRaw)
          : typeof amountRaw === 'number'
            ? rupeeStringToPaise(amountRaw.toFixed(2))
            : null,
    };
  }

  /**
   * Maps PayU's status vocabulary onto our lifecycle. An unrecognised status
   * maps to null so an unknown provider state is never optimistically read as
   * success.
   */
  private mapStatus(rawStatus: string | null): PaymentTransactionStatus | null {
    if (!rawStatus) return null;
    switch (rawStatus.trim().toLowerCase()) {
      case PAYU_STATUS_SUCCESS:
        return PaymentTransactionStatus.SUCCESS;
      case PAYU_STATUS_FAILURE:
        return PaymentTransactionStatus.FAILED;
      case PAYU_STATUS_PENDING:
      case PAYU_STATUS_IN_PROGRESS:
        return PaymentTransactionStatus.PROCESSING;
      case PAYU_STATUS_REFUNDED:
        return PaymentTransactionStatus.REFUNDED;
      default:
        return null;
    }
  }

  /**
   * Strips signing material and card data before the payload is persisted in
   * `Payment.providerResponse` or logged. Keys are matched case-insensitively.
   */
  private sanitisePayload(
    payload: Record<string, unknown>,
  ): Record<string, unknown> {
    const redacted = new Set(
      PROVIDER_RESPONSE_REDACTED_KEYS.map((key) => key.toLowerCase()),
    );
    const safe: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      if (redacted.has(key.toLowerCase())) continue;
      // Only primitive values are kept; nested objects from a forged payload
      // are not worth persisting and could be arbitrarily large.
      if (
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean' ||
        value === null
      ) {
        safe[key] = value;
      }
    }
    return safe;
  }
}
