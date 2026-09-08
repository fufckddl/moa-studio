# 토스페이먼츠 결제 연결

플랜 선택 → 로그인 → 서버 주문 생성 → 토스 결제창 → 서버 승인 → 결과 조회 순서로
동작합니다. 키가 없으면 결제를 비활성화하며, 테스트 결제는 실제 이용 권한으로
취급하지 않습니다.

## 설정과 배포 경로

현재 운영 사이트는 `https://moa-studio.pages.dev`이며 Cloudflare Pages와
Supabase Edge 함수 `moa-payments`를 사용합니다. 운영 결제 키와
`PUBLIC_APP_URL`은 Supabase Edge secrets에 설정합니다. Node 서버와 SQLite는
로컬 데모 경로이며, 아래 `.env.local` 설정은 이 로컬 실행에 해당합니다.

1. 토스페이먼츠 개발자센터에서 실제 가맹점을 선택합니다.
   토스비즈니스·토스플레이스 계정만 있는 경우 온라인 전자결제 계약 상태를 별도로
   확인해야 합니다.
2. `.env.example`을 `.env.local`로 복사하고 같은 상점의 **API 개별 연동 키**를
   비공개로 입력합니다. 이 구현은 `test_ck_`와 `test_sk_` 형식의 결제창 키를
   사용합니다. 위젯용 `gck/gsk` 키와 혼용하지 않습니다.
3. 개발 서버를 다시 시작하고 로그인한 뒤 가격표에서 플랜을 선택합니다. 테스트
   모드 표시를 확인하고 토스 테스트 결제를 진행합니다.

시크릿 키는 운영 Edge 함수 또는 로컬 Node 서버에서만 사용합니다.
`VITE_` 접두어를 붙이거나 브라우저
번들에 넣지 마세요. `.env.local`과 `.data`는 Git에서 제외됩니다.

## 금액과 결제 방식

| 플랜     |     월간 | 연간 일괄 결제 (약 10% 할인) |
| -------- | -------: | ---------------------------: |
| 라이트   |  3,900원 |                     42,000원 |
| 스탠다드 |  7,900원 |                     85,000원 |
| 프로     | 12,900원 |                    139,000원 |

금액은 서버에서 정합니다. 브라우저에서 바꾼 금액이나 다른 계정의 주문은 승인하지
않습니다. 운영 주문과 승인 결과는 Supabase Postgres에 저장하고, 로컬 Node
데모에서는 SQLite에 저장합니다. 같은 주문은 중복 반영하지 않습니다.
승인 응답이 불확실하면 토스 주문 조회 API로 확인합니다. 결제 내역
조회는 본인 계정의 주문만 반환하며 주문번호, 구매일, 이용 기간, 현재 상태,
영수증 링크를 표시합니다.

현재 구현은 선택 기간의 **1회 결제**입니다. 자동 갱신·정기 청구는 포함하지
않습니다. 환불은 토스페이먼츠 관리자 콘솔에서 처리하고, 앱은 결제 조회 API와
웹훅 재확인으로 `CANCELED` 또는 `PARTIAL_CANCELED` 상태를 동기화해 유료 권한에서
제외합니다. 클라이언트에는 환불·취소용 시크릿 키나 관리자 권한을 노출하지
않습니다.

## 운영 전환

현재 Edge 운영 경로에는 계약이 완료된 동일 가맹점의 표준 결제창 라이브 키 쌍,
`PUBLIC_APP_URL=https://moa-studio.pages.dev`, `TOSS_LIVE_ENABLED=1`,
`PAID_FEATURES_READY=1`, `MOA_AI_READY=1`이 모두 필요합니다.
`PAID_FEATURES_READY`는 유료 권한·기간·운영
정책·환불/지원 절차가 준비된 뒤 켜고, `MOA_AI_READY`는 유료 플랜의 AI 제공이
실제로 검증된 뒤 켭니다. 현재 운영 절차는 [출시 runbook](launch-runbook.md)과
[유료 출시 검증](paid-launch-verification.md)을 따릅니다.

별도 Node 배포를 선택할 때는 `MOA_SECURE_COOKIES=1`, `/api` 프록시와 SQLite
영구 저장·백업 설정이 필요합니다. 이 경로의 [배포 안내](deployment.md)는
현재 Pages/Supabase 운영 경로와 구분합니다.

### 2026-09-08 운영 전환 확인

사용자가 실결제 활성화를 승인했지만, Toss 관리자 화면에서 현재 테스트한
소프트빌드 링크페이 상점은 **심사중**이며 계약일이 표시되지 않았습니다.
라이브 API 탭은 있으나 계약 완료 전에는 거래할 수 없다는 안내가 표시됩니다.
심사 결과는 등록된 연락처로 안내될 예정입니다. 별도 빌링 상점의 계약 완료는
현재 1회 결제 연동의 승인 근거가 아니므로 해당 키로 전환하지 않았습니다.

