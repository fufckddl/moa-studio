import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('Toss authentication simulation is restricted to test orders and test keys', async t => {
  const requests = [];
  globalThis.window = {
    TossPayments: () => ({ payment: () => ({ requestPayment: async value => requests.push(value) }) }),
  };
  t.after(() => { delete globalThis.window; });
  const source = readFileSync(new URL('../src/lib/payments.ts', import.meta.url), 'utf8')
    .replace(/^import .* from .*;$/gm, '')
    .replace('export { expectedAmount, formatWon };', '');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const { requestTossPayment } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  const order = { amount: 3900, orderId: 'test-order', orderName: 'Light', customerKey: 'customer', successUrl: 'https://example.test/success', failUrl: 'https://example.test/fail' };
  await requestTossPayment({ ...order, mode: 'test', clientKey: 'test_ck_example' });
  await requestTossPayment({ ...order, mode: 'live', clientKey: 'live_ck_example' });
  await requestTossPayment({ ...order, mode: 'test', clientKey: 'live_ck_example' });
  assert.deepEqual(requests[0].sandbox, { paymentResult: 'SUCCESS' });
  assert.equal('sandbox' in requests[1], false);
  assert.equal('sandbox' in requests[2], false);
  assert.equal(requests[0].amount.value, 3900);
  assert.equal(requests[0].successUrl, order.successUrl);
});
