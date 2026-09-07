# 무료 클라우드 배포

Cloudflare Pages가 웹 화면을 제공하고 Supabase가 계정, PostgreSQL 데이터,
비공개 사진 저장소, 토스 결제 Edge Function을 담당합니다.
템플릿 문구 생성은 브라우저에서 처리하며 외부 AI API를 호출하지 않습니다.

## 프로젝트

- Supabase: `moa-studio`, 서울 `ap-northeast-2`
- Project ref: `mbmxkathxgvznuphbfbg`
- API: `https://mbmxkathxgvznuphbfbg.supabase.co`
- 생성 당시 프로젝트 비용: 월 0달러
- Cloudflare Pages 운영 주소: https://moa-studio.pages.dev
- 최초 공개 배포: https://0cc93e6d.moa-studio.pages.dev

## 웹 빌드

`cloud.env.example`을 `.env.production.local`로 복사하고 Supabase URL과
publishable key를 입력합니다. 두 값은 브라우저용 공개 설정입니다.
`service_role`, `sb_secret_`, 토스 시크릿 키를 `VITE_` 변수에 넣지 마세요.

```sh
npm ci
npm run build
npm run check:cloud
```

Vite는 프로덕션 빌드에서 `.env.production.local`을 사용합니다.
로컬 `npm run dev`는 기존 `.env.local`과 SQLite 서버를 사용하므로
클라우드와 로컬 계정은 서로 다릅니다.

## Cloudflare 업로드

Cloudflare 로그인 후 무료 Pages 프로젝트를 만들고 빌드 파일을 업로드합니다.
프로젝트 이름이 이미 사용 중이면 실제 생성된 이름에 맞춰 배포 명령을 수정합니다.

```sh
npx --yes wrangler@4.129.0 login --scopes account:read user:read pages:write
npx --yes wrangler@4.129.0 pages project create moa-studio --production-branch main
npm run deploy:cloud
```

Direct Upload 프로젝트이므로 Git 자동 배포를 나중에 원하면 별도 Pages 프로젝트를
만들거나 CI에서 동일한 업로드 명령을 실행합니다.

## DB와 사진

- `supabase/migrations/`에 스키마와 접근 정책을 보관합니다.
- `workspaces`: 로그인한 사용자 자신의 브랜드·프로젝트만 읽고 씁니다.
- `moa-photos`: 비공개 저장소이며 사용자 ID로 구분한 경로에 저장합니다.
- 이미지 파일 자체는 Storage에, 파일 경로는 PostgreSQL에 저장합니다.
- `payment_orders`: 사용자 본인 조회만 허용합니다. 주문 생성·승인 변경은
  Edge Function이 토스 응답을 검증한 뒤 서버 권한으로 처리합니다.
- 브라우저 비회원 보관함은 해당 브라우저에만 남으며 자동 업로드하지 않습니다.

기존 로컬 SQLite DB는 `.data/backups/pre-cloud-*.sqlite`에 일관된 스냅샷으로
백업했습니다. 전환 전 로컬 DB에는 계정 2개, 저장된 보관함 0개, 결제 주문 2개가
있었습니다. 로컬 비밀번호·세션을 Supabase 계정으로 복사하지 않습니다.
로컬 테스트 주문도 운영 결제 이력에 섞지 않습니다.

## 토스 서버 비밀 설정

Supabase 대시보드의 Edge Functions → Secrets에 다음 값을 설정합니다.

- `PUBLIC_APP_URL`: 실제 Pages 운영 HTTPS 주소
- `TOSS_CLIENT_KEY`: 같은 가맹점의 API 개별 연동 클라이언트 키
- `TOSS_SECRET_KEY`: 위 키와 같은 환경의 API 개별 연동 시크릿 키
- `TOSS_LIVE_ENABLED`: 테스트는 `0`, 실제 결제 활성화는 `1`
- `PAID_FEATURES_READY`: 유료 권한과 운영 정책 검증 전에는 `0`
- `MOA_AI_READY`: 유료 AI 제공 경로 검증 전에는 `0`

