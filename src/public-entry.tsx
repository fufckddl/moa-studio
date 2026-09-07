import ReactDOMServer from 'react-dom/server';
import { Landing } from './views/Landing';
import { PublicPage } from './views/PublicPage';
import { canonicalUrl, getPublicPage, normalizePublicPath, notFoundPage } from './lib/publicPages';
import './styles.css';
import './studio.css';

export { appShellRoutes, publicRoutes } from './lib/publicPages';

export interface PublicRenderResult {
  status: 200 | 404;
  title: string;
  description: string;
  canonical: string;
  html: string;
  noindex?: boolean;
}

const landingDescription = '카페의 사진과 이야기를 카드뉴스, 게시글, 일주일의 콘텐츠로. 모아 스튜디오.';

export function renderPublicPath(path: string): PublicRenderResult {
  const normalized = normalizePublicPath(path);
  if (normalized === '/') return renderLanding('/');
  const page = normalized ? getPublicPage(normalized) : null;
  if (page) {
    return {
      status: 200,
      title: page.title,
      description: page.description,
      canonical: canonicalUrl(page.path),
      html: ReactDOMServer.renderToString(<PublicPage page={page} />),
    };
  }
  return {
    status: 404,
    title: '페이지를 찾을 수 없습니다 | 모아 스튜디오',
    description: '요청하신 모아 스튜디오 공개 페이지를 찾을 수 없습니다.',
    canonical: canonicalUrl('/404'),
    noindex: true,
    html: ReactDOMServer.renderToString(<PublicPage page={notFoundPage} />),
  };
}

function renderLanding(path: string): PublicRenderResult {
  return {
    status: 200,
    title: '모아 스튜디오 | 카페의 순간을 모아, 이야기로',
    description: landingDescription,
    canonical: canonicalUrl(path),
    html: ReactDOMServer.renderToString(<Landing
      onStart={() => undefined}
      onLogin={() => undefined}
      onAccount={() => undefined}
      onCheckout={() => undefined}
    />),
  };
}
