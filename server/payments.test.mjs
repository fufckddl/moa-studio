import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuthService } from './auth.mjs';
import { createPaymentService } from './payments.mjs';

const ORIGIN = 'http://127.0.0.1:5173';
const APP_URL = 'http://127.0.0.1:5173';
const TEST_SCRYPT = { N: 1024, r: 8, p: 1, maxmem: 4 * 1024 * 1024 };
const TEST_CONFIG = {
  clientKey: 'test_ck_moa_standard',
  secretKey: 'test_sk_moa_standard',
  publicAppUrl: APP_URL,
};
const LIVE_CONFIG = {
  clientKey: 'live_ck_moa_standard',
  secretKey: 'live_sk_moa_standard',
  publicAppUrl: 'https://moa.example.test',
  liveEnabled: true,
  paidFeaturesReady: true,
  aiReady: true,
};
const EXPECTED_PRICES = {
  light: { month: 3900, year: 42000 },
  studio: { month: 7900, year: 85000 },
  plus: { month: 12900, year: 139000 },
};

test('config stays disabled without usable Toss keys', async () => {
  const app = createApp({ config: { clientKey: '', secretKey: '' } });
  const result = await app.payment.handle(request('/api/payments/config', { method: 'GET' }));
  app.close();
  assert.equal(result.status, 200);
  assert.equal(result.payload.configured, false);
  assert.equal(result.payload.mode, 'disabled');
  assert.doesNotMatch(result.payload.message, /TOSS_|OPENAI_|API/);
});

test('config rejects mixed, widget, and non-opted-in live keys', async () => {
  for (const config of [
    { clientKey: 'test_ck_moa_standard', secretKey: 'live_sk_moa_standard' },
    { clientKey: 'test_gck_moa_widget', secretKey: 'test_sk_moa_standard' },
    { clientKey: 'live_ck_moa_standard', secretKey: 'live_sk_moa_standard', liveEnabled: false, publicAppUrl: 'https://example.test' },
    { clientKey: 'live_ck_moa_standard', secretKey: 'live_sk_moa_standard', liveEnabled: true, paidFeaturesReady: false, aiReady: true, publicAppUrl: 'https://example.test' },
    { clientKey: 'live_ck_moa_standard', secretKey: 'live_sk_moa_standard', liveEnabled: true, paidFeaturesReady: true, aiReady: false, publicAppUrl: 'https://example.test' },
    { clientKey: 'live_ck_moa_standard', secretKey: 'live_sk_moa_standard', liveEnabled: true, publicAppUrl: 'http://example.test' },
  ]) {
    const app = createApp({ config });
    const result = await app.payment.handle(request('/api/payments/config', { method: 'GET' }));
    app.close();
    assert.equal(result.status, 200);
    assert.equal(result.payload.configured, false);
    assert.equal(result.payload.mode, 'disabled');
  }
});

test('creating an order requires login and uses server-owned pricing', async () => {
  const app = createApp();
  const unauthenticated = await expectHttpError(() =>
    app.payment.handle(request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } })),
  );
  assert.equal(unauthenticated.statusCode, 401);

  const client = await signedInClient(app, 'owner@example.test');
  const orders = {};
  for (const [plan, prices] of Object.entries(EXPECTED_PRICES)) {
    for (const interval of Object.keys(prices)) {
      const order = await app.payment.handle(
        client.request('/api/payments/orders', { method: 'POST', body: { plan, interval, amount: 1 } }),
      );
      orders[`${plan}:${interval}`] = order;
    }
  }

  app.close();
  assert.equal(orders['light:month'].status, 201);
  assert.equal(orders['light:month'].payload.amount, 3900);
  assert.equal(orders['light:year'].payload.amount, 42000);
  assert.equal(orders['studio:month'].payload.amount, 7900);
  assert.equal(orders['studio:year'].payload.amount, 85000);
  assert.equal(orders['plus:month'].payload.amount, 12900);
  assert.equal(orders['plus:year'].payload.amount, 139000);
  assert.equal(orders['plus:year'].payload.orderName, '모아 스튜디오 Pro 연간 플랜');
  assert.equal(orders['plus:year'].payload.clientKey, TEST_CONFIG.clientKey);
  assert.match(orders['plus:year'].payload.customerKey, /^moa_usr_/);
  assert.equal(orders['plus:year'].payload.successUrl, `${APP_URL}/?payment=success`);
  assert.equal(orders['plus:year'].payload.failUrl, `${APP_URL}/?payment=fail`);
  assert.equal(orders['plus:year'].payload.mode, 'test');
  assert.equal(orders['light:month'].payload.orderName, '모아 스튜디오 Light 월간 플랜');
  assert.equal(orders['studio:month'].payload.orderName, '모아 스튜디오 Standard 월간 플랜');
});

