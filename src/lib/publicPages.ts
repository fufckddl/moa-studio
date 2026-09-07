import { expectedAmount, formatWon } from './planPricing';

export const PUBLIC_ORIGIN = 'https://moa-studio.pages.dev';
export const BUSINESS_EMAIL = 'dlckdfuf141@gmail.com';
export const BUSINESS_PHONE = '010-8929-4943';
export const BUSINESS_ADDRESS = '경기도 안성시 남파로 130';
export const BUSINESS_NAME = '소프트빌드';
export const BUSINESS_REPRESENTATIVE = '이창렬';
export const BUSINESS_NUMBER = '236-57-00826';
export const MAIL_ORDER_NUMBER = '2026-경기안성-0202';

export type PublicRoute = '/' | '/features' | '/pricing' | '/terms' | '/privacy' | '/refund' | '/support';

export interface PublicPageSection {
  heading: string;
  body: string[];
  items?: string[];
}

export interface PublicPage {
  path: PublicRoute | '/404';
  title: string;
  navLabel: string;
  description: string;
  eyebrow: string;
  heading: string;
  intro: string;
  updated: string;
  sections: PublicPageSection[];
}

export const publicRoutes: PublicRoute[] = ['/', '/features', '/pricing', '/terms', '/privacy', '/refund', '/support'];
export const appShellRoutes = ['/studio', '/studio/library', '/studio/brand', '/auth/reset-password'];
export const publicRouteSet = new Set<string>(publicRoutes);

const price = (plan: 'light' | 'studio' | 'plus', interval: 'month' | 'year') => `${formatWon(expectedAmount(plan, interval))}원`;

const policySources = [
  '전자상거래 등에서의 소비자보호에 관한 법률 제17조, 제18조',
  '전자상거래 등에서의 소비자보호에 관한 법률 시행령 제6조',
  '개인정보보호위원회 2026 개인정보 처리방침 작성지침',
];

