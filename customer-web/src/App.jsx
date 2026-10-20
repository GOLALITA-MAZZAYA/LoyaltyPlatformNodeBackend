import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { CheckCircle2, ChevronRight, ArrowLeft, Gift, Sparkles, Percent, RotateCw, QrCode, ShieldCheck } from 'lucide-react';
import { ApiError, completeProfile, getJoinPage, getMyCard, getMyQrCode, savedToken, sendOtp, verifyOtp } from './api.js';

// URL shape printed on branch posters: /j/:merchantCode/:branchCode
const [, merchantCode = '', branchCode = ''] = window.location.pathname.split('/').filter(Boolean);

const t = (isAr, en, ar) => (isAr ? ar : en);

/** Optional cap on the free item's price: "300.00" → " (up to QAR 300)". Empty when no cap is set. */
function rewardCap(value, isAr) {
  const n = Number(value);
  if (!value || !Number.isFinite(n) || n <= 0) return '';
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return t(isAr, ` (up to QAR ${amount})`, ` (بحد أقصى ${amount} ر.ق)`);
}

export default function App() {
  const [lang, setLang] = useState('en');
  const isAr = lang === 'ar';

  // 'loading' | 'invalid' | 'phone' | 'otp' | 'profile' | 'card'
  const [step, setStep] = useState('loading');
  const [page, setPage] = useState(null);
  const [card, setCard] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const [phone, setPhone] = useState('');
  const [otp, setOtp] = useState({ id: null, devCode: null, resendAt: 0 });
  const [code, setCode] = useState('');
  const [pendingToken, setPendingToken] = useState(null);
  const [firstName, setFirstName] = useState('');
  const [consent, setConsent] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    document.documentElement.dir = isAr ? 'rtl' : 'ltr';
    document.documentElement.lang = lang;
  }, [isAr, lang]);

  // Ticks the resend countdown.
  useEffect(() => {
    if (step !== 'otp') return undefined;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [step]);

  const showCard = useCallback((data, celebrate) => {
    setCard(data);
    setStep('card');
    if (celebrate) confetti({ particleCount: 70, spread: 60, origin: { y: 0.7 }, colors: ['#8A1538', '#F59E0B', '#10B981'] });
  }, []);

  // Load the branch; if this browser already holds a card for this merchant, open it straight away.
  useEffect(() => {
    (async () => {
      try {
        setPage(await getJoinPage(merchantCode, branchCode));
      } catch (err) {
        setError(err instanceof ApiError ? err : null);
        setStep('invalid');
        return;
      }
      const token = savedToken.get(merchantCode);
      if (token) {
        try {
          showCard(await getMyCard(token), false);
          return;
        } catch (err) {
          if (err.status === 401 || err.status === 409) savedToken.clear(merchantCode);
        }
      }
      setStep('phone');
    })();
  }, [showCard]);

  const run = async (fn) => {
    setError(null);
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, { title: String(err) }));
    } finally {
      setBusy(false);
    }
  };

  const fullPhone = `+974${phone}`;

  const requestCode = () =>
    run(async () => {
      const res = await sendOtp(merchantCode, branchCode, fullPhone, lang);
      setOtp({ id: res.otpRequestId, devCode: res.devCode ?? null, resendAt: Date.now() + res.resendAfterSeconds * 1000 });
      setCode('');
      setNow(Date.now());
      setStep('otp');
    });

  const onPhoneSubmit = (e) => {
    e.preventDefault();
    if (!/^[3-7]\d{7}$/.test(phone)) {
      setError(new ApiError(422, { title: 'Enter your 8-digit Qatar mobile number', messageAr: 'أدخل رقم جوال قطري من 8 أرقام' }));
      return;
    }
    requestCode();
  };

  const onOtpSubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const res = await verifyOtp(otp.id, code);
      if (res.profileRequired) {
        setPendingToken(res.memberToken);
        setStep('profile');
        return;
      }
      savedToken.set(merchantCode, res.memberToken);
      showCard(await getMyCard(res.memberToken), false);
    });
  };

  const onProfileSubmit = (e) => {
    e.preventDefault();
    run(async () => {
      const res = await completeProfile(pendingToken, { firstName: firstName.trim(), consentAccepted: true });
      const { memberToken, memberTokenExpiresAt: _exp, ...cardData } = res;
      if (memberToken) savedToken.set(merchantCode, memberToken);
      setPendingToken(null);
      showCard(cardData, true);
    });
  };

  const signOut = () => {
    savedToken.clear(merchantCode);
    setCard(null);
    setPhone('');
    setCode('');
    setError(null);
    setStep('phone');
  };

  const baseTier = page?.tiers?.[0];
  const resendIn = Math.max(0, Math.ceil((otp.resendAt - now) / 1000));
  const branchName = page ? (isAr && page.branchNameAr) || page.branchName : '';

  return (
    <div className="app-container">
      <header className="top-nav">
        <div className="brand-badge">
          {page && (
            <>
              <div className="brand-avatar">{page.merchantName.charAt(0)}</div>
              <div>
                <div className="brand-title">{page.merchantName}</div>
                <div className="branch-subtitle">{branchName}</div>
              </div>
            </>
          )}
        </div>
        <button className="lang-btn" onClick={() => setLang(isAr ? 'en' : 'ar')}>
          {isAr ? 'English' : 'العربية'}
        </button>
      </header>

      {['phone', 'otp', 'profile'].includes(step) && (
        <section className="hero-banner">
          <span className="hero-tag">{t(isAr, 'Loyalty Program', 'برنامج الولاء')}</span>
          <h1 className="hero-heading">{t(isAr, `Join ${page.merchantName} Rewards`, `انضم إلى مكافآت ${page.merchantName}`)}</h1>
          <p className="hero-desc">{t(isAr, 'Verify your mobile number to get your digital loyalty card.', 'تحقق من رقم جوالك للحصول على بطاقة الولاء الرقمية.')}</p>
        </section>
      )}

      <main className="content-area">
        {step === 'loading' && <div className="form-card status-card">{t(isAr, 'Loading…', 'جارٍ التحميل…')}</div>}

        {step === 'invalid' && (
          <div className="form-card status-card">
            <h2 className="form-title">{t(isAr, 'This link isn’t working', 'هذا الرابط غير صالح')}</h2>
            <p className="form-subtitle">
              {error?.status === 0
                ? error.text(isAr)
                : t(isAr, 'Please scan the QR code at the shop counter again, or ask the staff for help.', 'يرجى مسح رمز QR عند الكاشير مرة أخرى أو طلب المساعدة من الموظفين.')}
            </p>
          </div>
        )}

        {step === 'phone' && (
          <>
            {baseTier && <Perks tier={baseTier} isAr={isAr} />}
            <form className="form-card" onSubmit={onPhoneSubmit}>
              <h2 className="form-title">{t(isAr, 'Enter your mobile number', 'أدخل رقم جوالك')}</h2>
              <p className="form-subtitle">
                {t(isAr, 'We’ll send a verification code. Already a member? Use the same number to open your card.', 'سنرسل لك رمز تحقق. عضو بالفعل؟ استخدم نفس الرقم لفتح بطاقتك.')}
              </p>
              <label className="input-label" htmlFor="phone">{t(isAr, 'Mobile number', 'رقم الجوال')}</label>
              <div className="phone-input-group" dir="ltr">
                <span className="country-select country-fixed">🇶🇦 +974</span>
                <input
                  id="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  className="text-input"
                  placeholder="5512 3456"
                  maxLength={8}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 8))}
                  autoFocus
                />
              </div>
              <ErrorBox error={error} isAr={isAr} />
              <button type="submit" className="btn-primary" disabled={busy}>
                {busy ? t(isAr, 'Sending…', 'جارٍ الإرسال…') : t(isAr, 'Send code', 'إرسال الرمز')}
                <ChevronRight size={18} />
              </button>
            </form>
          </>
        )}

        {step === 'otp' && (
          <form className="form-card" onSubmit={onOtpSubmit}>
            <button type="button" className="lang-btn back-btn" onClick={() => { setError(null); setStep('phone'); }}>
              <ArrowLeft size={14} />
              {t(isAr, 'Change number', 'تغيير الرقم')}
            </button>
            <h2 className="form-title">{t(isAr, 'Enter the code', 'أدخل الرمز')}</h2>
            <p className="form-subtitle">
              {t(isAr, 'We sent a 6-digit code to', 'أرسلنا رمزاً من 6 أرقام إلى')} <span dir="ltr">+974 {phone}</span>
            </p>
            {otp.devCode && (
              <div className="dev-hint">
                {t(isAr, 'Local test mode, no SMS is sent. Your code is', 'وضع الاختبار المحلي، لا يتم إرسال رسالة. رمزك هو')}{' '}
                <strong dir="ltr">{otp.devCode}</strong>
              </div>
            )}
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="text-input otp-input"
              dir="ltr"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-label={t(isAr, 'Verification code', 'رمز التحقق')}
              autoFocus
            />
            <ErrorBox error={error} isAr={isAr} />
            <button type="submit" className="btn-primary" disabled={busy || code.length !== 6}>
              {busy ? t(isAr, 'Checking…', 'جارٍ التحقق…') : t(isAr, 'Verify', 'تحقق')}
              <CheckCircle2 size={18} />
            </button>
            <button type="button" className="link-btn" disabled={busy || resendIn > 0} onClick={requestCode}>
              {resendIn > 0
                ? t(isAr, `Resend code in ${resendIn}s`, `إعادة الإرسال بعد ${resendIn} ث`)
                : t(isAr, 'Resend code', 'إعادة إرسال الرمز')}
            </button>
          </form>
        )}

        {step === 'profile' && (
          <form className="form-card" onSubmit={onProfileSubmit}>
            <h2 className="form-title">{t(isAr, 'Almost done', 'خطوة أخيرة')}</h2>
            <p className="form-subtitle">{t(isAr, 'Tell us your name to create your card.', 'أخبرنا باسمك لإنشاء بطاقتك.')}</p>
            <label className="input-label" htmlFor="firstName">{t(isAr, 'First name', 'الاسم الأول')}</label>
            <input
              id="firstName"
              type="text"
              autoComplete="given-name"
              className="text-input"
              maxLength={60}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              autoFocus
            />
            <label className="check-row">
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
              <span>
                {t(isAr, `I agree to join the ${page.merchantName} loyalty program and to its terms.`, `أوافق على الانضمام إلى برنامج ولاء ${page.merchantName} وعلى شروطه.`)}
              </span>
            </label>
            {(isAr ? page.termsAr : page.termsEn) && <p className="terms-text">{isAr ? page.termsAr : page.termsEn}</p>}
            <ErrorBox error={error} isAr={isAr} />
            <button type="submit" className="btn-primary" disabled={busy || !firstName.trim() || !consent}>
              {busy ? t(isAr, 'Creating…', 'جارٍ الإنشاء…') : t(isAr, 'Create my card', 'أنشئ بطاقتي')}
              <ChevronRight size={18} />
            </button>
          </form>
        )}

        {step === 'card' && card && <Card card={card} branchName={branchName} isAr={isAr} onSignOut={signOut} token={savedToken.get(merchantCode)} />}
      </main>

      <footer className="app-footer">
        Powered by <strong>Golalita Loyalty</strong>
      </footer>
    </div>
  );
}

