import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('autosaving text reuses uploaded photo bytes while changed photos and accounts upload independently', async t => {
  let userId = 'user-a';
  const uploads = [];
  const storedRows = [];
  const client = {
    auth: {
      async getSession() { return { data: { session: {} } }; },
      async getUser() { return { data: { user: { id: userId, email: 'qa@example.test', user_metadata: {} } } }; },
      async signOut() { return {}; },
    },
    storage: {
      from() { return {
        async upload(path, blob) { uploads.push({ path, size: blob.size }); return {}; },
        async createSignedUrls(paths) { return { data: paths.map(path => ({ path, signedUrl: `https://photos.example.test/${path}` })) }; },
      }; },
    },
    from() { return { async upsert(row) { storedRows.push(row); return {}; } }; },
  };
  globalThis.__autosavePhotoClient = client;
  t.after(() => { delete globalThis.__autosavePhotoClient; });
  const source = readFileSync(new URL('../src/lib/auth.ts', import.meta.url), 'utf8')
    .replace("import { getSupabaseClient, isCloudConfigured } from './supabase';", 'const getSupabaseClient = () => globalThis.__autosavePhotoClient; const isCloudConfigured = true;');
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
  const { putWorkspace, logout } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
  const workspace = { brand: null, projects: [{ id: 'project-1', name: 'first', photos: [{ id: 'photo-1', name: 'photo.png', dataUrl: 'data:image/png;base64,YQ==' }] }] };
  await putWorkspace(workspace, userId);
  workspace.projects[0].name = 'text changed';
  await putWorkspace(workspace, userId);
  assert.equal(uploads.length, 1, 'text-only autosave must not upload the same photo again');
  assert.equal(storedRows.length, 2, 'both workspace snapshots are still persisted');
  assert.equal(storedRows[1].projects[0].photos[0].dataUrl, '');
  workspace.projects[0].photos[0].dataUrl = 'data:image/png;base64,Yg==';
  const saved = await putWorkspace(workspace, userId);
  assert.equal(uploads.length, 2, 'changed image with the same id must upload');
  await putWorkspace(saved, userId);
  assert.equal(uploads.length, 2, 'hydrated storage photo already has an owned path');
  userId = 'user-b';
  await putWorkspace(workspace, userId);
  assert.equal(uploads.length, 3);
  assert.match(uploads[2].path, /^user-b\//);
  await logout();
  await putWorkspace(workspace, userId);
  assert.equal(uploads.length, 4, 'logout clears cached upload receipts');
});
