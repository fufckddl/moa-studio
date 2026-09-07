import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('workspace subscription scopes events, refreshes on reconnect and focus, and cleans up timers', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const window = new EventTarget();
  const document = new EventTarget();
  document.visibilityState = 'visible';
  Object.assign(window, { setTimeout: (...args) => setTimeout(...args), clearTimeout: id => clearTimeout(id), setInterval: (...args) => setInterval(...args), clearInterval: id => clearInterval(id) });
  globalThis.window = window;
  globalThis.document = document;
  const handlers = [];
  let statusHandler;
  let removed = 0;
  const channel = {
    on(type, filter, callback) { handlers.push({ type, filter, callback }); return this; },
    subscribe(callback) { statusHandler = callback; return this; },
  };
  globalThis.__workspaceSubscriptionClient = {
    channel() { return channel; },
    async removeChannel(value) { assert.equal(value, channel); removed++; return 'ok'; },
  };
  t.after(() => { globalThis.window = originalWindow; globalThis.document = originalDocument; delete globalThis.__workspaceSubscriptionClient; });
  const source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
    .replace("import { getAccessToken, getSupabaseClient, isCloudConfigured } from './supabase';", 'const getSupabaseClient = () => globalThis.__workspaceSubscriptionClient; const isCloudConfigured = true;');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { subscribeWorkspace } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  let changes = 0;
  const stop = subscribeWorkspace('user-a', () => { changes++; });
  assert.deepEqual(handlers.map(h => h.filter.event).sort(), ['INSERT', 'UPDATE']);
  for (const { type, filter } of handlers) {
    assert.equal(type, 'postgres_changes');
    assert.deepEqual({ schema: filter.schema, table: filter.table, filter: filter.filter }, { schema: 'public', table: 'workspaces', filter: 'user_id=eq.user-a' });
  }
  statusHandler('SUBSCRIBED');
  handlers[0].callback(); handlers[1].callback();
  t.mock.timers.tick(200);
  assert.equal(changes, 1, 'a burst of notifications refreshes once');
  document.visibilityState = 'hidden';
  handlers[1].callback(); t.mock.timers.tick(16000);
  assert.equal(changes, 1, 'background tabs do not poll or hydrate images');
  document.visibilityState = 'visible';
  document.dispatchEvent(new Event('visibilitychange')); t.mock.timers.tick(200);
  assert.equal(changes, 2);
  window.dispatchEvent(new Event('online')); t.mock.timers.tick(200);
  assert.equal(changes, 3);
  window.dispatchEvent(new Event('focus')); t.mock.timers.tick(200);
  assert.equal(changes, 4);
  t.mock.timers.tick(15000); t.mock.timers.tick(200);
  assert.ok(changes >= 5, 'periodic refresh recovers missed socket events');
  handlers[1].callback(); stop();
  const stoppedAt = changes;
  t.mock.timers.tick(30000);
  window.dispatchEvent(new Event('focus')); t.mock.timers.tick(200);
  assert.equal(changes, stoppedAt);
  assert.equal(removed, 1);
});
