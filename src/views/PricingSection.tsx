import { useState } from 'react';
import '../pricing.css';
import { expectedAmount } from '../lib/payments';

const plans = [
  { id: 'free', name: '무료 체험', english: 'FREE', description: '첫 사진을 부담 없이 수정해 보세요', monthly: 0, yearly: 0, features: ['AI 이미지 생성·수정 가입 후 총 3회', '사진과 메뉴로 템플릿 콘텐츠 만들기', '카드뉴스 최대 10장 · 게시글 · 홍보 일정', 'PNG · ZIP 다운로드', '브랜드 프로필 최대 1개 · 나만의 보관함'] },
  { id: 'light', name: '라이트', english: 'LIGHT', description: '필요한 사진만 가볍게 수정하고 싶다면', monthly: expectedAmount('light', 'month'), yearly: expectedAmount('light', 'year'), features: ['AI 이미지 생성·수정 월 10회', 'AI 콘텐츠 생성 월 10회 · 별도 한도', '카페 브랜드 프로필 최대 3개', '참고 사진 최대 3장 첨부', '모든 플랜 동일한 이미지 품질'] },
  { id: 'studio', name: '스탠다드', english: 'STANDARD', description: '우리 카페의 소식을 꾸준히 전하고 싶다면', monthly: expectedAmount('studio', 'month'), yearly: expectedAmount('studio', 'year'), features: ['AI 이미지 생성·수정 월 30회', 'AI 콘텐츠 생성 월 30회 · 별도 한도', '카페 브랜드 프로필 최대 3개', '참고 사진 최대 3장 첨부', '모든 플랜 동일한 이미지 품질'] },
  { id: 'plus', name: '프로', english: 'PRO', description: '자주 수정할수록 더 저렴하게', monthly: expectedAmount('plus', 'month'), yearly: expectedAmount('plus', 'year'), features: ['AI 이미지 생성·수정 월 50회', 'AI 콘텐츠 생성 월 100회 · 별도 한도', '카페 브랜드 프로필 최대 3개', '브랜드별 콘텐츠 보관함', '모든 플랜 동일한 이미지 품질'] },
];
const questions = [
  ['무료로 어디까지 사용할 수 있나요?', '현재 제공 중인 6종 템플릿, 최대 10장의 카드 편집, 게시글과 선택형 홍보 일정, PNG·ZIP 다운로드를 무료로 이용할 수 있어요. 로그인하면 브랜드 정보와 콘텐츠를 계정 보관함에 저장할 수 있습니다.'],
  ['지금 유료 플랜을 결제할 수 있나요?', '플랜을 선택하면 토스 결제 연결 상태와 최종 금액을 확인할 수 있어요. 테스트 모드에서는 실제 금액이 청구되지 않습니다. 유료 기능은 아직 출시 준비 중이에요.'],
  ['월간과 연간 가격은 어떻게 다른가요?', '연간 플랜은 월간 가격보다 약 10% 저렴해요. 연간 결제 시 라이트는 42,000원, 스탠다드는 85,000원, 프로는 139,000원을 한 번에 결제하는 예정안입니다. 표시 금액은 부가세 포함 기준입니다.'],
  ['AI 사진 채팅 횟수는 어떻게 차감되나요?', '인물 생성과 사진 수정은 같은 이미지 이용 횟수를 사용하며, 결과가 생성되면 1회 사용돼요. 참고 사진은 최대 3장까지 함께 첨부할 수 있고, 첨부 장수와 관계없이 요청당 1회입니다. 실패한 요청은 횟수가 복구돼요. 무료 체험은 가입 후 총 3회이며 자동 충전되지 않아요. 유료는 이용 시작일 기준 매월 갱신되며 콘텐츠 생성 한도와 별도로 계산합니다. 서비스 전체 AI 제공량이 소진되면 다음 날까지 이용이 제한될 수 있어요.'],
  ['AI 생성 1회는 무엇을 뜻하나요?', '출시 예정인 AI 기능에서 카드뉴스 3장과 게시글, 선택한 경우 홍보 일정까지 한 묶음으로 만드는 단위입니다. 현재 제공되는 템플릿 생성에는 이 AI 이용 횟수가 적용되지 않습니다.'],
  ['플랜 변경이나 해지는 어떻게 하나요?', '유료 플랜 출시와 함께 변경·해지·환불 정책을 안내할 예정입니다. 현재는 구독이나 자동 결제가 발생하지 않아요.'],
  ['회원가입 없이도 시작할 수 있나요?', '회원가입 없이 스튜디오와 예시 콘텐츠를 둘러볼 수 있어요. 콘텐츠 생성·편집·저장·다운로드와 브랜드 관리는 로그인 후 이용할 수 있습니다.'],
];
const won = (value: number) => new Intl.NumberFormat('ko-KR').format(value);

