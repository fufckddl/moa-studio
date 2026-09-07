import { useEffect, useRef, useState, type FormEvent } from 'react';
import { authenticate, type User } from '../lib/auth';
import '../auth.css';
interface Props { user: User | null; onClose: () => void; onAuthenticated: (user: User) => Promise<void>; onLogout: () => Promise<void> }
export function AuthDialog({ user, onClose, onAuthenticated, onLogout }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  const [visible, setVisible] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); const previous = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { element?.close(); document.body.style.overflow = previous; }; }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const values = new FormData(event.currentTarget);
    const email = String(values.get('email') || '').trim();
    setBusy(true); setError('');
    try {
      const result = await authenticate(mode, { name: String(values.get('name') || '').trim(), email, password: String(values.get('password') || '') });
      if (result.confirmationRequired || !result.user) {
        setConfirmationEmail(email);
        setMode('login');
        return;
      }
      await onAuthenticated(result.user);
      onClose();
    }
    catch (failure) { setError(failure instanceof Error ? failure.message : '연결을 확인하고 다시 시도해 주세요.'); }
    finally { setBusy(false); }
  }
  async function signOut() { setBusy(true); setError(''); try { await onLogout(); onClose(); } catch (failure) { setError(failure instanceof Error ? failure.message : '로그아웃하지 못했어요.'); } finally { setBusy(false); } }
  return <dialog ref={dialog} className="auth-dialog" aria-labelledby="auth-title" onCancel={e => { e.preventDefault(); if (!busy) onClose(); }} onClick={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
    <div className="auth-layout"><aside className="auth-photo"><img src="/assets/cafe-latte.png" alt="햇살이 드는 카페의 라테" /><div><span>mo:a studio</span><p>당신의 이야기가<br />머무는 곳.</p></div></aside>
      <section className="auth-content"><button className="auth-close" disabled={busy} onClick={onClose} aria-label="계정 창 닫기">×</button><span className="auth-eyebrow">YOUR OWN LITTLE STUDIO</span>
        <h2 id="auth-title">{user ? `${user.name}님의 스튜디오` : mode === 'login' ? '다시 만나 반가워요.' : '우리의 이야기를 시작해요.'}</h2>
        <p className="auth-description">{user ? '차곡차곡 모은 콘텐츠를 계정에 보관하세요.' : '카페의 순간을 모으고, 나만의 콘텐츠를 이어가세요.'}</p>
        {user ? <div className="auth-account"><span>로그인한 계정</span><strong>{user.email}</strong><p>브랜드와 보관함은 이 서버의 계정에 저장됩니다.</p><button className="auth-submit" disabled={busy} onClick={signOut}>{busy ? '로그아웃 중…' : '로그아웃'}</button></div> : <>
          {confirmationEmail && <p className="auth-success" role="status">{confirmationEmail}로 확인 메일을 보냈어요. 메일의 확인 링크를 누른 뒤 로그인해 주세요.</p>}
          <div className="auth-tabs" role="group" aria-label="계정 메뉴"><button aria-pressed={mode === 'login'} disabled={busy} onClick={() => { setMode('login'); setError(''); }}>로그인</button><button aria-pressed={mode === 'signup'} disabled={busy} onClick={() => { setMode('signup'); setError(''); setConfirmationEmail(''); }}>회원가입</button></div>
          <form key={mode} onSubmit={submit}><fieldset disabled={busy}>{mode === 'signup' && <label>이름<input name="name" autoComplete="name" placeholder="어떻게 불러드릴까요?" required maxLength={40} /></label>}
            <label>이메일<input name="email" type="email" autoComplete="email" placeholder="hello@yourcafe.com" required maxLength={254} /></label>
            <label>비밀번호<div className="auth-password"><input name="password" type={visible ? 'text' : 'password'} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder={mode === 'signup' ? '10자 이상 입력해 주세요' : '비밀번호를 입력해 주세요'} required minLength={mode === 'signup' ? 10 : undefined} maxLength={128} /><button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? '비밀번호 숨기기' : '비밀번호 보기'}>{visible ? '숨기기' : '보기'}</button></div></label>
            <button className="auth-submit" type="submit">{busy ? '잠시만 기다려 주세요…' : mode === 'login' ? '내 스튜디오로 들어가기 ↗' : '계정 만들기 ↗'}</button></fieldset>
          </form><p className="auth-footnote">회원가입 없이도 스튜디오를 둘러볼 수 있어요.<br />생성·편집·저장·다운로드는 로그인 후 이용해 주세요.</p></>}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </section></div></dialog>;
}
