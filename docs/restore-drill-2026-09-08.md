# 2026-09-08 Supabase 전체 데이터 복구 실습

## 결과

2026-09-08 13시(KST)에 기존 암호화 백업을 격리된 로컬 Supabase에 실제 복원하고,
데이터베이스의 백업 열 값 전체, 사진 파일, 로그인과 접근 권한을 검증했습니다.
운영 Supabase에는 복구 데이터를 쓰지 않았습니다.

| 검증 항목 | 결과 |
| --- | --- |
| 입력 백업 | `moa-studio-supabase-2026-09-08T02-22-58-032Z.tar.gz.gpg` |
| 암호화 파일 크기 | 1,090,851 bytes |
| 아카이브 무결성 | DB 덤프 4개 + Storage 파일 11개, 총 15개 SHA-256 일치 |
| 실제 복구 데이터 대조 | 30개 테이블에서 백업된 열을 양방향 `EXCEPT ALL`로 비교, 일치 |
| 사용자와 작업공간 | 사용자 4명, 작업공간 3개 복원 |
| 저장소 | 비공개 bucket 2개, 객체 11개 복원 |
| 사진 내용 | 11개 전부 복구 Storage API에서 다운로드, SHA-256 일치 |
| 앱 테이블/시퀀스 권한 | 8개 객체의 소유자·RLS·ACL이 원본과 일치 |
| 열 단위 권한 | 1개 열 ACL 일치 |
| 앱 함수 | 11개 함수의 정의·소유자·권한·보안 설정 일치 |
| 접근 정책 | 앱/Storage 정책 21개 일치 |
| Realtime publication | 기존 마이그레이션 별도 적용 후 `public.workspaces` membership 일치 |
| 로그인 | 복구 사용자로 로컬 인증 성공, 실제 이메일 발송 없음 |
| 작업공간 접근 | 본인 데이터 정확히 일치, 타 사용자 및 비로그인 접근 차단 |
| 사진 접근 | 본인 사진 2개 다운로드 성공, 타 사용자 접근 차단 10건 확인 |
| 앱 SQL 통합 검증 | `rls.sql`, `moa_content_ai.sql` 모두 통과, 테스트 transaction rollback |
| 재실행 보호 | 이미 복구한 대상으로 실행하면 empty-schema 검사에서 중단 |

정확한 데이터 대조는 로그인 테스트 전에 수행했습니다. 로그인 테스트는 격리 대상의
세션·인증 토큰을 새로 만들기 때문에 그 이후 인증 행은 자연스럽게 달라집니다.
정책 비교는 양쪽 DB의 `search_path`를 동일하게 비워 deparse 표현 차이를 제거했습니다.

## 실습 환경

- PostgreSQL 17.6 기반 Supabase 로컬 컨테이너
- Auth, Storage, REST API, Kong 및 DB 사용
- API `127.0.0.1:54321`, DB `127.0.0.1:54322`에만 바인딩
- 운영 키 대신 로컬 Supabase 키로 복구 API 호출
- SQL dump를 읽는 호스트 `pg_restore`는 18.4
- 검증 완료 후 실습 컨테이너는 중지하고, 복구 볼륨은 로컬에 보존

## 실습으로 발견해 수정한 문제

기존 복구는 `roles.sql`과 managed schema 전체를 그대로 적용했습니다.
실제 실행에서 플랫폼 파라미터 권한과 이미 존재하는 `auth.aal_level` type 때문에
실패했습니다. DB transaction이 rollback되어 부분 DDL은 남지 않았습니다.

수정 후에는 custom dump TOC로 앱 객체와 인증 데이터를 선택하고,
대상 Supabase의 기본 role·managed DDL·플랫폼 migration 이력을 유지합니다.
앱 권한은 기존 대상의 기본 grant 영향을 제거한 후 원본 권한을 적용합니다.

Storage는 파일을 먼저 업로드하고 원본 metadata를 맞춥니다. 원본 `version`을
덮어쓰면 새 파일의 실제 저장 위치를 찾지 못하므로 대상의 내부 version을 유지합니다.
ID, 소유자, 시각, MIME type, cache metadata와 사용자 metadata는 백업과 대조했습니다.

## 복구 범위와 남은 설정

이 결과는 **현재 Moa의 DB 데이터와 Storage 파일을 로컬 Supabase에 복구한 검증**입니다.
새 hosted Supabase 프로젝트에 대한 배포·전환 검증은 별도입니다.

- Realtime publication은 현재 아카이브에 포함되지 않아 기존
  `20260907082806_enable_workspace_realtime.sql`을 별도로 적용했습니다.
  Realtime 서버의 실제 이벤트 전송은 이번 데이터 복구 실습 범위에 포함하지 않았습니다.
- SMTP, OAuth, Auth redirect URL, JWT/API key, Edge Function secrets는 별도 설정입니다.
  원본 로그인 토큰이 새 JWT 키에서도 그대로 유효한 것은 아닙니다.
- Cloudflare 배포, Toss 실제 결제/환불, OpenAI 실제 유료 호출은 실행하지 않았습니다.
- 현재 비어 있는 내부 벡터·분석·multipart 테이블은 자동 복구 대상에서 제외합니다.
  데이터가 생기면 명시적 이관 절차가 필요하며 스크립트는 비어 있지 않으면 중단합니다.
- 외부 정기 백업은 **미연결**입니다. B2/R2 endpoint 지원 코드는 준비됐지만,
  외부 계정·비공개 bucket·Application Key를 연결하기 전에는 정기 업로드가 시작되지 않습니다.

## 코드 검증

- Node 테스트 174개 통과
- 새 복구 계획/helper 및 S3 endpoint 회귀 테스트 포함
- TypeScript typecheck, production build, cloud bundle 검사, JavaScript 문법 검사, diff 공백 검사 통과
- 백업 workflow YAML 및 내장 Bash 문법 검사 통과. 외부 저장소 미설정으로 실제 B2 업로드와 GitHub 백업 작업 실행은 미검증
- 독립 코드 리뷰에서 현재 복구 경로의 차단 이슈 없음

절차: [백업/복구 운영 문서](backup-and-restore.md)
무료 외부 저장소 비교: [Backblaze B2 / R2 / Drive](free-offsite-backup.md)