export const publicPages: PublicPage[] = [
  {
    path: '/features',
    title: '기능 안내 | 모아 스튜디오',
    navLabel: '기능',
    description: '카페 사진, 메뉴 정보, 브랜드 톤을 카드뉴스와 게시글로 정리하는 모아 스튜디오 기능 안내.',
    eyebrow: 'Features',
    heading: '카페 운영자가 매일 쓰기 쉽게 만든 콘텐츠 작업대',
    intro: '모아 스튜디오는 사진을 고르고, 메뉴 정보를 입력하고, 브랜드 톤을 맞춘 뒤 바로 쓸 수 있는 이미지와 문구로 정리합니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '콘텐츠 제작',
        body: ['사진과 메뉴 정보를 바탕으로 카드뉴스, 게시글, 해시태그, 선택형 홍보 일정을 한 화면에서 만듭니다.'],
        items: ['카드뉴스 최대 10장 편집', 'PNG 단일 다운로드와 ZIP 묶음 다운로드', '게시글·해시태그·일정 별도 편집'],
      },
      {
        heading: '브랜드 보관함',
        body: ['로그인하면 브랜드 프로필과 작업 중인 콘텐츠를 계정 보관함에 저장합니다. 무료 체험은 브랜드 1개, 유료 플랜은 최대 3개까지 사용할 수 있습니다.'],
        items: ['브랜드 이름, 지역, 소개 문구, 색상 저장', '저장한 프로젝트 다시 열기', '브랜드별 콘텐츠 관리'],
      },
      {
        heading: 'AI 사진 기능',
        body: ['AI 이미지 생성·수정은 가입 후 무료 3회 체험을 제공합니다. 유료 플랜은 월별 이미지 이용 횟수를 제공하며, 실패한 요청은 이용 횟수를 복구합니다.'],
        items: ['무료 체험 총 3회', '라이트 월 10회', '스탠다드 월 30회', '프로 월 50회'],
      },
    ],
  },
  {
    path: '/pricing',
    title: '가격 안내 | 모아 스튜디오',
    navLabel: '가격',
    description: '모아 스튜디오 무료 체험, 라이트, 스탠다드, 프로 플랜 가격과 제공량.',
    eyebrow: 'Pricing',
    heading: '필요한 만큼 쓰는 카페 콘텐츠 플랜',
    intro: '모든 금액은 부가세 포함 기준입니다. 현재 결제는 기간 이용권 단건 결제이며 자동 정기 청구는 별도 계약 전까지 실행되지 않습니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '무료 체험',
        body: ['카드 등록 없이 시작할 수 있습니다. 가입하면 AI 이미지 생성·수정 3회를 체험하고 브랜드 프로필 1개를 저장할 수 있습니다.'],
        items: ['템플릿 콘텐츠 제작', '카드뉴스 최대 10장', 'PNG·ZIP 다운로드'],
      },
      {
        heading: '유료 플랜',
        body: [`라이트는 월 ${price('light', 'month')} 또는 연 ${price('light', 'year')}, 스탠다드는 월 ${price('studio', 'month')} 또는 연 ${price('studio', 'year')}, 프로는 월 ${price('plus', 'month')} 또는 연 ${price('plus', 'year')}입니다.`],
        items: ['라이트: AI 이미지 월 10회, 콘텐츠 월 10회', '스탠다드: AI 이미지 월 30회, 콘텐츠 월 30회', '프로: AI 이미지 월 50회, 콘텐츠 월 100회'],
      },
      {
        heading: '결제 전 확인',
        body: ['토스페이먼츠 결제창에서 최종 결제 금액을 확인합니다. 테스트 모드에서는 실제 청구가 발생하지 않으며, 실결제 전에는 결제창에 표시되는 금액과 플랜을 다시 확인해 주세요.'],
      },
    ],
  },
  {
    path: '/terms',
    title: '이용약관 | 모아 스튜디오',
    navLabel: '이용약관',
    description: '모아 스튜디오 서비스 이용 조건, 계정, 결제, 콘텐츠 책임 안내.',
    eyebrow: 'Terms',
    heading: '이용약관',
    intro: '이 약관은 모아 스튜디오 웹 서비스 이용 조건을 설명합니다. 서비스를 이용하면 이 약관과 개인정보 처리방침, 환불 정책을 확인한 것으로 봅니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '서비스 제공자',
        body: [`${BUSINESS_NAME}(${BUSINESS_REPRESENTATIVE})은 카페 운영자를 위한 콘텐츠 제작 도구인 모아 스튜디오를 제공합니다. 문의는 ${BUSINESS_EMAIL} 또는 ${BUSINESS_PHONE}으로 접수합니다.`],
        items: [`사업자등록번호 ${BUSINESS_NUMBER}`, `통신판매업 신고번호 ${MAIL_ORDER_NUMBER}`, `주소 ${BUSINESS_ADDRESS}`],
      },
      {
        heading: '계정과 보안',
        body: ['사용자는 본인 이메일로 계정을 만들고 비밀번호를 안전하게 관리해야 합니다. 지원 요청 시 주문번호나 계정 이메일은 확인할 수 있지만 비밀번호를 요구하지 않습니다.'],
      },
      {
        heading: '콘텐츠와 금지 행위',
        body: ['사용자가 업로드한 사진과 입력한 문구에 대한 권리는 사용자에게 있습니다. 타인의 권리, 초상, 상표, 저작권을 침해하는 자료나 불법·유해 목적의 자료를 업로드해서는 안 됩니다.'],
      },
      {
        heading: '결제와 이용 기간',
        body: ['유료 플랜은 표시된 기간 동안 제공되는 이용권입니다. 자동 갱신이나 반복 결제는 별도 계약 전까지 실행되지 않습니다. 결제 완료 후 이용 가능 기간과 제공량은 계정 기준으로 적용됩니다.'],
      },
      {
        heading: '변경과 중단',
        body: ['보안, 장애 대응, 법령 준수, 외부 제공자 장애, 서비스 개선을 위해 일부 기능이 변경되거나 일시 중단될 수 있습니다. 중요한 변경은 서비스 화면 또는 이메일로 안내합니다.'],
      },
    ],
  },
  {
    path: '/privacy',
    title: '개인정보 처리방침 | 모아 스튜디오',
    navLabel: '개인정보',
    description: '모아 스튜디오 개인정보 수집 항목, 이용 목적, 보유 기간, 위탁 및 권리 행사 안내.',
    eyebrow: 'Privacy',
    heading: '개인정보 처리방침',
    intro: '모아 스튜디오는 서비스 제공에 필요한 개인정보만 처리하고, 목적 달성 또는 보유 기간 경과 시 파기합니다. 결제·분쟁 관련 기록은 전자상거래법상 보존 의무를 따릅니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '처리하는 개인정보',
        body: ['회원가입과 로그인에는 이메일, 이름, 인증 식별자, 접속 기록이 사용됩니다. 콘텐츠 제작에는 사용자가 입력한 카페 정보, 메뉴 정보, 업로드 사진, 생성·편집 결과, 브랜드 프로필과 보관함 데이터가 사용됩니다. 결제 시 주문번호, 플랜, 결제 금액, 결제 상태, 영수증 URL, 이용 기간을 처리합니다.'],
      },
      {
        heading: '처리 목적',
        body: ['계정 인증, 콘텐츠 제작·저장·다운로드, AI 이미지 기능 제공, 결제 처리, 유료 권한 확인, 고객 문의 응대, 부정 이용 방지, 법령상 의무 이행을 위해 개인정보를 처리합니다.'],
      },
      {
        heading: '보유 기간',
        body: ['계정과 보관함 데이터는 회원 탈퇴 또는 삭제 요청 시 지체 없이 삭제합니다. 다만 법령상 보존이 필요한 기록은 분리 보관합니다. 계약 또는 청약철회 기록과 대금결제·공급 기록은 5년, 소비자 불만 또는 분쟁처리 기록은 3년, 표시·광고 기록은 6개월 보관합니다. 백업은 운영상 필요한 범위에서 최대 30일 이내로 제한하는 계획이며 실제 운영 절차 확정 전까지 별도 점검이 필요합니다.'],
      },
      {
        heading: '처리 위탁과 외부 서비스',
        body: ['Supabase는 서울 리전(ap-northeast-2)의 인증, 데이터베이스, 비공개 사진 저장소를 담당합니다. Cloudflare Pages는 공개 웹사이트와 정적 파일 전송을 담당합니다. 토스페이먼츠는 결제창, 결제 승인, 영수증과 결제 상태 확인을 담당합니다. OpenAI는 AI 이미지 생성·수정 기능이 활성화된 경우 사용자가 제출한 이미지와 요청 내용을 처리합니다. Brevo는 Supabase 인증 이메일 발송을 위한 SMTP 제공자로 사용됩니다.'],
      },
      {
        heading: '국외 이전과 확인 필요 사항',
        body: ['Supabase 서울 리전에 저장되는 계정·보관함 데이터와 별개로, Cloudflare, OpenAI, Brevo, 토스페이먼츠가 처리하는 일부 접속·보안·전송·지원 데이터는 각 제공자의 인프라 위치와 정책에 따라 국외에서 처리될 수 있습니다. 이전받는 자, 이전 국가, 이전 일시·방법, 보유 기간의 최종 운영 고지는 서비스 공개 전 제공자 계약과 대시보드 설정으로 재확인해야 합니다.'],
        items: ['운영 체크리스트: 제공자별 DPA 또는 약관 확인', '운영 체크리스트: 국외 이전 국가와 보유 기간 확정', '운영 체크리스트: AI 기능 활성화 전 입력 데이터 처리 범위 고지 확정'],
      },
      {
        heading: '이용자 권리',
        body: [`이용자는 개인정보 열람, 정정, 삭제, 처리정지, 회원 탈퇴, 계정 삭제를 요청할 수 있습니다. 요청은 ${BUSINESS_EMAIL}로 접수하며 본인 확인 후 처리합니다. 결제·분쟁 등 법령상 보존해야 하는 기록은 의무 기간 동안 분리 보관될 수 있습니다.`],
      },
      {
        heading: '작성 기준',
        body: [`이 방침은 ${policySources.join(', ')}을 기준으로 작성했습니다.`],
      },
    ],
  },
  {
    path: '/refund',
    title: '환불 정책 | 모아 스튜디오',
    navLabel: '환불',
    description: '모아 스튜디오 결제 취소, 청약철회, 환불 접수와 처리 기준.',
    eyebrow: 'Refund',
    heading: '환불 정책',
    intro: '모아 스튜디오는 전자상거래법상 청약철회권과 디지털 서비스 이용 상태를 함께 고려해 환불을 처리합니다. 사용하지 않은 이용권은 결제 후 7일 이내 전액 환불을 원칙으로 합니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '청약철회와 전액 환불',
        body: ['결제 후 7일 이내이고 유료 제공량을 사용하지 않았으며 이용 기간이 개시되지 않았거나 실질적으로 이용하지 않은 경우 전액 환불을 요청할 수 있습니다. 표시·광고 내용과 다르거나 계약 내용과 다르게 제공된 경우에는 법령이 정한 기간과 기준에 따라 환불을 처리합니다.'],
      },
      {
        heading: '이용을 시작한 경우',
        body: ['AI 생성·수정, 유료 콘텐츠 생성, 다운로드, 저장 등 유료 제공량을 사용했거나 이용 기간 혜택을 받은 경우에는 제공된 이익 또는 공급 비용에 해당하는 금액을 제외하고 환불될 수 있습니다. 법에서 허용하지 않는 위약금이나 손해배상 명목의 공제는 하지 않습니다.'],
      },
      {
        heading: '신청 방법',
        body: [`환불 요청은 ${BUSINESS_EMAIL}로 접수합니다. 주문번호, 결제 계정 이메일, 요청 사유를 함께 보내 주세요. 비밀번호, 카드 전체 번호, 인증번호는 절대 보내지 마세요.`],
      },
      {
        heading: '처리 방식',
        body: ['환불은 관리자 확인 후 토스페이먼츠 결제 내역을 기준으로 수동 처리합니다. 접수일, 결제 상태, 사용량, 법령상 보존 기록을 확인한 뒤 처리 결과를 안내합니다. 주말과 공휴일에는 확인이 다음 영업일로 넘어갈 수 있습니다.'],
      },
      {
        heading: '작성 기준',
        body: ['전자상거래법 제17조는 원칙적으로 계약내용에 관한 서면을 받은 날 또는 공급 시작일로부터 7일 이내 청약철회를 인정하며, 제18조는 환급 효과와 일부 사용 시 비용 청구 범위를 정합니다.'],
      },
    ],
  },
  {
    path: '/support',
    title: '고객지원 | 모아 스튜디오',
    navLabel: '고객지원',
    description: '모아 스튜디오 계정, 결제, 환불, 개인정보 요청을 접수하는 고객지원 안내.',
    eyebrow: 'Support',
    heading: '고객지원',
    intro: '계정, 결제, 환불, 개인정보 요청은 이메일로 접수합니다. 주문번호나 계정 이메일을 함께 보내면 확인이 빠릅니다.',
    updated: '2026-09-07',
    sections: [
      {
        heading: '연락처',
        body: [`이메일 ${BUSINESS_EMAIL}`, `전화 ${BUSINESS_PHONE}`, `주소 ${BUSINESS_ADDRESS}`],
      },
      {
        heading: '문의할 때 포함할 내용',
        body: ['결제 문의는 주문번호와 결제 계정 이메일을 포함해 주세요. 계정 문의는 가입 이메일과 요청 내용을 적어 주세요. 개인정보 삭제나 계정 삭제 요청은 본인 확인 후 처리합니다.'],
        items: ['비밀번호를 보내지 마세요.', '카드 전체 번호나 인증번호를 보내지 마세요.', '문제가 발생한 화면과 시간을 함께 알려 주세요.'],
      },
      {
        heading: '처리 안내',
        body: ['접수된 요청은 내용 확인 후 순서대로 답변합니다. 결제 취소나 환불은 토스페이먼츠 결제 상태와 사용량 확인이 필요할 수 있습니다. 주말과 공휴일에는 답변이 늦어질 수 있습니다.'],
      },
    ],
  },
];

