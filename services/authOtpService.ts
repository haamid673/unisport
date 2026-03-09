import { storageService } from './storageService';

const OTP_STORAGE_KEY = 'unisport_auth_otp_session_v1';

type OtpChannel = 'email' | 'phone';

interface OtpSession {
  identifier: string;
  channel: OtpChannel;
  otp: string;
  createdAt: number;
  expiresAt: number;
}

export const authOtpService = {
  sendOtp: (identifier: string, channel: OtpChannel): string => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const session: OtpSession = {
      identifier,
      channel,
      otp,
      createdAt: Date.now(),
      expiresAt: Date.now() + 2 * 60 * 1000 // 2 minutes
    };

    storageService.set(OTP_STORAGE_KEY, session);

    console.log(`
${channel === 'email' ? '📧' : '📱'} DEMO OTP SENT
Channel: ${channel.toUpperCase()}
Recipient: ${identifier}
OTP: ${otp}
Expires in: 2 minutes
    `);

    return otp;
  },

  verifyOtp: (
    identifier: string,
    channel: OtpChannel,
    enteredOtp: string
  ): { success: boolean; message: string } => {
    const session = storageService.get<OtpSession | null>(OTP_STORAGE_KEY, null);

    if (!session) {
      return { success: false, message: 'No OTP session found. Please resend OTP.' };
    }

    if (session.identifier !== identifier || session.channel !== channel) {
      return { success: false, message: 'OTP recipient mismatch. Please resend OTP.' };
    }

    if (Date.now() > session.expiresAt) {
      storageService.remove(OTP_STORAGE_KEY);
      return { success: false, message: 'OTP expired. Please resend OTP.' };
    }

    if (session.otp !== enteredOtp.trim()) {
      return { success: false, message: 'Invalid OTP.' };
    }

    storageService.remove(OTP_STORAGE_KEY);
    return { success: true, message: 'OTP verified successfully.' };
  },

  clearOtpSession: () => {
    storageService.remove(OTP_STORAGE_KEY);
  },

  getRemainingSeconds: (): number => {
    const session = storageService.get<OtpSession | null>(OTP_STORAGE_KEY, null);
    if (!session) return 0;

    const remaining = Math.max(0, Math.floor((session.expiresAt - Date.now()) / 1000));
    return remaining;
  }
};