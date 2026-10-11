import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface SendOtpSmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

@Injectable()
export class Fast2SmsService {
  private readonly logger = new Logger(Fast2SmsService.name);
  private readonly apiKey: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = this.configService.get<string>("FAST2SMS_OTP_API_KEY");
  }

  /**
   * Sends an OTP via Fast2SMS Bulk V2 API exclusively using the "otp" route.
   * Endpoint: POST https://www.fast2sms.com/dev/bulkV2
   */
  async sendOtp(phone: string, otp: string): Promise<SendOtpSmsResult> {
    const apiKey = this.apiKey || process.env.FAST2SMS_OTP_API_KEY;
    const cleanPhone = phone.replace(/\D/g, "").slice(-10);

    // Always log clean OTP banner to server console for developer convenience
    console.log(
      `\n========================================\n` +
        `[PuretyFarm Auth] 🥛 OTP DISPATCH\n` +
        `Recipient : ${cleanPhone} (${phone})\n` +
        `Code      : ${otp}\n` +
        `Provider  : Fast2SMS (POST https://www.fast2sms.com/dev/bulkV2)\n` +
        `Route     : OTP ("otp")\n` +
        `Expires   : 5 Minutes\n` +
        `========================================\n`,
    );

    if (!apiKey) {
      this.logger.warn(
        `FAST2SMS_OTP_API_KEY is not configured. Mobile=${phone} OTP=${otp}`,
      );
      return {
        success: true,
        messageId: "dev_mock_sent",
      };
    }

    try {
      const response = await fetch("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: {
          authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          route: "otp",
          variables_values: otp,
          numbers: cleanPhone,
        }),
        signal: AbortSignal.timeout(5000),
      });

      const data = await response.json().catch(() => null);

      if (response.ok && data && data.return === true) {
        this.logger.log(
          `[Fast2SMS OTP Route] Dispatched OTP to ${cleanPhone}. RequestId=${data.request_id || "sent"}`,
        );
        return {
          success: true,
          messageId: data.request_id || "fast2sms_sent",
        };
      }

      const errorMessage =
        data && Array.isArray(data.message)
          ? data.message.join(", ")
          : (data && data.message) || `Fast2SMS error HTTP ${response.status}`;

      this.logger.warn(
        `Fast2SMS OTP delivery failure for ${cleanPhone}: ${errorMessage}`,
      );
      return {
        success: false,
        error: errorMessage,
      };
    } catch (error: any) {
      this.logger.error(
        `Network error dispatching OTP to ${phone} via Fast2SMS`,
        error?.stack || error,
      );
      return {
        success: false,
        error: error?.message || "Network error contacting Fast2SMS",
      };
    }
  }
}
