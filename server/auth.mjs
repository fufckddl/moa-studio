import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { httpError } from './content.mjs';

const scrypt = promisify(scryptCallback);
const COOKIE_NAME = 'moa_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ORIGIN = 'http://127.0.0.1:5173';
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const DEFAULT_SCRYPT_PARAMS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const PLAN_AI_LIMITS = { free: 0, light: 10, studio: 30, plus: 100 };
const PLAN_BRAND_LIMITS = { free: 1, light: 3, studio: 3, plus: 3 };
const PHOTO_CHAT_MAX_THREADS = 10;
const PHOTO_CHAT_MAX_MESSAGES = 200;
const PHOTO_CHAT_USER_MAX_CHARS = 2000;
const PHOTO_CHAT_ASSISTANT_MAX_CHARS = 4000;

export function createAuthService(options = {}) {
  const dbPath = options.dbPath ?? resolve(process.env.MOA_DATA_FILE || '.data/moa-studio.sqlite');
  const now = options.now ?? (() => Date.now());
  const allowedOrigin = options.allowedOrigin ?? DEFAULT_ORIGIN;
  const secureCookie = options.secureCookie ?? process.env.MOA_SECURE_COOKIES === '1';
  const scryptParams = options.scryptParams ?? DEFAULT_SCRYPT_PARAMS;
  const limiter = new RateLimiter(now);

  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  initialize(db);

  async function handle(request, rawBody, response) {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;
    if (isMutation(request.method)) assertSameOrigin(request, allowedOrigin);

    if (request.method === 'GET' && path === '/api/auth/session') {
      return noStore(200, { user: getUserFromRequest(request) });
    }

    if (request.method === 'GET' && path === '/api/entitlements') {
      const user = requireUser(request);
      return noStore(200, readEntitlements(user.id));
    }

    if (request.method === 'POST' && path === '/api/auth/signup') {
      assertJson(request);
      const input = parseCredentials(rawBody, { requireName: true });
      const key = `signup:${clientIdentity(request)}:${input.email}`;
      limiter.assert(key);
      if (findUserByEmail(input.email)) {
        limiter.fail(key);
        throw httpError(409, '이미 가입된 이메일입니다.');
      }

      const password = await hashPassword(input.password, scryptParams);
      const user = { id: randomId('usr'), name: input.name, email: input.email };
      try {
        db.prepare(
          'INSERT INTO users (id, email, name, password_hash, password_salt, password_params, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        ).run(user.id, user.email, user.name, password.hash, password.salt, JSON.stringify(password.params), now());
      } catch (error) {
        if (String(error?.message ?? '').includes('UNIQUE')) throw httpError(409, '이미 가입된 이메일입니다.');
        throw error;
      }
      issueSession(response, user.id);
      return noStore(201, { user });
    }

    if (request.method === 'POST' && path === '/api/auth/login') {
      assertJson(request);
      const input = parseCredentials(rawBody);
      const key = `login:${clientIdentity(request)}:${input.email}`;
      limiter.assert(key);
      const row = findUserByEmail(input.email);
      const valid = await verifyPassword(input.password, row ?? dummyPasswordRow(scryptParams), scryptParams);
      if (!row || !valid) {
        limiter.fail(key);
        throw httpError(401, '이메일 또는 비밀번호가 올바르지 않습니다.');
      }
      limiter.reset(key);
      issueSession(response, row.id);
      return noStore(200, { user: publicUser(row) });
    }

    if (request.method === 'POST' && path === '/api/auth/logout') {
      assertJson(request);
      const token = readCookie(request);
      if (token) revokeSession(token);
      clearSession(response);
      return noStore(200, { ok: true });
    }

    if (request.method === 'GET' && path === '/api/workspace') {
      const user = requireUser(request);
      return noStore(200, readWorkspace(user.id));
    }

    if (request.method === 'PUT' && path === '/api/workspace') {
      const user = requireUser(request);
      const expectedUser = String(request.headers['x-moa-user'] ?? '');
      if (expectedUser && expectedUser !== user.id) throw httpError(409, '로그인 상태가 변경되었습니다. 새로고침 후 다시 저장해 주세요.');
      assertJson(request);
      const workspace = parseWorkspace(rawBody, { brandLimit: allowedBrandCount(user.id) });
      db.prepare(
        'INSERT INTO workspaces (user_id, brand_json, projects_json, brand_profiles_json, active_brand_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET brand_json = excluded.brand_json, projects_json = excluded.projects_json, brand_profiles_json = excluded.brand_profiles_json, active_brand_id = excluded.active_brand_id, updated_at = excluded.updated_at',
      ).run(
        user.id,
        workspace.brand ? JSON.stringify(workspace.brand) : null,
        JSON.stringify(workspace.projects),
        Object.hasOwn(workspace, 'brandProfiles') ? JSON.stringify(workspace.brandProfiles) : null,
        Object.hasOwn(workspace, 'activeBrandId') ? workspace.activeBrandId : null,
        now(),
      );
      return noStore(200, workspace);
    }

    return null;
  }

  function getUserFromRequest(request) {
    const token = readCookie(request);
    if (!token) return null;
    cleanExpiredSessions();
    const row = db
      .prepare(
        'SELECT users.id, users.email, users.name FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?',
      )
      .get(hashToken(token), now());
    return row ? publicUser(row) : null;
  }

  function readEntitlements(userId) {
    const active = readActivePaidPlan(userId);
    const plan = active?.plan ?? 'free';
    return {
      plan,
      aiLimit: PLAN_AI_LIMITS[plan],
      aiUsed: 0,
      aiRemaining: PLAN_AI_LIMITS[plan],
      brandLimit: PLAN_BRAND_LIMITS[plan],
      periodStart: active?.periodStart ?? null,
      periodEnd: active?.periodEnd ?? null,
      configured: false,
    };
  }

  function allowedBrandCount(userId) {
    const active = readActivePaidPlan(userId);
    const planLimit = PLAN_BRAND_LIMITS[active?.plan ?? 'free'];
    return Math.max(planLimit, storedBrandProfileCount(userId));
  }

  function readActivePaidPlan(userId) {
    if (!tableExists('payment_orders')) return null;
    const row = db
      .prepare(
        `SELECT plan, period_start, period_end
         FROM payment_orders
         WHERE user_id = ? AND status = 'PAID' AND mode = 'live' AND period_start <= ? AND period_end > ?
         ORDER BY CASE plan WHEN 'plus' THEN 3 WHEN 'studio' THEN 2 WHEN 'light' THEN 1 ELSE 0 END DESC, period_end DESC
         LIMIT 1`,
      )
      .get(userId, now(), now());
    if (!row || !Object.hasOwn(PLAN_BRAND_LIMITS, row.plan)) return null;
    return {
      plan: row.plan,
      periodStart: row.period_start ? new Date(row.period_start).toISOString() : null,
      periodEnd: row.period_end ? new Date(row.period_end).toISOString() : null,
    };
  }

  function storedBrandProfileCount(userId) {
    const row = db.prepare('SELECT brand_profiles_json FROM workspaces WHERE user_id = ?').get(userId);
    if (!row || row.brand_profiles_json === null) return 0;
    const profiles = safeJson(row.brand_profiles_json || '[]', []);
    return Array.isArray(profiles) ? profiles.length : 0;
  }

  function tableExists(table) {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
  }

  function requireUser(request) {
    const user = getUserFromRequest(request);
    if (!user) throw httpError(401, '로그인이 필요합니다.');
    return user;
  }

  function issueSession(response, userId) {
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(
      hashToken(token),
      userId,
      now(),
      now() + SESSION_MS,
    );
    response.setHeader('Set-Cookie', serializeCookie(token, { maxAge: SESSION_MS / 1000, secure: secureCookie }));
  }

  function revokeSession(token) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  }

  function cleanExpiredSessions() {
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now());
  }

  function findUserByEmail(email) {
    return db.prepare('SELECT id, email, name, password_hash, password_salt, password_params FROM users WHERE email = ?').get(email);
  }

  function readWorkspace(userId) {
    const row = db.prepare('SELECT brand_json, projects_json, brand_profiles_json, active_brand_id FROM workspaces WHERE user_id = ?').get(userId);
    if (!row) return { brand: null, projects: [] };
    const workspace = {
      brand: row.brand_json ? safeJson(row.brand_json, null) : null,
      projects: safeJson(row.projects_json || '[]', []),
    };
    if (row.brand_profiles_json !== null) {
      workspace.brandProfiles = safeJson(row.brand_profiles_json || '[]', []);
      workspace.activeBrandId = row.active_brand_id ?? null;
    }
    return workspace;
  }

  return { handle, getUserFromRequest, close: () => db.close(), db };
}

