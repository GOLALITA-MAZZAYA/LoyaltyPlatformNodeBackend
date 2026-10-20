import { AppError } from '../lib/errors.js';

export interface SmsSender {
  /** true when the code is handed back to the caller instead of being texted (local testing only). */
  readonly returnsCode: boolean;
  sendOtp(phone: string, code: string, locale: 'en' | 'ar'): Promise<void>;
}

/** Local testing: nothing is sent; the route returns the code so the page can show it. */
export class DevSmsSender implements SmsSender {
  readonly returnsCode = true;
  async sendOtp() {}
}

/** Used until a real SMS provider is wired in: fails loudly instead of pretending a text was sent. */
export class UnconfiguredSmsSender implements SmsSender {
  readonly returnsCode = false;
  async sendOtp(): Promise<void> {
    throw new AppError(503, 'sms_not_configured', 'SMS delivery is not configured', {
      messageAr: 'خدمة الرسائل غير متاحة حالياً',
    });
  }
}
