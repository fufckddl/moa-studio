import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/chatHistory.ts', import.meta.url), 'utf8');

function loadModule({ cloud = false, supabase } = {}) {
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  });
  const module = { exports: {} };
  const sandbox = {
    module,
    exports: module.exports,
    require: (specifier) => {
      if (specifier === './supabase') {
        return {
          isCloudConfigured: cloud,
          getSupabaseClient: () => supabase,
        };
      }
      throw new Error(`unexpected import: ${specifier}`);
    },
    globalThis,
    Date,
    Number,
    Map,
    Promise,
    encodeURIComponent,
    JSON,
    Array,
    Object,
    Error,
  };
  vm.runInNewContext(outputText, sandbox);
  return module.exports;
}

function installLocalStorage() {
  const values = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
    },
  };
  return values;
}

function createSupabase({ userId = 'user-1', rows = new Map(), failUpserts = [] } = {}) {
  const upserts = [];
  let getUserCalls = 0;
  return {
    upserts,
    rows,
    auth: {
      getUser: async () => {
        getUserCalls += 1;
        await Promise.resolve();
        return { data: { user: { id: userId } }, error: null };
      },
    },
    get getUserCalls() {
      return getUserCalls;
    },
    from(table) {
      assert.equal(table, 'photo_chat_history');
      const state = { userId: null, conversationId: null };
      return {
        select() {
          return this;
        },
        eq(column, value) {
          if (column === 'user_id') state.userId = value;
          if (column === 'conversation_id') state.conversationId = value;
          return this;
        },
        async maybeSingle() {
          await Promise.resolve();
          const row = rows.get(`${state.userId}:${state.conversationId}`);
          return { data: row ?? null, error: null };
        },
        async upsert(row) {
          await Promise.resolve();
          const failure = failUpserts.shift();
          if (failure) return { error: failure };
          upserts.push(row);
          rows.set(`${row.user_id}:${row.conversation_id}`, {
            messages: row.messages,
            updated_at: row.updated_at,
          });
          return { error: null };
        },
      };
    },
  };
}

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

test('guest and local backend history stay in local storage by user and conversation', async () => {
  installLocalStorage();
  const history = loadModule({ cloud: false });
  const messages = [{ role: 'user', content: 'make it brighter' }];

  await history.saveChatHistory(null, 'photo-edit', messages);
  await history.saveChatHistory('guest', 'other', [{ role: 'assistant', content: 'done' }]);

  assertJsonEqual(await history.loadChatHistory(null, 'photo-edit'), messages);
  assertJsonEqual(await history.loadChatHistory('guest', 'other'), [{ role: 'assistant', content: 'done' }]);
  assertJsonEqual(await history.loadChatHistory('user-1', 'photo-edit'), []);
  delete globalThis.window;
});

test('cached history reads synchronously by account and returns null for missing or corrupted cache', async () => {
  const values = installLocalStorage();
  const history = loadModule({ cloud: false });
  const ownMessages = [{ role: 'user', content: 'cached for account' }];
  const otherMessages = [{ role: 'assistant', content: 'cached for another account' }];

  await history.saveChatHistory('user-1', 'photo-edit', ownMessages);
  await history.saveChatHistory('user-2', 'photo-edit', otherMessages);

  assertJsonEqual(history.readCachedChatHistory('user-1', 'photo-edit'), ownMessages);
  assertJsonEqual(history.readCachedChatHistory('user-2', 'photo-edit'), otherMessages);
  assert.equal(history.readCachedChatHistory('user-1', 'missing'), null);

  for (const key of values.keys()) {
    if (key.includes(encodeURIComponent('user-1')) && key.includes(encodeURIComponent('photo-edit'))) {
      values.set(key, '{"messages":[{"role":"user","content":"x","references":[]}],"updatedAt":"2026-09-07T00:00:00.000Z"}');
    }
  }
  assert.equal(history.readCachedChatHistory('user-1', 'photo-edit'), null);
  delete globalThis.window;
});

