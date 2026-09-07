#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

const ROOT = process.cwd();
const SECRET_FILE = resolve(ROOT, '.data/launch-server-secret');
const ENV_FILES = ['.env.local', '.env.production.local'];
const EXPECTED_PRICES = {
  light: { month: 3900, year: 42000 },
  studio: { month: 7900, year: 85000 },
  plus: { month: 12900, year: 139000 },
};
const ONE_BY_ONE_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=';

main().catch(error => {
  const status = error?.status ? `HTTP ${error.status}` : 'ERROR';
  console.error(JSON.stringify({ ok: false, status, error: sanitizeError(error) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  const env = loadEnvironment();
  const config = readConfig(env);
  const state = { userId: null, email: null, orderIds: [], workspaceWritten: false };
  const checks = [];

  try {
    const qaUser = await createQaUser(config);
    state.userId = qaUser.user.id;
    state.email = qaUser.email;

    const session = await signIn(config, qaUser.email, qaUser.password);
    const user = session.user;
    assert(user?.id === state.userId, 'signed in as unexpected QA user');

    checks.push(await checkContentStatus(config));
    checks.push(await checkFreeGenerate(config, session.access_token));
    checks.push(await checkWorkspaceSaveRead(config, session.access_token, user.id));
    state.workspaceWritten = true;
    checks.push(await checkWorkspaceAuthorization(config, session.access_token, user.id));
    checks.push(await checkPaymentOrders(config, session.access_token, state.orderIds));

    const failed = checks.flatMap(check => check.ok ? [] : [check.name]);
    const summary = {
      ok: failed.length === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      target: { supabaseUrl: config.url, appOrigin: config.appOrigin ?? null },
      qa: { userId: maskId(user.id), email: maskEmail(state.email) },
      checks,
    };
    const cleanupResult = await cleanup(config, state);
    summary.cleanup = cleanupResult;
    console.log(JSON.stringify(summary, null, 2));
    if (failed.length || cleanupResult.ok !== true) process.exitCode = 1;
  } catch (error) {
    const cleanupResult = await cleanup(config, state).catch(cleanupError => ({ ok: false, error: sanitizeError(cleanupError) }));
    error.cleanup = cleanupResult;
    throw error;
  }
}

function loadEnvironment() {
  const env = { ...process.env };
  for (const relative of ENV_FILES) {
    const path = resolve(ROOT, relative);
    if (!existsSync(path)) continue;
    Object.assign(env, parseDotenv(readFileSync(path, 'utf8')));
  }
  if (existsSync(SECRET_FILE)) {
    Object.assign(env, parseSecretFile(readFileSync(SECRET_FILE, 'utf8')));
  }
  return env;
}

function parseDotenv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

function parseSecretFile(text) {
  const trimmed = text.trim();
  if (!trimmed) return {};
  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
  }
  const fromDotenv = parseDotenv(trimmed);
  if (Object.keys(fromDotenv).length) return fromDotenv;
  return { SUPABASE_SERVICE_ROLE_KEY: trimmed };
}

function readConfig(env) {
  const url = normalizeRequiredUrl(env.VITE_SUPABASE_URL || env.SUPABASE_URL, 'VITE_SUPABASE_URL');
  const publishableKey = required(env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY, 'VITE_SUPABASE_PUBLISHABLE_KEY');
  const serviceRoleKey = required(
    env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEYS,
    'SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY',
  );
  const appOrigin = optionalOrigin(env.LAUNCH_VERIFY_ORIGIN || env.PUBLIC_APP_URL || env.VITE_PUBLIC_APP_URL || env.APP_URL);
  return { url, publishableKey, serviceRoleKey: readFirstJsonKey(serviceRoleKey), appOrigin };
}

function required(value, name) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function normalizeRequiredUrl(value, name) {
  const text = required(value, name).replace(/\/+$/, '');
  const url = new URL(text);
  if (url.protocol !== 'https:') throw new Error(`${name} must be an https URL`);
  return url.toString().replace(/\/+$/, '');
}

function optionalOrigin(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const url = new URL(text);
  return url.origin;
}

function readFirstJsonKey(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('{')) return text;
  const parsed = JSON.parse(text);
  return parsed.default || Object.values(parsed).find(candidate => typeof candidate === 'string') || text;
}

async function createQaUser(config) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const email = `moa-launch-qa-${stamp}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `MoaQa-${randomUUID()}-9a!`;
  const response = await authFetch(config, '/admin/users', {
    method: 'POST',
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { name: 'Moa Launch QA', source: 'verify-launch-live' },
    },
  });
  const user = response.user && typeof response.user === 'object' ? response.user : response;
  assert(user?.id, 'admin create user response missing user id');
  return { email, password, user };
}

async function signIn(config, email, password) {
  const response = await fetchJson(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: publicHeaders(config),
    body: JSON.stringify({ email, password }),
  });
  assert(response.access_token, 'sign in response missing access token');
  assert(response.user?.id, 'sign in response missing user id');
  return response;
}

async function checkContentStatus(config) {
  const body = await functionFetch(config, 'moa-content', '/status', { method: 'GET', auth: 'public' });
  return {
    name: 'content_status',
    ok: typeof body.configured === 'boolean' && body.provider === 'openai',
    configured: body.configured === true,
    mode: body.mode,
    provider: body.provider,
  };
}

async function checkFreeGenerate(config, accessToken) {
  const body = await functionFetch(config, 'moa-content', '/status', { method: 'GET', auth: 'public' });
  if (body.configured !== true) {
    return {
      name: 'free_generate_requires_paid_plan',
      ok: false,
      skipped: true,
      reason: 'moa-content is in template mode; deploy MOA_AI_PROVIDER=openai and OPENAI_API_KEY before running the paid-launch gate',
    };
  }

  const response = await rawFunctionFetch(config, 'moa-content', '/generate', {
    method: 'POST',
    accessToken,
    body: generatePayload(),
  });
  const payload = await safeJson(response);
  return {
    name: 'free_generate_requires_paid_plan',
    ok: response.status === 402,
    status: response.status,
    error: typeof payload.error === 'string' ? payload.error : undefined,
  };
}

async function checkWorkspaceSaveRead(config, accessToken, userId) {
  const workspace = {
    user_id: userId,
    brand: brandPayload(),
    projects: [{ id: `launch-project-${randomUUID()}`, name: 'Launch QA Project', photos: [], pack: null, photoChats: {} }],
    brand_profiles: [{ id: 'qa-brand', ...brandPayload() }],
    active_brand_id: 'qa-brand',
    updated_at: new Date().toISOString(),
  };

  const written = await restFetch(config, '/workspaces?on_conflict=user_id&select=user_id,brand,projects,brand_profiles,active_brand_id', {
    method: 'POST',
    accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: workspace,
  });
  assert(Array.isArray(written) && written.length === 1, 'workspace upsert did not return one row');

  const selected = await restFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(userId)}&select=user_id,brand,projects,brand_profiles,active_brand_id`, {
    method: 'GET',
    accessToken,
  });
  const row = selected?.[0];
  return {
    name: 'workspace_save_read',
    ok: row?.user_id === userId && row?.brand?.name === workspace.brand.name && Array.isArray(row?.projects) && row.projects.length === 1 && row?.active_brand_id === 'qa-brand',
    rows: Array.isArray(selected) ? selected.length : null,
  };
}

