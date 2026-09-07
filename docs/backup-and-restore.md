# Supabase DB 및 Storage 백업/복구

모아 스튜디오 운영 Supabase 프로젝트는 PostgreSQL 데이터와 Storage 파일을 함께 백업해야 합니다.
Supabase의 데이터베이스 백업은 Storage 객체 메타데이터는 포함할 수 있지만 실제 파일 바이트는 포함하지 않습니다. 이 절차는 DB dump와 Storage 다운로드를 분리해서 만든 뒤 하나의 암호화된 아카이브로 묶습니다.

운영 프로젝트:

- Supabase project ref: `mbmxkathxgvznuphbfbg`
- Supabase URL: `https://mbmxkathxgvznuphbfbg.supabase.co`
- 필수 DB schema: `public,auth,storage`
- 있으면 추가하는 DB schema: `moa_private`
- Storage bucket: 실행 시 `storage.buckets`에서 전체 bucket ID를 조회합니다.
- 보관 기간: 30일

## 필요한 비밀값

GitHub Actions의 `Supabase Backup` workflow가 사용하는 값입니다. 저장소에 커밋하거나 로그로 출력하지 않습니다.

| 이름 | 위치 | 설명 |
| --- | --- | --- |
| `SUPABASE_DB_URL` | GitHub Secret | Supabase PostgreSQL 연결 문자열입니다. `supabase db dump --db-url`과 schema 존재 확인에 사용합니다. |
| `SUPABASE_SERVICE_ROLE_KEY` | GitHub Secret | Storage bucket/object 목록 조회와 파일 다운로드에 사용합니다. |
| `BACKUP_ENCRYPTION_PASSPHRASE` | GitHub Secret | GPG AES256 대칭 암호화에 사용하는 긴 passphrase입니다. |
| `BACKUP_DESTINATION_URI` | GitHub Secret | 암호화된 백업을 보낼 비공개 외부 대상입니다. `s3://bucket/prefix` 또는 `file:///mounted/private/path` 형식을 지원합니다. |
| `BACKUP_AWS_ACCESS_KEY_ID` | GitHub Secret | `BACKUP_DESTINATION_URI`가 `s3://`일 때 필요합니다. 백업 버킷 쓰기와 보관 기간 삭제 권한만 부여합니다. |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | GitHub Secret | `s3://` 대상용 AWS secret입니다. |
| `BACKUP_AWS_REGION` | GitHub Secret | S3 버킷 리전입니다. |

CI 빌드 검증에는 별도로 `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`를 GitHub Actions variable 또는 secret으로 설정합니다. 이 두 값은 브라우저용 공개 설정이지만, workflow가 없으면 빌드 검증을 실패시켜 배포 전 누락을 드러냅니다.

`SUPABASE_DB_SCHEMAS`는 기본값 `public,auth,storage`를 사용합니다. `SUPABASE_OPTIONAL_DB_SCHEMAS`는 기본값 `moa_private`이며, 실행 시 실제 존재하는 schema만 dump 대상에 추가합니다. 새 비공개 schema가 생기면 `SUPABASE_OPTIONAL_DB_SCHEMAS=moa_private,새_schema`처럼 추가합니다.

`SUPABASE_STORAGE_BUCKETS`는 기본으로 설정하지 않습니다. 비어 있으면 스크립트가 `storage.buckets`를 조회해서 모든 bucket을 백업합니다. 특정 bucket만 백업해야 하는 임시 조사 때만 쉼표 구분 값으로 override합니다.

백업 실행 환경에는 `supabase`, `psql`, `pg_dump`, `gpg`, `tar`가 필요합니다. `s3://` 대상을 쓰면 `aws` CLI도 필요합니다. GitHub Actions workflow는 `postgresql-client`를 설치해서 `psql`과 `pg_dump`를 제공합니다.

## 백업 실행

수동 실행:

```bash
SUPABASE_PROJECT_REF=mbmxkathxgvznuphbfbg \
SUPABASE_URL=https://mbmxkathxgvznuphbfbg.supabase.co \
SUPABASE_DB_URL='postgresql://...' \
SUPABASE_SERVICE_ROLE_KEY='...' \
BACKUP_ENCRYPTION_PASSPHRASE='...' \
BACKUP_DESTINATION_URI='s3://private-bucket/moa-studio/supabase' \
node scripts/backup-supabase.mjs
```

