import { storageService } from './storageService';

const OTP_KEY = 'unisport_auth_otp_v1';

interface OtpSession {
  identifier: string;
  channel: 'email' | 'phone';
  otp: string;
  createdAt: number;
  expiresAt: number;
}

export const authOtpService = {
  sendOtp: (identifier: string, channel: 'email' | 'phone') => {
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const session: OtpSession = {
      identifier,
      channel,
      otp,
      createdAt: Date.now(),
      expiresAt: Date.now() + 2 * 60 * 1000
    };

    storageService.set(OTP_KEY, session);

    console.log(`[DEMO ${channel.toUpperCase()} OTP] Sent to ${identifier}: ${otp}`);
    return otp;
  },

  verifyOtp: (
    identifier: string,
    channel: 'email' | 'phone',
    enteredOtp: string
  ) => {
    const session = storageService.get<OtpSession | null>(OTP_KEY, null);

    if (!session) {
      throw new Error('No OTP session found. Please request OTP again.');
    }

    if (session.identifier !== identifier || session.channel !== channel) {
      throw new Error('OTP recipient mismatch. Please request OTP again.');
    }

    if (Date.now() > session.expiresAt) {
      storageService.remove(OTP_KEY);
      throw new Error('OTP expired. Please request a new one.');
    }

    if (session.otp !== enteredOtp.trim()) {
      throw new Error('Invalid OTP.');
    }

    return true;
  },

  clearOtp: () => {
    storageService.remove(OTP_KEY);
  }
};