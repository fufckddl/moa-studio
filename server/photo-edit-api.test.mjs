import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const originalApiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  .replace(/^import .* from '\.\.\/shared\/template\.mjs';$/m, 'const makeTemplatePack = () => {}, validateTemplateRequest = () => {};');

async function loadApi({ photoEditApiUrl = '', token = 'test-session' } = {}) {
  const apiSource = originalApiSource
    .replace(
      /^import .* from '\.\/lib\/supabase';$/m,
      `const getAccessToken = async () => ${JSON.stringify(token)}; const isCloudConfigured = true; const supabaseUrl = 'https://example.test'; const supabasePublishableKey = 'test-public';`,
    )
    .replace(
      'const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};',
      `const env = { VITE_PHOTO_EDIT_API_URL: ${JSON.stringify(photoEditApiUrl)} };`,
    );
  const { outputText } = ts.transpileModule(apiSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return await import(`data:text/javascript;base64,${Buffer.from(`${outputText}\n// ${crypto.randomUUID()}`).toString('base64')}`);
}

const usage = {
  configured: true,
  plan: 'free',
  limit: 3,
  used: 1,
  remaining: 2,
  period: 'day',
  periodStart: '2026-09-07T00:00:00.000Z',
  periodEnd: '2026-09-08T00:00:00.000Z',
  globalRemaining: 42,
};
const request = {
  photo: { id: 'photo', name: '라떼', dataUrl: 'data:image/jpeg;base64,AAAA' },
  prompt: '컵은 유지하고 배경을 밝게',
  requestId: '00000000-0000-4000-8000-000000000001',
  messages: [],
};
const reference = {
  id: 'ref-1',
  name: '참고',
  dataUrl: 'data:image/jpeg;base64,BBBB',
  purpose: 'style',
};

test('photo edit status and usage use configured Worker URL with Supabase bearer auth', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example/photo-edit/' });
  const calls = [];
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    if (String(url).endsWith('/status')) {
      return Response.json({
        imageEditingConfigured: true,
        imageEditingProvider: 'openai',
      });
    }
    return Response.json(usage);
  });

  const status = await api.getPhotoEditStatus();
  const receivedUsage = await api.getPhotoEditUsage();

  assert.equal(calls[0].url, 'https://worker.example/photo-edit/status');
  assert.equal(calls[1].url, 'https://worker.example/photo-edit/usage');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer test-session');
  assert.equal(calls[0].options.headers.apikey, undefined);
  assert.equal(status.configured, true);
  assert.equal(status.provider, 'openai');
  assert.deepEqual(receivedUsage, usage);
  assert.ok(timeouts.includes(30_000));
});

test('photo edit usage reports login action without inventing free quota when Worker auth is missing', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example', token: null });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not run');
  });

  const status = await api.getPhotoEditStatus();
  const receivedUsage = await api.getPhotoEditUsage();

  assert.equal(status.configured, false);
  assert.match(status.reason, /로그인/);
  assert.equal(status.usage, undefined);
  assert.equal(receivedUsage.configured, false);
  assert.equal(receivedUsage.limit, undefined);
  assert.match(receivedUsage.reason, /로그인/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('photo edit client sends references, bounded history, auth, and at least 120 seconds timeout', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  const timeouts = [];
  let received;
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return new AbortController().signal;
  });
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    received = { url, options, body: JSON.parse(options.body) };
    return Response.json({ imageDataUrl: request.photo.dataUrl, message: '변경안을 확인해 주세요.', usage });
  });
  const messages = Array.from({ length: 24 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `수정 ${index}`, references: [reference] }));

  const protectedRegion = { x: 0.25, y: 0.1, width: 0.5, height: 0.6 };
  const response = await api.editPhoto({ ...request, messages, references: [reference], protectedRegion });

  assert.equal(response.imageDataUrl, request.photo.dataUrl);
  assert.deepEqual(response.usage, usage);
  assert.equal(received.url, 'https://worker.example/edit');
  assert.equal(received.options.headers.Authorization, 'Bearer test-session');
  assert.equal(received.options.headers.apikey, undefined);
  assert.deepEqual(received.body.photo, request.photo);
  assert.deepEqual(received.body.references, [reference]);
  assert.deepEqual(received.body.protectedRegion, protectedRegion);
  assert.deepEqual(received.body.messages, messages.slice(-20).map(message => ({ role: message.role, content: message.content })));
  assert.equal(received.body.prompt, request.prompt);
  assert.ok(timeouts.some(ms => ms >= 120_000));
});

test('photo edit client falls back to existing Supabase function when Worker URL is absent', async t => {
  const api = await loadApi();
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (String(url).endsWith('/status')) return Response.json({ configured: false, mode: 'template' });
    if (String(url).endsWith('/usage')) return Response.json({ error: '요청한 경로를 찾을 수 없습니다.' }, { status: 404 });
    return Response.json({ error: '사진 편집 공급자가 아직 연결되지 않았습니다.' }, { status: 503 });
  });

  const status = await api.getPhotoEditStatus();
  await assert.rejects(api.getPhotoEditUsage(), /요청한 경로/);
  await assert.rejects(api.editPhoto(request), /사진 편집 공급자/);

  assert.equal(status.configured, false);
  assert.equal(calls[0].url, 'https://example.test/functions/v1/moa-content/status');
  assert.equal(calls[0].options.headers.apikey, 'test-public');
  assert.equal(calls[1].url, 'https://example.test/functions/v1/moa-content/usage');
  assert.equal(calls[2].url, 'https://example.test/functions/v1/moa-content/edit');
  assert.equal(calls[2].options.headers.apikey, 'test-public');
  assert.equal(calls[2].options.headers.Authorization, 'Bearer test-session');
});

