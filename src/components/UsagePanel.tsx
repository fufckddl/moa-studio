import type { ApiStatus, Entitlements } from '../api';
import type { User } from '../lib/auth';
import { useEffect, useRef } from 'react';
import './UsagePanel.css';

interface Props {
  user: User | null;
  status: ApiStatus | null;
  entitlements: Entitlements;
  loading?: boolean;
  compact?: boolean;
  onRefresh: () => void;
}

export function UsagePanel({ user, status, entitlements, loading, compact, onRefresh }: Props) {
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  useEffect(() => {
    const update = () => { if (document.visibilityState === 'visible') refresh.current(); };
    const timer = window.setInterval(update, 15000);
    window.addEventListener('focus', update);
    window.addEventListener('online', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', update);
      window.removeEventListener('online', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  const aiEnabled = Boolean(user && entitlements.plan !== 'free' && entitlements.configured && status?.mode === 'live');
  const period = formatPeriod(entitlements.periodStart, entitlements.periodEnd);
  const summary = user
    ? `${planLabel(entitlements.plan)} 플랜, AI 생성 ${entitlements.aiUsed}/${entitlements.aiLimit}회 사용, 브랜드 ${entitlements.brandLimit}개까지`
    : '비로그인 둘러보기, 생성과 편집은 로그인 후 이용 가능';
  const compactText = !user ? '둘러보기 모드 · 로그인 후 생성·편집 가능' : aiEnabled
    ? `${planLabel(entitlements.plan)} · AI ${entitlements.aiRemaining}회 남음 · 브랜드 ${entitlements.brandLimit}개`
    : `템플릿 모드 · 브랜드 ${entitlements.brandLimit}개`;

  if (compact) {
    return (
      <aside className="usage-panel compact" aria-label="계정 사용량 요약" aria-busy={loading}>
        <span>{compactText}</span>
      </aside>
    );
  }

  return (
    <aside className="usage-panel" aria-label="계정 사용량 요약" aria-busy={loading}>
      <div>
        <span className="usage-kicker">ACCOUNT USAGE</span>
        <strong>{user ? planLabel(entitlements.plan) : '둘러보기'}</strong>
        <p>{!user ? '생성·편집·저장은 로그인 후 이용할 수 있어요.' : aiEnabled ? 'OpenAI 연결 상태에서 AI 생성이 차감됩니다.' : '현재 생성은 템플릿 모드로 처리됩니다.'}</p>
      </div>
      <dl aria-label={summary}>
        <div>
          <dt>AI 생성</dt>
          <dd>{entitlements.aiUsed} / {entitlements.aiLimit}</dd>
        </div>
        <div>
          <dt>남은 횟수</dt>
          <dd>{entitlements.aiRemaining}</dd>
        </div>
        <div>
          <dt>브랜드</dt>
          <dd>{entitlements.brandLimit}개</dd>
        </div>
      </dl>
      <div className="usage-foot">
        <span>{period}</span>
      </div>
    </aside>
  );
}

function planLabel(plan: Entitlements['plan']) {
  if (plan === 'plus') return '프로';
  if (plan === 'light') return '라이트';
  if (plan === 'studio') return '스탠다드';
  return '무료';
}

function formatPeriod(start: string | null, end: string | null) {
  if (!start && !end) return '만료일 없음';
  const formatter = new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' });
  if (start && end) return `${formatter.format(new Date(start))} - ${formatter.format(new Date(end))}`;
  if (end) return `${formatter.format(new Date(end))} 만료`;
  return start ? `${formatter.format(new Date(start))} 시작` : '만료일 없음';
}
