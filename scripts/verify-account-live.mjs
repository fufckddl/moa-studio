#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const ROOT = process.cwd();
const SECRET_FILE = resolve(ROOT, '.data/launch-server-secret');
const ENV_FILES = ['.env.local', '.env.production.local'];
const PHOTO_BUCKET = 'moa-photos';
const PEOPLE_BUCKET = 'moa-people';
const ERASE_CONFIRMATION = '작업물 삭제';
const DELETE_CONFIRMATION = '계정 삭제';
const ONE_BY_ONE_JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAH/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAEFAqf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEDAQE/Aaf/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAECAQE/Aaf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAY/Aqf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAE/IX//2gAMAwEAAgADAAAAEP/EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQMBAT8QH//EABQRAQAAAAAAAAAAAAAAAAAAABD/2gAIAQIBAT8QH//EABQQAQAAAAAAAAAAAAAAAAAAABD/2gAIAQEAAT8QH//Z';

main().catch(error => {
  const status = error?.status ? `HTTP ${error.status}` : 'ERROR';
  console.error(JSON.stringify({ ok: false, status, error: sanitizeError(error) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const startedAt = new Date().toISOString();
  const env = loadEnvironment();
  const config = readConfig(env);
  const service = createClient(config.url, config.serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const state = { userId: null, email: null, photoPaths: [], peoplePaths: [], deletedUser: false };
  const checks = [];

  try {
    const qa = await createQaUser(service);
    state.userId = qa.user.id;
    state.email = qa.email;

    const session = await signIn(config, qa.email, qa.password);
    assert(session.user?.id === state.userId, 'signed in as unexpected QA user');
    const oldAccessToken = session.access_token;
    const oldRefreshToken = session.refresh_token;

    const seeded = await seedOwnData(config, oldAccessToken, state.userId);
    state.photoPaths.push(seeded.photoPath);
    state.peoplePaths.push(seeded.personPath);
    checks.push(await checkSeededOwnData(config, oldAccessToken, state.userId, seeded));

    checks.push(await checkWrongPasswordErase(config, oldAccessToken));
    checks.push(await checkCorrectErase(config, oldAccessToken, qa.password));
    checks.push(await checkEraseEffects(config, service, state.userId));

    const refreshed = await refreshSession(config, oldRefreshToken);
    checks.push({
      name: 'old_session_refresh_after_erase',
      ok: refreshed.user?.id === state.userId && Boolean(refreshed.access_token),
      userId: maskId(refreshed.user?.id),
    });

    checks.push(await checkResaveAfterErase(config, refreshed.access_token, state.userId));
    checks.push(await checkCorrectDelete(config, refreshed.access_token, qa.password));
    state.deletedUser = true;
    checks.push(await checkDeleteEffects(config, service, oldAccessToken, refreshed.access_token, state.userId));

    const failed = checks.flatMap(check => check.ok ? [] : [check.name]);
    const summary = {
      ok: failed.length === 0,
      startedAt,
      finishedAt: new Date().toISOString(),
      target: { supabaseUrl: config.url, appOrigin: config.appOrigin ?? null },
      qa: { userId: maskId(state.userId), email: maskEmail(state.email) },
      checks,
    };
    const cleanupResult = await cleanup(config, service, state);
    summary.cleanup = cleanupResult;
    console.log(JSON.stringify(summary, null, 2));
    if (failed.length || cleanupResult.ok !== true) process.exitCode = 1;
  } catch (error) {
    const cleanupResult = await cleanup(config, service, state).catch(cleanupError => ({ ok: false, error: sanitizeError(cleanupError) }));
    error.cleanup = cleanupResult;
    throw error;
  }
}

async function createQaUser(service) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const email = `moa-account-qa-${stamp}-${randomUUID().slice(0, 8)}@example.invalid`;
  const password = `MoaAccountQa-${randomUUID()}-9a!`;
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { name: 'Moa Account QA', source: 'verify-account-live' },
  });
  if (error) throw error;
  assert(data.user?.id, 'admin create user response missing user id');
  return { email, password, user: data.user };
}

async function signIn(config, email, password) {
  const response = await fetchJson(`${config.url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: publicHeaders(config),
    body: JSON.stringify({ email, password }),
  });
  assert(response.access_token, 'sign in response missing access token');
  assert(response.refresh_token, 'sign in response missing refresh token');
  assert(response.user?.id, 'sign in response missing user id');
  return response;
}

async function refreshSession(config, refreshToken) {
  const response = await fetchJson(`${config.url}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: publicHeaders(config),
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  assert(response.access_token, 'refresh response missing access token');
  assert(response.user?.id, 'refresh response missing user id');
  return response;
}

async function seedOwnData(config, accessToken, userId) {
  const projectId = `qa-project-${randomUUID().slice(0, 12)}`;
  const photoId = `qa-photo-${randomUUID().slice(0, 12)}`;
  const personId = `qa-person-${randomUUID().slice(0, 12)}`;
  const photoPath = `${userId}/${projectId}/${photoId}.jpg`;
  const personPath = `${userId}/${personId}.jpg`;
  const brand = brandPayload('Initial QA Cafe');
  const projects = [{
    id: projectId,
    name: 'Account lifecycle QA project',
    photos: [{ id: photoId, name: 'qa.jpg', dataUrl: '', storagePath: photoPath }],
    pack: null,
    photoChats: {},
  }];

  await uploadObject(config, PHOTO_BUCKET, photoPath, accessToken);
  await restFetch(config, '/workspaces?on_conflict=user_id&select=user_id', {
    method: 'POST',
    accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      user_id: userId,
      brand,
      projects,
      brand_profiles: [{ id: 'qa-brand', ...brand }],
      active_brand_id: 'qa-brand',
      updated_at: new Date().toISOString(),
    },
  });

  await uploadObject(config, PEOPLE_BUCKET, personPath, accessToken);
  await restFetch(config, '/generated_people?select=user_id,id', {
    method: 'POST',
    accessToken,
    headers: { Prefer: 'return=representation' },
    body: {
      user_id: userId,
      id: personId,
      name: 'QA Person',
      prompt: 'Account lifecycle verification person',
      storage_path: personPath,
    },
  });

  return { projectId, photoPath, personId, personPath };
}

async function checkSeededOwnData(config, accessToken, userId, seeded) {
  const workspaceRows = await restFetch(config, `/workspaces?user_id=eq.${encodeURIComponent(userId)}&select=user_id,projects`, { method: 'GET', accessToken });
  const peopleRows = await restFetch(config, `/generated_people?user_id=eq.${encodeURIComponent(userId)}&select=user_id,id,storage_path`, { method: 'GET', accessToken });
  const photoCount = await storageCount(config, PHOTO_BUCKET, userId, accessToken);
  const peopleCount = await storageCount(config, PEOPLE_BUCKET, userId, accessToken);
  const workspace = workspaceRows?.[0];
  return {
    name: 'seed_own_workspace_and_storage',
    ok: workspace?.user_id === userId && workspace.projects?.[0]?.photos?.[0]?.storagePath === seeded.photoPath && peopleRows?.[0]?.storage_path === seeded.personPath && photoCount === 1 && peopleCount === 1,
    workspaceRows: Array.isArray(workspaceRows) ? workspaceRows.length : null,
    generatedPeopleRows: Array.isArray(peopleRows) ? peopleRows.length : null,
    storageObjects: { [PHOTO_BUCKET]: photoCount, [PEOPLE_BUCKET]: peopleCount },
  };
}

async function checkWrongPasswordErase(config, accessToken) {
  const response = await rawFunctionFetch(config, 'moa-account', '/erase', {
    method: 'POST',
    accessToken,
    origin: config.appOrigin,
    body: { password: `wrong-${randomUUID()}`, confirmation: ERASE_CONFIRMATION },
  });
  const body = await safeJson(response);
  return {
    name: 'erase_wrong_password_rejected',
    ok: response.status === 401,
    status: response.status,
    error: typeof body.error === 'string' ? body.error : undefined,
  };
}

async function checkCorrectErase(config, accessToken, password) {
  const response = await rawFunctionFetch(config, 'moa-account', '/erase', {
    method: 'POST',
    accessToken,
    origin: config.appOrigin,
    body: { password, confirmation: ERASE_CONFIRMATION },
  });
  const body = await safeJson(response);
  return {
    name: 'erase_correct_password_accepted',
    ok: response.status === 200 && body.ok === true,
    status: response.status,
  };
}

async function checkEraseEffects(config, service, userId) {
  const user = await service.auth.admin.getUserById(userId);
  const workspaceRows = await service.from('workspaces').select('user_id').eq('user_id', userId);
  const peopleRows = await service.from('generated_people').select('user_id').eq('user_id', userId);
  const locks = await service.from('account_lifecycle_locks').select('user_id,action').eq('user_id', userId);
  const photoCount = await serviceStorageCount(service, PHOTO_BUCKET, userId);
  const peopleCount = await serviceStorageCount(service, PEOPLE_BUCKET, userId);
  if (user.error) throw user.error;
  if (workspaceRows.error) throw workspaceRows.error;
  if (peopleRows.error) throw peopleRows.error;
  if (locks.error) throw locks.error;
  return {
    name: 'erase_removes_data_keeps_user',
    ok: Boolean(user.data.user?.id) && workspaceRows.data.length === 0 && peopleRows.data.length === 0 && locks.data.length === 0 && photoCount === 0 && peopleCount === 0,
    userExists: Boolean(user.data.user?.id),
    workspaceRows: workspaceRows.data.length,
    generatedPeopleRows: peopleRows.data.length,
    lockRows: locks.data.length,
    storageObjects: { [PHOTO_BUCKET]: photoCount, [PEOPLE_BUCKET]: peopleCount },
  };
}

async function checkResaveAfterErase(config, accessToken, userId) {
  const brand = brandPayload('Resaved QA Cafe');
  const response = await rawRestFetch(config, '/workspaces?on_conflict=user_id&select=user_id,brand,brand_profiles,active_brand_id', {
    method: 'POST',
    bearer: accessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: {
      user_id: userId,
      brand,
      projects: [],
      brand_profiles: [{ id: 'resaved-brand', ...brand }],
      active_brand_id: 'resaved-brand',
      updated_at: new Date().toISOString(),
    },
  });
  const body = await safeJson(response);
  const row = Array.isArray(body) ? body[0] : null;
  return {
    name: 'resave_after_erase',
    ok: response.status < 300 && row?.user_id === userId && row?.brand?.name === brand.name && row?.active_brand_id === 'resaved-brand',
    status: response.status,
  };
}

async function checkCorrectDelete(config, accessToken, password) {
  const response = await rawFunctionFetch(config, 'moa-account', '/delete', {
    method: 'POST',
    accessToken,
    origin: config.appOrigin,
    body: { password, confirmation: DELETE_CONFIRMATION },
  });
  const body = await safeJson(response);
  return {
    name: 'delete_correct_password_accepted',
    ok: response.status === 200 && body.ok === true,
    status: response.status,
  };
}

async function checkDeleteEffects(config, service, oldAccessToken, refreshedAccessToken, userId) {
  const user = await service.auth.admin.getUserById(userId);
  const workspaceRows = await service.from('workspaces').select('user_id').eq('user_id', userId);
  const peopleRows = await service.from('generated_people').select('user_id').eq('user_id', userId);
  const lockRows = await service.from('account_lifecycle_locks').select('user_id,action').eq('user_id', userId);
  const archived = await service.from('account_payment_archive').select('payment_order_id').eq('source_user_id', userId);
  const oldBearerWrite = await rawRestFetch(config, '/workspaces?on_conflict=user_id&select=user_id', {
    method: 'POST',
    bearer: refreshedAccessToken || oldAccessToken,
    headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    body: { user_id: userId, brand: brandPayload('Deleted User Write'), projects: [], brand_profiles: [], active_brand_id: null, updated_at: new Date().toISOString() },
  });
  const oldBearerBody = await safeJson(oldBearerWrite);
  const photoCount = await serviceStorageCount(service, PHOTO_BUCKET, userId);
  const peopleCount = await serviceStorageCount(service, PEOPLE_BUCKET, userId);
  if (workspaceRows.error) throw workspaceRows.error;
  if (peopleRows.error) throw peopleRows.error;
  if (lockRows.error) throw lockRows.error;
  if (archived.error) throw archived.error;
  return {
    name: 'delete_removes_user_and_blocks_old_bearer',
    ok: Boolean(user.error) && workspaceRows.data.length === 0 && peopleRows.data.length === 0 && lockRows.data.length === 1 && oldBearerWrite.status >= 400 && photoCount === 0 && peopleCount === 0,
    userLookupStatus: user.error ? 'missing' : 'present',
    workspaceRows: workspaceRows.data.length,
    generatedPeopleRows: peopleRows.data.length,
    lockRows: lockRows.data.length,
    archivedPaymentRows: archived.data.length,
    oldBearerWriteStatus: oldBearerWrite.status,
    oldBearerWriteCode: typeof oldBearerBody.code === 'string' ? oldBearerBody.code : undefined,
    storageObjects: { [PHOTO_BUCKET]: photoCount, [PEOPLE_BUCKET]: peopleCount },
  };
}

async function cleanup(config, service, state) {
  if (!state.userId) return { ok: true, userId: null, deletedUser: false };
  const userId = state.userId;
  await service.from('moa_ai_requests').delete().eq('user_id', userId);
  await service.from('photo_chat_history').delete().eq('user_id', userId);
  await service.from('generated_people').delete().eq('user_id', userId);
  await service.from('workspaces').delete().eq('user_id', userId);
  await service.from('payment_orders').delete().eq('user_id', userId);
  await service.from('account_payment_archive').delete().eq('source_user_id', userId);
  await service.from('account_lifecycle_locks').delete().eq('user_id', userId);
  await removeAllForPrefix(service, PHOTO_BUCKET, userId);
  await removeAllForPrefix(service, PEOPLE_BUCKET, userId);
  const lookup = await service.auth.admin.getUserById(userId);
  if (!lookup.error && lookup.data.user) await service.auth.admin.deleteUser(userId, false);
  return { ok: true, userId: maskId(userId), deletedUser: state.deletedUser || Boolean(lookup.error) };
}

async function uploadObject(config, bucket, path, accessToken) {
  const response = await fetch(`${config.url}/storage/v1/object/${bucket}/${path}`, {
    method: 'POST',
    headers: {
      ...publicHeaders(config),
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'image/jpeg',
      'x-upsert': 'false',
    },
    body: Buffer.from(ONE_BY_ONE_JPEG, 'base64'),
  });
  const body = await safeJson(response);
  if (!response.ok) throw httpStatusError(response, body);
  return body;
}

async function storageCount(config, bucket, prefix, accessToken) {
  const paths = [];
  await collectStoragePathsViaFetch(config, bucket, prefix, accessToken, paths);
  return paths.length;
}

async function collectStoragePathsViaFetch(config, bucket, prefix, accessToken, paths) {
  let offset = 0;
  while (true) {
    const response = await fetch(`${config.url}/storage/v1/object/list/${bucket}`, {
      method: 'POST',
      headers: { ...publicHeaders(config), Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } }),
    });
    const body = await safeJson(response);
    if (!response.ok) throw httpStatusError(response, body);
    const items = Array.isArray(body) ? body : [];
    for (const item of items) {
      if (!item?.name) continue;
      const path = `${prefix}/${item.name}`;
      if (item.id || item.metadata || item.name.includes('.')) paths.push(path);
      else await collectStoragePathsViaFetch(config, bucket, path, accessToken, paths);
    }
    if (items.length < 1000) break;
    offset += items.length;
  }
}

