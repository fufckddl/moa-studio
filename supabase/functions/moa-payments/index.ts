import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from '@supabase/supabase-js';

const TOSS_API_BASE = 'https://api.tosspayments.com';
const KRW = 'KRW';
const ORDER_TTL_MS = 30 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const LOCAL_ORIGINS = new Set(['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173']);
const PLANS = {
  light: { name: 'Light', prices: { month: 3900, year: 42000 } },
  studio: { name: 'Standard', prices: { month: 7900, year: 85000 } },
  plus: { name: 'Pro', prices: { month: 12900, year: 139000 } },
} as const;

type PaymentPlan = keyof typeof PLANS;
type PaymentInterval = keyof typeof PLANS[PaymentPlan]['prices'];
type PaymentMode = 'test' | 'live' | 'disabled';
type ActivePaymentConfig = { valid: true; mode: 'test' | 'live'; clientKey: string; secretKey: string; publicAppUrl: string };
type PaymentConfig = { valid: false; mode: 'disabled'; message: string } | ActivePaymentConfig;
type User = { id: string; email?: string };
type OrderRow = {
  id: string;
  user_id: string;
  plan: PaymentPlan;
  interval: PaymentInterval;
  mode: Exclude<PaymentMode, 'disabled'>;
  order_name: string;
  amount: number;
  currency: 'KRW';
  status: 'PENDING' | 'PAID' | 'FAILED' | 'CANCELED';
  toss_payment_key: string | null;
  receipt_url: string | null;
  toss_status: string | null;
  created_at: string;
  paid_at: string | null;
  period_end: string | null;
  expires_at: string;
};

Deno.serve(async (request: Request) => {
  try {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });
    const path = normalizePath(new URL(request.url).pathname);

    if (request.method === 'GET' && path === '/config') return json(request, 200, publicConfig(readConfig()));

    if (request.method === 'GET' && path === '/membership') {
      const user = await requireUser(request);
      await syncActiveMembership(user.id, readConfig());
      const { data, error } = await admin().from('payment_orders')
        .select('plan, interval, mode, period_end')
        .eq('user_id', user.id)
        .eq('status', 'PAID')
        .eq('mode', 'live')
        .gt('period_end', new Date().toISOString())
        .order('period_end', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw httpError(500, '멤버십 정보를 확인하지 못했습니다.');
      return json(request, 200, { membership: data ? { plan: data.plan, interval: data.interval, mode: data.mode, periodEnd: data.period_end } : null });
    }

    if (request.method === 'GET' && path === '/orders') {
      const user = await requireUser(request);
      const orders = await listOwnedOrders(user.id, readConfig());
      return json(request, 200, { orders: orders.map(presentOrder) });
    }

    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (request.method === 'GET' && orderMatch) {
      const user = await requireUser(request);
      const order = await getOwnedOrder(user.id, decodeURIComponent(orderMatch[1]));
      return json(request, 200, presentOrder(await syncOrderFromProvider(order, readConfig())));
    }

    if (request.method === 'POST' && path === '/webhook') {
      const config = readConfig();
      assertPaymentAvailable(config);
      const input = parseWebhookInput(await readJsonBody(request));
      await reconcileWebhookPayment(input, config);
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }

    if (request.method === 'POST' && path === '/orders') {
      const config = readConfig();
      assertPaymentAvailable(config);
      assertOrigin(request, config);
      const input = parseOrderInput(await readJsonBody(request));
      const user = await requireUser(request);
      const order = await createOrder(user, input, config);
      return json(request, 201, presentOrderForCheckout(order, config));
    }

    if (request.method === 'POST' && path === '/confirm') {
      const config = readConfig();
      assertPaymentAvailable(config);
      assertOrigin(request, config);
      const input = parseConfirmInput(await readJsonBody(request));
      const user = await requireUser(request);
      const order = await getOwnedOrder(user.id, input.orderId);
      const paid = await confirmPayment(order, input, config);
      return json(request, 200, presentOrder(paid));
    }

    return json(request, 404, { error: '요청한 경로를 찾을 수 없습니다.' });
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    const message = status === 500 ? '서버 오류가 발생했습니다.' : error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
    return json(request, status, { error: message });
  }
});

