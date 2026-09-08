# 출시 운영 Runbook

이 문서는 모아 스튜디오를 `https://moa-studio.pages.dev`와 Supabase 운영 프로젝트로 출시하기 전후에 확인할 운영 절차입니다.

## 현재 운영 기준

- GitHub repository: `https://github.com/fufckddl/moa-studio.git`
- Supabase project: `moa-studio`
- Supabase project ref: `mbmxkathxgvznuphbfbg`
- Supabase URL: `https://mbmxkathxgvznuphbfbg.supabase.co`
- Cloudflare Pages project: `moa-studio`
- Cloudflare Pages production URL: `https://moa-studio.pages.dev`

## 2026-09-07 출시 상태

- Public domain remains `https://moa-studio.pages.dev`. No custom domain or 301 redirect is planned for this launch.
- GitHub baseline `d7426f8` is on the remote and tagged `v0.1.0-verified-baseline`.
- Current Cloudflare Pages deployment is `6fe6043e.moa-studio.pages.dev`, aliased to production.
- Google Search Console HTML tag verification is complete. On 2026-09-08, the additional HTML verification file `google0370e157dba29c8d.html` was found to return 404, deployed, and verified through Google’s own confirmation button; Search Console now reports both HTML file and tag verification complete. The sitemap and all seven listed public URLs return 200. Sitemap submission was accepted; Search Console still reports “could not fetch” for the submitted sitemap; Google live URL inspection fetches the sitemap successfully. The home index request is accepted. Sitemap processing is not verified complete.
- Naver ownership verification has both the HTML meta tag and the issued `naver5845663b05524c7a6409523211371bb5.html` file deployed. On 2026-09-08, file-mode verification returned 404 because only the tag had been deployed; the issued file was added and verified against the public URL. Cloudflare redirects the `.html` URL to its extensionless route, which returns 200 with the exact issued content for normal and Yeti user agents. The ownership CAPTCHA remains user-pending.
- Turnstile is created and server auth protection is enabled. UI login QA passes, and a no-token password login returns `400 captcha_failed`.
- UI QA passed for free generation, autosave, reload, `1080x1350` PNG export, and ZIP export with 3 cards, caption, and schedule.
- Account direct API erase/delete passed. After the `moa-account` v2 CORS fix, browser data erase passes: Auth account retained, workspace rows removed, lifecycle lock released. Password recovery link and new password submission also pass. Final browser account deletion passed: Auth, workspace, active order, and Storage counts reached zero; six canceled test orders were archived, then only those QA archives were cleaned up.
- The AI gate is enabled with `MOA_AI_READY=1`. `TOSS_LIVE_ENABLED=0` and `PAID_FEATURES_READY=0` remain disabled, so live checkout is still unavailable.
- OpenAI Responses and Images permissions now pass real provider calls. The deployed content function reports live OpenAI mode; paid Light generation, 10-to-9 usage decrement, idempotent duplicate handling, failed-request quota recovery, free-account rejection, and a real `gpt-image-2` photo edit all passed. Temporary QA Auth, order, and AI-request data was removed.
- On 2026-09-08, the database password was reset with user authorization. A
  TLS Postgres connection succeeded, and public site, Auth health, and content
  provider status returned 200 after the reset.
