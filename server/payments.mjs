import { randomUUID } from 'node:crypto';
import { httpError, loadLocalEnv } from './content.mjs';

const TOSS_API_BASE = 'https://api.tosspayments.com';
const DEFAULT_ORIGIN = 'http://127.0.0.1:5173';
const DEFAULT_APP_URL = 'http://127.0.0.1:5173';
const MAX_BODY_BYTES = 32 * 1024;
const KRW = 'KRW';
const ORDER_TTL_MS = 30 * 60 * 1000;
const PLANS = {
  light: {
    name: 'Light',
    prices: { month: 3900, year: 42000 },
  },
  studio: {
    name: 'Standard',
    prices: { month: 7900, year: 85000 },
  },
  plus: {
    name: 'Pro',
    prices: { month: 12900, year: 139000 },
  },
};

export function createPaymentService(options = {}) {
  loadLocalEnv();
  if (!options.auth?.db || typeof options.auth.getUserFromRequest !== 'function') {
    throw new TypeError('createPaymentService requires auth.db and auth.getUserFromRequest');
  }

  const auth = options.auth;
  const db = auth.db;
  const now = options.now ?? (() => Date.now());
  const fetchImpl = options.fetchImpl ?? fetch;
  const allowedOrigin = options.allowedOrigin ?? DEFAULT_ORIGIN;
  const config = readConfig(options.config, options.env ?? process.env);
  const limiter = new RateLimiter(now);
  const inflightConfirms = new Map();

  initialize(db);

  async function handle(request, rawBody = request.rawBody ?? '') {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    const path = url.pathname;

    if (request.method === 'GET' && path === '/api/payments/config') {
      return noStore(200, publicConfig());
    }

    if (request.method === 'GET' && path === '/api/payments/membership') {
      const user = requireUser(request);
      await syncActiveMembership(user.id);
      return noStore(200, { membership: readMembership(user.id) });
    }

    if (request.method === 'GET' && path === '/api/payments/orders') {
      const user = requireUser(request);
      const orders = await readOrders(user.id);
      return noStore(200, { orders: orders.map(presentOrder) });
    }

    const orderMatch = path.match(/^\/api\/payments\/orders\/([^/]+)$/);
    if (request.method === 'GET' && orderMatch) {
      const user = requireUser(request);
      const order = await readOrder(user.id, decodeURIComponent(orderMatch[1]));
      return noStore(200, presentOrder(order));
    }

    if (request.method === 'POST' && path === '/api/payments/webhook') {
      assertPaymentAvailable();
      assertJson(request);
      assertBodySize(rawBody);
      const input = parseWebhookInput(rawBody);
      await reconcileWebhookPayment(input);
      return noStore(204, null);
    }

    if (request.method === 'POST' && path === '/api/payments/orders') {
      assertPaymentAvailable();
      assertSameOrigin(request);
      assertJson(request);
      assertBodySize(rawBody);
      const user = requireUser(request);
      limiter.assert(`order:${clientIdentity(request)}:${user.id}`);
      const input = parseOrderInput(rawBody);
      const order = createOrder(user, input);
      return noStore(201, presentOrderForCheckout(order, config));
    }

    if (request.method === 'POST' && path === '/api/payments/confirm') {
      assertPaymentAvailable();
      assertSameOrigin(request);
      assertJson(request);
      assertBodySize(rawBody);
      const user = requireUser(request);
      limiter.assert(`confirm:${clientIdentity(request)}:${user.id}`);
      const input = parseConfirmInput(rawBody);
      const key = `${user.id}:${input.orderId}:${input.amount}:${input.paymentKey}`;
      if (!inflightConfirms.has(key)) {
        inflightConfirms.set(
          key,
          confirmPayment(user, input).finally(() => inflightConfirms.delete(key)),
        );
      }
      return noStore(200, await inflightConfirms.get(key));
    }

    return null;
  }

  function publicConfig() {
    if (!config.valid) {
      return {
        configured: false,
        mode: 'disabled',
        message: config.message,
      };
    }
    return {
      configured: true,
      mode: config.mode,
      clientKey: config.clientKey,
    };
  }

  function assertPaymentAvailable() {
    if (!config.valid) throw httpError(503, config.message);
  }

  function createOrder(user, input) {
    const plan = PLANS[input.plan];
    const amount = plan.prices[input.interval];
    const orderId = `moa_${randomUUID().replaceAll('-', '')}`;
    const orderName = `모아 스튜디오 ${plan.name} ${input.interval === 'year' ? '연간' : '월간'} 플랜`;
    const createdAt = now();

    db.prepare(
      `INSERT INTO payment_orders (
        id, user_id, plan, interval, mode, order_name, amount, currency, status,
        created_at, updated_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
    ).run(orderId, user.id, input.plan, input.interval, config.mode, orderName, amount, KRW, createdAt, createdAt, createdAt + ORDER_TTL_MS);

    return getOwnedOrder(user.id, orderId);
  }

  async function confirmPayment(user, input) {
    const order = getOwnedOrder(user.id, input.orderId);
    if (input.amount !== order.amount) throw httpError(400, '결제 금액이 주문 금액과 일치하지 않습니다.');
    if (order.status === 'PAID') {
      if (order.toss_payment_key !== input.paymentKey) throw httpError(409, '이미 다른 결제 키로 승인된 주문입니다.');
      return presentPaidOrder(order);
    }
    if (order.status !== 'PENDING') throw httpError(409, '처리할 수 없는 주문 상태입니다.');
    if (order.expires_at <= now()) throw httpError(410, '결제 주문 시간이 만료되었습니다. 다시 시도해 주세요.');
    if (order.mode !== config.mode) throw httpError(409, '현재 결제 모드와 주문 모드가 일치하지 않습니다. 주문을 다시 생성해 주세요.');

    const idempotencyKey = `confirm:${order.id}`;
    let payment;
    try {
      payment = await callTossConfirm(input, idempotencyKey);
    } catch (error) {
      payment = await reconcileTossOrder(order.id, input.paymentKey, input.amount);
      if (!payment) throw error;
    }

    const verified = verifyTossPayment(payment, order, input.paymentKey);
    persistPaidOrder(order, verified);
    return presentPaidOrder(getOwnedOrder(user.id, order.id));
  }

  async function callTossConfirm(input, idempotencyKey) {
    const response = await tossFetch('/v1/payments/confirm', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        paymentKey: input.paymentKey,
        orderId: input.orderId,
        amount: input.amount,
      }),
    });
    if (!response.ok) throw httpError(502, '토스 결제 승인이 실패했습니다.');
    return parseTossJson(response);
  }

  async function reconcileTossOrder(orderId, paymentKey, amount) {
    const response = await tossFetch(`/v1/payments/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
    if (!response.ok) return null;
    const payment = await parseTossJson(response);
    try {
      return verifyTossPayment(payment, { id: orderId, amount, currency: KRW }, paymentKey);
    } catch {
      return null;
    }
  }

  async function fetchTossPaymentByKey(paymentKey) {
    const response = await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' });
    if (!response.ok) throw httpError(502, '토스 결제 상태를 확인하지 못했습니다.');
    return parseTossJson(response);
  }

  async function fetchTossPaymentByOrderId(orderId) {
    const response = await tossFetch(`/v1/payments/orders/${encodeURIComponent(orderId)}`, { method: 'GET' });
    if (!response.ok) throw httpError(502, '토스 결제 상태를 확인하지 못했습니다.');
    return parseTossJson(response);
  }

  async function tossFetch(path, init) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      return await fetchImpl(`${TOSS_API_BASE}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Basic ${Buffer.from(`${config.secretKey}:`, 'utf8').toString('base64')}`,
          ...(init.headers ?? {}),
        },
      });
    } catch (error) {
      if (error.name === 'AbortError') throw httpError(504, '토스 결제 승인 응답 시간이 초과되었습니다.');
      throw httpError(502, '토스 결제 서버에 연결하지 못했습니다.');
    } finally {
      clearTimeout(timeout);
    }
  }

  function persistPaidOrder(order, payment) {
    const paidAt = now();
    const periodEnd = periodEndFor(paidAt, order.interval);
    const receiptUrl = safeReceiptUrl(payment.receipt?.url);
    try {
      db.exec('BEGIN IMMEDIATE');
      const current = db.prepare('SELECT status FROM payment_orders WHERE id = ?').get(order.id);
      if (current?.status !== 'PAID') {
        db.prepare(
          `UPDATE payment_orders
           SET status = 'PAID', toss_payment_key = ?, toss_status = ?, receipt_url = ?,
               paid_at = ?, period_start = ?, period_end = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND status = 'PENDING'`,
        ).run(payment.paymentKey, payment.status, receiptUrl, paidAt, paidAt, periodEnd, paidAt, order.id, order.user_id);
      }
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The rollback can fail if the transaction was never opened.
      }
      throw error;
    }
  }

  function readMembership(userId) {
    const row = db
      .prepare(
        `SELECT plan, interval, mode, period_end
         FROM payment_orders
         WHERE user_id = ? AND status = 'PAID' AND mode = 'live' AND period_end > ?
         ORDER BY period_end DESC
         LIMIT 1`,
      )
      .get(userId, now());
    if (!row) return null;
    return {
      plan: row.plan,
      interval: row.interval,
      mode: row.mode,
      periodEnd: new Date(row.period_end).toISOString(),
    };
  }

  async function syncActiveMembership(userId) {
    if (!config.valid || config.mode !== 'live') return;
    const rows = db
      .prepare(
        `SELECT *
         FROM payment_orders
         WHERE user_id = ? AND status = 'PAID' AND mode = 'live' AND period_end > ?
         ORDER BY period_end DESC
         LIMIT 5`,
      )
      .all(userId, now());
    for (const row of rows) await syncOrderFromProvider(row);
  }

  async function readOrders(userId) {
    const rows = db
      .prepare(
        `SELECT *
         FROM payment_orders
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 20`,
      )
      .all(userId);
    return await Promise.all(rows.map((row) => syncOrderFromProvider(row)));
  }

  function getOwnedOrder(userId, orderId) {
    if (!isOrderId(orderId)) throw httpError(404, '주문을 찾을 수 없습니다.');
    const row = db.prepare('SELECT * FROM payment_orders WHERE id = ? AND user_id = ?').get(orderId, userId);
    if (!row) throw httpError(404, '주문을 찾을 수 없습니다.');
    return row;
  }

  async function readOrder(userId, orderId) {
    return await syncOrderFromProvider(getOwnedOrder(userId, orderId));
  }

  async function syncOrderFromProvider(order) {
    if (!shouldSyncProviderStatus(order)) return order;
    const payment = await fetchTossPaymentByKey(order.toss_payment_key);
    if (!matchesStoredPayment(payment, order, order.toss_payment_key)) throw httpError(502, '토스 결제 상태가 저장된 주문과 일치하지 않습니다.');
    if (!isRevokedPaymentStatus(payment.status)) return order;
    persistRevokedOrder(order, payment);
    return getOwnedOrder(order.user_id, order.id);
  }

  async function reconcileWebhookPayment(input) {
    let payment;
    if (input.paymentKey) payment = await fetchTossPaymentByKey(input.paymentKey);
    else payment = await fetchTossPaymentByOrderId(input.orderId);

    const order = db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(payment.orderId);
    if (!order || !matchesStoredPayment(payment, order, input.paymentKey || payment.paymentKey)) return;
    if (isRevokedPaymentStatus(payment.status)) persistRevokedOrder(order, payment);
  }

  function persistRevokedOrder(order, payment) {
    if (order.status === 'CANCELED') return;
    db.prepare(
      `UPDATE payment_orders
       SET status = 'CANCELED', toss_status = ?, updated_at = ?
       WHERE id = ? AND status IN ('PAID', 'PENDING')`,
    ).run(payment.status, now(), order.id);
  }

  function shouldSyncProviderStatus(order) {
    return config.valid && order.mode === config.mode && order.status === 'PAID' && !!order.toss_payment_key;
  }

  function requireUser(request) {
    const user = auth.getUserFromRequest(request);
    if (!user) throw httpError(401, '로그인이 필요합니다.');
    return user;
  }

  function assertSameOrigin(request) {
    const origin = String(request.headers.origin ?? '');
    if (origin && origin !== allowedOrigin) throw httpError(403, '허용되지 않은 요청 출처입니다.');
  }

  return { handle, plans: PLANS, close: () => undefined };
}