키는 함수 소스나 Git에 기록하지 않습니다. 함수는 `moa-payments`이며,
로그인이 필요한 요청에서 Supabase access token을 검증합니다.
테스트 승인은 유료 회원 권한으로 취급하지 않습니다.

현재 플랜은 라이트 월 3,900원/연 42,000원,
스탠다드 월 7,900원/연 85,000원, 프로 월 12,900원/연 139,000원입니다.
기간 이용권 단건 결제이며 자동 갱신·정기 청구가 아닙니다.
주문 조회, 결제 내역 조회, 멤버십 조회, 웹훅 처리는 토스 조회 API로 취소 또는 부분 취소 상태를 재확인하고 유료 권한에서 제외합니다.
플랜별 생성량 예약·사용·환원과 브랜드 수 제한은 서버에 구현했습니다.
실제 AI 제공자 연결과 환불 신청/관리자 처리 화면은 완료되지 않았습니다.

## 회원가입과 이메일

Supabase Authentication → URL Configuration의 Site URL은
`https://moa-studio.pages.dev`이며 이메일 확인 리디렉션은
`https://moa-studio.pages.dev/`로 설정했습니다.

Supabase 기본 메일 발송은 프로젝트 팀 이메일만 대상으로 합니다.
일반 고객에게 회원가입 확인 메일·비밀번호 재설정 메일을 보내려면
별도의 SMTP 서비스 또는 로그인 제공자 설정이 필요합니다.
이 제한을 우회하려고 이메일 확인을 자동 해제하지 않습니다.

Brevo 무료 계정과 휴대폰 인증을 완료하고 SMTP를 Supabase에 연결했습니다.
발신자 이름은 모아 스튜디오이며 등록한 Gmail 발신 주소는 Brevo 인증 도메인으로
변환됩니다. 가입 확인 메일의 Gmail 받은편지함 도착, Brevo Delivered 기록,
이메일 확인 후 비밀번호 로그인까지 검증했습니다. 테스트 계정은 삭제했습니다.
가입 확인 메일 제목과 본문을 한국어로 설정했습니다.

- SMTP: smtp-relay.brevo.com:587
- 무료 메일 한도: 하루 300통, 현재 Supabase 인증 발송 제한은 시간당 30통
- SMTP 키: 2027-09-06 만료, 90일 미사용 시 조기 만료될 수 있음
- SMTP 비밀키는 Supabase의 암호화된 설정에 보관하며 로컬 임시 파일은 삭제
- 현재 무료 주소에서는 자체 도메인 DKIM 설정이 불가능하므로 발신 주소는
  Brevo의 변환 정책에 의존합니다. 별도 도메인 확보 시 발신 도메인을 인증하세요.

## 무료 한도와 운영

무료 범위 안에서 배포·DB의 정기 구독 비용 없이 시작하는 구성입니다.
사용량이 증가하면 각 서비스의 대시보드에서 한도를 확인해야 합니다.
Supabase 무료 프로젝트는 비활성 시 일시 정지될 수 있고 자동 백업을
제공하지 않으므로 별도 백업이 필요합니다. 토스 결제 수수료와
향후 AI API 사용료는 무료 배포 비용과 별개입니다.

공식 문서:
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://supabase.com/pricing
- https://supabase.com/docs/guides/auth/auth-smtp

## 현재 원격 검증 결과

- DB 마이그레이션 적용 완료, 작업 공간·결제·AI 사용량 테이블에 RLS 적용
- 사진 버킷 비공개, 파일당 5MB, JPEG/PNG/WEBP 제한 확인
- 원격 RLS·결제 기간·중복 승인 SQL 테스트 통과, 테스트 데이터 rollback 확인
- Supabase 보안 advisor: 경고 없음
- moa-payments 함수 배포 완료, 공개 설정 조회 200, 미인증·잘못된 토큰 401 확인
- Cloudflare 공개 배포 HTTP 200, HTTPS 및 보안 응답 헤더 확인
- 토스 테스트 키와 운영 URL을 비공개 서버 설정에 저장, config는 test/configured 상태
- 실제 클라우드 임시 계정 로그인, 보관함 저장·복원, 비공개 사진 업로드 검증
- 사진 서명 URL 다운로드 200, 공개 URL 접근 차단, 공개 웹에서 PNG 내보내기 통과
- 월 9,900/19,900원, 연 95,040/191,040원 주문 생성·조회 및 운영 콜백 URL 확인
- Node 테스트 41개, Edge Function 테스트 6개 통과; typecheck·build·클라우드 코드 검사 통과
- 가입 확인 메일 발송·수신·이메일 인증·인증 후 로그인 통과
- 이전 검증 계정·사진·주문 정리 완료. 이번 카드 테스트용 임시 계정과 미승인 테스트 주문은 결제창 확인을 위해 유지
- 클라우드 토스 최종 카드 승인은 아직 미검증
- 실제 결제는 활성화하지 않았으며 유료 기능은 출시 예정으로 표시


