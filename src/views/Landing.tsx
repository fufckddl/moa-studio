import { useEffect, useRef } from 'react';
import '../landing.css';
import { BusinessInfo } from '../components/BusinessInfo';
import { PricingSection } from './PricingSection';

const steps = [
  { title: '사진을 고르고', description: '우리 카페의 메뉴와 공간을 담아주세요.' },
  { title: '이야기를 더하고', description: '메뉴 이름과 설명, 원하는 말투를 선택해요.' },
  { title: '콘텐츠로 꺼내요', description: '카드뉴스와 게시글, 필요할 때는 홍보 일정까지.' },
];

interface LandingProps {
  onCheckout: (plan: 'light' | 'studio' | 'plus', interval: 'month' | 'year') => void;
  onStart: () => void;
  onLogin: () => void;
  onAccount: () => void;
  userName?: string;
}

export function Landing({ onStart, onLogin, onAccount, userName, onCheckout }: LandingProps) {
  const root = useRef<HTMLElement>(null);
  const heroPhoto = useRef<HTMLImageElement>(null);
  const heroCopy = useRef<HTMLDivElement>(null);
  const progress = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const target = ['#story', '#process', '#pricing'].includes(location.hash) ? location.hash.slice(1) : null;
    if (!target) return;
    const frame = requestAnimationFrame(() => document.getElementById(target)?.scrollIntoView({ behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    if (!root.current) return;
    if (!('IntersectionObserver' in window)) {
      root.current.querySelectorAll('[data-reveal]').forEach(element => element.classList.add('is-revealed'));
      return;
    }
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.12 });
    root.current.querySelectorAll('[data-reveal]').forEach(element => observer.observe(element));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let heroHeight = root.current?.querySelector('.landing-hero')?.clientHeight ?? window.innerHeight;
    let active = false;
    const update = () => {
      frame = 0;
      const scroll = window.scrollY;
      const ratio = Math.min(1, Math.max(0, scroll / heroHeight));
      if (heroPhoto.current) {
        heroPhoto.current.style.transform = `scale(${1.04 + ratio * 0.04}) translate3d(0, ${ratio * 34}px, 0)`;
      }
      if (heroCopy.current) {
        heroCopy.current.style.transform = `translate3d(0, ${ratio * -30}px, 0)`;
        heroCopy.current.style.opacity = String(1 - ratio * 0.36);
      }
      if (progress.current) {
        progress.current.style.transform = `scaleX(${Math.min(1, Math.max(0.08, ratio))})`;
      }
    };
    const measure = () => {
      heroHeight = root.current?.querySelector('.landing-hero')?.clientHeight ?? window.innerHeight;
      onScroll();
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const stop = () => {
      if (!active) return;
      active = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', measure);
      for (const element of [heroPhoto.current, heroCopy.current, progress.current]) {
        if (element) {
          element.style.transform = '';
          element.style.opacity = '';
        }
      }
    };
    const start = () => {
      if (motionQuery.matches || active) return;
      active = true;
      measure();
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', measure);
    };
    const syncMotion = () => motionQuery.matches ? stop() : start();
    syncMotion();
    motionQuery.addEventListener('change', syncMotion);
    return () => {
      motionQuery.removeEventListener('change', syncMotion);
      stop();
    };
  }, []);

  return <main className="landing" ref={root} id="main-content">
    <a className="landing-skip" href="#story">모아 소개로 건너뛰기</a>
    <section className="landing-hero" aria-labelledby="landing-title">
      <img ref={heroPhoto} className="landing-hero-photo" src="/assets/moa-hero-cafe.webp" alt="창으로 들어오는 오후의 빛과 나무 테이블 위 한 잔의 커피" fetchPriority="high" width="1536" height="1024" />
      <header className="landing-header">
        <a className="landing-logo" href="#/" aria-label="모아 스튜디오 홈">mo:a <span>studio</span></a>
        <nav aria-label="메인 메뉴">
          <a href="#story">모아 이야기</a>
          <a href="#pricing">플랜</a>
          <a className="landing-studio-link" href="/studio" onClick={event => { event.preventDefault(); onStart(); }}>스튜디오 열기 <span aria-hidden="true">↗</span></a>
          <button className="landing-account" type="button" onClick={userName ? onAccount : onLogin}>{userName ? `${userName}님` : '로그인'}</button>
        </nav>
      </header>
      <div className="landing-hero-copy" ref={heroCopy}>
        <h1 id="landing-title">
          <span>좋은 공간에는,</span>
          <span>들려줄 이야기가 있어요.</span>
        </h1>
        <p>당신의 카페가 가진 분위기를,<br className="mobile-break" /> 한 장의 콘텐츠로.</p>
      </div>
      <div className="landing-hero-bottom">
        <span>모아 스튜디오</span>
        <a href="#story">스크롤하여 모아 만나기 <span aria-hidden="true">↓</span></a>
      </div>
      <div className="landing-progress" aria-hidden="true"><span ref={progress} /></div>
    </section>

    <section className="landing-story landing-section" id="story" aria-labelledby="story-title">
      <div className="landing-story-copy" data-reveal>
        <p className="landing-index"><span>01</span> / 모아 이야기</p>
        <h2 id="story-title">매일의 정성이,<br />더 많은 사람에게.</h2>
        <p className="landing-description">문을 열고, 커피를 내리고, 손님을 맞이하는 하루.<br />그 사이 홍보까지 고민하지 않도록.<br />모아는 사진과 메뉴 정보를<br className="mobile-break" /> 보기 좋은 콘텐츠로 정리합니다.</p>
        <a className="landing-text-link" href="#process">어떤 콘텐츠를 만들 수 있나요? <span aria-hidden="true">↓</span></a>
      </div>
      <figure className="landing-story-photo" data-reveal>
        <img src="/assets/cafe-latte.webp" alt="햇살이 드는 카페 테이블 위의 시그니처 크림 라떼" loading="lazy" width="1122" height="1402" />
        <figcaption>한 잔의 커피에서 시작되는 이야기</figcaption>
      </figure>
    </section>

    <section className="landing-process landing-section" id="process" aria-labelledby="process-title">
      <div data-reveal>
        <p className="landing-index"><span>02</span> / 만드는 과정</p>
        <h2 id="process-title">사진에서 게시물까지,<br />자연스럽게.</h2>
      </div>
      <ol className="landing-steps">
        {steps.map((step, index) => <li key={step.title} data-reveal>
          <h3><span>0{index + 1}</span>{step.title}</h3>
          <p>{step.description}</p>
        </li>)}
      </ol>
      <p className="landing-template-note">현재는 입력 정보를 반영하는 템플릿 모드로 제공됩니다.</p>
    </section>

    <PricingSection onStart={onStart} onCheckout={onCheckout} />

    <section className="landing-start" aria-labelledby="start-title">
      <div className="landing-start-content" data-reveal>
        <div><h2 id="start-title">이제, 우리 카페의 차례.</h2><p>사진 한 장으로 첫 콘텐츠를 만들어 보세요.</p></div>
        <a className="landing-start-link" href="/studio" onClick={event => { event.preventDefault(); onStart(); }}>스튜디오 시작하기 <span aria-hidden="true">↗</span></a>
      </div>
      <footer className="landing-footer">
        <a className="landing-logo" href="#/" onClick={() => window.scrollTo({ top: 0, behavior: 'instant' })} aria-label="모아 스튜디오 맨 위로">mo:a <span>studio</span></a>
        <p>카페의 순간을 모아, 이야기로.</p>
        <BusinessInfo />
      </footer>
    </section>
  </main>;
}