test('new local payment order tables constrain plan ids to known paid plans', () => {
  const app = createApp();
  const schema = app.auth.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'payment_orders'").get().sql;
  app.close();

  assert.match(schema, /plan TEXT NOT NULL CHECK \(plan IN \('light', 'studio', 'plus'\)\)/);
});

test('payment requests enforce JSON, same-origin, known plan, and body limits', async () => {
  const app = createApp();
  const client = await signedInClient(app, 'shapes@example.test');

  const wrongOrigin = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/orders', { method: 'POST', origin: 'http://evil.test', body: { plan: 'studio', interval: 'month' } })),
  );
  assert.equal(wrongOrigin.statusCode, 403);

  const wrongType = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/orders', { method: 'POST', contentType: 'text/plain', rawBody: '{}' })),
  );
  assert.equal(wrongType.statusCode, 415);

  const badPlan = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'free', interval: 'month' } })),
  );
  assert.equal(badPlan.statusCode, 400);

  const tooLarge = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/orders', { method: 'POST', rawBody: JSON.stringify({ plan: 'studio', interval: 'month', note: 'x'.repeat(33 * 1024) }) })),
  );
  app.close();
  assert.equal(tooLarge.statusCode, 413);
});

test('orders are scoped to their owner', async () => {
  const app = createApp();
  const first = await signedInClient(app, 'first@example.test');
  const second = await signedInClient(app, 'second@example.test');
  const order = await app.payment.handle(first.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));

  const stolenRead = await expectHttpError(() => app.payment.handle(second.request(`/api/payments/orders/${order.payload.orderId}`, { method: 'GET' })));
  app.close();
  assert.equal(stolenRead.statusCode, 404);
});

test('confirm rejects tampered amounts before calling Toss', async () => {
  let fetchCalls = 0;
  const app = createApp({ fetchImpl: async () => { fetchCalls += 1; } });
  const client = await signedInClient(app, 'tamper@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));

  const tampered = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { orderId: order.payload.orderId, paymentKey: 'pay_valid_key', amount: 1 } })),
  );
  app.close();
  assert.equal(tampered.statusCode, 400);
  assert.equal(fetchCalls, 0);
});

