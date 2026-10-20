import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { AppError } from '../../lib/errors.js';
import type { SmsSender } from '../../integrations/sms.js';

export const OTP_TTL_SECONDS = 5 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const RESEND_AFTER_SECONDS = 60;
const PHONE_LIMIT = { max: 3, windowMs: 15 * 60_000 };
const IP_LIMIT = { max: 10, windowMs: 60 * 60_000 };

const tooMany = (retryAfterSeconds: number) =>
  new AppError(429, 'rate_limited', 'Too many code requests, try again later', {
    messageAr: 'طلبات كثيرة، حاول لاحقاً',
    extra: { retryAfterSeconds },
  });

const otpError = (code: 'otp_invalid' | 'otp_expired' | 'otp_attempts_exceeded', attemptsRemaining?: number) => {
  const text: Record<typeof code, [string, string]> = {
    otp_invalid: ['The code is incorrect', 'الرمز غير صحيح'],
    otp_expired: ['The code has expired, request a new one', 'انتهت صلاحية الرمز، اطلب رمزاً جديداً'],
    otp_attempts_exceeded: ['Too many wrong codes, request a new one', 'محاولات كثيرة خاطئة، اطلب رمزاً جديداً'],
  };
  const [en, ar] = text[code];
  return new AppError(401, code, en, { messageAr: ar, ...(attemptsRemaining !== undefined && { extra: { attemptsRemaining } }) });
};

export interface VerifiedOtp {
  merchantId: string;
  branchId: string;
  phone: string;
}

export class OtpService {
  private readonly key: Buffer;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly sms: SmsSender,
    secret: string,
  ) {
    // Separate key from the JWT key, derived from the same secret.
    this.key = createHmac('sha256', secret).update('otp-v1').digest();
  }

  private hash(phone: string, code: string) {
    return createHmac('sha256', this.key).update(`${phone}:${code}`).digest('hex');
  }

  async send(input: { merchantId: string; branchId: string; phone: string; ip: string; locale: 'en' | 'ar' }) {
    const now = Date.now();
    const recent = await this.prisma.otpRequest.findMany({
      where: { phone: input.phone, createdAt: { gt: new Date(now - PHONE_LIMIT.windowMs) } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    const sinceLast = recent[0] ? (now - recent[0].createdAt.getTime()) / 1000 : Infinity;
    if (sinceLast < RESEND_AFTER_SECONDS) throw tooMany(Math.ceil(RESEND_AFTER_SECONDS - sinceLast));
    if (recent.length >= PHONE_LIMIT.max) {
      const oldest = recent[recent.length - 1]!.createdAt.getTime();
      throw tooMany(Math.ceil((oldest + PHONE_LIMIT.windowMs - now) / 1000));
    }
    const fromIp = await this.prisma.otpRequest.count({
      where: { ip: input.ip, createdAt: { gt: new Date(now - IP_LIMIT.windowMs) } },
    });
    if (fromIp >= IP_LIMIT.max) throw tooMany(IP_LIMIT.windowMs / 1000);

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const request = await this.prisma.otpRequest.create({
      data: {
        merchantId: input.merchantId,
        branchId: input.branchId,
        phone: input.phone,
        codeHash: this.hash(input.phone, code),
        expiresAt: new Date(now + OTP_TTL_SECONDS * 1000),
        ip: input.ip,
      },
    });

    try {
      await this.sms.sendOtp(input.phone, code, input.locale);
    } catch (err) {
      // Nothing was delivered, so don't let it count against the customer's limits.
      await this.prisma.otpRequest.delete({ where: { id: request.id } });
      throw err;
    }

    return {
      otpRequestId: request.id,
      resendAfterSeconds: RESEND_AFTER_SECONDS,
      expiresInSeconds: OTP_TTL_SECONDS,
      ...(this.sms.returnsCode && { devCode: code }),
    };
  }

  /** Single use: a verified code cannot be verified again. */
  async verify(otpRequestId: string, code: string): Promise<VerifiedOtp> {
    const request = await this.prisma.otpRequest.findUnique({ where: { id: otpRequestId } });
    if (!request || request.verifiedAt) throw otpError('otp_invalid');
    if (request.expiresAt.getTime() <= Date.now()) throw otpError('otp_expired');

    // Count the attempt before comparing, atomically, so parallel guesses can't exceed the limit.
    const counted = await this.prisma.otpRequest.updateMany({
      where: { id: request.id, verifiedAt: null, attempts: { lt: OTP_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) throw otpError('otp_attempts_exceeded');

    const expected = Buffer.from(request.codeHash, 'hex');
    const actual = Buffer.from(this.hash(request.phone, code), 'hex');
    if (!timingSafeEqual(expected, actual)) {
      const remaining = OTP_MAX_ATTEMPTS - (request.attempts + 1);
      throw remaining > 0 ? otpError('otp_invalid', remaining) : otpError('otp_attempts_exceeded');
    }

    const consumed = await this.prisma.otpRequest.updateMany({
      where: { id: request.id, verifiedAt: null },
      data: { verifiedAt: new Date() },
    });
    if (consumed.count === 0) throw otpError('otp_invalid');

    return { merchantId: request.merchantId, branchId: request.branchId, phone: request.phone };
  }
}
