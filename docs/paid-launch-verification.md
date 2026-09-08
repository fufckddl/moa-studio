# Paid Launch Verification

Live paid checkout stays disabled until all gates below are complete. Keep
`TOSS_LIVE_ENABLED=0` and `PAID_FEATURES_READY=0` until the final live
verification pass. `MOA_AI_READY=1` has passed real provider verification.

## 2026-09-07 Status

- Live checkout gates remain disabled: `TOSS_LIVE_ENABLED=0` and
  `PAID_FEATURES_READY=0`. The verified AI gate is `MOA_AI_READY=1`.
- Public production domain remains `https://moa-studio.pages.dev`; no custom
  domain or redirect is planned for this launch.
- Turnstile is created and server auth is enabled. UI login QA passes, and a
  password login without a Turnstile token returns `400 captcha_failed`.
- UI QA passed for free generation, autosave, reload, `1080x1350` PNG export,
  and ZIP export with 3 cards, caption, and schedule.
- Direct account erase/delete API QA passed. `moa-account` v2 fixes the
  browser CORS preflight. Browser data erase, password recovery, and final account deletion pass.
  Deletion removed Auth/workspace/active orders/Storage and archived six test
  payment records; those QA-only archives were then cleaned up.
- Toss SDK test-only sandbox auth is applied. The first actual QA Light monthly
  `3,900원` checkout completed with order
  `moa_2842e99a13fb40a0b7adda96eb5f9622`.
- All six price/period combinations were approved through the actual Toss
  test SDK checkout and server confirmation. All six were then canceled through
  the Toss test API, and the deployed `moa-payments` v12 synchronized `CANCELED`
  on order lookup without manual DB status updates. Test payments never grant
  live membership. The UI now explicitly displays cancellation and refund help.
- The restricted OpenAI key now has Responses and Images write permissions.
  A direct Responses call with `gpt-5.6-luna`, image input, and strict JSON
  schema output returned `200`, and the deployed `moa-content` status reports
  `configured: true`, `provider: openai`, and `mode: live`.
- A temporary paid Light QA entitlement verified real AI generation, usage
  decrement from 10 to 9, idempotent duplicate response without another usage
  decrement, failed-provider recovery without usage loss, and `402` rejection
  for a free account. Temporary Auth, order, and AI-request rows were removed.
- The deployed photo-edit Worker also completed a real `gpt-image-2` edit and
  returned a valid JPEG. The temporary free-trial quota moved from 3 to 2.
- `MOA_AI_READY=1` is now set. `TOSS_LIVE_ENABLED=0` and
  `PAID_FEATURES_READY=0` remain disabled pending backup/restore readiness and
  the final live-payment decision.
- Final local tests: 159 passed. Edge Function tests: 14 passed. Typecheck,
  build, cloud bundle/secret checks, and rollback-only paid AI SQL checks passed.
  Paid launch remains blocked on backup/restore readiness and the remaining
  operational gates.

## Current Prices

| Plan     |  Monthly |    Yearly |
| -------- | -------: | --------: |
| Light    |  3,900원 |  42,000원 |
| Standard |  7,900원 |  85,000원 |
| Pro      | 12,900원 | 139,000원 |

The server owns these amounts. Client-submitted amounts are ignored during order
creation and rejected during payment confirmation if they differ from the stored
order amount.

## Required Server Secrets

- `TOSS_CLIENT_KEY` and `TOSS_SECRET_KEY`: same Toss Payments key mode and same
  merchant account.
- `PUBLIC_APP_URL`: HTTPS production origin for live payments.
- `OPENAI_API_KEY`: server-only secret for Supabase Edge Function `moa-content`;
  restricted keys must include Responses API write permission.
- `MOA_AI_PROVIDER=openai`: enables OpenAI content generation when
  `OPENAI_API_KEY` is present.
- `MOA_AI_MODEL`: optional; defaults to `gpt-5.6-luna`.

Do not expose Toss secret keys, Supabase service role keys, or OpenAI API keys
in frontend environment variables.

## AI Content Gate

`moa-content` uses the OpenAI Responses API with structured JSON output. The
function sends brand, brief, and image data to OpenAI only after a paid
entitlement reservation succeeds. It then validates the returned content pack
shape before marking the request as succeeded.

Provider failures, timeouts, malformed JSON, or invalid content shape call
`fail_moa_ai_request`; failed requests do not count toward monthly usage.
Template mode is used only when OpenAI is not configured and does not reserve
paid quota. A previously succeeded `requestId` returns the stored response
without a second OpenAI call.

Before setting `MOA_AI_READY=1`, verify:

1. `GET /moa-content/status` returns `configured: true`, `provider: openai`,
   `mode: live`.
2. A direct Responses API smoke test with the configured key succeeds for
   `gpt-5.6-luna`, image input, and strict JSON schema output.
3. A paid Light account can generate an AI pack and remaining usage decreases
   from 10 to 9.
4. A duplicate submit with the same `requestId` returns the same saved AI pack
   without another OpenAI call.
5. A forced provider failure records the request as `failed` and does not reduce
   remaining monthly usage.
6. A free account receives `402` for `/generate`.

## Payment And Refund Gate

Toss live checkout is enabled only when `TOSS_LIVE_ENABLED=1`,
`PAID_FEATURES_READY=1`, and `MOA_AI_READY=1` are all set with live keys and
HTTPS `PUBLIC_APP_URL`.

Refunds are handled in the Toss Payments dashboard. The app verifies status
through Toss lookup APIs and treats `CANCELED` and `PARTIAL_CANCELED` as revoked
membership states. Webhooks never grant paid access from the webhook body; they
re-query Toss and only sync cancellation state when the provider payment matches
the stored order.

Before setting `PAID_FEATURES_READY=1`, verify:

1. Orders are created with the server prices in this document.
2. Amount tampering is rejected before any Toss confirm call.
3. Order lookup is scoped to the authenticated owner.
4. Duplicate confirmation of the same paid order is idempotent.
5. Toss provider status `CANCELED` or `PARTIAL_CANCELED` revokes membership on
   order lookup, order history, and membership lookup.
6. Support has a manual refund procedure using order id, account email, payment
   date, and Toss dashboard status.

## Local Verification Commands

Run these before deployment:

```bash
npm test
npm run test:cloud
npm run typecheck
npm run build
```

Run the rollback-only SQL paid AI checks against the intended Supabase database
after migrations are applied:

```bash
psql "$DATABASE_URL" -f supabase/tests/moa_content_ai.sql
```

## External References

- OpenAI Responses API text generation:
  https://platform.openai.com/docs/guides/text
- OpenAI structured outputs:
  https://platform.openai.com/docs/guides/structured-outputs
- OpenAI models: https://platform.openai.com/docs/models
- Toss Payments payment window integration:
  https://docs.tosspayments.com/guides/v2/payment-window/integration
- Toss Payments API authentication:
  https://docs.tosspayments.com/reference/using-api/authorization