설정만 확인하고 백업 파일을 만들지 않으려면:

```bash
node scripts/backup-supabase.mjs --dry-run
```

GitHub Actions:

- `.github/workflows/supabase-backup.yml`
- 매일 `17:00 UTC`에 실행합니다. 한국 시간으로 다음 날 `02:00 KST`입니다.
- `workflow_dispatch`에서 `dry_run=true`를 선택하면 비밀값과 대상 설정만 검증합니다.
- 수동 실행에서 필수 secret이 없으면 `::error`로 실패합니다.
- 예약 실행에서 아직 secret이 없으면 `::notice`를 남기고 backup step을 건너뜁니다. 초기 설정 전까지 매일 실패 알림을 만들지 않기 위한 동작입니다.

백업 산출물:

- `moa-studio-supabase-<timestamp>.tar.gz.gpg`
- `moa-studio-supabase-<timestamp>.tar.gz.gpg.sha256`
- 암호화 전 아카이브 내부:
  - `db/roles.sql`
  - `db/schema.sql`
  - `db/data.sql`
  - `db/selected-schemas.pg_dump`
  - `storage/<discovered bucket>/<object path>`
  - `manifest.json`

`manifest.json`에는 각 dump와 Storage 파일의 `sha256`, byte 크기, bucket/object 이름, Storage metadata, 생성 시간이 들어갑니다. 복구 스크립트는 tar 경로, tar link entry, 추출 후 symlink/hardlink, manifest 경로, checksum을 검증합니다.

## DB dump 범위와 한계

Supabase CLI 문서는 `supabase db dump`가 Supabase 내부 권한 문제를 줄이기 위해 managed schema를 필터링한다고 설명합니다. 같은 문서와 migration guide는 roles, schema, data를 별도 파일로 export하고 새 대상에서 `psql`로 restore하는 절차를 안내합니다. 따라서 이 도구는 두 종류의 DB artifact를 함께 보관합니다.

- `roles.sql`, `schema.sql`, `data.sql`: Supabase CLI가 만든 SQL dump입니다. 자동 복구 스크립트가 기본으로 사용하는 파일입니다.
- `selected-schemas.pg_dump`: `pg_dump --format=custom`로 만든 raw logical dump입니다. Supabase CLI가 managed schema를 필터링하더라도 `auth`, `storage`, `moa_private` 같은 발견된 schema의 구조와 데이터를 보존하기 위한 수동 복구/검사용 artifact입니다.

`auth`와 `storage` managed schema가 새 Supabase 프로젝트에서 그대로 복구 가능한지는 restore drill로 확인해야 합니다. Supabase managed table 소유자와 기본 권한은 플랫폼 서비스가 기대하는 값이 있으므로, raw dump를 운영 프로젝트에 바로 적용하지 않습니다.

현재 read-only metadata 기준으로 운영 DB에는 `auth.users`, `auth.identities`, `auth.sessions`, `storage.buckets`, `storage.objects`, `public.workspaces`, `public.payment_orders`, `public.moa_ai_requests`, `public.photo_chat_history`, `public.generated_people`가 있습니다. `moa_private` schema는 현재 보이지 않지만, 나중에 생성되면 기본 optional schema 설정으로 백업에 포함됩니다.

DB dump에 포함되지 않는 플랫폼 설정은 별도로 재설정해야 합니다.

- Supabase Auth Site URL, redirect URL, SMTP 설정
- OAuth provider 설정
- Edge Function secrets
- JWT secret/API key 자체
- Cloudflare Pages/Worker variables and secrets
- Toss, OpenAI, backup destination credentials

## 보관 기간

기본 보관 기간은 `BACKUP_RETENTION_DAYS=30`입니다.

- 로컬 또는 마운트된 `file://` 대상: 대상 디렉터리에서 `moa-studio-supabase-`로 시작하는 오래된 파일을 삭제합니다.
- `s3://` 대상: 같은 prefix의 오래된 백업 객체를 S3 API로 삭제합니다.
- `BACKUP_RETENTION_DAYS=0`이면 삭제하지 않습니다.

S3를 사용할 때는 백업 전용 IAM 사용자를 만들고 대상 prefix에 대한 최소 권한만 부여합니다.

## 복구 원칙

운영 프로젝트로 복구하지 않습니다. 복구는 새로 만든 격리 Supabase 프로젝트에서 먼저 검증합니다. 스크립트는 아래 조건을 만족하지 않으면 dry run도 진행하지 않습니다.

