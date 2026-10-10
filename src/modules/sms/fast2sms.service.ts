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
   * Sends an OTP via Fast2SMS Bulk V2 API and mirrors it to the server console.
   * Supports Quick SMS route ("q") for instant delivery and OTP route ("otp").
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
      `Route     : Quick SMS ("q") / OTP\n` +
      `Expires   : 5 Minutes\n` +
      `========================================\n`
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

    // Try Quick SMS route ("q") first for instant live delivery without domain verification blocks
    try {
      const quickResponse = await fetch("https://www.fast2sms.com/dev/bulkV2", {
        method: "POST",
        headers: {
          authorization: apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          route: "q",
          message: `Your Purety Farm verification code is ${otp}. Valid for 5 minutes.`,
          numbers: cleanPhone,
        }),
      });

      const quickData = await quickResponse.json().catch(() => null);

      if (quickResponse.ok && quickData && quickData.return === true) {
        this.logger.log(
          `[Fast2SMS Quick SMS] Dispatched OTP to ${cleanPhone}. RequestId=${quickData.request_id || "sent"}`,
        );
        return {
          success: true,
          messageId: quickData.request_id || "fast2sms_sent",
        };
      }

      // If Quick SMS returned an error or non-200, try the OTP route as secondary
      const quickError =
        quickData && Array.isArray(quickData.message)
          ? quickData.message.join(", ")
          : (quickData && quickData.message) || `HTTP ${quickResponse.status}`;

      this.logger.warn(
        `Fast2SMS Quick SMS returned notice (${quickError}), trying OTP route...`,
      );

      const otpResponse = await fetch("https://www.fast2sms.com/dev/bulkV2", {
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
      });

      const otpData = await otpResponse.json().catch(() => null);

      if (otpResponse.ok && otpData && otpData.return === true) {
        this.logger.log(
          `[Fast2SMS OTP Route] Dispatched OTP to ${cleanPhone}. RequestId=${otpData.request_id || "sent"}`,
        );
        return {
          success: true,
          messageId: otpData.request_id || "fast2sms_sent",
        };
      }

      const otpError =
        otpData && Array.isArray(otpData.message)
          ? otpData.message.join(", ")
          : (otpData && otpData.message) || `Fast2SMS error HTTP ${otpResponse.status}`;

      this.logger.warn(`Fast2SMS OTP delivery notice for ${cleanPhone}: ${otpError}`);
      return {
        success: false,
        error: otpError,
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