test('confirm verifies Toss DONE/KRW/order/amount/paymentKey and grants a dated membership once', async () => {
  const fetchCalls = [];
  const app = createApp({
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url, init, body: JSON.parse(init.body) });
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from(`${TEST_CONFIG.secretKey}:`).toString('base64')}`);
      assert.match(init.headers['Idempotency-Key'], /^confirm:moa_/);
      return tossResponse({
        paymentKey: fetchCalls[0].body.paymentKey,
        orderId: fetchCalls[0].body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: fetchCalls[0].body.amount,
        receipt: { url: 'https://dashboard.tosspayments.com/receipt/test' },
      });
    },
  });
  const client = await signedInClient(app, 'paid@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'year' } }));
  const paid = await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_valid_key', amount: order.payload.amount },
    }),
  );
  const repeat = await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_valid_key', amount: order.payload.amount },
    }),
  );
  const membership = await app.payment.handle(client.request('/api/payments/membership'));
  app.close();

  assert.equal(fetchCalls.length, 1);
  assert.equal(paid.payload.status, 'PAID');
  assert.equal(paid.payload.amount, 85000);
  assert.equal(paid.payload.receiptUrl, 'https://dashboard.tosspayments.com/receipt/test');
  assert.equal(repeat.payload.status, 'PAID');
  assert.equal(membership.payload.membership, null);
});

test('live payments grant membership and clamp calendar billing periods', async () => {
  const jan31 = Date.UTC(2027, 0, 31, 9, 0, 0);
  const app = createApp({
    config: LIVE_CONFIG,
    now: () => jan31,
    fetchImpl: async (_url, init) => {
      if (init.method === 'GET') {
        return tossResponse({
          paymentKey: 'pay_live_month_key',
          orderId: orderIdForLookup,
          status: 'DONE',
          currency: 'KRW',
          totalAmount: 7900,
        });
      }
      const body = JSON.parse(init.body);
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: body.amount,
      });
    },
  });
  const client = await signedInClient(app, 'live-month@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  const orderIdForLookup = order.payload.orderId;
  await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_live_month_key', amount: order.payload.amount },
    }),
  );
  const membership = await app.payment.handle(client.request('/api/payments/membership'));
  app.close();

  assert.equal(membership.payload.membership.mode, 'live');
  assert.equal(membership.payload.membership.periodEnd, '2027-02-28T09:00:00.000Z');
});

test('year billing period clamps leap day to the next valid date', async () => {
  const leapDay = Date.UTC(2028, 1, 29, 9, 0, 0);
  const app = createApp({
    config: LIVE_CONFIG,
    now: () => leapDay,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: body.amount,
      });
    },
  });
  const client = await signedInClient(app, 'live-year@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'plus', interval: 'year' } }));
  const paid = await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_live_year_key', amount: order.payload.amount },
    }),
  );
  app.close();

  assert.equal(paid.payload.periodEnd, '2029-02-28T09:00:00.000Z');
});

test('concurrent duplicate confirms share one Toss confirm call', async () => {
  let fetchCalls = 0;
  let capturedBody;
  const app = createApp({
    fetchImpl: async (_url, init) => {
      fetchCalls += 1;
      capturedBody = JSON.parse(init.body);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return tossResponse({
        paymentKey: capturedBody.paymentKey,
        orderId: capturedBody.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: capturedBody.amount,
      });
    },
  });
  const client = await signedInClient(app, 'concurrent@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'plus', interval: 'month' } }));
  const body = { orderId: order.payload.orderId, paymentKey: 'pay_concurrent_key', amount: order.payload.amount };

  const [first, second, tampered] = await Promise.allSettled([
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body })),
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body })),
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { ...body, amount: 1 } })),
  ]);
  app.close();

  assert.equal(fetchCalls, 1);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'fulfilled');
  assert.equal(first.value.payload.status, 'PAID');
  assert.equal(second.value.payload.status, 'PAID');
  assert.equal(tampered.status, 'rejected');
  assert.equal(tampered.reason.statusCode, 400);
});

test('uncertain confirm failures reconcile by orderId lookup before failing', async () => {
  const calls = [];
  const app = createApp({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') throw new Error('temporary network failure');
      const orderId = decodeURIComponent(url.split('/').at(-1));
      return tossResponse({
        paymentKey: 'pay_reconciled_key',
        orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: 7900,
      });
    },
  });
  const client = await signedInClient(app, 'reconcile@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  const paid = await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_reconciled_key', amount: order.payload.amount },
    }),
  );
  app.close();

  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /\/v1\/payments\/orders\/moa_/);
  assert.equal(paid.payload.status, 'PAID');
});

test('invalid Toss payment responses do not grant membership', async () => {
  const app = createApp({
    fetchImpl: async (_url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'READY',
        currency: 'KRW',
        totalAmount: body.amount,
      });
    },
  });
  const client = await signedInClient(app, 'invalid@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));

  const invalid = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { orderId: order.payload.orderId, paymentKey: 'pay_invalid_key', amount: order.payload.amount } })),
  );
  const membership = await app.payment.handle(client.request('/api/payments/membership'));
  const pending = await app.payment.handle(client.request(`/api/payments/orders/${order.payload.orderId}`, { method: 'GET' }));
  app.close();

  assert.equal(invalid.statusCode, 502);
  assert.equal(membership.payload.membership, null);
  assert.equal(pending.payload.status, 'PENDING');
});

test('paid replay must match stored amount and payment key', async () => {
  const app = createApp({
    config: LIVE_CONFIG,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: body.amount,
      });
    },
  });
  const client = await signedInClient(app, 'replay@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_original_key', amount: order.payload.amount },
    }),
  );

  const wrongAmount = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { orderId: order.payload.orderId, paymentKey: 'pay_original_key', amount: 1 } })),
  );
  const wrongKey = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { orderId: order.payload.orderId, paymentKey: 'pay_different_key', amount: order.payload.amount } })),
  );
  app.close();

  assert.equal(wrongAmount.statusCode, 400);
  assert.equal(wrongKey.statusCode, 409);
});

test('pending orders cannot be approved after the configured payment mode changes', async () => {
  const auth = createAuthService({ dbPath: ':memory:', allowedOrigin: ORIGIN, scryptParams: TEST_SCRYPT });
  const testPayment = createPaymentService({ auth, allowedOrigin: ORIGIN, config: TEST_CONFIG, fetchImpl: async () => tossResponse({}) });
  const livePayment = createPaymentService({ auth, allowedOrigin: ORIGIN, config: LIVE_CONFIG, fetchImpl: async () => tossResponse({}) });
  const app = { auth, close: () => auth.close() };
  const client = await signedInClient(app, 'mode-change@example.test');
  const order = await testPayment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));

  const modeChanged = await expectHttpError(() =>
    livePayment.handle(client.request('/api/payments/confirm', { method: 'POST', body: { orderId: order.payload.orderId, paymentKey: 'pay_mode_change', amount: order.payload.amount } })),
  );
  auth.close();

  assert.equal(modeChanged.statusCode, 409);
});

test('receipt URL only accepts Toss-owned HTTPS hosts', async () => {
  const app = createApp({
    config: LIVE_CONFIG,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: body.amount,
        receipt: { url: 'https://eviltosspayments.com/receipt/phish' },
      });
    },
  });
  const client = await signedInClient(app, 'receipt@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  const paid = await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_receipt_key', amount: order.payload.amount },
    }),
  );
  app.close();

  assert.equal(paid.payload.receiptUrl, undefined);
});

test('live order lookups sync canceled provider status and revoke membership', async () => {
  let paymentKey = '';
  let paidOrderId = '';
  const app = createApp({
    config: LIVE_CONFIG,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        paymentKey = body.paymentKey;
        return tossResponse({
          paymentKey,
          orderId: body.orderId,
          status: 'DONE',
          currency: 'KRW',
          totalAmount: body.amount,
        });
      }
      assert.equal(url, `https://api.tosspayments.com/v1/payments/${paymentKey}`);
      return tossResponse({
        paymentKey,
        orderId: paidOrderId,
        status: 'PARTIAL_CANCELED',
        currency: 'KRW',
        totalAmount: 12900,
      });
    },
  });
  const client = await signedInClient(app, 'canceled-live@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'plus', interval: 'month' } }));
  paidOrderId = order.payload.orderId;
  await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: paidOrderId, paymentKey: 'pay_cancel_sync_key', amount: order.payload.amount },
    }),
  );

  const membership = await app.payment.handle(client.request('/api/payments/membership'));
  const refreshed = await app.payment.handle(client.request(`/api/payments/orders/${paidOrderId}`, { method: 'GET' }));
  const history = await app.payment.handle(client.request('/api/payments/orders', { method: 'GET' }));
  app.close();

  assert.equal(membership.payload.membership, null);
  assert.equal(refreshed.payload.status, 'CANCELED');
  assert.equal(refreshed.payload.providerStatus, 'PARTIAL_CANCELED');
  assert.equal(history.payload.orders[0].status, 'CANCELED');
});