function readConfig(override, env) {
  const clientKey = normalizeKey(override?.clientKey ?? env.TOSS_CLIENT_KEY);
  const secretKey = normalizeKey(override?.secretKey ?? env.TOSS_SECRET_KEY);
  const publicAppUrl = normalizeUrl(override?.publicAppUrl ?? env.PUBLIC_APP_URL ?? DEFAULT_APP_URL);
  const liveEnabledValue = override?.liveEnabled ?? env.TOSS_LIVE_ENABLED ?? '';
  const liveEnabled = liveEnabledValue === true || String(liveEnabledValue) === '1';
  const paidFeaturesReadyValue = override?.paidFeaturesReady ?? env.PAID_FEATURES_READY ?? '';
  const paidFeaturesReady = paidFeaturesReadyValue === true || String(paidFeaturesReadyValue) === '1';
  const aiReadyValue = override?.aiReady ?? env.MOA_AI_READY ?? '';
  const aiReady = aiReadyValue === true || String(aiReadyValue) === '1';

  if (!clientKey || !secretKey) {
    return disabled('결제 설정이 아직 완료되지 않았습니다.');
  }
  if (isWidgetKey(clientKey) || isWidgetKey(secretKey)) {
    return disabled('결제위젯 키가 감지되었습니다. 표준 결제창용 client/secret 키를 같은 세트로 설정해 주세요.');
  }
  if (!isClientKey(clientKey) || !isSecretKey(secretKey)) {
    return disabled('Toss Payments 키 형식이 올바르지 않습니다.');
  }
  const clientMode = keyMode(clientKey);
  const secretMode = keyMode(secretKey);
  if (clientMode !== secretMode) {
    return disabled('테스트 키와 라이브 키가 섞여 있습니다. 같은 모드의 키 세트를 사용해 주세요.');
  }
  if (clientMode === 'live' && !liveEnabled) {
    return disabled('실결제 전환 확인이 아직 완료되지 않았습니다.');
  }
  if (clientMode === 'live' && !paidFeaturesReady) {
    return disabled('유료 기능 제공 준비가 아직 완료되지 않았습니다.');
  }
  if (clientMode === 'live' && !aiReady) {
    return disabled('유료 AI 기능 제공 준비가 아직 확인되지 않았습니다.');
  }
  if (clientMode === 'live' && !publicAppUrl.startsWith('https://')) {
    return disabled('라이브 결제는 HTTPS PUBLIC_APP_URL이 필요합니다.');
  }
  return {
    valid: true,
    mode: clientMode,
    clientKey,
    secretKey,
    publicAppUrl: publicAppUrl.replace(/\/+$/, ''),
  };
}