function ErrorBox({ error, isAr }) {
  if (!error) return null;
  const wait = error.body?.retryAfterSeconds;
  return (
    <div className="error-box" role="alert">
      {error.text(isAr)}
      {wait ? ` (${Math.ceil(wait / 60)} ${t(isAr, 'min', 'د')})` : ''}
    </div>
  );
}

function Perks({ tier, isAr }) {
  const reward = isAr ? tier.punchRule.rewardDescriptionAr : tier.punchRule.rewardDescriptionEn;
  const cap = rewardCap(tier.punchRule.rewardMaxValue, isAr);
  const rows = [];
  if (tier.punchRule.enabled) {
    rows.push({
      icon: <Gift size={18} />,
      text: reward
        ? t(isAr, `Collect ${tier.punchRule.stampsRequired} stamps: ${reward}`, `اجمع ${tier.punchRule.stampsRequired} أختام: ${reward}`) + cap
        : t(isAr, `Collect ${tier.punchRule.stampsRequired} stamps to earn a reward`, `اجمع ${tier.punchRule.stampsRequired} أختام لتحصل على مكافأة`) + cap,
    });
  }
  if (tier.discountPercent > 0) {
    rows.push({ icon: <Percent size={18} />, text: t(isAr, `${tier.discountPercent}% member discount`, `خصم ${tier.discountPercent}% للأعضاء`) });
  }
  if (!rows.length) return null;
  return (
    <div className="perks-card">
      <div className="perks-title">{t(isAr, 'Member benefits', 'مزايا العضوية')}</div>
      {rows.map((r, i) => (
        <div className="perk-row" key={i}>
          <div className="perk-icon-wrap">{r.icon}</div>
          <div className="perk-text">{r.text}</div>
        </div>
      ))}
    </div>
  );
}


