import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, symlink } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  assert.throws(() => validateRestoreTarget({ ...base, RESTORE_EXPECTED_PROJECT_REF: 'other' }), /exactly match/i);
  assert.throws(() => validateRestoreTarget({ ...base, RESTORE_CONFIRM_ISOLATED_TARGET: '0' }), /isolated/i);
  assert.throws(() => validateRestoreTarget({
    ...base,
    RESTORE_TARGET_PROJECT_REF: 'mbmxkathxgvznuphbfbg',
    RESTORE_EXPECTED_PROJECT_REF: 'mbmxkathxgvznuphbfbg',
    RESTORE_TARGET_SUPABASE_URL: 'https://mbmxkathxgvznuphbfbg.supabase.co',
  }), /production/i);
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