- GitHub Actions secrets now contain `SUPABASE_DB_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `BACKUP_ENCRYPTION_PASSPHRASE`.
  `BACKUP_DESTINATION_URI` and external storage credentials remain unset, so
  scheduled off-machine backups are not active.
- A real AES256 encrypted local backup was created in the operator's
  `~/Moa Backups` directory: 4 DB dumps and 11 Storage objects. Restore dry-run
  decrypted and checksummed all 15 files successfully.
- Full isolated Supabase DB/Storage replay remains unverified. Docker image
  preparation exhausted local disk space; task-owned downloaded images were
  removed and Docker stopped. Existing Docker images were retained. The backup
  used the installed host PostgreSQL tools with the CLI-generated dump script.
- The current dump contains complete managed `auth`/`storage` schema DDL;
  replay into a fresh Supabase project needs a separate compatibility pass.
  Managed schema customizations and Storage metadata preservation must be
  checked before considering restore readiness complete.
- Supabase's own scheduled backups are unavailable on the current Free plan.
- Operational checks outside search and payments pass: both Storage buckets are
  private (`moa-photos` 10 objects, `moa-people` 1 object), an unauthenticated
  public object request is rejected, and a signed URL downloads the sampled
  object successfully. Brevo shows the production confirmation email progressing
  through sent, delivered, opened, and clicked states.
- A fresh production build and `npm run check:cloud` pass, including the public
  bundle secret scan. No OpenAI, Supabase secret/service-role, Toss secret,
  database credential, or backup passphrase pattern was found in `dist` or the
  recorded launch logs.
- Final local tests: 159 passed; Edge Function tests: 14 passed. Typecheck, production build, cloud bundle/secret checks, and rollback-only paid AI SQL validation passed. All six Toss test price/period combinations were approved, then canceled and synchronized through the deployed function without manual DB status updates.

## 출시 전 필수 Secret과 Variable

GitHub Actions variables 또는 secrets:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

GitHub Actions backup secrets:

- `SUPABASE_DB_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `BACKUP_ENCRYPTION_PASSPHRASE`
- `BACKUP_DESTINATION_URI`
- `BACKUP_AWS_ACCESS_KEY_ID`, `BACKUP_AWS_SECRET_ACCESS_KEY`, `BACKUP_AWS_REGION` when `BACKUP_DESTINATION_URI` starts with `s3://`

Backup defaults:

- `SUPABASE_DB_SCHEMAS=public,auth,storage`
- `SUPABASE_OPTIONAL_DB_SCHEMAS=moa_private`
- `SUPABASE_STORAGE_BUCKETS` is normally unset so every bucket in `storage.buckets` is discovered and backed up.

Supabase Edge Function secrets:

- `PUBLIC_APP_URL`
- `TOSS_CLIENT_KEY`
- `TOSS_SECRET_KEY`
- `TOSS_LIVE_ENABLED`
- `PAID_FEATURES_READY`
- `MOA_AI_READY`
- `OPENAI_API_KEY` for the deployed photo edit Worker path, if that path is enabled
- `SUPABASE_SERVICE_ROLE_KEY` or current `SUPABASE_SECRET_KEY` naming used by the function

