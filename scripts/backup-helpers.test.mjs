import assert from 'node:assert/strict';
import test from 'node:test';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverStorageBuckets,
  listStorageObjects,
} from './backup-supabase.mjs';
import {
  assertNoLinks,
  assertSafePathSegment,
  assertSafeStorageObjectName,
  parseDestinationUri,
  safeJoinWithin,
  storageObjectLocalPath,
  validateManifestPaths,
  validateRestoreTarget,
  validateTarPathListing,
  validateTarVerboseListing,
} from './backup-helpers.mjs';

function fakeStorageClient({ buckets = [], objects = new Map() }) {
  const calls = [];
  return {
    calls,
    storage: {
      async listBuckets() {
        return { data: buckets, error: null };
      },
      from(bucket) {
        return {
          async list(prefix = '', options = {}) {
            calls.push({ bucket, prefix, options });
            const key = `${bucket}:${prefix ?? ''}`;
            const items = objects.get(key) ?? [];
            const offset = options.offset ?? 0;
            const limit = options.limit ?? items.length;
            return { data: items.slice(offset, offset + limit), error: null };
          },
        };
      },
    },
  };
}

function storageFile(name, extra = {}) {
  return {
    id: `id-${name}`,
    name,
    metadata: { size: 1, mimetype: 'application/octet-stream' },
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:01.000Z',
    last_accessed_at: null,
    ...extra,
  };
}

function storageFolder(name) {
  return {
    id: null,
    name,
    metadata: null,
    created_at: null,
    updated_at: null,
    last_accessed_at: null,
  };
}

test('storage object paths stay inside the backup directory', () => {
  const root = '/tmp/moa-backup/storage';
  assert.equal(
    storageObjectLocalPath(root, 'moa-photos', 'user-a/photo.jpg'),
    join(root, 'moa-photos', 'user-a', 'photo.jpg'),
  );
  assert.throws(() => storageObjectLocalPath(root, 'moa-photos', '../secret.txt'), /path traversal/i);
  assert.throws(() => storageObjectLocalPath(root, 'moa-photos', '/secret.txt'), /absolute/i);
  assert.throws(() => storageObjectLocalPath(root, 'moa-photos', 'user-a\\secret.txt'), /unsafe/i);
  assert.throws(() => storageObjectLocalPath(root, '../bucket', 'user-a/photo.jpg'), /bucket id/i);
  assert.equal(assertSafePathSegment('moa-photos', 'storage bucket id'), 'moa-photos');
});

test('storage bucket discovery uses the Storage API and sorts bucket ids', async () => {
  const previousBuckets = process.env.SUPABASE_STORAGE_BUCKETS;
  delete process.env.SUPABASE_STORAGE_BUCKETS;
  try {
    const client = fakeStorageClient({
      buckets: [{ id: 'z-assets' }, { id: 'a-assets' }],
    });
    assert.deepEqual(await discoverStorageBuckets(client), ['a-assets', 'z-assets']);
  } finally {
    if (previousBuckets === undefined) delete process.env.SUPABASE_STORAGE_BUCKETS;
    else process.env.SUPABASE_STORAGE_BUCKETS = previousBuckets;
  }
});

test('storage object listing recursively walks nested folders with full paths and metadata', async () => {
  const client = fakeStorageClient({
    objects: new Map([
      ['photos:', [storageFolder('users'), storageFile('root.jpg', { metadata: { size: 12 } })]],
      ['photos:users', [storageFolder('alice')]],
      ['photos:users/alice', [
        storageFile('avatar.jpg', {
          metadata: { size: 34, mimetype: 'image/jpeg' },
          created_at: '2026-09-08T01:00:00.000Z',
          updated_at: '2026-09-08T01:00:01.000Z',
          last_accessed_at: '2026-09-08T01:00:02.000Z',
        }),
      ]],
    ]),
  });

  assert.deepEqual(await listStorageObjects(client, ['photos']), [
    {
      bucket_id: 'photos',
      name: 'users/alice/avatar.jpg',
      metadata: { size: 34, mimetype: 'image/jpeg' },
      created_at: '2026-09-08T01:00:00.000Z',
      updated_at: '2026-09-08T01:00:01.000Z',
      last_accessed_at: '2026-09-08T01:00:02.000Z',
    },
    {
      bucket_id: 'photos',
      name: 'root.jpg',
      metadata: { size: 12 },
      created_at: '2026-09-08T00:00:00.000Z',
      updated_at: '2026-09-08T00:00:01.000Z',
      last_accessed_at: null,
    },
  ]);
  assert.deepEqual(client.calls.map(call => `${call.bucket}:${call.prefix}:${call.options.offset}`), [
    'photos::0',
    'photos:users:0',
    'photos:users/alice:0',
  ]);
});