test('test order lookups sync matching-mode provider cancellations without granting membership', async () => {
  let paymentKey = '';
  let paidOrderId = '';
  let providerLookups = 0;
  const app = createApp({
    config: TEST_CONFIG,
    fetchImpl: async (url, init) => {
      if (init.method === 'POST') {
        const body = JSON.parse(init.body);
        paymentKey = body.paymentKey;
        return tossResponse({
          paymentKey,
          orderId: body.orderId,
          status: 'DONE',
          currency: 'KRW',
          totalAmount: body.amount,
        });
      }
      providerLookups += 1;
      assert.equal(url, `https://api.tosspayments.com/v1/payments/${paymentKey}`);
      return tossResponse({
        paymentKey,
        orderId: paidOrderId,
        status: 'PARTIAL_CANCELED',
        currency: 'KRW',
        totalAmount: 7900,
      });
    },
  });
  const client = await signedInClient(app, 'canceled-test@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  paidOrderId = order.payload.orderId;
  await app.payment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: paidOrderId, paymentKey: 'pay_test_cancel_sync_key', amount: order.payload.amount },
    }),
  );

  const refreshed = await app.payment.handle(client.request(`/api/payments/orders/${paidOrderId}`, { method: 'GET' }));
  const history = await app.payment.handle(client.request('/api/payments/orders', { method: 'GET' }));
  const membership = await app.payment.handle(client.request('/api/payments/membership'));
  app.close();

  assert.equal(providerLookups, 1);
  assert.equal(refreshed.payload.status, 'CANCELED');
  assert.equal(refreshed.payload.providerStatus, 'PARTIAL_CANCELED');
  assert.equal(history.payload.orders[0].status, 'CANCELED');
  assert.equal(membership.payload.membership, null);
});

