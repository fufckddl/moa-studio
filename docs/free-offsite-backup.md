# Free Offsite Backup Target

The backup job supports S3-compatible object storage through `BACKUP_DESTINATION_URI=s3://...`. Standard AWS S3 still works without an endpoint. For S3-compatible providers, set the GitHub secret `BACKUP_AWS_ENDPOINT_URL` and the workflow passes it to the script as `AWS_ENDPOINT_URL`.

## Connected B2 destination — 2026-09-08

- Private bucket: `moa-studio-backup-20260908`, US West (`us-west-004`).
- Destination: `s3://moa-studio-backup-20260908/supabase`.
- Endpoint: `https://s3.us-west-004.backblazeb2.com`.
- Default SSE-B2 encryption is enabled, in addition to the backup script's GPG AES256 encryption.
- The application key is restricted to this bucket and the `supabase/` prefix. Its values are stored only in GitHub Actions secrets, not in this repository or the frontend.
- The account has no credit card registered. Caps & Alerts displays storage $0 / 10 GB, downloads $0 / 1 GB daily, and 2,500 daily Class B and Class C operations. All email usage alerts remain enabled. Editing caps requires adding a payment method; no payment method or paid service was added.
- The workflow limits each encrypted archive to 100 MiB and visible objects under the destination prefix plus the proposed upload to 1 GiB. A limit breach or invalid object size stops upload with an error. These safeguards supplement the provider's $0 caps; they do not measure hidden B2 versions.
- Provider lifecycle rules hide `supabase/` objects after 30 days and delete hidden versions one day later, including versions left behind by S3 deletions. The workflow also retains backups for 30 days.
- No Event Notifications, replication, Fireball, public bucket, or paid subscription is enabled for this backup.
- Standard Linux GitHub Actions runs use this public repository; no paid runner was configured.

The first remote backup verification is pending execution. The schedule remains daily at 02:00 KST; scheduled execution can be delayed by GitHub.

Backblaze documents that staying within free usage limits incurs no charge and that Class D operations such as Event Notifications cannot be capped. Keep the account's current $0 caps and avoid adding uncapped services. [Caps and alerts](https://www.backblaze.com/docs/cloud-storage-data-caps-and-alerts), [SSE pricing and behavior](https://www.backblaze.com/docs/cloud-storage-server-side-encryption).

## Recommendation

Use Backblaze B2 first for the current Moa Studio backup size.

The current encrypted archive is about 1.09 MB. A 30 day daily retention set is roughly 33 MB before growth, and still comfortably under a 10 GB free storage allowance. Backblaze lists B2 at $6.95/TB/month, states the first 10 GB of storage is always free, and says sign-up does not require a credit card. Its S3-compatible endpoint format is `https://s3.<region>.backblazeb2.com`, and Backblaze says those API endpoints accept HTTPS only.

Sources:

- Backblaze B2 pricing: https://www.backblaze.com/cloud-storage/pricing
- Backblaze B2 sign-up: https://www.backblaze.com/sign-up/cloud-storage
- Backblaze B2 S3-compatible API endpoint format: https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api

## Provider Comparison

| Provider | Free storage fit | Setup friction | Backup script fit | Notes |
| --- | --- | --- | --- | --- |
| Backblaze B2 | First 10 GB is free. This fits the current 30 day estimate by a wide margin. | Lowest. Backblaze advertises no credit card required for sign-up. | Direct S3-compatible fit with `AWS_ENDPOINT_URL=https://s3.<region>.backblazeb2.com`. | Best current option for a private offsite backup bucket. |
| Cloudflare R2 | 10 GB-month/month free on Standard storage. This fits the current backup size. | Higher. Cloudflare requires adding an R2 subscription through checkout before use, then bills monthly by usage. | S3-compatible fit with an R2 endpoint in `AWS_ENDPOINT_URL`. | Strong technical option if the account already exists and billing setup is acceptable. |
| Google Drive | Google accounts include up to 15 GB total storage. | Higher for automation. The storage is shared across Google Photos, Drive, and Gmail. | Not supported by this script without adding OAuth/API integration. | Usable manually, but a scheduled encrypted upload would require separate OAuth work and new code. |

Cloudflare sources:

- R2 pricing and free tier: https://developers.cloudflare.com/r2/pricing/
- R2 setup flow and S3-compatible access: https://developers.cloudflare.com/r2/get-started/

Google source:

- Google One storage plans: https://one.google.com/about/plans

## Backblaze B2 Setup

Create a private bucket dedicated to this backup. Do not make it public. Use a scoped application key for this one bucket or prefix only.

GitHub Actions secrets to set:

| Secret | Value |
| --- | --- |
| `BACKUP_DESTINATION_URI` | `s3://<private-bucket>/moa-studio/supabase` |
| `BACKUP_AWS_ACCESS_KEY_ID` | Backblaze B2 application key ID |
| `BACKUP_AWS_SECRET_ACCESS_KEY` | Backblaze B2 application key |
| `BACKUP_AWS_REGION` | B2 region, for example `us-west-004` |
| `BACKUP_AWS_ENDPOINT_URL` | B2 endpoint, for example `https://s3.us-west-004.backblazeb2.com` |

The backup script validates `AWS_ENDPOINT_URL` before invoking `aws`. It must be HTTPS and must not contain credentials, a bucket path, query parameters, or a hash fragment. Credentials belong only in `BACKUP_AWS_ACCESS_KEY_ID` and `BACKUP_AWS_SECRET_ACCESS_KEY`.

## Runner Prerequisites

The scheduled GitHub Actions backup installs PostgreSQL client 18 from the PostgreSQL Global Development Group apt repository. Do not rely on Ubuntu's default `postgresql-client` package for this backup: `pg_dump` must be at least the production server's major version, and matching `pg_restore` 18 keeps the custom-format archive compatible with the local restore tooling.

The workflow configures the PGDG apt source with the PostgreSQL signing key and an apt `Signed-By` source file, then installs `postgresql-client-18`. It installs `awscli` only when `BACKUP_DESTINATION_URI` starts with `s3://`.

## Retention And Cleanup

The script writes encrypted GPG archives and `.sha256` files, then deletes objects older than `BACKUP_RETENTION_DAYS`. The current default is 30 days.

For Backblaze B2, also configure a bucket lifecycle rule for the backup prefix. B2 may keep hidden or prior file versions depending on bucket version behavior, so configure lifecycle cleanup that hides old current versions and deletes hidden or previous versions after the required retention window. This keeps provider-side retained versions from growing beyond the script's visible object cleanup.

Keep the bucket private, keep the application key scoped to the backup bucket or prefix, retain only encrypted `.tar.gz.gpg` archives offsite, and store the GPG passphrase separately from the object storage account.
