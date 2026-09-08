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

### 2026-09-08 운영 전환 확인

- 사용자가 외부 무료 백업 연결과 실결제 활성화를 요청했습니다. Backblaze B2의
  첫 10GB 무료 저장소와 현재 백업의 용량 적합성을 다시 확인했습니다. 가입 및
  로그인 단계에서 아직 계정 접근을 완료하지 못해 버킷과 저장소 키는 미연결입니다.
- Cloudflare R2도 확인했으나 아직 구독이 없으며, 시작 화면은 무료 한도 초과 시
  사용량 과금 및 자동 갱신 동의를 요구합니다. R2 구독은 추가하지 않았습니다.
- 토스에 로그인해 확인한 현재 테스트 상점 `link_tobuyw5ix`의 상태는 **심사중**,
  결제방식은 **링크페이**, 계약일은 미표시입니다. 일부 카드사 심사 승인 표시는
  있으나 전체 상점 계약 완료와 동일하지 않습니다. 전체상점 홈도 심사중이며
  등록 연락처로 심사 결과를 알린다고 표시합니다.
- 별도 빌링 상점의 계약 완료를 이 앱의 일반 결제 승인으로 대신하지 않았습니다.
  라이브 키 및 운영 결제 설정은 변경하지 않았고, 운영 API는 여전히 `mode: test`
  입니다. 자세한 내용은 [유료 출시 검증](paid-launch-verification.md)을 참고하세요.
- 사용자는 Google에 색인 완료가 표시됐다고 알렸고, 검색 설정은 다음 날까지
  그대로 두기로 했습니다. 2026-09-09 오전 10시 KST에 Google·네이버 상태를
  한 번 확인하도록 예약했습니다. 이 기록은 검색 노출의 독립 검증을 뜻하지 않습니다.

- Public domain remains `https://moa-studio.pages.dev`. No custom domain or 301 redirect is planned for this launch.
- GitHub baseline `d7426f8` is on the remote and tagged `v0.1.0-verified-baseline`.
- Current Cloudflare Pages deployment is `6fe6043e.moa-studio.pages.dev`, aliased to production.
- Google Search Console HTML tag verification is complete. On 2026-09-08, the additional HTML verification file `google0370e157dba29c8d.html` was found to return 404, deployed, and verified through Google’s own confirmation button; Search Console now reports both HTML file and tag verification complete. The sitemap and all seven listed public URLs return 200. Sitemap submission was accepted; Search Console still reports “could not fetch” for the submitted sitemap; Google live URL inspection fetches the sitemap successfully. The home index request is accepted. A fresh Google live inspection on 2026-09-08 at 12:49:55 KST reports crawl allowed and page fetch successful. The same sitemap was resubmitted once and Google acknowledged submission, but the report still displays “could not fetch” and zero discovered pages. Sitemap processing is not verified complete.
- Naver ownership verification has both the HTML meta tag and the issued `naver5845663b05524c7a6409523211371bb5.html` file deployed. On 2026-09-08, file-mode verification returned 404 because only the tag had been deployed; the issued file was added and verified against the public URL. Cloudflare redirects the `.html` URL to its extensionless route, which returns 200 with the exact issued content for normal and Yeti user agents. Ownership verification is now complete. On 2026-09-08 at 12:48 KST, `sitemap.xml` was submitted; the homepage crawl request was accepted at 12:49 KST. Search exposure and indexing are not yet confirmed.
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
- On 2026-09-08, the encrypted archive was actually restored into a local Supabase
  isolated on loopback. All backed-up column values in 30 tables matched, and all
  11 Storage files were downloaded again with matching SHA-256 hashes. Restored
  account login, workspace isolation, photo ownership and both rollback SQL suites
  passed. App object permissions, 11 functions and 21 policies match the source.
- The replay fixed managed DDL collisions by selecting app schema/data from the
  custom dump and preserving target platform objects. Storage logical metadata is
  restored while physical file versions remain target-generated. The existing
  Realtime publication migration was applied separately. See
  [the restore drill record](restore-drill-2026-09-08.md) for scope and evidence.
- [Free offsite storage research](free-offsite-backup.md) recommends Backblaze B2.
  B2/R2 S3 endpoint support is implemented, but no external account/bucket/key has
  been connected, so scheduled offsite uploads remain inactive.
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
- `BACKUP_AWS_ENDPOINT_URL` for B2/R2; leave unset for AWS S3

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

## Sitemap response verification — 2026-09-08

- Explicitly set `/sitemap.xml` to `Content-Type: application/xml; charset=utf-8`
  in the Cloudflare Pages headers and deployed the change.
- Production returned HTTP 200 with the XML declaration and sitemap namespace;
  all seven listed URLs returned HTTP 200 without redirects.
- Search Console's live URL test at 13:27 KST returned HTTP 200 and
  `application/xml`. Its tested-page source contained the complete XML sitemap,
  with no HTML document wrapper.
- The [referenced community discussion](https://support.google.com/webmasters/thread/282179767?hl=ko)
  suggests checking XML versus HTML response types, but does not establish a
  confirmed fix. Production already served XML before the explicit header, so
  this change does not establish the cause of the sitemap report error.
- The sitemap report still showed “Couldn't fetch” during verification. A
  successful live URL test does not establish successful sitemap processing.
- Resubmitted `sitemap.xml` once after deployment; Search Console confirmed
  submission, while the report still displayed “Couldn't fetch” immediately after.

## Incident restore posture

Do not restore directly into production during the first response. First decrypt and verify the archive, restore into an isolated project, compare data and Storage counts, then decide whether to promote the isolated project or plan a controlled production migration. Keep the production project intact until the recovery target has been validated.
