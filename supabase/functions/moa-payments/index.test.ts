// HTTP-handler tests with mocked Auth/PostgREST/Toss. No network or real payment.
import { strictEqual as assertEquals } from 'node:assert';
let handle: (request: Request) => Promise<Response>;
const serve = Deno.serve;
Deno.serve = ((handler: typeof handle) => { handle = handler; return {}; }) as typeof Deno.serve;
await import('./index.ts');
Deno.serve = serve;

const EXPECTED_PRICES = {
  light: { month: 3900, year: 42000 },
  studio: { month: 7900, year: 85000 },
  plus: { month: 12900, year: 139000 },
};

Deno.test('cloud payment handler validates identity, prices, ownership and provider result', async () => {
  const owner = '7d8e8e69-d6b8-4dde-9bae-163ef7501529';
  const originalFetch = globalThis.fetch;
  const environment = {
    SUPABASE_URL: 'https://moa-test.supabase.co',
    SUPABASE_ANON_KEY: 'fake-anon-key-for-offline-test',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key-for-offline-test',
    PUBLIC_APP_URL: 'https://moa.example.com',
    TOSS_CLIENT_KEY: 'test_ck_mock',
    TOSS_SECRET_KEY: 'test_sk_mock',
    TOSS_LIVE_ENABLED: '0',
  };
  const originalEnv = new Map(Object.keys(environment).map(key => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);
  let order: Record<string, unknown> | undefined;
  let providerAmount = 7900;
  let tossCalls = 0;
  let finalizeCalls = 0;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'moa-test.supabase.co') {
      if (url.pathname === '/auth/v1/user') return Promise.resolve(reply({ id: owner, aud: 'authenticated', email: 'qa@example.invalid' }));
      if (url.pathname === '/rest/v1/payment_orders' && init?.method === 'POST') {
        order = { ...JSON.parse(String(init.body)), toss_payment_key: null, receipt_url: null, period_end: null };
        return Promise.resolve(reply(order, 201));
      }
      if (url.pathname === '/rest/v1/payment_orders') {
        const matched = order && url.searchParams.get('id') === `eq.${order.id}` && url.searchParams.get('user_id') === `eq.${order.user_id}`;
        return Promise.resolve(matched ? reply(order) : reply({ message: 'not found', code: 'PGRST116' }, 406));
      }
      if (url.pathname === '/rest/v1/rpc/finalize_payment_order') {
        finalizeCalls++;
        const body = JSON.parse(String(init?.body));
        order = { ...order, status: 'PAID', toss_payment_key: body.p_payment_key, period_end: '2027-02-28T00:00:00Z' };
        return Promise.resolve(reply(order));
      }
    }
    if (url.hostname === 'api.tosspayments.com' && url.pathname === '/v1/payments/confirm') {
      tossCalls++;
      return Promise.resolve(reply({ status: 'DONE', currency: 'KRW', orderId: order?.id, paymentKey: 'test-payment-key', totalAmount: providerAmount }));
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  }) as typeof fetch;
  async function call(path: string, method = 'GET', body?: unknown, login = true, origin = 'https://moa.example.com') {
    return await handle(new Request(`https://moa-test.supabase.co/functions/v1/moa-payments${path}`, {
      method,
      headers: { Origin: origin, ...(login ? { Authorization: 'Bearer mocked-user-token' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }));
  }
  try {
    assertEquals((await call('/membership', 'GET', undefined, false)).status, 401);
    assertEquals((await call('/config', 'OPTIONS', undefined, false, 'https://evil.example')).headers.get('Access-Control-Allow-Origin'), null);
    assertEquals((await call('/orders', 'POST', { plan: '__proto__', interval: 'month' })).status, 400);
    assertEquals((await call('/orders', 'POST', { plan: 'studio', interval: 'month' }, true, 'https://evil.example')).status, 403);
    const orders: Record<string, Record<string, unknown>> = {};
    for (const [plan, prices] of Object.entries(EXPECTED_PRICES)) {
      for (const interval of Object.keys(prices)) {
        const response = await call('/orders', 'POST', { plan, interval, amount: 1 });
        assertEquals(response.status, 201);
        orders[`${plan}:${interval}`] = await response.json();
      }
    }
    assertEquals(orders['light:month'].amount, 3900);
    assertEquals(orders['light:year'].amount, 42000);
    assertEquals(orders['studio:month'].amount, 7900);
    assertEquals(orders['studio:year'].amount, 85000);
    assertEquals(orders['plus:month'].amount, 12900);
    assertEquals(orders['plus:year'].amount, 139000);
    const response = await call('/orders', 'POST', { plan: 'studio', interval: 'month', amount: 1 });
    assertEquals(response.status, 201);
    const created = await response.json();
    assertEquals(created.amount, 7900);
    assertEquals(created.orderName, '모아 스튜디오 Standard 월간 플랜');
    assertEquals(created.successUrl, 'https://moa.example.com/?payment=success');
    const confirm = { orderId: created.orderId, paymentKey: 'test-payment-key', amount: 7900 };
    assertEquals((await call('/confirm', 'POST', { ...confirm, amount: 1 })).status, 400);
    assertEquals(tossCalls, 0);
    order!.user_id = 'fe72c43e-970f-4d22-aa62-310139c088bd';
    assertEquals((await call(`/orders/${created.orderId}`)).status, 404);
    order!.user_id = owner;
    providerAmount = 100;
    assertEquals((await call('/confirm', 'POST', confirm)).status, 502);
    assertEquals(finalizeCalls, 0);
    providerAmount = 7900;
    assertEquals((await call('/confirm', 'POST', confirm)).status, 200);
    assertEquals(finalizeCalls, 1);
    assertEquals((await call('/confirm', 'POST', confirm)).status, 200);
    assertEquals(finalizeCalls, 1);
    assertEquals((await call('/confirm', 'POST', { ...confirm, paymentKey: 'different-payment-key' })).status, 409);
    Deno.env.set('TOSS_CLIENT_KEY', 'live_ck_mock');
    Deno.env.set('TOSS_SECRET_KEY', 'live_sk_mock');
    assertEquals((await (await call('/config')).json()).configured, false);
    Deno.env.set('TOSS_LIVE_ENABLED', '1');
    Deno.env.set('PAID_FEATURES_READY', '1');
    Deno.env.set('PUBLIC_APP_URL', 'http://moa.example.com');
    assertEquals((await (await call('/config')).json()).configured, false);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
});

Deno.test('cloud live gate requires paid feature readiness and syncs provider cancellations', async () => {
  const owner = '7d8e8e69-d6b8-4dde-9bae-163ef7501530';
  const originalFetch = globalThis.fetch;
  const environment = {
    SUPABASE_URL: 'https://moa-live-test.supabase.co',
    SUPABASE_ANON_KEY: 'fake-anon-key-for-offline-test',
    SUPABASE_SERVICE_ROLE_KEY: 'fake-service-key-for-offline-test',
    PUBLIC_APP_URL: 'https://moa.example.com',
    TOSS_CLIENT_KEY: 'live_ck_mock',
    TOSS_SECRET_KEY: 'live_sk_mock',
    TOSS_LIVE_ENABLED: '1',
    PAID_FEATURES_READY: '1',
    MOA_AI_READY: '1',
  };
  const originalEnv = new Map(Object.keys(environment).map(key => [key, Deno.env.get(key)]));
  for (const [key, value] of Object.entries(environment)) Deno.env.set(key, value);

  let order: Record<string, unknown> | undefined;
  let providerStatus = 'DONE';
  let finalizeCalls = 0;
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'moa-live-test.supabase.co') {
      if (url.pathname === '/auth/v1/user') return Promise.resolve(reply({ id: owner, aud: 'authenticated', email: 'qa@example.invalid' }));
      if (url.pathname === '/rest/v1/payment_orders' && init?.method === 'POST') {
        order = { ...JSON.parse(String(init.body)), toss_payment_key: null, receipt_url: null, toss_status: null, paid_at: null, period_end: null };
        return Promise.resolve(reply(order, 201));
      }
      if (url.pathname === '/rest/v1/payment_orders' && init?.method === 'PATCH') {
        order = { ...order, ...JSON.parse(String(init.body)) };
        return Promise.resolve(reply(order));
      }
      if (url.pathname === '/rest/v1/payment_orders') {
        const select = url.searchParams.get('select') ?? '';
        const byId = order && url.searchParams.get('id') === `eq.${order.id}`;
        const byOwner = order && url.searchParams.get('user_id') === `eq.${order.user_id}`;
        if (byId && (!url.searchParams.has('user_id') || byOwner)) return Promise.resolve(reply(order));
        if (select === '*') return Promise.resolve(reply(order && byOwner && order.status === 'PAID' ? [order] : []));
        if (select.includes('plan') && order?.status === 'PAID') return Promise.resolve(reply({
          plan: order.plan,
          interval: order.interval,
          mode: order.mode,
          period_end: order.period_end,
        }));
        if (select.includes('plan')) return Promise.resolve(reply(null));
        return Promise.resolve(reply({ message: 'not found', code: 'PGRST116' }, 406));
      }
      if (url.pathname === '/rest/v1/rpc/finalize_payment_order') {
        finalizeCalls++;
        const body = JSON.parse(String(init?.body));
        order = {
          ...order,
          status: 'PAID',
          toss_payment_key: body.p_payment_key,
          toss_status: body.p_toss_status,
          paid_at: body.p_paid_at,
          period_end: '2027-02-28T00:00:00Z',
        };
        return Promise.resolve(reply(order));
      }
    }
    if (url.hostname === 'api.tosspayments.com') {
      if (url.pathname === '/v1/payments/confirm') {
        const body = JSON.parse(String(init?.body));
        return Promise.resolve(reply({ status: 'DONE', currency: 'KRW', orderId: body.orderId, paymentKey: body.paymentKey, totalAmount: body.amount }));
      }
      if (url.pathname.startsWith('/v1/payments/')) {
        const paymentKey = decodeURIComponent(url.pathname.split('/').at(-1) ?? '');
        return Promise.resolve(reply({ status: providerStatus, currency: 'KRW', orderId: order?.id, paymentKey, totalAmount: order?.amount }));
      }
    }
    throw new Error(`Unexpected network request: ${url.origin}${url.pathname}`);
  }) as typeof fetch;

  async function call(path: string, method = 'GET', body?: unknown, login = true) {
    return await handle(new Request(`https://moa-live-test.supabase.co/functions/v1/moa-payments${path}`, {
      method,
      headers: { Origin: 'https://moa.example.com', ...(login ? { Authorization: 'Bearer mocked-user-token' } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    }));
  }

  try {
    Deno.env.delete('PAID_FEATURES_READY');
    assertEquals((await (await call('/config')).json()).configured, false);
    Deno.env.set('PAID_FEATURES_READY', '1');
    Deno.env.delete('MOA_AI_READY');
    assertEquals((await (await call('/config')).json()).configured, false);
    Deno.env.set('MOA_AI_READY', '1');
    assertEquals((await (await call('/config')).json()).configured, true);

    let response = await call('/orders', 'POST', { plan: 'plus', interval: 'month' });
    const created = await response.json();
    response = await call('/confirm', 'POST', { orderId: created.orderId, paymentKey: 'pay_live_cancel_key', amount: created.amount });
    assertEquals(response.status, 200);
    assertEquals(finalizeCalls, 1);
    providerStatus = 'PARTIAL_CANCELED';
    assertEquals((await (await call('/membership')).json()).membership, null);
    const canceled = await (await call(`/orders/${created.orderId}`)).json();
    assertEquals(canceled.status, 'CANCELED');
    assertEquals(canceled.providerStatus, 'PARTIAL_CANCELED');

    response = await call('/orders', 'POST', { plan: 'studio', interval: 'month' });
    const pending = await response.json();
    providerStatus = 'DONE';
    assertEquals((await call('/webhook', 'POST', { data: { orderId: pending.orderId, paymentKey: 'pay_webhook_fake_key' } }, false)).status, 204);
    const stillPending = await (await call(`/orders/${pending.orderId}`)).json();
    assertEquals(stillPending.status, 'PENDING');
    assertEquals(finalizeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originalEnv) value === undefined ? Deno.env.delete(key) : Deno.env.set(key, value);
  }
});
