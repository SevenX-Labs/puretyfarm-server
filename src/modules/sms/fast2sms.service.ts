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
   * Sends an OTP via Fast2SMS Bulk V2 OTP API.
   * Method: POST https://www.fast2sms.com/dev/bulkV2
   */
  async sendOtp(phone: string, otp: string): Promise<SendOtpSmsResult> {
    const apiKey = this.apiKey || process.env.FAST2SMS_OTP_API_KEY;

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
      // 10-digit Indian mobile number
      const cleanPhone = phone.replace(/\D/g, "").slice(-10);

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
      });

      const data = await response.json().catch(() => null);

      if (!response.ok || (data && data.return === false)) {
        const errorMsg =
          data && Array.isArray(data.message)
            ? data.message.join(", ")
            : (data && data.message) || `Fast2SMS error HTTP ${response.status}`;
        this.logger.error(
          `Fast2SMS OTP delivery failed for ${cleanPhone}: ${errorMsg}`,
        );
        return {
          success: false,
          error: errorMsg,
        };
      }

      this.logger.log(
        `Fast2SMS OTP dispatched successfully to ${cleanPhone}. RequestId=${data?.request_id || "unknown"}`,
      );
      return {
        success: true,
        messageId: data?.request_id || "fast2sms_sent",
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