export const notFoundPage: PublicPage = {
  path: '/404',
  title: '페이지를 찾을 수 없습니다 | 모아 스튜디오',
  navLabel: '404',
  description: '요청하신 모아 스튜디오 공개 페이지를 찾을 수 없습니다.',
  eyebrow: '404',
  heading: '페이지를 찾을 수 없습니다',
  intro: '주소가 바뀌었거나 공개되지 않은 페이지입니다. 필요한 문의는 고객지원으로 접수해 주세요.',
  updated: '2026-09-07',
  sections: [{ heading: '다음 단계', body: ['홈으로 돌아가거나 고객지원 페이지에서 문의해 주세요.'], items: ['홈 /', '고객지원 /support'] }],
};

export function getPublicPage(path: string) {
  const normalized = normalizePublicPath(path);
  return publicPages.find(page => page.path === normalized) ?? null;
}

export function normalizePublicPath(path: string): PublicRoute | '/' | null {
  const clean = path.replace(/\/+$/, '') || '/';
  if (clean === '/') return '/';
  return publicRouteSet.has(clean) ? clean as PublicRoute : null;
}

export function canonicalUrl(path: string) {
  const normalized = normalizePublicPath(path);
  return `${PUBLIC_ORIGIN}${normalized === '/' ? '/' : normalized ? `${normalized}/` : path}`;
}
