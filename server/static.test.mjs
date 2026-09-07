import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from './index.mjs';

test('production serves SPA and assets with API isolation and private file protection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'moa-static-'));
  const dist = join(directory, 'dist');
  await mkdir(join(dist, 'assets'), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<!doctype html><h1>Moa</h1>');
  await writeFile(join(dist, 'assets', 'app.js'), 'export const app = true;');
  await writeFile(join(directory, 'private.txt'), 'must never be served');
  await writeFile(join(dist, '.env.local'), 'must never be served');
  await symlink(join(directory, 'private.txt'), join(dist, 'leak.txt'));
  const app = createApiServer({
    authService: { handle: async () => null },
    paymentService: { handle: async () => null },
    staticDirectory: dist,
  });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => app.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${app.address().port}`;
  for (const path of ['/', '/?payment=success&orderId=test', '/studio/library']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.match(await response.text(), /Moa/);
  }
  const asset = await fetch(base + '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /text\/javascript/);
  assert.match(await asset.text(), /export const/);
  const head = await fetch(base + '/assets/app.js', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const path of ['/api/unknown', '/api', '/.env.local', '/%2eenv.local', '/leak.txt', '/assets/missing.js', '/%00.txt', '/%ZZ', '/%2e%2e%2fprivate.txt']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /must never/);
  }
  const mutation = await fetch(base + '/', { method: 'POST' });
  assert.equal(mutation.status, 404);
  const health = await fetch(base + '/api/health');
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
});