async function requireUser(request: Request): Promise<User> {
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw httpError(401, '로그인이 필요합니다.');
  const { data, error } = await userClient(authorization).auth.getUser(token);
  if (error || !data.user) throw httpError(401, '로그인이 필요합니다.');
  return { id: data.user.id, email: data.user.email ?? undefined };
}

async function createOrder(user: User, input: { plan: PaymentPlan; interval: PaymentInterval }, config: ActivePaymentConfig): Promise<OrderRow> {
  const plan = PLANS[input.plan];
  const amount = plan.prices[input.interval];
  const now = new Date();
  const orderId = `moa_${crypto.randomUUID().replaceAll('-', '')}`;
  const orderName = `모아 스튜디오 ${plan.name} ${input.interval === 'year' ? '연간' : '월간'} 플랜`;
  const { data, error } = await admin().from('payment_orders').insert({
    id: orderId,
    user_id: user.id,
    plan: input.plan,
    interval: input.interval,
    mode: config.mode,
    order_name: orderName,
    amount,
    currency: KRW,
    status: 'PENDING',
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: new Date(now.getTime() + ORDER_TTL_MS).toISOString(),
  }).select('*').single();
  if (error) throw httpError(500, '결제 주문을 만들지 못했습니다.');
  return data as OrderRow;
}

async function confirmPayment(order: OrderRow, input: { orderId: string; paymentKey: string; amount: number }, config: ActivePaymentConfig): Promise<OrderRow> {
  if (input.amount !== order.amount) throw httpError(400, '결제 금액이 주문 금액과 일치하지 않습니다.');
  if (order.status === 'PAID') {
    if (order.toss_payment_key !== input.paymentKey) throw httpError(409, '이미 다른 결제 키로 승인된 주문입니다.');
    return order;
  }
  if (order.status !== 'PENDING') throw httpError(409, '처리할 수 없는 주문 상태입니다.');
  if (new Date(order.expires_at).getTime() <= Date.now()) throw httpError(410, '결제 주문 시간이 만료되었습니다. 다시 시도해 주세요.');
  if (order.mode !== config.mode) throw httpError(409, '현재 결제 모드와 주문 모드가 일치하지 않습니다. 주문을 다시 생성해 주세요.');

  let payment: TossPayment;
  try {
    payment = await callTossConfirm(input, config);
  } catch (error) {
    const reconciled = await reconcileTossOrder(order, input.paymentKey, config);
    if (!reconciled) throw error;
    payment = reconciled;
  }

  verifyTossPayment(payment, order, input.paymentKey);
  const { data, error } = await admin().rpc('finalize_payment_order', {
    p_order_id: order.id,
    p_payment_key: payment.paymentKey,
    p_toss_status: payment.status,
    p_receipt_url: safeReceiptUrl(payment.receipt?.url),
    p_paid_at: new Date().toISOString(),
  });
  if (error) {
    if (error.code === '23505') throw httpError(409, '이미 다른 결제 키로 승인된 주문입니다.');
    throw httpError(500, '결제 승인 결과를 저장하지 못했습니다.');
  }
  return data as OrderRow;
}

async function callTossConfirm(input: { orderId: string; paymentKey: string; amount: number }, config: ActivePaymentConfig) {
  const response = await tossFetch('/v1/payments/confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `confirm:${input.orderId}` },
    body: JSON.stringify({ paymentKey: input.paymentKey, orderId: input.orderId, amount: input.amount }),
  }, config);
  if (!response.ok) throw httpError(502, '토스 결제 승인이 실패했습니다.');
  return parseTossJson(response);
}