- `RESTORE_CONFIRM_ISOLATED_TARGET=1`
- `RESTORE_TARGET_PROJECT_REF`와 `RESTORE_EXPECTED_PROJECT_REF`가 정확히 일치
- target ref와 URL이 운영 프로젝트 `mbmxkathxgvznuphbfbg` 또는 `https://mbmxkathxgvznuphbfbg.supabase.co`가 아님

복구 dry run:

```bash
RESTORE_CONFIRM_ISOLATED_TARGET=1 \
RESTORE_TARGET_PROJECT_REF='isolatedrestoreproject' \
RESTORE_EXPECTED_PROJECT_REF='isolatedrestoreproject' \
RESTORE_TARGET_SUPABASE_URL='https://isolatedrestoreproject.supabase.co' \
RESTORE_ARCHIVE_PATH='/secure/backups/moa-studio-supabase-2026-09-07T17-00-00-000Z.tar.gz.gpg' \
RESTORE_ENCRYPTION_PASSPHRASE='...' \
node scripts/restore-supabase.mjs
```

dry run은 암호화 해제, tar path 검사, tar link 검사, 추출 후 link 검사, manifest 검사, checksum 검증까지만 수행합니다. DB 또는 Storage에는 쓰지 않습니다.

격리 프로젝트에 실제 복구:

```bash
RESTORE_CONFIRM_ISOLATED_TARGET=1 \
RESTORE_TARGET_PROJECT_REF='isolatedrestoreproject' \
RESTORE_EXPECTED_PROJECT_REF='isolatedrestoreproject' \
RESTORE_TARGET_SUPABASE_URL='https://isolatedrestoreproject.supabase.co' \
RESTORE_TARGET_DB_URL='postgresql://...' \
RESTORE_TARGET_SERVICE_ROLE_KEY='...' \
RESTORE_ARCHIVE_PATH='/secure/backups/moa-studio-supabase-2026-09-07T17-00-00-000Z.tar.gz.gpg' \
RESTORE_ENCRYPTION_PASSPHRASE='...' \
node scripts/restore-supabase.mjs --execute
```

`--execute`는 `psql --single-transaction`으로 `roles.sql`, `schema.sql`, `SET session_replication_role = replica`, `data.sql`을 적용하고, Storage 파일을 같은 bucket/object path로 업로드합니다. 대상 프로젝트는 비어 있는 새 프로젝트로 준비합니다. 기존 데이터가 있는 프로젝트에 덮어쓰는 방식으로 운영하지 않습니다.

`selected-schemas.pg_dump`는 자동으로 적용하지 않습니다. Supabase managed schema 충돌, 권한, 소유자 문제를 사람이 확인해야 하는 수동 복구 artifact입니다.

## 복구 검증 체크리스트

1. 복구 dry run이 checksum mismatch 없이 통과하는지 확인합니다.
2. 격리 프로젝트에 `--execute` 복구를 수행합니다.
3. Supabase SQL Editor에서 핵심 테이블 row count를 운영 백업 manifest 시점과 비교합니다.
4. `storage.objects`의 bucket별 객체 수를 manifest의 `storage.object_count`와 비교합니다.
5. 임의의 Storage 객체를 signed URL로 내려받아 manifest hash와 비교합니다.
6. 격리 프로젝트 URL과 publishable key로 `.env.production.local`을 임시 구성해 `npm run build && npm run check:cloud`를 실행합니다.
7. 이메일, OAuth, SMTP, Edge Function secrets, URL redirect 설정은 DB dump에 포함되지 않는 플랫폼 설정입니다. Supabase 대시보드와 운영 runbook 기준으로 별도 재설정합니다.
8. 결제 보관 기간 또는 `moa_private` schema가 추가된 뒤에는 `manifest.database.schemas`에 새 schema가 들어갔는지 확인합니다.
9. `selected-schemas.pg_dump`가 manifest에 있고 checksum 검증을 통과했는지 확인합니다.

## 공식 문서 기준

- Supabase CLI database dump: https://supabase.com/docs/reference/cli/supabase-db-dump
- Supabase database backups: https://supabase.com/docs/guides/platform/backups
- Supabase Storage copy and management guidance: https://supabase.com/docs/guides/storage
- Supabase Auth와 SMTP 설정: https://supabase.com/docs/guides/auth/auth-smtp
