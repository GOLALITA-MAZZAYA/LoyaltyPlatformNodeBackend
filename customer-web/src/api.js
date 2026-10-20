// Calls the LoyaltyPlatform Node backend only. In local dev, Vite proxies /v1 to localhost:4000.

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.title || `Request failed (${status})`);
    this.status = status;
    this.code = body?.code || 'network_error';
    this.messageAr = body?.messageAr;
    this.body = body || {};
  }

  text(isAr) {
    return (isAr && this.messageAr) || this.message;
  }
}

async function request(method, path, { body, token } = {}) {
  let res;
  try {
    res = await fetch(`/v1${path}`, {
      method,
      headers: {
        ...(body && { 'content-type': 'application/json' }),
        ...(token && { authorization: `Bearer ${token}` }),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, { code: 'network_error', title: 'No connection. Check your internet and try again.', messageAr: 'لا يوجد اتصال، تحقق من الإنترنت وحاول مجدداً' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const getJoinPage = (merchantCode, branchCode) =>
  request('GET', `/public/join/${encodeURIComponent(merchantCode)}/${encodeURIComponent(branchCode)}`);

export const sendOtp = (merchantCode, branchCode, phone, locale) =>
  request('POST', '/public/otp/send', { body: { merchantCode, branchCode, phone, locale } });

export const verifyOtp = (otpRequestId, code) => request('POST', '/public/otp/verify', { body: { otpRequestId, code } });

export const getMyCard = (token) => request('GET', '/public/me', { token });

export const getMyQrCode = (token) => request('POST', '/public/me/qr', { token });

export const completeProfile = (token, profile) => request('PUT', '/public/me', { token, body: profile });

// The card token lives in this browser only, one per merchant. Storage can be blocked
// (private mode), so every access is guarded and the page still works without it.
const key = (merchantCode) => `glp_member_${merchantCode}`;

export const savedToken = {
  get(merchantCode) {
    try {
      return localStorage.getItem(key(merchantCode));
    } catch {
      return null;
    }
  },
  set(merchantCode, token) {
    try {
      localStorage.setItem(key(merchantCode), token);
    } catch {
      /* not persisted; the customer verifies again next time */
    }
  },
  clear(merchantCode) {
    try {
      localStorage.removeItem(key(merchantCode));
    } catch {
      /* ignore */
    }
  },
};