function disabled(message) {
  return { valid: false, mode: 'disabled', message };
}

function parseOrderInput(rawBody) {
  const payload = parseObject(rawBody);
  const plan = typeof payload.plan === 'string' ? payload.plan : '';
  const interval = typeof payload.interval === 'string' ? payload.interval : '';
  if (!Object.hasOwn(PLANS, plan)) throw httpError(400, '결제할 플랜이 올바르지 않습니다.');
  if (!Object.hasOwn(PLANS[plan].prices, interval)) throw httpError(400, '결제 주기가 올바르지 않습니다.');
  return { plan, interval };
}

function parseConfirmInput(rawBody) {
  const payload = parseObject(rawBody);
  const orderId = typeof payload.orderId === 'string' ? payload.orderId.trim() : '';
  const paymentKey = typeof payload.paymentKey === 'string' ? payload.paymentKey.trim() : '';
  const amount = normalizeAmount(payload.amount);
  if (!isOrderId(orderId)) throw httpError(400, '주문 번호가 올바르지 않습니다.');
  if (paymentKey.length < 10 || paymentKey.length > 300) throw httpError(400, '결제 키가 올바르지 않습니다.');
  return { orderId, paymentKey, amount };
}

function parseWebhookInput(rawBody) {
  const payload = parseObject(rawBody);
  const source = payload.data && typeof payload.data === 'object' ? payload.data : payload;
  const orderId = typeof source.orderId === 'string' ? source.orderId.trim() : '';
  const paymentKey = typeof source.paymentKey === 'string' ? source.paymentKey.trim() : '';
  if (!isOrderId(orderId)) throw httpError(400, '주문 번호가 올바르지 않습니다.');
  if (paymentKey && (paymentKey.length < 10 || paymentKey.length > 300)) throw httpError(400, '결제 키가 올바르지 않습니다.');
  return { orderId, paymentKey };
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

function verifyTossPayment(payment, order, paymentKey) {
  if (!payment || typeof payment !== 'object') throw httpError(502, '토스 결제 응답이 올바르지 않습니다.');
  if (payment.status !== 'DONE') throw httpError(502, '토스 결제가 완료 상태가 아닙니다.');
  if (!matchesStoredPayment(payment, order, paymentKey)) throw httpError(502, '토스 결제 정보가 주문과 일치하지 않습니다.');
  return payment;
}

function matchesStoredPayment(payment, order, paymentKey) {
  if (!payment || typeof payment !== 'object') return false;
  if (payment.currency !== KRW) throw httpError(502, '토스 결제 통화가 올바르지 않습니다.');
  return payment.orderId === order.id &&
    payment.paymentKey === paymentKey &&
    Number(payment.totalAmount) === Number(order.amount);
}

function isRevokedPaymentStatus(status) {
  return status === 'CANCELED' || status === 'PARTIAL_CANCELED';
}

async function parseTossJson(response) {
  try {
    return await response.json();
  } catch {
    throw httpError(502, '토스 결제 응답을 처리하지 못했습니다.');
  }
}

function presentOrderForCheckout(order, config) {
  return {
    ...presentOrder(order),
    clientKey: config.clientKey,
    customerKey: `moa_${order.user_id}`,
    successUrl: `${config.publicAppUrl}/?payment=success`,
    failUrl: `${config.publicAppUrl}/?payment=fail`,
  };
}

function presentOrder(order) {
  const payload = {
    orderId: order.id,
    orderName: order.order_name,
    amount: order.amount,
    status: order.status,
    mode: order.mode,
    plan: order.plan,
    interval: order.interval,
  };
  if (order.status === 'PAID') {
    payload.receiptUrl = order.receipt_url || undefined;
    payload.periodEnd = new Date(order.period_end).toISOString();
    payload.paidAt = order.paid_at ? new Date(order.paid_at).toISOString() : undefined;
  }
  if (order.toss_status) payload.providerStatus = order.toss_status;
  payload.createdAt = new Date(order.created_at).toISOString();
  return payload;
}

function presentPaidOrder(order) {
  return {
    orderId: order.id,
    orderName: order.order_name,
    amount: order.amount,
    status: 'PAID',
    mode: order.mode,
    receiptUrl: order.receipt_url || undefined,
    periodEnd: new Date(order.period_end).toISOString(),
    paidAt: order.paid_at ? new Date(order.paid_at).toISOString() : undefined,
    providerStatus: order.toss_status || undefined,
    createdAt: new Date(order.created_at).toISOString(),
  };
}

function initialize(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS payment_orders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL CHECK (plan IN ('light', 'studio', 'plus')),
      interval TEXT NOT NULL,
      mode TEXT NOT NULL,
      order_name TEXT NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL,
      toss_payment_key TEXT UNIQUE,
      toss_status TEXT,
      receipt_url TEXT,
      paid_at INTEGER,
      period_start INTEGER,
      period_end INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS payment_orders_user_status_idx ON payment_orders(user_id, status, period_end);
  `);
}

function normalizeAmount(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw httpError(400, '결제 금액이 올바르지 않습니다.');
  return value;
}

function periodEndFor(startMs, interval) {
  const date = new Date(startMs);
  const originalDay = date.getUTCDate();
  if (interval === 'year') {
    date.setUTCDate(1);
    date.setUTCFullYear(date.getUTCFullYear() + 1);
  } else {
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + 1);
  }
  date.setUTCDate(Math.min(originalDay, daysInUtcMonth(date.getUTCFullYear(), date.getUTCMonth())));
  return date.getTime();
}

function daysInUtcMonth(year, month) {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function assertJson(request) {
  const contentType = String(request.headers['content-type'] ?? '');
  if (!contentType.toLowerCase().startsWith('application/json')) throw httpError(415, 'Content-Type은 application/json이어야 합니다.');
}

function assertBodySize(rawBody) {
  if (Buffer.byteLength(rawBody ?? '', 'utf8') > MAX_BODY_BYTES) throw httpError(413, '결제 요청 본문은 32KB 이하여야 합니다.');
}

function clientIdentity(request) {
  return String(request.headers['x-forwarded-for'] ?? request.socket?.remoteAddress ?? 'local').split(',')[0].trim();
}

function noStore(status, payload) {
  return { status, payload, noStore: true };
}

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function keyMode(key) {
  if (key.startsWith('test_')) return 'test';
  if (key.startsWith('live_')) return 'live';
  return 'disabled';
}

function isClientKey(key) {
  return /^(test|live)_ck_/.test(key);
}

function isSecretKey(key) {
  return /^(test|live)_sk_/.test(key);
}

function isWidgetKey(key) {
  return /_(gck|gsk)_/.test(key);
}

function isOrderId(value) {
  return /^moa_[A-Za-z0-9_-]{10,64}$/.test(value);
}

function normalizeUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_APP_URL;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return DEFAULT_APP_URL;
    return url.toString().replace(/\/+$/, '');
  } catch {
    return DEFAULT_APP_URL;
  }
}

function safeReceiptUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'tosspayments.com' || host.endsWith('.tosspayments.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

class RateLimiter {
  constructor(now) {
    this.now = now;
    this.entries = new Map();
  }

  assert(key) {
    const current = this.now();
    const entry = this.entries.get(key) ?? { count: 0, resetAt: current + 60_000 };
    if (entry.resetAt <= current) {
      entry.count = 0;
      entry.resetAt = current + 60_000;
    }
    entry.count += 1;
    this.entries.set(key, entry);
    if (entry.count > 30) throw httpError(429, '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
  }
}