라이브 키를 복사하거나 노출하지 않았으며 운영 결제 secrets도 변경하지
않았습니다. `TOSS_LIVE_ENABLED=0`, `PAID_FEATURES_READY=0`,
`MOA_AI_READY=1`을 유지합니다. 공개 운영 API는 결제 `configured: true`,
`mode: test`와 AI `configured: true`, `provider: openai`, `mode: live`를
반환했습니다. 가맹점 승인과 남은 운영 조건을 확인한 뒤 라이브 키 연결 및
실제 결제·유료 권한·환불 흐름을 검증해야 합니다.

암호화 로컬 백업과 격리된 로컬 Supabase 실제 복구 실습은 완료했습니다.
30개 테이블의 백업 열 값과 Storage 파일 11개의 해시가 일치했고 로그인·소유권·
SQL 검증이 통과했습니다. [복구 실습 기록](restore-drill-2026-09-08.md)을
참조하세요. 외부 백업 대상은 $0 상한의 비공개 Backblaze B2에 연결했으며
[원격 실행 기록](free-offsite-backup.md)에서 검증 결과를 확인할 수 있습니다.
실결제 승인·환불과 전체 유료 출시 검증은 완료되지 않았습니다.

토스 결제 조회 API를 통해 라이브 결제의 취소 상태를 재확인합니다. 본인 주문
조회, 결제 내역 조회, 멤버십 조회 중 토스 상태가 `CANCELED` 또는
`PARTIAL_CANCELED`이면 로컬 주문 상태를 `CANCELED`로 동기화하고 유료 권한에서
제외합니다. 웹훅은 본문만 믿고 권한을 부여하지 않으며, 토스 조회 API로 재확인한
취소 상태만 반영합니다. 결과 페이지가 열리지 않은 인증 건은 해당 주문 조회·승인
흐름으로 복구할 수 있지만, 자동 백그라운드 정산 작업은 없습니다.

## 환불과 고객지원

환불 요청은 운영자가 주문번호, 결제일, 이메일, 환불 사유를 확인한 뒤
토스페이먼츠 관리자 콘솔에서 처리합니다. 처리 전에는 앱의 결제 내역에서 주문이
본인 계정에 속하고 `PAID` 상태인지 확인합니다. 처리 후에는 해당 주문 상세나 결제
내역을 다시 열어 토스 조회 결과가 `CANCELED` 또는 `PARTIAL_CANCELED`로
동기화되는지 확인합니다. 동기화된 주문은 멤버십 조회에서 제외됩니다.

지원 응대에는 결제 시크릿, Supabase service role key, OpenAI API key를 사용하지
않습니다. 운영자가 필요한 경우 관리자 콘솔과 서버 로그에서 주문번호 기준으로만
확인하고, 사용자에게는 결제 상태, 환불 접수 여부, 예상 처리 시점만 안내합니다.

## 유료 AI 설정

Supabase Edge 함수 `moa-content`는 `MOA_AI_PROVIDER=openai`와 서버 전용
`OPENAI_API_KEY`가 있을 때 OpenAI Responses API로 카드뉴스 콘텐츠를 생성합니다.
`MOA_AI_MODEL`은 선택값이며 기본값은 비용 민감형 텍스트/이미지 입력 워크로드에
맞춘 `gpt-5.6-luna`입니다. 키가 없거나 provider가 다르면 템플릿 생성만 반환하며
유료 AI 사용량을 예약하지 않습니다.

OpenAI 호출은 구조화된 JSON 스키마 응답만 허용하고, 응답이 실패하거나 스키마
검증에 실패하면 예약된 사용량을 `failed`로 돌려 월간 한도에서 제외합니다. 이미
성공한 같은 `requestId`는 저장된 응답을 반환해 중복 OpenAI 호출과 중복 차감을
막습니다.

## 검증

`npm test`는 금액 변조, 소유권, 중복 승인, 공급자 오류, 라이브 준비 게이트, 취소
동기화, 웹훅 위조 방지를 모의 응답으로 검사합니다. `npm run test:cloud`는
Supabase Edge 함수의 같은 핵심 조건을 검사합니다. 이는 실제 토스 테스트 결제
완료를 대신하지 않습니다. 브라우저 결제창과 리디렉션의 종단 검증에는 실제 상점의
테스트 키가 필요합니다.

공식 문서:
[결제창 연동](https://docs.tosspayments.com/guides/v2/payment-window/integration),
[API 키](https://docs.tosspayments.com/reference/using-api/api-keys),
[API 인증](https://docs.tosspayments.com/reference/using-api/authorization),
[코어 API](https://docs.tosspayments.com/reference),
[LLM Quick Reference](https://docs.tosspayments.com/guides/v2/get-started/llms-quick-reference).

2026-09-06 소프트빌드 테스트 키 연결 후 사용자가 카드 인증을 완료한 9,900원
주문의 `PAID` 저장을 확인했습니다. 실제 금액 청구는 없었으며, 운영 키를 이용한
라이브 결제는 아직 수행하지 않았습니다.
