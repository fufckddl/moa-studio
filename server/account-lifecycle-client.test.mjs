import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('cloud auth sends captcha tokens for signup login reset and account lifecycle requests', async t => {
  const calls = [];
  const client = {
    auth: {
      async getSession() { return { data: { session: { access_token: 'session-token' } } }; },
      async getUser() { return { data: { user: { id: 'user-1', email: 'owner@example.test', user_metadata: { name: 'Owner' } } } }; },
      async signUp(payload) { calls.push(['signUp', payload]); return { data: { user: { id: 'user-1', email: payload.email, user_metadata: payload.options.data }, session: {} } }; },
      async signInWithPassword(payload) { calls.push(['signInWithPassword', payload]); return { data: { user: { id: 'user-1', email: payload.email, user_metadata: {} } } }; },
      async resetPasswordForEmail(email, options) { calls.push(['resetPasswordForEmail', email, options]); return {}; },
      async updateUser(payload) { calls.push(['updateUser', payload]); return { data: { user: { id: 'user-1', email: 'owner@example.test', user_metadata: {} } } }; },
      async signOut(payload) { calls.push(['signOut', payload]); return {}; },
    },
    functions: {
      async invoke(name, options) { calls.push(['invoke', name, options]); return { data: { ok: true } }; },
    },
  };
  globalThis.window = {
    location: { origin: 'https://moa.example.test' },
    localStorage: memoryLocalStorage(),
    indexedDB: { deleteDatabase(name) { calls.push(['deleteDatabase', name]); } },
  };
  globalThis.__accountClient = client;
  t.after(() => { delete globalThis.__accountClient; delete globalThis.window; });

  const source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
    .replace("import { getAccessToken, getSupabaseClient, isCloudConfigured } from './supabase';", 'const getSupabaseClient = () => globalThis.__accountClient; const isCloudConfigured = true; async function getAccessToken() { return "session-token"; }')
    .replace("const TURNSTILE_SITE_KEY = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY ?? '').trim();", "const TURNSTILE_SITE_KEY = 'site-key';")
    .replace("const TURNSTILE_REQUIRED = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_REQUIRED ?? '').trim().toLowerCase() === 'true';", 'const TURNSTILE_REQUIRED = false;');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

  await api.authenticate('signup', { name: 'Owner', email: 'owner@example.test', password: 'strong-password', captchaToken: 'captcha-signup' });
  await api.authenticate('login', { email: 'owner@example.test', password: 'strong-password', captchaToken: 'captcha-login' });
  await api.sendPasswordReset('owner@example.test', 'captcha-reset');
  await api.eraseAccountData({ password: 'strong-password', confirmation: '작업물 삭제', captchaToken: 'captcha-erase' });
  await api.deleteAccount({ password: 'strong-password', confirmation: '계정 삭제', captchaToken: 'captcha-delete' });

  assert.equal(calls.find(call => call[0] === 'signUp')[1].options.captchaToken, 'captcha-signup');
  assert.equal(calls.find(call => call[0] === 'signInWithPassword')[1].options.captchaToken, 'captcha-login');
  assert.equal(calls.find(call => call[0] === 'resetPasswordForEmail')[2].captchaToken, 'captcha-reset');
  const invokes = calls.filter(call => call[0] === 'invoke');
  assert.equal(invokes[0][1], 'moa-account/erase');
  assert.equal(invokes[0][2].body.captchaToken, 'captcha-erase');
  assert.equal(invokes[1][1], 'moa-account/delete');
  assert.equal(invokes[1][2].body.captchaToken, 'captcha-delete');
  assert.ok(calls.some(call => call[0] === 'deleteDatabase' && call[1] === 'moa-studio-person-library'));
  client.functions.invoke = async () => ({ error: { message: 'Edge Function returned a non-2xx status code', context: Response.json({ error: '비밀번호를 다시 확인해 주세요.' }, { status: 401 }) } });
  await assert.rejects(api.eraseAccountData({ password: 'wrong-password', confirmation: '작업물 삭제', captchaToken: 'fresh-token' }), /비밀번호를 다시 확인/);
});

test('cloud auth fails closed when Turnstile is configured and a token is missing', async t => {
  globalThis.__accountClient = {};
  t.after(() => { delete globalThis.__accountClient; });
  const source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
    .replace("import { getAccessToken, getSupabaseClient, isCloudConfigured } from './supabase';", 'const getSupabaseClient = () => globalThis.__accountClient; const isCloudConfigured = true; async function getAccessToken() { return null; }')
    .replace("const TURNSTILE_SITE_KEY = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY ?? '').trim();", "const TURNSTILE_SITE_KEY = 'site-key';")
    .replace("const TURNSTILE_REQUIRED = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_REQUIRED ?? '').trim().toLowerCase() === 'true';", 'const TURNSTILE_REQUIRED = false;');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const api = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

  await assert.rejects(
    api.authenticate('login', { email: 'owner@example.test', password: 'strong-password' }),
    /보안 확인/,
  );
});

function memoryLocalStorage() {
  const values = new Map([
    ['moa-studio:projects', '[]'],
    ['other-key', 'kept'],
  ]);
  return {
    get length() { return values.size; },
    key(index) { return Array.from(values.keys())[index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
}