function initialize(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_params TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workspaces (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      brand_json TEXT,
      projects_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);
  `);
  ensureColumn(db, 'users', 'password_salt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, 'users', 'password_params', `TEXT NOT NULL DEFAULT '${JSON.stringify(DEFAULT_SCRYPT_PARAMS)}'`);
  ensureColumn(db, 'sessions', 'token_hash', 'TEXT');
  ensureColumn(db, 'workspaces', 'brand_profiles_json', 'TEXT');
  ensureColumn(db, 'workspaces', 'active_brand_id', 'TEXT');
  const columns = columnNames(db, 'sessions');
  if (columns.has('token')) {
    for (const row of db.prepare("SELECT token FROM sessions WHERE token_hash IS NULL OR token_hash = ''").all()) {
      db.prepare('UPDATE sessions SET token_hash = ? WHERE token = ?').run(hashToken(row.token), row.token);
    }
  }
}

function parseCredentials(rawBody, options = {}) {
  const payload = parseObject(rawBody);
  const credentials = {
    email: normalizeEmail(payload.email),
    password: normalizePassword(payload.password),
  };
  if (options.requireName) credentials.name = normalizeName(payload.name);
  return credentials;
}

function parseWorkspace(rawBody, options = {}) {
  if (Buffer.byteLength(rawBody ?? '', 'utf8') > MAX_BODY_BYTES) throw httpError(413, '작업공간 데이터는 10MB 이하여야 합니다.');
  const payload = parseObject(rawBody);
  const workspace = {
    brand: payload.brand === null ? null : validateBrand(payload.brand),
    projects: validateProjects(payload.projects),
  };
  if (Object.hasOwn(payload, 'brandProfiles') || Object.hasOwn(payload, 'activeBrandId')) {
    const brandProfiles = validateBrandProfiles(payload.brandProfiles, options.brandLimit);
    const activeBrandId = validateActiveBrandId(payload.activeBrandId, brandProfiles);
    workspace.brandProfiles = brandProfiles;
    workspace.activeBrandId = activeBrandId;
  }
  return workspace;
}

function parseObject(rawBody) {
  let payload;
  try {
    payload = JSON.parse(rawBody || '{}');
  } catch {
    throw httpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw httpError(400, '요청 데이터가 올바르지 않습니다.');
  return payload;
}

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '올바른 이메일을 입력해 주세요.');
  return email;
}

function normalizeName(value) {
  const name = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (name.length < 1 || name.length > 60) throw httpError(400, '이름은 1~60자로 입력해 주세요.');
  return name;
}

function normalizePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) throw httpError(400, '비밀번호는 10~128자로 입력해 주세요.');
  return value;
}

async function hashPassword(password, params) {
  const salt = randomBytes(16).toString('base64');
  const hash = await scrypt(password, salt, 64, params);
  return { salt, hash: hash.toString('base64'), params: sanitizeScryptParams(params) };
}

async function verifyPassword(password, row, fallbackParams) {
  if (typeof row.password_hash === 'string' && row.password_hash.startsWith('scrypt$') && !row.password_salt) {
    return verifyLegacyPassword(password, row.password_hash);
  }
  const params = sanitizeScryptParams(safeJson(row.password_params, fallbackParams));
  const expected = Buffer.from(row.password_hash, 'base64');
  const actual = await scrypt(password, row.password_salt, expected.length, params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function verifyLegacyPassword(password, stored) {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, rawN, rawR, rawP, salt, digest] = parts;
  const params = sanitizeScryptParams({ N: rawN, r: rawR, p: rawP, maxmem: DEFAULT_SCRYPT_PARAMS.maxmem });
  const expected = Buffer.from(digest, 'base64url');
  const actual = await scrypt(password, salt, expected.length, params);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function dummyPasswordRow(params) {
  return {
    password_hash: 'mNKoWnAJn5qh69Fiw7zTZDgshprpsIh47ZDWJkrrvzVCzKo7F+DY7YpZfE6p7QeBdICl6q4yrzcAYvqvHAYq2Q==',
    password_salt: 'dummy-moa-studio-auth-salt',
    password_params: JSON.stringify(sanitizeScryptParams(params)),
  };
}

function sanitizeScryptParams(params) {
  return {
    N: Number(params?.N) || DEFAULT_SCRYPT_PARAMS.N,
    r: Number(params?.r) || DEFAULT_SCRYPT_PARAMS.r,
    p: Number(params?.p) || DEFAULT_SCRYPT_PARAMS.p,
    maxmem: Number(params?.maxmem) || DEFAULT_SCRYPT_PARAMS.maxmem,
  };
}

function validateBrand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '브랜드 데이터가 올바르지 않습니다.');
  return {
    name: text(value.name, 80),
    tagline: text(value.tagline, 140),
    location: text(value.location, 120),
    instagram: text(value.instagram, 80),
    color: /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : '#254a3b',
  };
}

function validateBrandProfiles(value, brandLimit = 3) {
  if (!Array.isArray(value)) throw httpError(400, '브랜드 프로필 목록이 올바르지 않습니다.');
  if (value.length > brandLimit) throw httpError(400, `브랜드 프로필은 최대 ${brandLimit}개까지 저장할 수 있습니다.`);
  const ids = new Set();
  return value.map((profile) => {
    const id = text(profile?.id, 120);
    if (!id) throw httpError(400, '브랜드 프로필 ID가 올바르지 않습니다.');
    if (ids.has(id)) throw httpError(400, '브랜드 프로필 ID는 중복될 수 없습니다.');
    ids.add(id);
    return { id, ...validateBrand(profile) };
  });
}

function validateActiveBrandId(value, brandProfiles) {
  if (brandProfiles.length === 0) {
    if (value !== null) throw httpError(400, '활성 브랜드 프로필이 올바르지 않습니다.');
    return null;
  }
  const activeBrandId = text(value, 120);
  if (!activeBrandId || !brandProfiles.some((profile) => profile.id === activeBrandId)) {
    throw httpError(400, '활성 브랜드 프로필이 올바르지 않습니다.');
  }
  return activeBrandId;
}

function validateProjects(value) {
  if (!Array.isArray(value)) throw httpError(400, '프로젝트 목록이 올바르지 않습니다.');
  if (value.length > 100) throw httpError(400, '프로젝트는 최대 100개까지 저장할 수 있습니다.');
  return value.map(validateProject);
}

function validateProject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '프로젝트 데이터가 올바르지 않습니다.');
  const photos = Array.isArray(value.photos) ? value.photos : [];
  if (photos.length > 3) throw httpError(400, '프로젝트 이미지는 최대 3장까지 저장할 수 있습니다.');
  const pack = validatePack(value.pack);
  return {
    id: text(value.id, 120),
    name: text(value.name, 120),
    updatedAt: text(value.updatedAt, 40),
    ...(typeof value.brandId === 'string' ? { brandId: text(value.brandId, 120) } : {}),
    brand: validateBrand(value.brand),
    brief: validateBrief(value.brief),
    photos: photos.map(validatePhoto),
    pack,
    ...(value.photoChats === undefined ? {} : { photoChats: validatePhotoChats(value.photoChats, pack) }),
  };
}

function validateBrief(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '콘텐츠 입력 데이터가 올바르지 않습니다.');
  return {
    productName: text(value.productName, 120),
    description: text(value.description, 500),
    price: text(value.price, 80),
    tone: ['warm', 'simple', 'playful'].includes(value.tone) ? value.tone : 'warm',
    goal: ['new', 'daily', 'event'].includes(value.goal) ? value.goal : 'daily',
    ...(typeof value.includeSchedule === 'boolean' ? { includeSchedule: value.includeSchedule } : {}),
    ...(typeof value.scheduleStartDate === 'string' ? { scheduleStartDate: text(value.scheduleStartDate, 10) } : {}),
  };
}

function validatePhoto(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '이미지 데이터가 올바르지 않습니다.');
  const dataUrl = text(value.dataUrl, MAX_BODY_BYTES);
  if (dataUrl && !/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl) && dataUrl !== '/assets/cafe-latte.png') {
    throw httpError(400, '이미지는 PNG, JPG, WEBP data URL 또는 제공된 샘플 이미지만 저장할 수 있습니다.');
  }
  return { id: text(value.id, 120), name: text(value.name, 180), dataUrl };
}

function validatePack(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '생성 결과 데이터가 올바르지 않습니다.');
  if (!Array.isArray(value.cards) || value.cards.length < 1 || value.cards.length > 10) throw httpError(400, '카드는 1~10장까지 저장할 수 있습니다.');
  if (String(value.caption ?? '').length > 5000) throw httpError(400, '게시글은 5,000자까지 저장할 수 있습니다.');
  if (Array.isArray(value.hashtags) && value.hashtags.length > 30) throw httpError(400, '해시태그는 30개까지 저장할 수 있습니다.');
  if (Array.isArray(value.schedule) && value.schedule.length > 30) throw httpError(400, '홍보 일정은 30개까지 저장할 수 있습니다.');
  return {
    source: value.source === 'ai' ? 'ai' : 'template',
    cards: Array.isArray(value.cards) ? value.cards.map(validateCard) : [],
    caption: text(value.caption, 5000),
    hashtags: Array.isArray(value.hashtags) ? value.hashtags.map((tag) => text(tag, 60)) : [],
    schedule: Array.isArray(value.schedule) ? value.schedule.map(validateSchedule) : [],
  };
}

function validateCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '카드 데이터가 올바르지 않습니다.');
  return {
    id: text(value.id, 120),
    title: text(value.title, 200),
    subtitle: text(value.subtitle, 200),
    eyebrow: text(value.eyebrow, 80),
    body: text(value.body, 1000),
    imageId: text(value.imageId, 120),
    layout: ['editorial', 'minimal', 'bold', 'split', 'poster', 'menu'].includes(value.layout) ? value.layout : 'editorial',
    ...(value.style === undefined ? {} : { style: validateCardStyle(value.style) }),
  };
}

function validateCardStyle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '카드 스타일이 올바르지 않습니다.');
  const result = {};
  for (const key of ['textColor', 'backgroundColor']) {
    if (value[key] === undefined) continue;
    if (!/^#[0-9a-f]{6}$/i.test(value[key])) throw httpError(400, '카드 색상이 올바르지 않습니다.');
    result[key] = value[key];
  }
  if (value.fontScale !== undefined) {
    if (typeof value.fontScale !== 'number' || !Number.isFinite(value.fontScale) || value.fontScale < 0.85 || value.fontScale > 1.2) throw httpError(400, '글자 크기는 85~120%여야 합니다.');
    result.fontScale = value.fontScale;
  }
  if (value.align !== undefined) {
    if (!['left', 'center', 'right'].includes(value.align)) throw httpError(400, '글자 정렬이 올바르지 않습니다.');
    result.align = value.align;
  }
  return result;
}

function validatePhotoChats(value, pack) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '사진 수정 대화 기록이 올바르지 않습니다.');
  const entries = Object.entries(value);
  const cardIds = new Set(pack.cards.map((card) => card.id));
  if (entries.length > PHOTO_CHAT_MAX_THREADS) throw httpError(400, '사진 수정 대화는 카드 10개까지 저장할 수 있습니다.');
  const result = {};
  for (const [cardId, messages] of entries) {
    if (!cardId || cardId.length > 120 || !cardIds.has(cardId)) throw httpError(400, '사진 수정 대화의 카드 정보가 올바르지 않습니다.');
    if (!Array.isArray(messages)) throw httpError(400, '사진 수정 대화 메시지가 올바르지 않습니다.');
    if (messages.length > PHOTO_CHAT_MAX_MESSAGES) throw httpError(400, '사진 수정 대화는 카드당 200개까지 저장할 수 있습니다.');
    result[cardId] = messages.map(validatePhotoChatMessage);
  }
  return result;
}

function validatePhotoChatMessage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '사진 수정 대화 메시지가 올바르지 않습니다.');
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('role') || !keys.includes('content')) {
    throw httpError(400, '사진 수정 대화는 텍스트 기록만 저장할 수 있습니다.');
  }
  if (value.role !== 'user' && value.role !== 'assistant') throw httpError(400, '사진 수정 대화 역할이 올바르지 않습니다.');
  const max = value.role === 'assistant' ? PHOTO_CHAT_ASSISTANT_MAX_CHARS : PHOTO_CHAT_USER_MAX_CHARS;
  if (typeof value.content !== 'string' || value.content.length < 1 || value.content.length > max) {
    throw httpError(400, value.role === 'assistant' ? 'AI 응답은 4,000자까지 저장할 수 있습니다.' : '사진 수정 요청은 2,000자까지 저장할 수 있습니다.');
  }
  return { role: value.role, content: value.content };
}

function validateSchedule(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, '일정 데이터가 올바르지 않습니다.');
  return {
    ...(typeof value.date === 'string' ? { date: text(value.date, 10) } : {}),
    day: text(value.day, 20),
    title: text(value.title, 160),
    format: text(value.format, 80),
    description: text(value.description, 500),
  };
}

function assertSameOrigin(request, allowedOrigin) {
  const origin = request.headers.origin;
  if (origin && origin !== allowedOrigin) throw httpError(403, '요청 출처를 확인할 수 없습니다.');
}

function assertJson(request) {
  const type = String(request.headers['content-type'] ?? '').toLowerCase();
  if (!type.includes('application/json')) throw httpError(415, 'Content-Type은 application/json이어야 합니다.');
}

function readCookie(request) {
  for (const part of String(request.headers.cookie ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE_NAME) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function serializeCookie(value, options = {}) {
  const parts = [`${COOKIE_NAME}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSession(response) {
  response.setHeader('Set-Cookie', serializeCookie('', { maxAge: 0 }));
}

function isMutation(method) {
  return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
}

function publicUser(row) {
  return { id: row.id, name: row.name, email: row.email };
}

function clientIdentity(request) {
  return String(request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'local').split(',')[0].trim();
}

function randomId(prefix) {
  return `${prefix}_${randomBytes(12).toString('base64url')}`;
}

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function noStore(status, payload) {
  return { status, payload, noStore: true };
}

function columnNames(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));
}

function ensureColumn(db, table, name, definition) {
  if (!columnNames(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

class RateLimiter {
  constructor(now) {
    this.now = now;
    this.records = new Map();
  }

  assert(key) {
    const record = this.records.get(key);
    if (record?.blockedUntil > this.now()) throw httpError(429, '잠시 후 다시 시도해 주세요.');
  }

  fail(key) {
    const current = this.records.get(key);
    const stale = !current || this.now() - current.firstAt > 10 * 60 * 1000;
    const next = stale ? { count: 1, firstAt: this.now(), blockedUntil: 0 } : { ...current, count: current.count + 1 };
    if (next.count >= 5) next.blockedUntil = this.now() + 10 * 60 * 1000;
    this.records.set(key, next);
  }

  reset(key) {
    this.records.delete(key);
  }
}