test('cloud save validates messages, verifies the Supabase user, and upserts through RLS-owned keys', async () => {
  installLocalStorage();
  const supabase = createSupabase();
  const history = loadModule({ cloud: true, supabase });
  const messages = [
    { role: 'user', content: 'keep the cup' },
    { role: 'assistant', content: 'created a brighter edit' },
  ];

  await history.saveChatHistory('user-1', 'photo-edit', messages);

  assert.equal(supabase.getUserCalls, 1);
  assert.equal(supabase.upserts.length, 1);
  assert.equal(supabase.upserts[0].user_id, 'user-1');
  assert.equal(supabase.upserts[0].conversation_id, 'photo-edit');
  assertJsonEqual(supabase.upserts[0].messages, messages);
  await assert.rejects(
    () => history.saveChatHistory('user-1', 'photo-edit', [{ role: 'user', content: 'x', references: [] }]),
    /형식/
  );
  await assert.rejects(
    () => history.saveChatHistory('user-1', 'photo-edit', [{ role: 'assistant', content: 'x'.repeat(4001) }]),
    /형식/
  );
  delete globalThis.window;
});

test('cloud auth mismatch is a non-retryable 401', async () => {
  installLocalStorage();
  const supabase = createSupabase({ userId: 'different-user' });
  const history = loadModule({ cloud: true, supabase });

  await assert.rejects(
    () => history.saveChatHistory('user-1', 'photo-edit', [{ role: 'user', content: 'blocked' }]),
    (error) => error.status === 401 && error.retryable === false
  );
  delete globalThis.window;
});

test('failed cloud saves keep dirty local history and retry it on the next load', async () => {
  installLocalStorage();
  const supabase = createSupabase({ failUpserts: [{ message: 'network unavailable', status: 503 }] });
  const history = loadModule({ cloud: true, supabase });
  const messages = [{ role: 'user', content: 'recover me' }];

  await assert.rejects(
    () => history.saveChatHistory('user-1', 'photo-edit', messages),
    (error) => error.status === 503
  );

  assertJsonEqual(await history.loadChatHistory('user-1', 'photo-edit'), messages);
  assert.equal(supabase.upserts.length, 1);
  assertJsonEqual(supabase.rows.get('user-1:photo-edit').messages, messages);
  delete globalThis.window;
});

test('older queued cloud writes do not overwrite newer local saves', async () => {
  installLocalStorage();
  const supabase = createSupabase();
  const history = loadModule({ cloud: true, supabase });
  const first = [{ role: 'user', content: 'old' }];
  const second = [{ role: 'user', content: 'new' }];

  const firstSave = history.saveChatHistory('user-1', 'photo-edit', first);
  const secondSave = history.saveChatHistory('user-1', 'photo-edit', second);
  await Promise.all([firstSave, secondSave]);

  assert.equal(supabase.upserts.length, 1);
  assertJsonEqual(supabase.upserts[0].messages, second);
  assertJsonEqual(await history.loadChatHistory('user-1', 'photo-edit'), second);
  delete globalThis.window;
});

test('cloud hydration rereads local state before replacing it with a fetched row', async () => {
  installLocalStorage();
  const cloudMessages = [{ role: 'assistant', content: 'cloud' }];
  const newerMessages = [{ role: 'user', content: 'new local' }];
  const rows = new Map([
    ['user-1:photo-edit', { messages: cloudMessages, updated_at: '2026-09-07T00:00:00.000Z' }],
  ]);
  const supabase = createSupabase({ rows });
  const history = loadModule({ cloud: true, supabase });

  const loading = history.loadChatHistory('user-1', 'photo-edit');
  await history.saveChatHistory('user-1', 'photo-edit', newerMessages);

  assertJsonEqual(await loading, newerMessages);
  assertJsonEqual(await history.loadChatHistory('user-1', 'photo-edit'), newerMessages);
  delete globalThis.window;
});
