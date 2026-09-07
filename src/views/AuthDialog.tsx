import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Turnstile } from '../components/Turnstile';
import { authenticate, deleteAccount, eraseAccountData, getTurnstileSiteKey, isTurnstileEnabled, sendPasswordReset, updatePassword, type User } from '../lib/auth';
import '../auth.css';

const ERASE_CONFIRMATION = '작업물 삭제';
const DELETE_CONFIRMATION = '계정 삭제';
const turnstileSiteKey = getTurnstileSiteKey();
const turnstileRequired = isTurnstileEnabled();

interface Props {
  user: User | null;
  onClose: () => void;
  onAuthenticated: (user: User) => Promise<void>;
  onLogout: () => Promise<void>;
  onAccountDeleted?: () => Promise<void> | void;
  onAccountDataErased?: () => Promise<void> | void;
}
export function AuthDialog({ user, onClose, onAuthenticated, onLogout, onAccountDeleted, onAccountDataErased }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'login' | 'signup' | 'reset'>('login');
  const [accountAction, setAccountAction] = useState<'none' | 'erase' | 'delete'>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [visible, setVisible] = useState(false);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  useEffect(() => { const element = dialog.current; element?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { element?.close(); document.body.style.overflow = previous; }; }, []);
  const expireCaptcha = useCallback(() => setCaptchaToken(''), []);
  const resetCaptcha = useCallback(() => { setCaptchaToken(''); setCaptchaResetKey(value => value + 1); }, []);
  const captchaError = useCallback(() => setError('보안 확인을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'), []);
  const renderCaptcha = () => turnstileRequired && <Turnstile siteKey={turnstileSiteKey} onVerify={setCaptchaToken} onExpire={expireCaptcha} onError={captchaError} resetKey={captchaResetKey} />;
  function requireCaptcha() {
    if (!turnstileRequired) return true;
    if (!turnstileSiteKey) {
      setError('보안 확인 설정이 필요해요. 관리자에게 문의해 주세요.');
      return false;
    }
    if (!captchaToken) {
      setError('보안 확인을 완료해 주세요.');
      return false;
    }
    return true;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const values = new FormData(event.currentTarget);
    const email = String(values.get('email') || '').trim();
    setError(''); setSuccess('');
    if (!requireCaptcha()) return;
    setBusy(true);
    try {
      if (mode === 'reset') {
        await sendPasswordReset(email, captchaToken || undefined);
        setSuccess('계정이 있으면 비밀번호 재설정 메일이 도착해요. 메일의 링크를 열어 새 비밀번호를 입력해 주세요.');
        setMode('login');
        return;
      }
      const result = await authenticate(mode, { name: String(values.get('name') || '').trim(), email, password: String(values.get('password') || ''), captchaToken: captchaToken || undefined });
      if (result.confirmationRequired || !result.user) {
        setConfirmationEmail(email);
        setMode('login');
        return;
      }
      await onAuthenticated(result.user);
      onClose();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '연결을 확인하고 다시 시도해 주세요.'); }
    finally { setBusy(false); resetCaptcha(); }
  }
  async function signOut() { setBusy(true); setError(''); try { await onLogout(); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : '로그아웃하지 못했어요.'); } finally { setBusy(false); } }
  async function submitAccountAction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || accountAction === 'none') return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    const confirmation = String(values.get('confirmation') || '').trim();
    setError(''); setSuccess('');
    if (!requireCaptcha()) return;
    setBusy(true);
    try {
      if (accountAction === 'erase') {
        await eraseAccountData({ password, confirmation, captchaToken: captchaToken || undefined });
        await onAccountDataErased?.();
        setSuccess('계정의 작업물, 사진, 대화, 인물 데이터를 삭제했어요. 결제 기록은 법적 보관 목적에 맞게 분리 보관됩니다.');
        setAccountAction('none');
        return;
      }
      await deleteAccount({ password, confirmation, captchaToken: captchaToken || undefined });
      await onAccountDeleted?.();
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '계정 요청을 처리하지 못했어요.');
    } finally {
      setBusy(false);
      resetCaptcha();
    }
  }
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="auth-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="auth-layout"><aside className="auth-photo"><img src="/assets/cafe-latte.webp" alt="햇살이 드는 카페의 라테" /><div><span>mo:a studio</span><p>당신의 이야기가<br />머무는 곳.</p></div></aside>
      <section className="auth-content"><button className="auth-close" disabled={busy} onClick={onClose} aria-label="계정 창 닫기">×</button><span className="auth-eyebrow">YOUR OWN LITTLE STUDIO</span>
        <h2 id="auth-title">{user ? `${user.name}님의 스튜디오` : mode === 'reset' ? '비밀번호를 다시 설정해요.' : mode === 'login' ? '다시 만나 반가워요.' : '우리의 이야기를 시작해요.'}</h2>
        <p className="auth-description">{user ? '차곡차곡 모은 콘텐츠를 계정에 보관하세요.' : '카페의 순간을 모으고, 나만의 콘텐츠를 이어가세요.'}</p>
        {user ? <div className="auth-account"><span>로그인한 계정</span><strong>{user.email}</strong><p>브랜드와 보관함은 이 서버의 계정에 저장됩니다.</p><button className="auth-submit" disabled={busy} onClick={signOut}>{busy ? '로그아웃 중…' : '로그아웃'}</button>
          <div className="auth-danger-zone">
            <h3>계정 데이터 관리</h3>
            <p>작업물 삭제는 계정은 남기고 보관함, 사진, 사진 대화, 인물 데이터를 지웁니다. 계정 삭제는 로그인 계정까지 닫습니다. 결제 기록은 법적 보관 목적에 맞게 제한된 기록으로 분리됩니다.</p>
            <div className="auth-danger-actions"><button type="button" disabled={busy} onClick={() => { setAccountAction('erase'); setError(''); setSuccess(''); }}>작업물 삭제</button><button type="button" disabled={busy} onClick={() => { setAccountAction('delete'); setError(''); setSuccess(''); }}>계정 삭제</button></div>
            {accountAction !== 'none' && <form className="auth-danger-form" onSubmit={submitAccountAction}><fieldset disabled={busy}>
              <p>{accountAction === 'erase' ? `계정 작업물을 삭제하려면 "${ERASE_CONFIRMATION}"를 입력해 주세요.` : `계정을 완전히 삭제하려면 "${DELETE_CONFIRMATION}"를 입력해 주세요.`}</p>
              <label>비밀번호<input name="password" type="password" autoComplete="current-password" required minLength={1} maxLength={128} /></label>
              <label>확인 문구<input name="confirmation" autoComplete="off" required pattern={accountAction === 'erase' ? ERASE_CONFIRMATION : DELETE_CONFIRMATION} /></label>
              {renderCaptcha()}
              <div className="auth-danger-actions"><button type="button" disabled={busy} onClick={() => setAccountAction('none')}>취소</button><button type="submit" disabled={busy}>{busy ? '처리 중…' : accountAction === 'erase' ? '작업물 삭제' : '계정 삭제'}</button></div>
            </fieldset></form>}
          </div>
        </div> : <>
          {confirmationEmail && <p className="auth-success" role="status">{confirmationEmail}로 확인 메일을 보냈어요. 메일의 확인 링크를 누른 뒤 로그인해 주세요.</p>}
          {success && <p className="auth-success" role="status">{success}</p>}
          <div className="auth-tabs" role="group" aria-label="계정 메뉴"><button aria-pressed={mode === 'login'} disabled={busy} onClick={() => { setMode('login'); setError(''); }}>로그인</button><button aria-pressed={mode === 'signup'} disabled={busy} onClick={() => { setMode('signup'); setError(''); setConfirmationEmail(''); }}>회원가입</button></div>
          <form key={mode} onSubmit={submit}><fieldset disabled={busy}>{mode === 'signup' && <label>이름<input name="name" autoComplete="name" placeholder="어떻게 불러드릴까요?" required maxLength={40} /></label>}
            <label>이메일<input name="email" type="email" autoComplete="email" placeholder="hello@yourcafe.com" required maxLength={254} /></label>
            {mode !== 'reset' && <label>비밀번호<div className="auth-password"><input name="password" type={visible ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'signup' ? '10자 이상 입력해 주세요' : '비밀번호를 입력해 주세요'} required minLength={mode === 'signup' ? 10 : undefined} maxLength={128} /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '비밀번호 숨기기' : '비밀번호 보기'}>{visible ? '숨기기' : '보기'}</button></div></label>}
            {renderCaptcha()}
            <button className="auth-submit" type="submit">{busy ? '잠시만 기다려 주세요…' : mode === 'reset' ? '재설정 메일 받기' : mode === 'login' ? '내 스튜디오로 들어가기 ↗' : '계정 만들기 ↗'}</button></fieldset>
          </form><p className="auth-footnote">{mode === 'reset' ? '입력한 이메일의 가입 여부는 표시하지 않아요.' : '회원가입 없이도 스튜디오를 둘러볼 수 있어요.'}<br />{mode === 'login' ? <button className="auth-link-button" disabled={busy} onClick={() => { setMode('reset'); setError(''); setSuccess(''); resetCaptcha(); }}>비밀번호를 잊으셨나요?</button> : <button className="auth-link-button" disabled={busy} onClick={() => { setMode('login'); setError(''); resetCaptcha(); }}>로그인으로 돌아가기</button>}</p></>}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </section></div></dialog>;
}

