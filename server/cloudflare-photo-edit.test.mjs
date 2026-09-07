import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { initializeQuota, reserveQuota, finishQuota } from '../cloudflare/photo-edit/quota.mjs';
import { parsePayload, handleRequest } from '../cloudflare/photo-edit/index.mjs';

import { buildEditPrompt } from '../cloudflare/photo-edit/openai.mjs';

const user = '00000000-0000-4000-8000-000000000001';
const requestId = '00000000-0000-4000-8000-000000000002';
const id = () => crypto.randomUUID();
function store() {
  const db = new DatabaseSync(':memory:');
  const sql = { exec(query, ...args) { const s = db.prepare(query); return s.columns().length ? s.all(...args) : (s.run(...args), []); } };
  initializeQuota(sql); return sql;
}
function input(width = 480, height = 320) {
  const jpeg = Buffer.from([255,216,255,192,0,11,8,height >> 8,height & 255,width >> 8,width & 255,1,1,0x11,0,255,217]);
  return { requestId, photo: { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, prompt: '배경을 밝게', messages: [] };
}

test('photo quota limits each user, rejects replay, refunds failed user attempts without resetting at UTC day boundary', () => {
  const sql = store(), now = new Date('2026-09-06T23:59:59Z');
  const first = id();
  assert.equal(reserveQuota(sql,user,first,now).status,200);
  assert.equal(reserveQuota(sql,user,first,now).status,409);
  assert.equal(reserveQuota(sql,user,id(),now).status,200);
  assert.equal(reserveQuota(sql,user,id(),now).status,200);
  assert.equal(reserveQuota(sql,user,id(),now).status,429);
  finishQuota(sql,first,false);
  assert.equal(reserveQuota(sql,user,id(),now).status,200);
  assert.equal(reserveQuota(sql,user,id(),new Date('2026-09-07T00:00:00Z')).status,429);
});

test('global cap counts uncertain or failed provider calls across users', () => {
  const sql = store();
  for (let i=0;i<50;i++) { const request = id(); assert.equal(reserveQuota(sql,id(),request).status,200); finishQuota(sql,request,false); }
  assert.equal(reserveQuota(sql,id(),id()).status,429);
});

test('photo input enforces decoded JPEG dimensions and rejects remote, oversized data URLs and invalid history', () => {
  assert.equal(parsePayload(input()).width,480);
  assert.equal(parsePayload(input(1024,480)).width,1024);
  assert.throws(() => parsePayload(input(1025,480)),/1024픽셀/);
  assert.throws(() => parsePayload({...input(),photo:{dataUrl:'https://example.com/private.jpg'}}),/JPEG/);
  assert.throws(() => parsePayload({...input(),photo:{dataUrl:`data:image/jpeg;base64,${'A'.repeat(3000000)}`}}),/JPEG/);
  assert.throws(() => parsePayload({...input(),photo:{dataUrl:'data:image/jpeg;base64,YWJj'}}),/JPEG/);
  assert.throws(() => parsePayload({...input(),messages:[{role:'system',content:'x'}]}),/대화/);
});

test('protected region is optional, normalized and must stay inside the source canvas', () => {
  assert.equal(parsePayload(input()).protectedRegion, undefined);
  assert.deepEqual(parsePayload({ ...input(), protectedRegion: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 } }).protectedRegion, { x: 0.25, y: 0.1, width: 0.5, height: 0.6 });
  assert.throws(() => parsePayload({ ...input(), protectedRegion: { x: Number.NaN, y: 0, width: 0.5, height: 0.5 } }), /좌표/);
  assert.throws(() => parsePayload({ ...input(), protectedRegion: { x: 0, y: 0, width: 0, height: 0.5 } }), /사진 안/);
  assert.throws(() => parsePayload({ ...input(), protectedRegion: { x: 0.75, y: 0, width: 0.5, height: 0.5 } }), /사진 안/);
  assert.throws(() => parsePayload({ ...input(), protectedRegion: { x: -0.1, y: 0, width: 0.5, height: 0.5 } }), /사진 안/);
});

