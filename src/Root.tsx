import { lazy, Suspense } from 'react';
import { getPublicPage, notFoundPage } from './lib/publicPages';
import { PublicPage } from './views/PublicPage';
import { Landing } from './views/Landing';

const Studio = lazy(() => import('./App'));
const Recovery = lazy(() => import('./views/AuthDialog').then(module => ({ default: module.AuthRecovery })));

export default function Root() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const query = new URLSearchParams(location.search);
  if (path === '/auth/reset-password') return <Suspense fallback={<main><p role="status">계정 확인 중…</p></main>}><Recovery /></Suspense>;
  const needsStudio = /^\/studio(?:\/(?:library|brand))?$/.test(path) || location.hash.startsWith('#/studio') || query.has('payment') || query.has('plan') || query.has('account');
  if (needsStudio) return <Suspense fallback={<main className="public-page"><p role="status">스튜디오를 불러오는 중이에요…</p></main>}><Studio /></Suspense>;
  if (path === '/') return <Landing
    onStart={() => location.assign('/studio')}
    onLogin={() => location.assign('/studio?account=1')}
    onAccount={() => location.assign('/studio?account=1')}
    onCheckout={(plan, interval) => location.assign(`/studio?plan=${plan}&interval=${interval}`)}
  />;
  const page = getPublicPage(path);
  if (page) return <PublicPage page={page} />;
  return <PublicPage page={notFoundPage} />;
}