// docs/loyalty-scanner-spec.md: codes live 90 s; ask for a new one every 60 s while the page is visible.
const QR_REFRESH_MS = 60_000;
const QR_LIFETIME_MS = 90_000;
const QR_RETRY_MS = 10_000;

function CustomerPassQr({ token, isAr }) {
  const [qr, setQr] = useState(null); // { code, qrDataUrl, receivedAt, expiresAtLocal }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const inFlight = useRef(false);
  const lastAttemptAt = useRef(0);

  const fetchQr = useCallback(async () => {
    if (!token || inFlight.current || document.visibilityState !== 'visible') return;
    inFlight.current = true;
    lastAttemptAt.current = Date.now();
    setLoading(true);
    try {
      const data = await getMyQrCode(token);
      const receivedAt = Date.now();
      // Trust the server's lifetime, but not a phone clock that is far off.
      const ttl = Date.parse(data.expiresAt) - receivedAt;
      const lifetime = ttl > 0 && ttl <= QR_LIFETIME_MS ? ttl : QR_LIFETIME_MS;
      setQr({ code: data.code, qrDataUrl: data.qrDataUrl, receivedAt, expiresAtLocal: receivedAt + lifetime });
      setError(null);
    } catch (err) {
      // Keep showing the current code (if any) until it expires; the next tick retries.
      setError(err instanceof ApiError ? err : new ApiError(0, { title: err?.message }));
    } finally {
      inFlight.current = false;
      setLoading(false);
      setNow(Date.now());
    }
  }, [token]);

  useEffect(() => {
    fetchQr();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchQr();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [fetchQr]);

  useEffect(() => {
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      if (document.visibilityState !== 'visible') return; // hidden pages stop requesting
      if (at - lastAttemptAt.current < QR_RETRY_MS) return;
      const due = !qr || at - qr.receivedAt >= QR_REFRESH_MS;
      // A revoked or blocked card (401) needs the customer to sign in again; don't keep retrying.
      if (due && error?.status !== 401) fetchQr();
    }, 1000);
    return () => clearInterval(timer);
  }, [fetchQr, qr, error]);

  const expired = qr && now >= qr.expiresAtLocal;
  const secondsLeft = qr ? Math.max(0, Math.ceil((qr.expiresAtLocal - now) / 1000)) : null;

  return (
    <div className="customer-qr-card">
      <div className="customer-qr-header">
        <div className="customer-qr-title">
          <QrCode size={18} />
          <span>{t(isAr, 'Your card QR', 'رمز بطاقتك')}</span>
        </div>
        <button
          type="button"
          className="qr-refresh-btn"
          onClick={fetchQr}
          disabled={loading}
          aria-label={t(isAr, 'Refresh QR code', 'تحديث الرمز')}
        >
          <RotateCw size={13} className={loading ? 'spinning' : ''} />
          <span>{t(isAr, 'Refresh', 'تحديث')}</span>
        </button>
      </div>

      <div className="customer-qr-box">
        {qr ? (
          <div className={`qr-image-wrapper${expired ? ' qr-expired' : ''}`}>
            <img src={qr.qrDataUrl} alt={t(isAr, 'Your card QR code', 'رمز بطاقتك')} className="qr-img" />
            {expired ? (
              <div className="qr-expired-label">{t(isAr, 'Code expired. Getting a new one…', 'انتهت صلاحية الرمز، جارٍ إنشاء رمز جديد…')}</div>
            ) : (
              <div className="qr-scan-badge">
                <ShieldCheck size={14} color="#10B981" />
                <span>{t(isAr, `Valid for ${secondsLeft}s`, `صالح لمدة ${secondsLeft} ث`)}</span>
              </div>
            )}
          </div>
        ) : error ? (
          <div className="qr-error-box">
            <p className="qr-error-text">{error.text(isAr)}</p>
            <button type="button" className="qr-retry-btn" onClick={fetchQr} disabled={loading}>
              {t(isAr, 'Try again', 'إعادة المحاولة')}
            </button>
          </div>
        ) : (
          <div className="qr-loading-box">
            <RotateCw size={28} className="spinning qr-muted" />
          </div>
        )}
      </div>

      {qr && error && <p className="qr-error-text">{error.text(isAr)}</p>}

      <p className="customer-qr-instruction">
        {t(
          isAr,
          'Show this QR to the cashier to collect your stamps. It changes every minute and works once.',
          'أظهر هذا الرمز للكاشير لجمع أختامك. يتغير كل دقيقة ويُستخدم مرة واحدة.'
        )}
      </p>
    </div>
  );
}