test('public API reports OpenAI provider status and blocks unauthenticated and cross origin edits before quota or provider calls',async () => {
  const env = { APP_ORIGIN:'https://moa-studio.pages.dev',PHOTO_EDIT_ENABLED:'1',OPENAI_API_KEY:'test-key',PHOTO_QUOTA:{},SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public' };
  const status = await handleRequest(new Request('https://worker/status'),env);
  const statusBody = await status.json();
  assert.equal(statusBody.imageEditingConfigured,true);
  assert.equal(statusBody.imageEditingProvider,'openai');
  assert.equal(statusBody.imageEditingModel,'gpt-image-2');
  assert.equal(statusBody.imageEditingSize,'1024x1024');
  assert.equal(statusBody.imageEditingQuality,'medium');
  const unready = await handleRequest(new Request('https://worker/status'),{...env,OPENAI_API_KEY:undefined});
  assert.equal((await unready.json()).imageEditingConfigured,false);
  const unauthenticated = await handleRequest(new Request('https://worker/edit',{method:'POST'}),env);
  assert.equal(unauthenticated.status,401);
  const cross = await handleRequest(new Request('https://worker/edit',{method:'POST',headers:{Origin:'https://evil.example'}}),env);
  assert.equal(cross.status,403);
});

test('authenticated edit binds quota to verified user and marks provider failures for refund', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => {
    const value = String(url);
    if (value.includes('/rpc/') || value.endsWith('/membership')) return Response.json([]);
    if (value.includes('/auth/v1/user')) return Response.json({ id:user });
    return Response.json({ error: { code: 'rate_limit_exceeded', message: 'raw upstream detail' } }, { status: 429 });
  };
  const env = {
    APP_ORIGIN:'https://moa-studio.pages.dev',PHOTO_EDIT_ENABLED:'1',SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'public',OPENAI_API_KEY:'test-key',
    PHOTO_QUOTA: { idFromName: name => name, get: () => ({ async fetch(url,options) { calls.push({url,...JSON.parse(options.body)}); return Response.json({status:200}); } }) },
  };
  try {
    const response = await handleRequest(new Request('https://worker/edit', {method:'POST',headers:{Authorization:'Bearer valid','Content-Type':'application/json'},body:JSON.stringify({...input(),userId:id()})}),env);
    assert.equal(response.status,503);
    assert.doesNotMatch((await response.json()).error,/raw upstream|test-key/);
    assert.equal(calls[0].userId,user);
    assert.equal(calls[0].requestId,requestId);
    assert.equal(calls[1].succeeded,false);
  } finally { globalThis.fetch = originalFetch; }
});

test('person replacement request takes precedence over preserving the source identity without a reference', async () => {
  const prompt = buildEditPrompt(parsePayload({ ...input(), prompt: '카리나가 커피를 들고 있는 모습으로 바꿔 줘' }));
  assert.match(prompt, /카리나가 커피를 들고 있는 모습으로 바꿔 줘/);
  assert.match(prompt, /make that change even when no subject reference is attached/);
  assert.match(prompt, /Depict exactly one requested replacement person or object/);
  assert.doesNotMatch(prompt, /unless the latest request explicitly asks to replace it using a subject reference/);
});

test('protected region guidance keeps Korean latest request priority but constrains edits outside the rectangle', async () => {
  const prompt = buildEditPrompt(parsePayload({ ...input(), prompt: '얼굴은 그대로 두고 배경을 밤거리로 바꿔 줘', protectedRegion: { x: 0.25, y: 0.1, width: 0.5, height: 0.6 } }));
  assert.match(prompt, /including requests written in Korean/);
  assert.match(prompt, /latest request takes priority/);
  assert.match(prompt, /Protected face\/person region/);
  assert.match(prompt, /x=0.25, y=0.1, width=0.5, height=0.6/);
  assert.match(prompt, /same position, size, angle, pose and framing/);
  assert.match(prompt, /Edit only outside the provided normalized percentage rectangle/);
  assert.match(prompt, /source face region will be restored after generation/);
  assert.match(prompt, /do not move the head/);
  assert.match(prompt, /satisfy the request only outside the protected rectangle/);
  assert.match(prompt, /얼굴은 그대로 두고 배경을 밤거리로 바꿔 줘/);
});
