import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../cloudflare/photo-edit/index.mjs';
import { buildPersonGenerationPrompt, generateOpenAIPerson, parsePersonGenerationPayload } from '../cloudflare/photo-edit/person-generation.mjs';

const user = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const jpegBase64 = Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8]).toString('base64');

function payload(overrides = {}) {
  return { requestId, prompt: 'red-haired barista in a linen apron beside a cafe window', ...overrides };
}

function envWithQuota(quotaFetch) {
  return {
    APP_ORIGIN: 'https://moa-studio.pages.dev',
    PHOTO_EDIT_ENABLED: '1',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_PUBLISHABLE_KEY: 'public',
    OPENAI_API_KEY: 'test-key',
    PHOTO_QUOTA: { idFromName: name => name, get: () => ({ fetch: quotaFetch }) },
  };
}

function request(body, headers = {}) {
  return new Request('https://worker/generate-person', {
    method: 'POST',
    headers: { Authorization: 'Bearer valid', 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

test('person generation payload requires UUID request id and trimmed prompt within bounds before charge', () => {
  assert.deepEqual(parsePersonGenerationPayload({ requestId, prompt: '  cafe portrait  ' }), { requestId, prompt: 'cafe portrait' });
  assert.throws(() => parsePersonGenerationPayload({ requestId: 'bad', prompt: 'cafe portrait' }), /요청 정보/);
  assert.throws(() => parsePersonGenerationPayload({ requestId: [requestId], prompt: 'cafe portrait' }), /요청 정보/);
  assert.throws(() => parsePersonGenerationPayload({ requestId, prompt: '   ' }), /1자 이상 2000자 이하/);
  assert.throws(() => parsePersonGenerationPayload({ requestId, prompt: 'x'.repeat(2001) }), /1자 이상 2000자 이하/);
});

test('person generation prompt bounds output to a reusable fictional adult person with a plain background', () => {
  const promptText = buildPersonGenerationPrompt(payload({ prompt: 'short black hair, navy sweater, warm espresso bar background' }));
  assert.match(promptText, /fictional adult person/);
  assert.match(promptText, /20 years old or older/);
  assert.match(promptText, /cafe marketing/);
  assert.match(promptText, /plain neutral light background/);
  assert.match(promptText, /leave hands empty/);
  assert.match(promptText, /reusable person asset/);
  assert.match(promptText, /appearance, clothing, pose, and mood/);
  assert.match(promptText, /short black hair, navy sweater, warm espresso bar background/);
});

test('OpenAI person generation uses images generations JSON settings and validates image result', async () => {
  let captured;
  const result = await generateOpenAIPerson('test-key', payload(), async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/images/generations');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    assert.equal(options.headers['Content-Type'], 'application/json');
    captured = JSON.parse(options.body);
    return Response.json({ data: [{ b64_json: jpegBase64 }] });
  });

  assert.match(result, /^data:image\/jpeg;base64,/);
  assert.equal(captured.model, 'gpt-image-2');
  assert.equal(captured.size, '1024x1024');
  assert.equal(captured.quality, 'medium');
  assert.equal(captured.output_format, 'jpeg');
  assert.equal(captured.n, 1);
  assert.match(captured.prompt, /fictional adult person/);
  assert.equal('image' in captured, false);
});

test('person generation blocks missing and invalid auth before quota or provider calls', async () => {
  const originalFetch = globalThis.fetch;
  const quotaCalls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return Response.json({ error: 'expired' }, { status: 401 });
    throw new Error(`unexpected fetch ${value}`);
  };
  const env = envWithQuota(async (url, options) => {
    quotaCalls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ status: 200 });
  });

  try {
    const missing = await handleRequest(new Request('https://worker/generate-person', { method: 'POST' }), env);
    assert.equal(missing.status, 401);
    const invalid = await handleRequest(request(payload()), env);
    assert.equal(invalid.status, 401);
    assert.deepEqual(quotaCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('person generation rejects request bounds before reserving quota or calling provider', async () => {
  const originalFetch = globalThis.fetch;
  const quotaCalls = [];
  const providerCalls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return Response.json({ id: user });
    if (value.includes('/rpc/current_moa_ai_entitlement')) return Response.json([]);
    if (value.includes('/v1/images/generations')) {
      providerCalls.push(value);
      return Response.json({ data: [{ b64_json: jpegBase64 }] });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  const env = envWithQuota(async (url, options) => {
    quotaCalls.push({ url, body: JSON.parse(options.body) });
    return Response.json({ status: 200 });
  });

  try {
    const response = await handleRequest(request(payload({ prompt: 'x'.repeat(2001) })), env);
    assert.equal(response.status, 400);
    assert.deepEqual(quotaCalls, []);
    assert.deepEqual(providerCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('person generation returns quota rejection without calling provider', async () => {
  const originalFetch = globalThis.fetch;
  const providerCalls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return Response.json({ id: user });
    if (value.includes('/rpc/current_moa_ai_entitlement')) return Response.json([]);
    if (value.includes('/v1/images/generations')) {
      providerCalls.push(value);
      return Response.json({ data: [{ b64_json: jpegBase64 }] });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  const env = envWithQuota(async () => Response.json({ status: 429, error: 'limit reached', usage: { remaining: 0 } }, { status: 429 }));

  try {
    const response = await handleRequest(request(payload()), env);
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { status: 429, error: 'limit reached', usage: { remaining: 0 } });
    assert.deepEqual(providerCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('person generation refunds reserved user quota on provider failure', async () => {
  const originalFetch = globalThis.fetch;
  const quotaCalls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return Response.json({ id: user });
    if (value.includes('/rpc/current_moa_ai_entitlement')) return Response.json([]);
    if (value.includes('/v1/images/generations')) return Response.json({ error: { code: 'rate_limit_exceeded', message: 'raw rate detail' } }, { status: 429 });
    throw new Error(`unexpected fetch ${value}`);
  };
  const env = envWithQuota(async (url, options) => {
    quotaCalls.push({ url, ...JSON.parse(options.body) });
    return Response.json({ status: 200, usage: { remaining: 2 } });
  });

  try {
    const response = await handleRequest(request(payload()), env);
    assert.equal(response.status, 503);
    assert.doesNotMatch((await response.json()).error, /raw rate detail/);
    assert.equal(quotaCalls[0].userId, user);
    assert.equal(quotaCalls[0].requestId, requestId);
    assert.equal(quotaCalls[1].requestId, requestId);
    assert.equal(quotaCalls[1].succeeded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('person generation succeeds without a source photo and returns usage', async () => {
  const originalFetch = globalThis.fetch;
  const quotaCalls = [];
  let providerBody;
  globalThis.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes('/auth/v1/user')) return Response.json({ id: user });
    if (value.includes('/rpc/current_moa_ai_entitlement')) return Response.json([]);
    if (value.includes('/v1/images/generations')) {
      providerBody = JSON.parse(options.body);
      return Response.json({ data: [{ b64_json: jpegBase64 }] });
    }
    throw new Error(`unexpected fetch ${value}`);
  };
  const usage = { configured: true, used: 1, remaining: 2, globalRemaining: 49 };
  const env = envWithQuota(async (url, options) => {
    quotaCalls.push({ url, ...JSON.parse(options.body) });
    return Response.json(String(url).endsWith('/finish') ? { ok: true } : { status: 200, usage });
  });

  try {
    const response = await handleRequest(request({ ...payload(), photo: undefined }), env);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.match(body.imageDataUrl, /^data:image\/jpeg;base64,/);
    assert.deepEqual(body.usage, usage);
    assert.match(body.message, /가상 성인 인물 사진/);
    assert.equal(providerBody.model, 'gpt-image-2');
    assert.equal('image' in providerBody, false);
    assert.equal(quotaCalls[0].requestId, requestId);
    assert.equal(quotaCalls[1].succeeded, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