async function checkWorkspaceAuthorization(config, accessToken, userId) {
  const otherUserId = randomUUID();
  const crossUser = await restFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(otherUserId)}&select=user_id`, {
    method: 'GET',
    accessToken,
  });
  const ownUserFilter = await restFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, {
    method: 'GET',
    accessToken,
  });
  const unauth = await rawRestFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(userId)}&select=user_id`, {
    method: 'GET',
    bearer: null,
  });
  const unauthBody = await safeJson(unauth);
  return {
    name: 'workspace_authorization',
    ok: Array.isArray(crossUser) && crossUser.length === 0 && Array.isArray(ownUserFilter) && ownUserFilter.length === 1 && unauth.status >= 400,
    crossUserRows: Array.isArray(crossUser) ? crossUser.length : null,
    ownRows: Array.isArray(ownUserFilter) ? ownUserFilter.length : null,
    unauthStatus: unauth.status,
    unauthCode: typeof unauthBody.code === 'string' ? unauthBody.code : undefined,
  };
}

async function checkPaymentOrders(config, accessToken, orderIds) {
  const configBody = await functionFetch(config, 'moa-payments', '/config', { method: 'GET', auth: 'public' });
  if (configBody.configured !== true) {
    return { name: 'payment_order_prices', ok: false, skipped: true, reason: configBody.message || 'payments disabled', mode: configBody.mode };
  }

  const checks = [];
  for (const [plan, prices] of Object.entries(EXPECTED_PRICES)) {
    for (const [interval, expectedAmount] of Object.entries(prices)) {
      const response = await rawFunctionFetch(config, 'moa-payments', '/orders', {
        method: 'POST',
        accessToken,
        origin: config.appOrigin,
        body: { plan, interval },
      });
      const payload = await safeJson(response);
      if (payload.orderId) orderIds.push(payload.orderId);
      checks.push({
        plan,
        interval,
        ok: response.status === 201 && payload.amount === expectedAmount && payload.status === 'PENDING' && payload.mode === configBody.mode,
        status: response.status,
        amount: payload.amount,
        expectedAmount,
        orderId: payload.orderId ? maskId(payload.orderId) : undefined,
      });
    }
  }
  return {
    name: 'payment_order_prices',
    ok: checks.every(check => check.ok),
    mode: configBody.mode,
    checked: checks,
  };
}