test('storage object listing paginates folders before recursing into nested files', async () => {
  const pagedRoot = [
    ...Array.from({ length: 1000 }, (_, index) => storageFile(`file-${String(index).padStart(4, '0')}.txt`)),
    storageFolder('nested'),
  ];
  const nestedFiles = Array.from({ length: 1001 }, (_, index) => storageFile(`nested-${String(index).padStart(4, '0')}.txt`));
  const client = fakeStorageClient({
    objects: new Map([
      ['archive:', pagedRoot],
      ['archive:nested', nestedFiles],
    ]),
  });

  const objects = await listStorageObjects(client, ['archive']);

  assert.equal(objects.length, 2001);
  assert.equal(objects.at(0).name, 'file-0000.txt');
  assert.equal(objects.at(999).name, 'file-0999.txt');
  assert.equal(objects.at(1000).name, 'nested/nested-0000.txt');
  assert.equal(objects.at(-1).name, 'nested/nested-1000.txt');
  assert.deepEqual(client.calls.map(call => `${call.prefix}:${call.options.offset}`), [
    ':0',
    ':1000',
    'nested:0',
    'nested:1000',
  ]);
});

test('safeJoinWithin rejects resolved paths outside the root', () => {
  assert.equal(safeJoinWithin('/tmp/root', 'a', 'b.txt'), join('/tmp/root', 'a', 'b.txt'));
  assert.throws(() => safeJoinWithin('/tmp/root', '..', 'b.txt'), /escapes root/i);
});

test('manifest paths reject traversal and invalid hashes', () => {
  validateManifestPaths({
    files: [{ path: 'db/schema.sql', sha256: 'a'.repeat(64), bytes: 1 }],
  });
  assert.throws(() => validateManifestPaths({
    files: [{ path: '../db/schema.sql', sha256: 'a'.repeat(64), bytes: 1 }],
  }), /traversal/i);
  assert.throws(() => validateManifestPaths({
    files: [{ path: 'db/schema.sql', sha256: 'bad', bytes: 1 }],
  }), /sha256/i);
});

test('backup destination supports local paths and s3 uris', () => {
  assert.deepEqual(parseDestinationUri('/secure/backups'), {
    type: 'local',
    path: '/secure/backups',
    display: '/secure/backups',
  });
  assert.deepEqual(parseDestinationUri('s3://moa-private/backups/prod'), {
    type: 's3',
    bucket: 'moa-private',
    prefix: 'backups/prod',
    display: 's3://moa-private/backups/prod',
  });
  assert.deepEqual(parseDestinationUri('file:///secure/Moa%20Backups'), {
    type: 'local',
    path: '/secure/Moa Backups',
    display: '/secure/Moa Backups',
  });
});