export function AuthRecovery({ onComplete }: { onComplete?: (user: User) => Promise<void> | void }) {
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const values = new FormData(event.currentTarget);
    const password = String(values.get('password') || '');
    setBusy(true); setError(''); setSuccess('');
    try {
      const user = await updatePassword(password);
      await onComplete?.(user);
      setSuccess('비밀번호를 변경했어요. 이제 새 비밀번호로 로그인할 수 있어요.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '비밀번호를 바꾸지 못했어요.');
    } finally {
      setBusy(false);
    }
  }
  return <main className="auth-recovery"><section className="auth-recovery-panel" aria-labelledby="auth-recovery-title"><span className="auth-eyebrow">ACCOUNT RECOVERY</span><h1 id="auth-recovery-title">새 비밀번호 설정</h1><form onSubmit={submit}><fieldset disabled={busy}><label>새 비밀번호<div className="auth-password"><input name="password" type={visible ? 'text' : 'password'} autoComplete="new-password" required minLength={10} maxLength={128} placeholder="10자 이상 입력해 주세요" /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '비밀번호 숨기기' : '비밀번호 보기'}>{visible ? '숨기기' : '보기'}</button></div></label><button className="auth-submit" type="submit">{busy ? '변경 중…' : '비밀번호 변경'}</button></fieldset></form>{success && <><p className="auth-success" role="status">{success}</p><button type="button" onClick={() => { window.location.href = '/studio'; }}>스튜디오로 이동</button></>}{error && <p className="auth-error" role="alert">{error}</p>}</section></main>;
}
