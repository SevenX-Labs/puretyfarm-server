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
   * Sends an OTP via Nexus OTP API:
   * Endpoint: POST https://apinexusotp.vercel.app/api/v1/otp/send
   * Header: Authorization: Bearer <FAST2SMS_OTP_API_KEY>
   * Body: { "phone": cleanPhone, "otp": otp }
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
        `Provider  : Nexus OTP (POST https://apinexusotp.vercel.app/api/v1/otp/send)\n` +
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

    const authHeader = apiKey.startsWith("Bearer ") ? apiKey : `Bearer ${apiKey}`;

    try {
      const response = await fetch("https://apinexusotp.vercel.app/api/v1/otp/send", {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          phone: cleanPhone,
          otp,
        }),
        signal: AbortSignal.timeout(5000),
      });

      const data = await response.json().catch(() => null);

      if (response.ok && data && (data.success === true || data.return === true)) {
        this.logger.log(
          `[Nexus OTP] Dispatched OTP to ${cleanPhone}. RequestId=${data.request_id || data.messageId || "sent"}`,
        );
        return {
          success: true,
          messageId: data.request_id || data.messageId || "nexus_otp_sent",
        };
      }

      const errorMessage =
        (data && data.message) ||
        (data && Array.isArray(data.error) ? data.error.join(", ") : data?.error) ||
        `Nexus OTP error HTTP ${response.status}`;

      this.logger.warn(
        `Nexus OTP delivery failure for ${cleanPhone}: ${errorMessage}`,
      );
      return {
        success: false,
        error: errorMessage,
      };
    } catch (error: any) {
      this.logger.error(
        `Network error dispatching OTP to ${phone} via Nexus OTP`,
        error?.stack || error,
      );
      return {
        success: false,
        error: error?.message || "Network error contacting Nexus OTP service",
      };
    }
  }
}