## 편집·유료 기능 준비 배포 (2026-09-06)

현재 배포: https://607833ed.moa-studio.pages.dev
운영 주소: https://moa-studio.pages.dev

- 무료 편집: 6개 레이아웃, 카드 1~10장, 제목·부제·본문·배지·사진·색상·글자 크기·정렬, 추가·삭제·순서 변경
- 게시글·해시태그 별도 편집, 선택형 홍보 일정과 시작일/항목 편집
- 브라우저 및 클라우드 저장 시 레이아웃·스타일·일정·추가 카드 보존
- 실결제 권한 기준 Studio/Plus 월별 생성량 30/100회와 브랜드 1/3개 제한 구현
- moa-content 배포 상태는 configured=false, mode=template. 실제 모델 생성 어댑터는 아직 연결하지 않음
- 테스트 결제로 유료 권한을 부여하지 않음. 실결제는 기능 준비·AI 준비·운영 활성화 게이트를 모두 통과해야 함
- 공개 사이트에서 테스트 카드 선택까지 진행. 필수 약관 동의 확인이 남아 최종 승인·콜백은 미검증
- 무료 AI 후보는 docs/free-ai-options.md에 조사만 기록했고 연동하지 않음

실제 편집·저장·다운로드·모바일 검증 자료: docs/design/content-release/verification.md


## 대화형 사진 수정 패널 (2026-09-06)

공개 배포 https://a2347262.moa-studio.pages.dev, moa-content v2.
우측 사진 수정 대화 패널과 변경안 적용·되돌리기 흐름을 추가했다.
실제 사진 편집 공급자는 미연결이며 `/status`의 `imageEditingConfigured`는 false다.
`POST /edit`는 로그인과 입력 검증 후 공급자 미연결 503을 반환한다.
수정 요청을 실제 AI가 처리하거나 사용량을 차감한 것으로 표시하지 않는다.
검증 상세: docs/design/photo-chat/verification.md. Node 48개, Edge 7개 통과.

## OpenAI 사진 편집 연결 (2026-09-07)

운영 웹 https://moa-studio.pages.dev 에서 우측 `AI와 수정하기` 패널을 이용한다.
Cloudflare Worker가 인증과 사용량을 확인한 뒤 OpenAI GPT Image 2로 사진
변경안을 생성한다. 이 연결은 Supabase moa-content의 유료 문구 생성과 독립적이다.

- Worker: https://moa-photo-edit.dlckdfuf141.workers.dev
- 프론트 설정: VITE_PHOTO_EDIT_API_URL
- 공급자 설정: OpenAI Images API, `gpt-image-2`, `1024x1024`, `medium`, JPEG 결과 1장
- 입력: 원본 및 참고 사진 최대 3장을 긴 변 1024px 이하 JPEG로 준비해 전송
- 사용량: 무료 체험 3회, 유료 플랜 월별 한도, 서비스 전체 하루 50회
- 현재 정리 검증: Node 테스트 141개, 빌드, 클라우드 비밀키 검사 통과
- Worker 정리 배포: `4532b4fd`, Cloudflare AI binding 없음, `/status`가 OpenAI GPT Image 2 설정 반환
- 이번 정리 검증에서는 실제 유료 AI 호출이나 사용량 차감은 하지 않음
- 세부 배포/사용량 경계: docs/cloudflare-photo-edit.md
- 유료 문구 생성 및 실결제 활성화 상태는 기존과 같다