async function reconcileTossOrder(order: OrderRow, paymentKey: string, config: ActivePaymentConfig) {
  const response = await tossFetch(`/v1/payments/orders/${encodeURIComponent(order.id)}`, { method: 'GET' }, config);
  if (!response.ok) return null;
  const payment = await parseTossJson(response);
  try {
    verifyTossPayment(payment, order, paymentKey);
    return payment;
  } catch {
    return null;
  }
}

async function fetchTossPaymentByKey(paymentKey: string, config: ActivePaymentConfig) {
  const response = await tossFetch(`/v1/payments/${encodeURIComponent(paymentKey)}`, { method: 'GET' }, config);
  if (!response.ok) throw httpError(502, '토스 결제 상태를 확인하지 못했습니다.');
  return parseTossJson(response);
}

async function fetchTossPaymentByOrderId(orderId: string, config: ActivePaymentConfig) {
  const response = await tossFetch(`/v1/payments/orders/${encodeURIComponent(orderId)}`, { method: 'GET' }, config);
  if (!response.ok) throw httpError(502, '토스 결제 상태를 확인하지 못했습니다.');
  return parseTossJson(response);
}

async function tossFetch(path: string, init: RequestInit, config: ActivePaymentConfig) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(`${TOSS_API_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${btoa(`${config.secretKey}:`)}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw httpError(504, '토스 결제 승인 응답 시간이 초과되었습니다.');
    throw httpError(502, '토스 결제 서버에 연결하지 못했습니다.');
  } finally {
    clearTimeout(timeout);
  }
}

function parseOrderInput(payload: Record<string, unknown>) {
  const plan = typeof payload.plan === 'string' ? payload.plan : '';
  const interval = typeof payload.interval === 'string' ? payload.interval : '';
  if (!isPlan(plan)) throw httpError(400, '결제할 플랜이 올바르지 않습니다.');
  if (!isInterval(interval)) throw httpError(400, '결제 주기가 올바르지 않습니다.');
  return { plan, interval };
}

function parseConfirmInput(payload: Record<string, unknown>) {
  const orderId = typeof payload.orderId === 'string' ? payload.orderId.trim() : '';
  const paymentKey = typeof payload.paymentKey === 'string' ? payload.paymentKey.trim() : '';
  const amount = payload.amount;
  if (!isOrderId(orderId)) throw httpError(400, '주문 번호가 올바르지 않습니다.');
  if (paymentKey.length < 10 || paymentKey.length > 300) throw httpError(400, '결제 키가 올바르지 않습니다.');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) throw httpError(400, '결제 금액이 올바르지 않습니다.');
  return { orderId, paymentKey, amount };
}

function parseWebhookInput(payload: Record<string, unknown>) {
  const source = payload.data && typeof payload.data === 'object' && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const orderId = typeof source.orderId === 'string' ? source.orderId.trim() : '';
  const paymentKey = typeof source.paymentKey === 'string' ? source.paymentKey.trim() : '';
  if (!isOrderId(orderId)) throw httpError(400, '주문 번호가 올바르지 않습니다.');
  if (paymentKey && (paymentKey.length < 10 || paymentKey.length > 300)) throw httpError(400, '결제 키가 올바르지 않습니다.');
  return { orderId, paymentKey };
}

async function getOwnedOrder(userId: string, orderId: string) {
  if (!isOrderId(orderId)) throw httpError(404, '주문을 찾을 수 없습니다.');
  const { data, error } = await admin().from('payment_orders').select('*').eq('id', orderId).eq('user_id', userId).single();
  if (error || !data) throw httpError(404, '주문을 찾을 수 없습니다.');
  return data as OrderRow;
}

async function listOwnedOrders(userId: string, config: PaymentConfig) {
  const { data, error } = await admin().from('payment_orders')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw httpError(500, '결제 내역을 확인하지 못했습니다.');
  return await Promise.all(((data ?? []) as OrderRow[]).map(order => syncOrderFromProvider(order, config)));
}

async function syncActiveMembership(userId: string, config: PaymentConfig) {
  if (!config.valid || config.mode !== 'live') return;
  const { data, error } = await admin().from('payment_orders')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'PAID')
    .eq('mode', 'live')
    .gt('period_end', new Date().toISOString())
    .order('period_end', { ascending: false })
    .limit(5);
  if (error) throw httpError(500, '멤버십 정보를 확인하지 못했습니다.');
  for (const order of (data ?? []) as OrderRow[]) await syncOrderFromProvider(order, config);
}

async function syncOrderFromProvider(order: OrderRow, config: PaymentConfig) {
  if (!config.valid || !shouldSyncProviderStatus(order, config)) return order;
  const payment = await fetchTossPaymentByKey(order.toss_payment_key!, config);
  if (!matchesStoredPayment(payment, order, order.toss_payment_key!)) throw httpError(502, '토스 결제 상태가 저장된 주문과 일치하지 않습니다.');
  if (!isRevokedPaymentStatus(payment.status)) return order;
  return await persistRevokedOrder(order, payment);
}

async function reconcileWebhookPayment(input: { orderId: string; paymentKey: string }, config: ActivePaymentConfig) {
  const payment = input.paymentKey
    ? await fetchTossPaymentByKey(input.paymentKey, config)
    : await fetchTossPaymentByOrderId(input.orderId, config);
  const { data } = await admin().from('payment_orders').select('*').eq('id', payment.orderId).maybeSingle();
  const order = data as OrderRow | null;
  if (!order || !matchesStoredPayment(payment, order, input.paymentKey || payment.paymentKey)) return;
  if (isRevokedPaymentStatus(payment.status)) await persistRevokedOrder(order, payment);
}

async function persistRevokedOrder(order: OrderRow, payment: TossPayment) {
  if (order.status === 'CANCELED') return order;
  const { data, error } = await admin().from('payment_orders')
    .update({ status: 'CANCELED', toss_status: payment.status, updated_at: new Date().toISOString() })
    .eq('id', order.id)
    .in('status', ['PAID', 'PENDING'])
    .select('*')
    .single();
  if (error) throw httpError(500, '결제 취소 상태를 저장하지 못했습니다.');
  return data as OrderRow;
}

function shouldSyncProviderStatus(order: OrderRow, config: ActivePaymentConfig) {
  return order.mode === config.mode && order.status === 'PAID' && !!order.toss_payment_key;
}

function verifyTossPayment(payment: TossPayment, order: OrderRow, paymentKey: string) {
  if (!payment || typeof payment !== 'object') throw httpError(502, '토스 결제 응답이 올바르지 않습니다.');
  if (payment.status !== 'DONE') throw httpError(502, '토스 결제가 완료 상태가 아닙니다.');
  if (!matchesStoredPayment(payment, order, paymentKey)) throw httpError(502, '토스 결제 정보가 주문과 일치하지 않습니다.');
}

function matchesStoredPayment(payment: TossPayment, order: OrderRow, paymentKey: string) {
  if (!payment || typeof payment !== 'object') return false;
  if (payment.currency !== KRW) throw httpError(502, '토스 결제 통화가 올바르지 않습니다.');
  return payment.orderId === order.id &&
    payment.paymentKey === paymentKey &&
    Number(payment.totalAmount) === Number(order.amount);
}

function isRevokedPaymentStatus(status: string) {
  return status === 'CANCELED' || status === 'PARTIAL_CANCELED';
}

async function parseTossJson(response: Response): Promise<TossPayment> {
  try {
    return await response.json();
  } catch {
    throw httpError(502, '토스 결제 응답을 처리하지 못했습니다.');
  }
}

function presentOrderForCheckout(order: OrderRow, config: ActivePaymentConfig) {
  return {
    ...presentOrder(order),
    clientKey: config.clientKey,
    customerKey: `moa_${order.user_id}`,
    successUrl: `${config.publicAppUrl}/?payment=success`,
    failUrl: `${config.publicAppUrl}/?payment=fail`,
  };
}

function presentOrder(order: OrderRow) {
  const payload: Record<string, unknown> = {
    orderId: order.id,
    orderName: order.order_name,
    amount: order.amount,
    status: order.status,
    mode: order.mode,
    plan: order.plan,
    interval: order.interval,
    createdAt: order.created_at ? new Date(order.created_at).toISOString() : undefined,
  };
  if (order.status === 'PAID') {
    payload.receiptUrl = order.receipt_url ?? undefined;
    payload.periodEnd = order.period_end ? new Date(order.period_end).toISOString() : undefined;
    payload.paidAt = order.paid_at ? new Date(order.paid_at).toISOString() : undefined;
  }
  if (order.toss_status) payload.providerStatus = order.toss_status;
  return payload;
}

function publicConfig(config: PaymentConfig) {
  if (!config.valid) return { configured: false, mode: 'disabled', message: config.message };
  return { configured: true, mode: config.mode, clientKey: config.clientKey };
}

function readConfig(): PaymentConfig {
  const clientKey = normalizeKey(Deno.env.get('TOSS_CLIENT_KEY'));
  const secretKey = normalizeKey(Deno.env.get('TOSS_SECRET_KEY'));
  const publicAppUrl = normalizeUrl(Deno.env.get('PUBLIC_APP_URL'));
  if (!publicAppUrl) return disabled('결제 운영 주소가 아직 연결되지 않았습니다.');
  const liveEnabled = Deno.env.get('TOSS_LIVE_ENABLED') === '1';
  const paidFeaturesReady = Deno.env.get('PAID_FEATURES_READY') === '1';
  const aiReady = Deno.env.get('MOA_AI_READY') === '1';
  if (!clientKey || !secretKey) return disabled('토스페이먼츠 결제 설정이 아직 연결되지 않았습니다.');
  if (isWidgetKey(clientKey) || isWidgetKey(secretKey)) return disabled('결제위젯 키가 감지되었습니다. 표준 결제창용 client/secret 키를 같은 세트로 설정해 주세요.');
  if (!isClientKey(clientKey) || !isSecretKey(secretKey)) return disabled('Toss Payments 키 형식이 올바르지 않습니다.');
  const clientMode = keyMode(clientKey);
  const secretMode = keyMode(secretKey);
  if (clientMode === 'disabled' || secretMode === 'disabled') return disabled('Toss Payments 키 형식이 올바르지 않습니다.');
  if (clientMode !== secretMode) return disabled('테스트 키와 라이브 키가 섞여 있습니다. 같은 모드의 키 세트를 사용해 주세요.');
  if (clientMode === 'live' && !liveEnabled) return disabled('실결제 전환 확인이 아직 완료되지 않았습니다.');
  if (clientMode === 'live' && !paidFeaturesReady) return disabled('유료 기능 제공 준비가 아직 완료되지 않았습니다.');
  if (clientMode === 'live' && !aiReady) return disabled('유료 AI 기능 제공 준비가 아직 확인되지 않았습니다.');
  if (clientMode === 'live' && !publicAppUrl.startsWith('https://')) return disabled('실결제는 HTTPS 운영 주소 연결 후 사용할 수 있습니다.');
  return { valid: true, mode: clientMode, clientKey, secretKey, publicAppUrl: publicAppUrl.replace(/\/+$/, '') };
}

function disabled(message: string): PaymentConfig {
  return { valid: false, mode: 'disabled', message };
}

function assertPaymentAvailable(config: PaymentConfig): asserts config is ActivePaymentConfig {
  if (!config.valid) throw httpError(503, config.message);
}

function assertOrigin(request: Request, config: ActivePaymentConfig) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const allowed = new Set([new URL(config.publicAppUrl).origin]);
  if (config.mode === 'test') for (const value of LOCAL_ORIGINS) allowed.add(value);
  if (!allowed.has(origin)) throw httpError(403, '허용되지 않은 요청 출처입니다.');
}

async function readJsonBody(request: Request) {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().startsWith('application/json')) throw httpError(415, 'Content-Type은 application/json이어야 합니다.');
  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) throw httpError(413, '결제 요청 본문은 32KB 이하여야 합니다.');
  try {
    const payload = JSON.parse(body || '{}');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid');
    return payload as Record<string, unknown>;
  } catch {
    throw httpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
}

function normalizePath(pathname: string) {
  const marker = '/moa-payments';
  const index = pathname.indexOf(marker);
  const path = index >= 0 ? pathname.slice(index + marker.length) : pathname;
  return path || '/';
}

function admin() {
  return createClient(requiredEnv('SUPABASE_URL'), secretKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function userClient(authorization: string) {
  return createClient(requiredEnv('SUPABASE_URL'), publishableKey(), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function publishableKey() {
  const modern = readJsonKey('SUPABASE_PUBLISHABLE_KEYS');
  return modern || requiredEnv('SUPABASE_ANON_KEY');
}

function secretKey() {
  const modern = readJsonKey('SUPABASE_SECRET_KEYS');
  return modern || requiredEnv('SUPABASE_SERVICE_ROLE_KEY');
}

function readJsonKey(name: string) {
  const value = Deno.env.get(name);
  if (!value) return '';
  try {
    const parsed = JSON.parse(value) as Record<string, string>;
    return parsed.default ?? Object.values(parsed)[0] ?? '';
  } catch {
    return '';
  }
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw httpError(500, `${name} 환경변수가 필요합니다.`);
  return value;
}

function corsHeaders(request: Request) {
  const origin = request.headers.get('Origin') ?? '*';
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  };
  if (origin === '*') {
    headers['Access-Control-Allow-Origin'] = '*';
  } else if (allowedCorsOrigins().has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

function allowedCorsOrigins() {
  const origins = new Set<string>();
  const appOrigin = publicAppOrigin();
  if (appOrigin) origins.add(appOrigin);
  if (Deno.env.get('TOSS_LIVE_ENABLED') !== '1') {
    for (const origin of LOCAL_ORIGINS) origins.add(origin);
  }
  return origins;
}

function json(request: Request, status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders(request), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function normalizeKey(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function keyMode(key: string): 'test' | 'live' | 'disabled' {
  if (key.startsWith('test_')) return 'test';
  if (key.startsWith('live_')) return 'live';
  return 'disabled';
}

function isPlan(value: string): value is PaymentPlan {
  return Object.hasOwn(PLANS, value);
}

function isInterval(value: string): value is PaymentInterval {
  return value === 'month' || value === 'year';
}

function isClientKey(key: string) {
  return /^(test|live)_ck_/.test(key);
}

function isSecretKey(key: string) {
  return /^(test|live)_sk_/.test(key);
}

function isWidgetKey(key: string) {
  return /_(gck|gsk)_/.test(key);
}

function isOrderId(value: string) {
  return /^moa_[0-9a-f]{32}$/i.test(value);
}

function normalizeUrl(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publicAppOrigin() {
  return normalizeUrl(Deno.env.get('PUBLIC_APP_URL'));
}

function safeReceiptUrl(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'tosspayments.com' || host.endsWith('.tosspayments.com')) ? url.toString() : null;
  } catch {
    return null;
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function httpError(status: number, message: string) {
  return new HttpError(status, message);
}

type TossPayment = {
  paymentKey: string;
  orderId: string;
  status: string;
  currency: string;
  totalAmount: number;
  receipt?: { url?: string };
};