async function serviceStorageCount(service, bucket, prefix) {
  const { data, error } = await service.storage.from(bucket).list(prefix, { limit: 1000, offset: 0, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw error;
  return countStorageItems(data ?? []);
}

async function removeAllForPrefix(service, bucket, prefix) {
  const paths = [];
  await collectStoragePaths(service, bucket, prefix, paths);
  for (let index = 0; index < paths.length; index += 100) {
    const chunk = paths.slice(index, index + 100);
    if (chunk.length) await service.storage.from(bucket).remove(chunk);
  }
}

async function collectStoragePaths(service, bucket, prefix, paths) {
  let offset = 0;
  while (true) {
    const { data, error } = await service.storage.from(bucket).list(prefix, { limit: 1000, offset, sortBy: { column: 'name', order: 'asc' } });
    if (error) throw error;
    const items = data ?? [];
    for (const item of items) {
      if (!item.name) continue;
      const path = `${prefix}/${item.name}`;
      if (item.id || item.metadata) paths.push(path);
      else await collectStoragePaths(service, bucket, path, paths);
    }
    if (items.length < 1000) break;
    offset += items.length;
  }
}

function countStorageItems(items) {
  if (!Array.isArray(items)) return 0;
  let count = 0;
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.id || item.metadata || item.name?.includes('.')) count += 1;
  }
  return count;
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

function brandPayload(name) {
  return {
    name,
    tagline: 'Account lifecycle verification only',
    location: 'Seoul',
    instagram: '@moa_account_qa',
    color: '#254a3b',
  };
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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
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
  const serviceRoleKey = required(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY || env.SUPABASE_SECRET_KEYS, 'SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SECRET_KEY');
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
  return new URL(text).origin;
}

function readFirstJsonKey(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('{')) return text;
  const parsed = JSON.parse(text);
  return parsed.default || Object.values(parsed).find(candidate => typeof candidate === 'string') || text;
}

function publicHeaders(config) {
  return { apikey: config.publishableKey, 'Content-Type': 'application/json' };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sanitizeError(error) {
  if (!error) return { message: 'unknown error' };
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
