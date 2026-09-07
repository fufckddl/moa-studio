import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const jpegDataUrl = 'data:image/jpeg;base64,/9j/AA==';

async function loadPersonLibrary({ cloud = false, client = null } = {}) {
  globalThis.__personLibraryClient = client;
  const source = readFileSync(new URL('../src/lib/personLibrary.ts', import.meta.url), 'utf8')
    .replace(
      /^import \{ getSupabaseClient, isCloudConfigured \} from '\.\/supabase';$/m,
      `const getSupabaseClient = () => globalThis.__personLibraryClient; const isCloudConfigured = ${cloud ? 'true' : 'false'};`,
    );
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
}

function memoryLocalStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    values,
  };
}

test('local person library is user scoped and validates reusable person bounds', async t => {
  const originalWindow = globalThis.window;
  const originalIndexedDb = globalThis.indexedDB;
  const localStorage = memoryLocalStorage();
  globalThis.window = { localStorage };
  delete globalThis.indexedDB;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.indexedDB = originalIndexedDb;
    delete globalThis.__personLibraryClient;
  });

  const api = await loadPersonLibrary();
  const saved = await api.savePerson('user-a', { id: 'person-1', name: '  Barista  ', prompt: '  Friendly adult barista  ', dataUrl: jpegDataUrl });
  assert.equal(saved.name, 'Barista');
  assert.equal(saved.prompt, 'Friendly adult barista');
  assert.equal(saved.storagePath, undefined);
  assert.deepEqual(await api.listPeople('user-b'), []);
  assert.equal((await api.listPeople('user-a'))[0].id, 'person-1');
  await api.renamePerson('user-a', 'person-1', 'Lead barista');
  assert.equal((await api.listPeople('user-a'))[0].name, 'Lead barista');
  await api.deletePerson('user-a', 'person-1');
  assert.deepEqual(await api.listPeople('user-a'), []);

  await assert.rejects(api.savePerson('user-a', { id: '../bad', name: 'Bad', prompt: 'Prompt', dataUrl: jpegDataUrl }), /ID/);
  await assert.rejects(api.savePerson('user-a', { id: 'p', name: 'n'.repeat(81), prompt: 'Prompt', dataUrl: jpegDataUrl }), /80/);
  await assert.rejects(api.savePerson('user-a', { id: 'p', name: 'Name', prompt: 'p'.repeat(2001), dataUrl: jpegDataUrl }), /2000/);
  await assert.rejects(api.savePerson('user-a', { id: 'p', name: 'Name', prompt: 'Prompt', dataUrl: 'data:image/png;base64,YQ==' }), /JPG/);
});

test('cloud person library verifies owner, uploads JPEG before metadata, signs list URLs, and deletes both records', async t => {
  const calls = [];
  const rows = [];
  const client = {
    auth: {
      async getUser() {
        calls.push({ op: 'getUser' });
        return { data: { user: { id: 'user-a' } } };
      },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'moa-people');
        return {
          async upload(path, blob, options) {
            calls.push({ op: 'upload', path, size: blob.size, options });
            return { error: null };
          },
          async createSignedUrls(paths, expiresIn) {
            calls.push({ op: 'sign', paths, expiresIn });
            return { data: paths.map(path => ({ path, signedUrl: `https://signed.example/${path}` })) };
          },
          async remove(paths) {
            calls.push({ op: 'remove', paths });
            return { error: null };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'generated_people');
      return {
        select() {
          calls.push({ op: 'select' });
          return this;
        },
        eq(field, value) {
          calls.push({ op: 'eq', field, value });
          return this;
        },
        order(field, options) {
          calls.push({ op: 'order', field, options });
          return Promise.resolve({ data: rows, error: null });
        },
        insert(row) {
          calls.push({ op: 'insert', row });
          rows.splice(0, rows.length, { id: row.id, name: row.name, prompt: row.prompt, storage_path: row.storage_path, created_at: '2026-09-07T00:00:00.000Z' });
          return this;
        },
        update(value) {
          calls.push({ op: 'update', value });
          return this;
        },
        delete() {
          calls.push({ op: 'delete' });
          return this;
        },
        async maybeSingle() {
          calls.push({ op: 'maybeSingle' });
          return { data: rows[0] ?? null, error: null };
        },
        async single() {
          calls.push({ op: 'single' });
          return { data: rows[0], error: null };
        },
      };
    },
  };
  t.after(() => { delete globalThis.__personLibraryClient; });
  const api = await loadPersonLibrary({ cloud: true, client });

  const saved = await api.savePerson('user-a', { id: 'person-1', name: 'Barista', prompt: 'Adult barista', dataUrl: jpegDataUrl });
  assert.equal(saved.storagePath, 'user-a/person-1.jpg');
  assert.deepEqual(calls.find(call => call.op === 'upload'), {
    op: 'upload',
    path: 'user-a/person-1.jpg',
    size: 4,
    options: { contentType: 'image/jpeg', cacheControl: '31536000, immutable', upsert: false },
  });
  assert.equal(calls.findIndex(call => call.op === 'upload') < calls.findIndex(call => call.op === 'insert'), true);
  assert.equal(calls.find(call => call.op === 'insert').row.storage_path, 'user-a/person-1.jpg');

  const listed = await api.listPeople('user-a');
  assert.equal(listed[0].dataUrl, 'https://signed.example/user-a/person-1.jpg');
  assert.equal(listed[0].storagePath, 'user-a/person-1.jpg');

  await api.renamePerson('user-a', 'person-1', 'Renamed');
  assert.deepEqual(calls.find(call => call.op === 'update').value, { name: 'Renamed' });
  await api.deletePerson('user-a', 'person-1');
  assert.deepEqual(calls.find(call => call.op === 'remove').paths, ['user-a/person-1.jpg']);
  assert.equal(calls.findIndex(call => call.op === 'delete') < calls.findIndex(call => call.op === 'remove'), true);
});