export function PricingSection({ onStart, onCheckout }: { onStart: () => void; onCheckout: (plan: 'light' | 'studio' | 'plus', interval: 'month' | 'year') => void }) {
  const [annual, setAnnual] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const selectedPlan = plans.find(plan => plan.id === selected);
  return <section className="pricing-section landing-section" id="pricing" aria-labelledby="pricing-title">
    <div className="pricing-heading" data-reveal>
      <div><p className="landing-index"><span>03</span> / 우리 카페에 맞는 플랜</p><h2 id="pricing-title">작게 시작해도,<br />이야기는 충분하니까.</h2></div>
      <div className="pricing-intro"><p>처음 한 장은 가볍게.<br />카페의 속도에 맞춰 모아와 함께하세요.</p><span>지금은 무료로 이용할 수 있어요.</span></div>
    </div>
    <div className="pricing-controls"><p>유료 플랜은 출시 예정 가격입니다. <span>모든 금액은 부가세 포함.</span></p><div className="pricing-toggle" role="group" aria-label="결제 주기"><button type="button" aria-pressed={!annual} onClick={() => setAnnual(false)}>월간</button><button type="button" aria-pressed={annual} onClick={() => setAnnual(true)}>연간 <span>약 10% 절약</span></button></div></div>
    <div className="pricing-grid">
      {plans.map(plan => {
        const paid = plan.monthly > 0;
        const price = annual ? Math.round(plan.yearly / 12) : plan.monthly;
        return <article key={plan.id} className={`pricing-card ${plan.id === 'studio' ? 'pricing-featured' : ''}`} aria-labelledby={`plan-${plan.id}`}>
          <div className="pricing-card-top"><span>{plan.english}</span><span className="pricing-badge">{plan.id === 'free' ? '지금 이용 가능' : plan.id === 'studio' ? '추천 플랜' : plan.id === 'light' ? '가볍게 시작' : '가장 낮은 회당 가격'}</span></div>
          <h3 id={`plan-${plan.id}`}>{plan.name}</h3><p className="pricing-description">{plan.description}</p>
          <div className="pricing-amount"><strong>{won(price)}</strong><span>원{paid ? annual ? ' / 월 환산' : ' / 월' : ''}</span></div>
          <p className="pricing-billing">{paid ? annual ? `연 ${won(plan.yearly)}원 일괄 결제 예정` : '월간 결제 기준 · 출시 예정' : '카드 등록 없이 시작하세요'}</p>
          <button type="button" className="pricing-cta" aria-expanded={paid ? selected === plan.id : undefined} aria-controls={paid ? 'pricing-selection' : undefined} onClick={() => paid ? setSelected(selected === plan.id ? null : plan.id) : onStart()}>{paid ? '플랜 살펴보기' : '무료로 시작하기'}<span aria-hidden="true">↗</span></button>
          <p className="pricing-feature-label">{paid ? '출시 예정 구성' : '지금 사용할 수 있는 기능'}</p><ul>{plan.features.map(feature => <li key={feature}><span aria-hidden="true">✓</span>{feature}</li>)}</ul>
        </article>;
      })}
    </div>
    <div id="pricing-selection">{selectedPlan && <div className="pricing-selection" role="status"><div><strong>{selectedPlan.english} · {annual ? '연간' : '월간'} 플랜을 살펴보고 계세요.</strong><p>선택한 플랜의 금액과 토스 결제 연결 상태를 다음 화면에서 확인하세요. 유료 기능은 출시 준비 중입니다.</p></div><button type="button" onClick={() => onCheckout(selectedPlan.id as 'light' | 'studio' | 'plus', annual ? 'year' : 'month')}>토스 결제 확인 <span aria-hidden="true">↗</span></button></div>}</div>
    <div className="pricing-faq"><div><p className="pricing-feature-label">BEFORE YOU START</p><h3>궁금한 점이<br />있으신가요?</h3></div><div className="pricing-questions">{questions.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></div>
  </section>;
}