test('restore target must be an explicit isolated non-production project', () => {
  const base = {
    RESTORE_CONFIRM_ISOLATED_TARGET: '1',
    RESTORE_TARGET_PROJECT_REF: 'restoreproject',
    RESTORE_EXPECTED_PROJECT_REF: 'restoreproject',
    RESTORE_TARGET_SUPABASE_URL: 'https://restoreproject.supabase.co',
  };
  assert.deepEqual(validateRestoreTarget(base), {
    targetRef: 'restoreproject',
    targetUrl: 'https://restoreproject.supabase.co',
  });
  assert.deepEqual(validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:secret@db.restoreproject.supabase.co:5432/postgres',
  }), {
    targetRef: 'restoreproject',
    targetUrl: 'https://restoreproject.supabase.co',
  });
  assert.deepEqual(validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres.restoreproject:secret@db.restoreproject.supabase.co:5432/postgres',
  }), {
    targetRef: 'restoreproject',
    targetUrl: 'https://restoreproject.supabase.co',
  });
  assert.deepEqual(validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres.restoreproject:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
  }), {
    targetRef: 'restoreproject',
    targetUrl: 'https://restoreproject.supabase.co',
  });
  assert.deepEqual(validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), {
    targetRef: 'localrestore',
    targetUrl: 'http://127.0.0.1:54321',
  });
  assert.throws(() => validateRestoreTarget({ ...base, RESTORE_EXPECTED_PROJECT_REF: 'other' }), /exactly match/i);
  assert.throws(() => validateRestoreTarget({ ...base, RESTORE_CONFIRM_ISOLATED_TARGET: '0' }), /isolated/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'mbmxkathxgvznuphbfbg',
    RESTORE_EXPECTED_PROJECT_REF: 'mbmxkathxgvznuphbfbg',
    RESTORE_TARGET_SUPABASE_URL: 'https://mbmxkathxgvznuphbfbg.supabase.co',
  }), /production/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_SUPABASE_URL: 'https://mbmxkathxgvznuphbfbg.supabase.co',
  }), /production/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:secret@db.mbmxkathxgvznuphbfbg.supabase.co:5432/postgres',
  }), /production/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres.mbmxkathxgvznuphbfbg:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
  }), /production/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_SUPABASE_URL: 'https://otherrestore.supabase.co',
  }), /RESTORE_TARGET_SUPABASE_URL project ref/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:secret@db.otherrestore.supabase.co:5432/postgres',
  }), /RESTORE_TARGET_DB_URL project ref/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:secret@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres',
  }), /RESTORE_TARGET_DB_URL must identify/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres.restoreproject:secret@example.com:6543/postgres',
  }), /RESTORE_TARGET_DB_URL must identify/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_DB_URL: 'postgresql://postgres.otherrestore:secret@db.restoreproject.supabase.co:5432/postgres',
  }), /host and username project refs/i);
  for (const param of ['host', 'hostaddr', 'port', 'user', 'dbname', 'service', 'servicefile']) {
    assert.throws(() => validateRestoreTarget({
      ...base,
      RESTORE_TARGET_DB_URL: `postgresql://postgres:secret@db.restoreproject.supabase.co:5432/postgres?${param}=db.otherrestore.supabase.co`,
    }), /libpq connection target/i);
  }
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_SUPABASE_URL: 'https://restoreproject.supabase.co.evil.example',
  }), /exact https/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321',
  }), /non-default port/i);
  for (const targetUrl of [
    'https://user:pass@restoreproject.supabase.co',
    'https://restoreproject.supabase.co/storage/v1',
    'https://restoreproject.supabase.co?apikey=secret',
    'https://restoreproject.supabase.co#fragment',
    'https://restoreproject.supabase.co:8443',
  ]) {
    assert.throws(() => validateRestoreTarget({
      ...base,
      RESTORE_TARGET_SUPABASE_URL: targetUrl,
    }), /RESTORE_TARGET_SUPABASE_URL/i);
  }
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@db.restoreproject.supabase.co:5432/postgres',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), /loopback RESTORE_TARGET_DB_URL/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321/storage/v1',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), /credentials, path, query, or hash/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321?apikey=secret',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), /credentials, path, query, or hash/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'ftp://127.0.0.1/',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), /http or https/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'localrestore',
    RESTORE_EXPECTED_PROJECT_REF: 'localrestore',
    RESTORE_TARGET_SUPABASE_URL: 'http://127.0.0.1:54321',
    RESTORE_TARGET_DB_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres?host=db.restoreproject.supabase.co',
    RESTORE_ALLOW_LOCAL_TARGET: '1',
  }), /libpq connection target/i);
});

test('storage object names cannot normalize into a different path', () => {
  assert.throws(() => assertSafeStorageObjectName('user-a/album/../photo.jpg'), /path traversal/i);
});

test('restore tar validation rejects traversal and links before extraction', () => {
  validateTarPathListing('moa-backup/db/schema.sql\nmoa-backup/storage/a/photo.jpg\n');
  assert.throws(() => validateTarPathListing('moa-backup/../../etc/passwd\n'), /unsafe archive path/i);
  validateTarVerboseListing('-rw-------  0 user group 10 Sep  7 12:00 moa-backup/db/schema.sql\n');
  assert.throws(
    () => validateTarVerboseListing('lrwxr-xr-x  0 user group  0 Sep  7 12:00 moa-backup/db/schema.sql -> /etc/passwd\n'),
    /link entry/i,
  );
  assert.throws(
    () => validateTarVerboseListing('hrw-r--r--  0 user group  0 Sep  7 12:00 moa-backup/db/data.sql link to moa-backup/db/schema.sql\n'),
    /link entry/i,
  );
});

test('post-extract archive validation rejects symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moa-backup-links-'));
  await mkdir(join(root, 'db'));
  await symlink('/etc/passwd', join(root, 'db', 'schema.sql'));
  await assert.rejects(() => assertNoLinks(root), /link entry/i);
});

test('post-extract archive validation allows normal directories with child entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moa-backup-directories-'));
  await mkdir(join(root, 'db', 'nested'), { recursive: true });
  await writeFile(join(root, 'db', 'schema.sql'), 'select 1;\n');
  await writeFile(join(root, 'db', 'nested', 'data.sql'), 'select 2;\n');

  await assert.doesNotReject(() => assertNoLinks(root));
});

test('post-extract archive validation rejects regular file hardlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'moa-backup-hardlinks-'));
  await mkdir(join(root, 'db'));
  const original = join(root, 'db', 'schema.sql');
  await writeFile(original, 'select 1;\n');
  await link(original, join(root, 'db', 'schema-copy.sql'));

  await assert.rejects(() => assertNoLinks(root), /link entry/i);
});