function Card({ card, branchName, isAr, onSignOut, token }) {
  const tierName = isAr ? card.tier.nameAr : card.tier.nameEn;
  const reward = isAr ? card.rewardDescAr : card.rewardDescEn;
  const cap = rewardCap(card.rewardMaxValue, isAr);
  return (
    <>
      <div className="card-welcome">
        <h2>{t(isAr, `Welcome, ${card.firstName}!`, `أهلاً بك، ${card.firstName}!`)}</h2>
      </div>

      <div className="digital-pass" style={{ background: card.design.backgroundColor }}>
        <div className="pass-header">
          <div>
            <div className="pass-merchant">{card.merchantName}</div>
            <div className="pass-holder">{card.firstName}{branchName ? ` · ${branchName}` : ''}</div>
          </div>
          <div className="tier-badge">{tierName}</div>
        </div>

        {card.punchEnabled && (
          <>
            <div className="pass-row">
              <span>{t(isAr, 'Stamp card', 'بطاقة الأختام')}</span>
              <span>
                <strong>{card.stamps}</strong> / {card.stampsRequired}
              </span>
            </div>
            <div className="stamp-grid">
              {Array.from({ length: card.stampsRequired }, (_, i) => {
                const stamped = i < card.stamps;
                const isReward = i === card.stampsRequired - 1;
                return (
                  <div key={i} className={`stamp-slot ${stamped ? 'stamped' : isReward ? 'reward' : 'empty'}`}>
                    {stamped ? <CheckCircle2 size={22} /> : isReward ? <Gift size={20} /> : <span>{i + 1}</span>}
                  </div>
                );
              })}
            </div>
            {card.rewardAvailable && (
              <div className="pass-row reward-ready">
                <Sparkles size={16} /> {t(isAr, 'Reward ready! Ask at the counter.', 'مكافأتك جاهزة! اطلبها من الكاشير.')}
              </div>
            )}
            {reward && (
              <div className="pass-note">
                {t(isAr, 'Reward:', 'المكافأة:')} {reward}
                {cap}
              </div>
            )}
          </>
        )}

        <div className="pass-row">
          <span>{card.pointsName}</span>
          <strong>{card.points}</strong>
        </div>
        {card.tier.discountPercent > 0 && (
          <div className="pass-note">{t(isAr, `${card.tier.discountPercent}% member discount`, `خصم ${card.tier.discountPercent}% للأعضاء`)}</div>
        )}
      </div>

      <CustomerPassQr token={token} isAr={isAr} />

      <button type="button" className="link-btn" onClick={onSignOut}>
        {t(isAr, 'Not you? Use another number', 'لست أنت؟ استخدم رقماً آخر')}
      </button>
    </>
  );
}