test('cloud person library rejects cross-account sessions and does not silently fall back after cloud failure', async t => {
  const originalWindow = globalThis.window;
  const localStorage = memoryLocalStorage();
  globalThis.window = { localStorage };
  let userId = 'other-user';
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: userId } } };
      },
    },
    storage: {
      from() {
        return {
          async upload() {
            return { error: { message: 'storage unavailable' } };
          },
        };
      },
    },
    from() {
      throw new Error('metadata should not be reached');
    },
  };
  t.after(() => {
    globalThis.window = originalWindow;
    delete globalThis.__personLibraryClient;
  });
  const api = await loadPersonLibrary({ cloud: true, client });
  await assert.rejects(api.listPeople('user-a'), /세션/);
  userId = 'user-a';
  await assert.rejects(api.savePerson('user-a', { id: 'person-1', name: 'Barista', prompt: 'Adult barista', dataUrl: jpegDataUrl }), /storage unavailable/);
  assert.equal(localStorage.values.size, 0);
});

test('cloud person save treats existing immutable image and metadata as an idempotent retry', async t => {
  const calls = [];
  const existing = { id: 'person-1', name: 'Existing', prompt: 'Original prompt', storage_path: 'user-a/person-1.jpg', created_at: '2026-09-07T01:00:00.000Z' };
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: 'user-a' } } };
      },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'moa-people');
        return {
          async upload(path, _blob, options) {
            calls.push({ op: 'upload', path, options });
            return { error: { statusCode: 409, message: 'The resource already exists' } };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'generated_people');
      return {
        insert(row) {
          calls.push({ op: 'insert', row });
          return this;
        },
        select() {
          calls.push({ op: 'select' });
          return this;
        },
        eq(field, value) {
          calls.push({ op: 'eq', field, value });
          return this;
        },
        async single() {
          const duplicate = !calls.some(call => call.op === 'duplicate-returned');
          if (duplicate) {
            calls.push({ op: 'duplicate-returned' });
            return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } };
          }
          return { data: existing, error: null };
        },
      };
    },
  };
  t.after(() => { delete globalThis.__personLibraryClient; });
  const api = await loadPersonLibrary({ cloud: true, client });
  const saved = await api.savePerson('user-a', { id: 'person-1', name: 'Existing', prompt: 'Original prompt', dataUrl: jpegDataUrl });
  assert.equal(saved.storagePath, 'user-a/person-1.jpg');
  assert.equal(saved.createdAt, '2026-09-07T01:00:00.000Z');
  assert.equal(calls.filter(call => call.op === 'upload').length, 1);
  assert.equal(calls.filter(call => call.op === 'insert').length, 1);
});

test('local person library reports IndexedDB open failures instead of pretending a durable save succeeded', async t => {
  const originalWindow = globalThis.window;
  const originalIndexedDb = globalThis.indexedDB;
  const localStorage = memoryLocalStorage();
  globalThis.window = { localStorage };
  globalThis.indexedDB = {
    open() {
      const request = {};
      queueMicrotask(() => request.onerror?.());
      return request;
    },
  };
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.indexedDB = originalIndexedDb;
    delete globalThis.__personLibraryClient;
  });
  const api = await loadPersonLibrary();
  await assert.rejects(
    api.savePerson('user-a', { id: 'person-1', name: 'Barista', prompt: 'Adult barista', dataUrl: jpegDataUrl }),
    error => {
      assert.equal(error.name, 'PersonLibraryError');
      assert.equal(error.retryable, true);
      assert.match(error.message, /저장소/);
      return true;
    },
  );
  assert.equal(localStorage.values.size, 0);
});