Cloudflare Pages variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`
- `VITE_PHOTO_EDIT_API_URL` when the photo edit Worker is enabled

Cloudflare Worker secrets and vars for photo edit are documented in `docs/cloudflare-photo-edit.md`.

## Git baseline

Before changing launch-critical configuration, preserve the reviewed baseline on `main` and push it to the GitHub remote.

```bash
git remote -v
git status --short
git log --oneline -5
git tag -a launch-baseline-2026-09-07 -m "Preserve launch baseline before operations setup"
git push origin main
git push origin launch-baseline-2026-09-07
```

If the tag already exists, do not overwrite it unless the owner explicitly decides to move the release marker.

## CI 운영 검증

Workflow:

- `.github/workflows/ci-operations.yml`

It runs:

- `npm ci`
- `npm test`
- `node --test scripts/backup-helpers.test.mjs`
- `npm run test:cloud`
- `npm run typecheck`
- `npm run build`
- `npm run check:cloud`

`npm run check:cloud` requires `.env.production.local` with the public Supabase URL and publishable key. The workflow writes this file from Actions variables or secrets and fails with an explicit missing-configuration error when either value is absent.

Local equivalent:

```bash
npm ci
npm test
node --test scripts/backup-helpers.test.mjs
npm run test:cloud
npm run typecheck
npm run build
npm run check:cloud
```

## Backup readiness

Workflow:

- `.github/workflows/supabase-backup.yml`

Before the first launch:

1. Add the backup secrets listed above.
2. Run `Supabase Backup` manually with `dry_run=true`.
3. Confirm the workflow reports configuration success and creates no archive.
4. Run `Supabase Backup` manually with `dry_run=false`.
5. Confirm the destination contains both `.tar.gz.gpg` and `.sha256`.
6. Confirm no unencrypted archive remains in Actions artifacts or logs.
7. Confirm `manifest.database.schemas` includes every expected app schema, including `moa_private` if it exists.
8. Confirm `manifest.storage.buckets` includes every bucket in `storage.buckets`, including future photo chat buckets if they are split out.
9. Confirm `db/selected-schemas.pg_dump` is present for raw logical recovery of discovered schemas.
10. Record the archive timestamp in the launch notes.

The nightly schedule runs at `17:00 UTC`, which is `02:00 KST`. Scheduled runs with missing backup secrets emit notices and skip the backup step so an unconfigured repository does not fail every night before credentials are provisioned. Manual runs still fail on missing configuration.

## Restore drill

Run a restore drill before taking paid users or important customer data.

1. Create a separate Supabase project for restore validation.
2. Configure only temporary restore secrets locally. Do not point restore variables at production.
3. Run `node scripts/restore-supabase.mjs` without `--execute` against the encrypted archive.
4. Confirm checksum validation succeeds.
5. Run `node scripts/restore-supabase.mjs --execute` only against the isolated project.
6. Compare table counts and Storage object counts with the manifest.
7. Verify a sample private image byte hash after download.
8. Confirm Auth users, Storage metadata, and actual Storage bytes are all present in the isolated project.
9. Keep `selected-schemas.pg_dump` as a manual recovery fallback; do not apply it to production without a separate restore plan.
10. Delete the isolated project or lock it down after validation.

The restore script refuses production target `mbmxkathxgvznuphbfbg`.

Detailed commands are in `docs/backup-and-restore.md`.

## Launch gate

Proceed only when all items below are true:

- `CI Operations` workflow is green on the launch commit.
- `Supabase Backup` dry run succeeds.
- A real encrypted backup has been written to the private destination.
- A restore dry run has verified the encrypted archive checksum.
- A restore drill has succeeded in an isolated non-production Supabase project.
- Naver ownership CAPTCHA has been completed by the user if Naver Search Advisor is part of launch reporting.
- UI CORS retest for `moa-account` v2 has passed.
- Final local and cloud test counts have been recorded for the release.
- Real OpenAI Responses generation has passed with a key that includes `api.responses.write`, or `MOA_AI_READY` remains `0`.
- Supabase Auth Site URL is `https://moa-studio.pages.dev`.
- Supabase email redirects include `https://moa-studio.pages.dev/`.
- Storage buckets `moa-photos` and `moa-people` are private.
- Any additional bucket shown in `storage.buckets` is included in the encrypted backup manifest.
- Any added private schema, including `moa_private`, is included in the encrypted backup manifest when present.
- RLS tests pass.
- Cloudflare Pages deployment returns HTTP 200 on the production URL.
- `/api/health` or the relevant public health/status route returns an expected response.
- Toss live payments remain disabled unless the paid launch gate in `docs/payments.md` is fully complete.

## Post-launch checks

Within the first day:

- Confirm the scheduled backup ran and produced a new encrypted archive.
- Confirm the backup destination lifecycle or script retention is deleting objects older than 30 days.
- Confirm Cloudflare Pages serves the expected build hash.
- Confirm Supabase Auth signup email delivery with the configured SMTP sender.
- Confirm one authenticated save/load path and one private Storage download path.
- Confirm no service role key, Toss secret, OpenAI key, or backup passphrase appears in public build files or logs.

## Incident restore posture

Do not restore directly into production during the first response. First decrypt and verify the archive, restore into an isolated project, compare data and Storage counts, then decide whether to promote the isolated project or plan a controlled production migration. Keep the production project intact until the recovery target has been validated.
