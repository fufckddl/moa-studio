# 모션 · 계정 검증

- 데스크톱 로그인 창, 모바일 390×844 회원가입 창과 헤더: 직접 브라우저 확인, 가로 넘침 없음.
- 이메일 회원가입, 새 계정 보관함 저장, 새로고침 세션 유지, 로그아웃, 잘못된 비밀번호 오류, 재로그인 후 프로젝트 복원 확인.
- UI 테스트용 임시 계정은 로그아웃 후 삭제.
- 홈 로그인 버튼 및 모달 닫기 동작 확인. 최종 브라우저 콘솔 오류 없음.
- 스크롤 0 → 783px에서 사진 transform scale 1.04 → 1.07843, translateY 0 → 35.2269px 확인. 텍스트 translateY 0 → -28.8221px. 소개 영역 2개 reveal 확인.
- reduced-motion 미디어 쿼리에서 CSS 모션 해제 및 JS change listener/정리 로직 코드 검토. 실제 운영체제 설정 변경 테스트는 수행하지 않음.
- npm test: 12/12 통과. 회원별 격리, 잘못된 Origin, 세션 해시, 로그아웃, stale-tab 방지, rate limit 및 기존 생성 검증 포함.
- npm run build: TypeScript 검사 및 Vite production build 통과, 44 modules.
- 별도 lint 명령은 프로젝트에 구성되지 않음.

현재 인증은 로컬 SQLite/HTTP 개발 서버 범위. 이메일 인증·재설정·소셜 로그인·운영 배포는 미포함.