test('photo edit client preserves Worker Korean errors including daily limit responses', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '오늘 무료 사진 편집 3회를 모두 사용했어요. 한국 시간 오전 9시에 다시 사용할 수 있어요.' }, { status: 429 }));

  await assert.rejects(api.editPhoto(request), /오늘 무료 사진 편집 3회/);
});

test('photo edit client refuses invalid Worker reference inputs before fetch', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('fetch should not run');
  });

  await assert.rejects(api.editPhoto({
    ...request,
    photo: { ...request.photo, dataUrl: 'data:image/png;base64,AAAA' },
  }), /JPEG/);
  await assert.rejects(api.editPhoto({
    ...request,
    references: [{ ...reference, dataUrl: 'data:image/png;base64,BBBB' }],
  }), /참고 이미지는 JPEG/);
  await assert.rejects(api.editPhoto({
    ...request,
    references: [reference, reference, reference, reference],
  }), /최대 3장/);
  await assert.rejects(api.editPhoto({
    ...request,
    references: [{ ...reference, dataUrl: `data:image/jpeg;base64,${'A'.repeat(3 * 1024 * 1024)}` }],
  }), /3MB/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test('personal quota exemption preserves unlimited flag and the shared service ceiling', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ configured: true, plan: 'free', unlimited: true, limit: null, remaining: null, used: 4, globalRemaining: 0 }));
  const result = await api.getPhotoEditUsage();
  assert.equal(result.unlimited, true);
  assert.equal(result.remaining, undefined);
  assert.equal(result.limit, undefined);
  assert.equal(result.used, 4);
  assert.equal(result.globalRemaining, 0);
});


test('photo edit client accepts detailed reference payloads above the old 700KB limit', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  const detailed = { ...reference, dataUrl: `data:image/jpeg;base64,${'A'.repeat(900000)}` };
  let sent;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    sent = JSON.parse(options.body);
    return Response.json({ imageDataUrl: request.photo.dataUrl, message: '변경안', usage });
  });
  await api.editPhoto({ ...request, references: [detailed] });
  assert.equal(sent.references[0].dataUrl, detailed.dataUrl);
});


test('photo usage normalization preserves light membership and one-time free period', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example' });
  let response = { ...usage, plan: 'light', limit: 10, remaining: 9, period: 'month' };
  t.mock.method(globalThis, 'fetch', async () => Response.json(response));
  assert.equal((await api.getPhotoEditUsage()).plan, 'light');
  response = { ...usage, period: 'lifetime', periodStart: '1970-01-01T00:00:00.000Z', periodEnd: '9999-12-31T00:00:00.000Z' };
  assert.equal((await api.getPhotoEditUsage()).period, 'lifetime');
});

test('person generation sends a text-only request to the Worker using the authenticated account', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example/' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return Response.json({ imageDataUrl: 'data:image/jpeg;base64,/9j/AA==', message: '인물을 만들었어요.', usage });
  });
  const result = await api.generatePerson('  카페의 성인 바리스타  ', request.requestId);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://worker.example/generate-person');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-session');
  assert.equal(calls[0].options.headers.apikey, undefined);
  assert.deepEqual(JSON.parse(calls[0].options.body), { prompt: '카페의 성인 바리스타', requestId: request.requestId });
  assert.equal(result.imageDataUrl, 'data:image/jpeg;base64,/9j/AA==');
  assert.equal(result.usage.remaining, 2);
});

test('person generation rejects unauthenticated or invalid requests before calling the provider', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('unexpected fetch'); });
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example/' });
  await assert.rejects(api.generatePerson(' ', request.requestId), /인물 설명/);
  await assert.rejects(api.generatePerson('a'.repeat(2001), request.requestId), /인물 설명/);
  await assert.rejects(api.generatePerson('인물', 'bad-request-id'), /요청 정보/);
  const guestApi = await loadApi({ photoEditApiUrl: 'https://worker.example/', token: null });
  await assert.rejects(guestApi.generatePerson('인물', request.requestId), /로그인/);
  const disconnectedApi = await loadApi();
  await assert.rejects(disconnectedApi.generatePerson('인물', request.requestId), /서버가 아직 연결/);
  assert.equal(calls, 0);
});

test('person generation reports quota errors and rejects malformed successful images', async t => {
  const api = await loadApi({ photoEditApiUrl: 'https://worker.example/' });
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: '생성 횟수를 모두 사용했어요.' }, { status: 429 }));
  await assert.rejects(api.generatePerson('인물', request.requestId), /생성 횟수를 모두/);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ imageDataUrl: 'javascript:alert(1)' }));
  await assert.rejects(api.generatePerson('인물', request.requestId), /응답이 올바르지/);
});

test('brand entitlements allow one free profile and three for every paid plan', async t => {
  const api = await loadApi();
  assert.equal(api.freeEntitlements().brandLimit, 1);
  let plan = 'free';
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ plan, brandLimit: 3 }), { status: 200 }));
  for (plan of ['free', 'light', 'studio', 'plus']) {
    assert.equal((await api.getEntitlements()).brandLimit, plan === 'free' ? 1 : 3);
  }
});