test('local person library rejects writes when no durable browser storage exists', async t => {
  const originalWindow = globalThis.window;
  const originalLocalStorage = globalThis.localStorage;
  const originalIndexedDb = globalThis.indexedDB;
  delete globalThis.window;
  delete globalThis.localStorage;
  delete globalThis.indexedDB;
  t.after(() => {
    globalThis.window = originalWindow;
    globalThis.localStorage = originalLocalStorage;
    globalThis.indexedDB = originalIndexedDb;
    delete globalThis.__personLibraryClient;
  });
  const api = await loadPersonLibrary();
  await assert.rejects(
    api.savePerson('user-a', { id: 'person-1', name: 'Barista', prompt: 'Adult barista', dataUrl: jpegDataUrl }),
    error => {
      assert.equal(error.name, 'PersonLibraryError');
      assert.equal(error.retryable, true);
      assert.match(error.message, /브라우저 저장소/);
      return true;
    },
  );
});


test('cloud person listing fails clearly when any private image cannot be signed', async t => {
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: 'user-a' } } };
      },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'moa-people');
        return {
          async createSignedUrls(paths) {
            return { data: [{ path: paths[0], error: 'not found' }] };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'generated_people');
      return {
        select() { return this; },
        eq() { return this; },
        async order() {
          return {
            data: [{ id: 'person-1', name: 'Barista', prompt: 'Adult barista', storage_path: 'user-a/person-1.jpg', created_at: '2026-09-07T00:00:00.000Z' }],
            error: null,
          };
        },
      };
    },
  };
  t.after(() => { delete globalThis.__personLibraryClient; });
  const api = await loadPersonLibrary({ cloud: true, client });
  await assert.rejects(
    api.listPeople('user-a'),
    error => {
      assert.equal(error.name, 'PersonLibraryError');
      assert.equal(error.retryable, true);
      assert.match(error.message, /불러오지/);
      return true;
    },
  );
});

test('cloud person delete removes metadata first and reports storage cleanup failure without recreating rows', async t => {
  const calls = [];
  const existing = { storage_path: 'user-a/person-1.jpg' };
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: 'user-a' } } };
      },
    },
    storage: {
      from(bucket) {
        assert.equal(bucket, 'moa-people');
        return {
          async remove(paths) {
            calls.push({ op: 'remove', paths });
            return { error: { message: 'storage cleanup failed' } };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'generated_people');
      return {
        select() {
          calls.push({ op: 'select' });
          return this;
        },
        eq(field, value) {
          calls.push({ op: 'eq', field, value });
          return this;
        },
        delete() {
          calls.push({ op: 'delete' });
          return this;
        },
        insert(row) {
          calls.push({ op: 'insert', row });
          return Promise.resolve({ data: null, error: null });
        },
        async maybeSingle() {
          calls.push({ op: 'maybeSingle' });
          return { data: existing, error: null };
        },
      };
    },
  };
  t.after(() => { delete globalThis.__personLibraryClient; });
  const api = await loadPersonLibrary({ cloud: true, client });
  await assert.rejects(api.deletePerson('user-a', 'person-1'), /storage cleanup failed/);
  assert.equal(calls.findIndex(call => call.op === 'delete') < calls.findIndex(call => call.op === 'remove'), true);
  assert.equal(calls.some(call => call.op === 'insert'), false);
});

test('cloud person delete does not remove storage when metadata lookup or deletion fails', async t => {
  const calls = [];
  let phase = 'lookup-fails';
  const client = {
    auth: {
      async getUser() {
        return { data: { user: { id: 'user-a' } } };
      },
    },
    storage: {
      from() {
        return {
          async remove(paths) {
            calls.push({ op: 'remove', paths, phase });
            return { error: null };
          },
        };
      },
    },
    from(table) {
      assert.equal(table, 'generated_people');
      return {
        select() {
          calls.push({ op: 'select', phase });
          return this;
        },
        eq() { return this; },
        delete() {
          calls.push({ op: 'delete', phase });
          return this;
        },
        async maybeSingle() {
          calls.push({ op: 'maybeSingle', phase });
          return phase === 'lookup-fails'
            ? { data: null, error: { message: 'metadata lookup failed' } }
            : { data: { storage_path: 'user-a/person-1.jpg' }, error: null };
        },
        then(resolve) {
          resolve(phase === 'delete-fails'
            ? { data: null, error: { message: 'metadata delete failed' } }
            : { data: null, error: null });
        },
      };
    },
  };
  t.after(() => { delete globalThis.__personLibraryClient; });
  const api = await loadPersonLibrary({ cloud: true, client });
  await assert.rejects(api.deletePerson('user-a', 'person-1'), /metadata lookup failed/);
  assert.equal(calls.some(call => call.op === 'remove'), false);
  phase = 'delete-fails';
  await assert.rejects(api.deletePerson('user-a', 'person-1'), /metadata delete failed/);
  assert.equal(calls.some(call => call.op === 'remove'), false);
});
