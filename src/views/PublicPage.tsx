import { useEffect } from 'react';
import { BusinessInfo } from '../components/BusinessInfo';
import { canonicalUrl, publicPages, type PublicPage as PublicPageData } from '../lib/publicPages';
import '../landing.css';

interface PublicPageProps {
  page: PublicPageData;
}

export function PublicPage({ page }: PublicPageProps) {
  useEffect(() => {
    document.title = page.title;
    setMeta('meta[name="description"]', 'content', page.description);
    setMeta('meta[property="og:title"]', 'content', page.title);
    setMeta('meta[property="og:description"]', 'content', page.description);
    setMeta('meta[property="og:url"]', 'content', canonicalUrl(page.path));
    setMeta('link[rel="canonical"]', 'href', canonicalUrl(page.path));
    setMeta('meta[name="robots"]', 'content', page.path === '/404' ? 'noindex,nofollow' : 'index,follow');
  }, [page]);

  return <main className="landing public-page" id="main-content">
    <header className="landing-header public-header">
      <a className="landing-logo" href="/" aria-label="모아 스튜디오 홈">mo:a <span>studio</span></a>
      <nav aria-label="공개 페이지">
        <a href="/features">기능</a>
        <a href="/pricing">가격</a>
        <a href="/support">고객지원</a>
        <a className="landing-studio-link" href="/studio">스튜디오 열기 <span aria-hidden="true">↗</span></a>
      </nav>
    </header>
    <section className="public-hero" aria-labelledby="public-title">
      <p className="landing-index"><span>{page.eyebrow}</span> / {page.updated}</p>
      <h1 id="public-title">{page.heading}</h1>
      <p>{page.intro}</p>
    </section>
    <section className="public-content" aria-label={`${page.navLabel} 상세`}>
      {page.sections.map(section => <article key={section.heading} className="public-section">
        <h2>{section.heading}</h2>
        {section.body.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        {section.items && <ul>{section.items.map(item => <li key={item}>{item}</li>)}</ul>}
      </article>)}
    </section>
    <section className="public-related" aria-label="관련 페이지">
      {publicPages.map(item => <a key={item.path} href={item.path}>{item.navLabel}</a>)}
    </section>
    <footer className="landing-footer public-footer">
      <a className="landing-logo" href="/" aria-label="모아 스튜디오 홈">mo:a <span>studio</span></a>
      <p>카페의 순간을 모아, 이야기로.</p>
      <BusinessInfo />
    </footer>
  </main>;
}

function setMeta(selector: string, attribute: string, value: string) {
  let element = document.querySelector(selector);
  if (!element) {
    element = selector.startsWith('link')
      ? document.createElement('link')
      : document.createElement('meta');
    if (selector === 'link[rel="canonical"]') element.setAttribute('rel', 'canonical');
    if (selector === 'meta[name="robots"]') element.setAttribute('name', 'robots');
    document.head.appendChild(element);
  }
  element.setAttribute(attribute, value);
}