function brandPayload() {
  return {
    name: 'Moa Launch QA Cafe',
    tagline: 'Launch verification only',
    location: 'Seoul',
    instagram: '@moa_launch_qa',
    color: '#254a3b',
  };
}

function generatePayload() {
  return {
    requestId: randomUUID(),
    brand: brandPayload(),
    brief: {
      productName: 'QA Latte',
      description: 'Deployment verification payload',
      price: '4500',
      tone: 'warm',
      goal: 'daily',
      includeSchedule: false,
      scheduleStartDate: null,
    },
    images: [{ id: 'qa-photo', name: 'qa.png', dataUrl: ONE_BY_ONE_PNG }],
  };
}

async function cleanup(config, state) {
  if (!state.userId) return { ok: true, deletedUser: false };
  await serviceRestFetch(config, `/moa_ai_requests?user_id=eq.${encodeURIComponent(state.userId)}`, { method: 'DELETE' });
  await serviceRestFetch(config, `/payment_orders?user_id=eq.${encodeURIComponent(state.userId)}`, { method: 'DELETE' });
  await serviceRestFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(state.userId)}`, { method: 'DELETE' });
  await authFetch(config, `/admin/users/${encodeURIComponent(state.userId)}`, { method: 'DELETE' });
  return { ok: true, deletedUser: true, userId: maskId(state.userId), orders: state.orderIds.length };
}

async function functionFetch(config, functionName, path, options) {
  const response = await rawFunctionFetch(config, functionName, path, options);
  const body = await safeJson(response);
  if (!response.ok) throw httpStatusError(response, body);
  return body;
}

async function rawFunctionFetch(config, functionName, path, options = {}) {
  const headers = {
    ...publicHeaders(config),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
    ...(options.origin ? { Origin: options.origin } : {}),
  };
  return fetch(`${config.url}/functions/v1/${functionName}${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function restFetch(config, path, options = {}) {
  const response = await rawRestFetch(config, path, { ...options, bearer: options.accessToken });
  const body = await safeJson(response);
  if (!response.ok) throw httpStatusError(response, body);
  return body;
}

async function rawRestFetch(config, path, options = {}) {
  const headers = {
    ...publicHeaders(config),
    ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}),
    ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers || {}),
  };
  return fetch(`${config.url}/rest/v1${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function serviceRestFetch(config, path, options = {}) {
  const response = await fetch(`${config.url}/rest/v1${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) throw httpStatusError(response, await safeJson(response));
  return safeJson(response);
}

async function authFetch(config, path, options = {}) {
  const response = await fetch(`${config.url}/auth/v1${path}`, {
    method: options.method || 'GET',
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await safeJson(response);
  if (!response.ok) throw httpStatusError(response, body);
  return body;
}

function publicHeaders(config) {
  return { apikey: config.publishableKey };
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const body = await safeJson(response);
  if (!response.ok) throw httpStatusError(response, body);
  return body;
}

async function safeJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { parseError: true };
  }
}

function httpStatusError(response, body) {
  const error = new Error(typeof body?.error === 'string' ? body.error : `request failed with HTTP ${response.status}`);
  error.status = response.status;
  error.code = body?.code;
  return error;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeError(error) {
  if (!error) return 'unknown error';
  const message = String(error.message || error).replace(/[A-Za-z0-9_-]{24,}/g, '[masked]');
  const payload = { message: message.slice(0, 500) };
  if (error.cleanup) payload.cleanup = error.cleanup;
  return payload;
}

function maskEmail(email) {
  if (!email) return null;
  const [name, domain] = email.split('@');
  return `${name.slice(0, 12)}…@${domain}`;
}

function maskId(id) {
  if (!id) return null;
  const text = String(id);
  return `${text.slice(0, 8)}…${text.slice(-6)}`;
}