test('order lookups do not sync provider status across payment modes', async () => {
  const auth = createAuthService({ dbPath: ':memory:', allowedOrigin: ORIGIN, scryptParams: TEST_SCRYPT });
  const testPayment = createPaymentService({
    auth,
    allowedOrigin: ORIGIN,
    config: TEST_CONFIG,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      return tossResponse({
        paymentKey: body.paymentKey,
        orderId: body.orderId,
        status: 'DONE',
        currency: 'KRW',
        totalAmount: body.amount,
      });
    },
  });
  const livePayment = createPaymentService({
    auth,
    allowedOrigin: ORIGIN,
    config: LIVE_CONFIG,
    fetchImpl: async () => {
      throw new Error('provider lookup should not run for mismatched order mode');
    },
  });
  const app = { auth, close: () => auth.close() };
  const client = await signedInClient(app, 'cross-mode-sync@example.test');
  const order = await testPayment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  await testPayment.handle(
    client.request('/api/payments/confirm', {
      method: 'POST',
      body: { orderId: order.payload.orderId, paymentKey: 'pay_cross_mode_key', amount: order.payload.amount },
    }),
  );

  const refreshed = await livePayment.handle(client.request(`/api/payments/orders/${order.payload.orderId}`, { method: 'GET' }));
  auth.close();

  assert.equal(refreshed.payload.status, 'PAID');
  assert.equal(refreshed.payload.providerStatus, 'DONE');
});

test('webhook rechecks Toss and never grants pending orders from webhook body', async () => {
  let pendingOrderId = '';
  const app = createApp({
    config: LIVE_CONFIG,
    fetchImpl: async (_url, _init) => tossResponse({
      paymentKey: 'pay_webhook_fake_key',
      orderId: pendingOrderId,
      status: 'DONE',
      currency: 'KRW',
      totalAmount: 7900,
    }),
  });
  const client = await signedInClient(app, 'webhook@example.test');
  const order = await app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'studio', interval: 'month' } }));
  pendingOrderId = order.payload.orderId;

  const webhook = await app.payment.handle(request('/api/payments/webhook', {
    method: 'POST',
    body: { eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: pendingOrderId, paymentKey: 'pay_webhook_fake_key' } },
  }));
  const refreshed = await app.payment.handle(client.request(`/api/payments/orders/${pendingOrderId}`, { method: 'GET' }));
  app.close();

  assert.equal(webhook.status, 204);
  assert.equal(refreshed.payload.status, 'PENDING');
});

test('order input rejects inherited-looking plan keys', async () => {
  const app = createApp();
  const client = await signedInClient(app, 'prototype@example.test');
  const badConstructor = await expectHttpError(() =>
    app.payment.handle(client.request('/api/payments/orders', { method: 'POST', body: { plan: 'constructor', interval: 'month' } })),
  );
  app.close();

  assert.equal(badConstructor.statusCode, 400);
});

function createApp(options = {}) {
  const auth = createAuthService({ dbPath: ':memory:', allowedOrigin: ORIGIN, scryptParams: TEST_SCRYPT });
  const payment = createPaymentService({
    auth,
    allowedOrigin: ORIGIN,
    config: options.config ?? TEST_CONFIG,
    fetchImpl: options.fetchImpl ?? (async () => tossResponse({})),
    now: options.now,
  });
  return {
    auth,
    payment,
    close() {
      auth.close();
    },
  };
}

async function signedInClient(app, email) {
  const client = new Client();
  const rawBody = JSON.stringify({ name: '모아 운영자', email, password: 'strong-password' });
  const response = {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
  const signup = await app.auth.handle(request('/api/auth/signup', { method: 'POST', rawBody }), rawBody, response);
  assert.equal(signup.status, 201);
  client.cookie = response.headers['set-cookie'].split(';')[0];
  return client;
}

class Client {
  constructor() {
    this.cookie = '';
  }

  request(path, options = {}) {
    return request(path, { ...options, cookie: this.cookie });
  }
}

function request(path, options = {}) {
  const rawBody = options.rawBody ?? (options.body === undefined ? '' : JSON.stringify(options.body));
  const headers = {
    origin: options.origin ?? ORIGIN,
    host: '127.0.0.1:8791',
    ...(rawBody ? { 'content-type': options.contentType ?? 'application/json' } : {}),
    ...(options.cookie ? { cookie: options.cookie } : {}),
  };
  return {
    method: options.method ?? 'GET',
    url: path,
    rawBody,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
  };
}

async function expectHttpError(action) {
  try {
    await action();
  } catch (error) {
    return error;
  }
  throw new assert.AssertionError({ message: 'Expected an HTTP error' });
}

function tossResponse(payload, init = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    async json() {
      return payload;
    },
  };
}
