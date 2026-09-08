import assert from 'node:assert/strict';
import test from 'node:test';
import {
  awsEndpointArgs,
  s3CopyArgs,
  s3DeleteObjectArgs,
  s3ListObjectsArgs,
} from './backup-s3.mjs';

const endpointEnv = {
  AWS_ENDPOINT_URL: 'https://s3.us-west-004.backblazeb2.com/',
};

test('S3 commands keep AWS defaults when no endpoint is configured', () => {
  assert.deepEqual(awsEndpointArgs({}), []);
  assert.deepEqual(
    s3CopyArgs('/tmp/archive.gpg', 's3://moa-private/backups/archive.gpg', {}),
    [
      's3',
      'cp',
      '/tmp/archive.gpg',
      's3://moa-private/backups/archive.gpg',
      '--only-show-errors',
    ],
  );
});

test('S3 upload, list, and delete commands include the configured HTTPS endpoint', () => {
  assert.deepEqual(
    s3CopyArgs('/tmp/archive.gpg', 's3://moa-private/backups/archive.gpg', endpointEnv),
    [
      's3',
      'cp',
      '/tmp/archive.gpg',
      's3://moa-private/backups/archive.gpg',
      '--only-show-errors',
      '--endpoint-url',
      'https://s3.us-west-004.backblazeb2.com',
    ],
  );
  assert.deepEqual(
    s3ListObjectsArgs({ bucket: 'moa-private', prefix: 'backups/prod' }, endpointEnv),
    [
      's3api',
      'list-objects-v2',
      '--bucket',
      'moa-private',
      '--prefix',
      'backups/prod/moa-studio-supabase-',
      '--output',
      'json',
      '--no-paginate',
      '--endpoint-url',
      'https://s3.us-west-004.backblazeb2.com',
    ],
  );
  assert.deepEqual(
    s3ListObjectsArgs({ bucket: 'moa-studio-backup-20260908', prefix: 'supabase' }, endpointEnv, 'next-page-token'),
    [
      's3api',
      'list-objects-v2',
      '--bucket',
      'moa-studio-backup-20260908',
      '--prefix',
      'supabase/moa-studio-supabase-',
      '--output',
      'json',
      '--no-paginate',
      '--endpoint-url',
      'https://s3.us-west-004.backblazeb2.com',
      '--continuation-token',
      'next-page-token',
    ],
  );
  assert.deepEqual(
    s3ListObjectsArgs(
      { bucket: 'moa-studio-backup-20260908', prefix: 'supabase' },
      endpointEnv,
      'next-page-token',
      { backupNamePrefix: false },
    ),
    [
      's3api',
      'list-objects-v2',
      '--bucket',
      'moa-studio-backup-20260908',
      '--prefix',
      'supabase/',
      '--output',
      'json',
      '--no-paginate',
      '--endpoint-url',
      'https://s3.us-west-004.backblazeb2.com',
      '--continuation-token',
      'next-page-token',
    ],
  );
  assert.deepEqual(
    s3DeleteObjectArgs('moa-private', 'backups/prod/archive.gpg', endpointEnv),
    [
      's3api',
      'delete-object',
      '--bucket',
      'moa-private',
      '--key',
      'backups/prod/archive.gpg',
      '--output',
      'json',
      '--endpoint-url',
      'https://s3.us-west-004.backblazeb2.com',
    ],
  );
});

test('AWS_ENDPOINT_URL rejects credentials and non-HTTPS endpoints', () => {
  assert.throws(
    () => awsEndpointArgs({ AWS_ENDPOINT_URL: 'http://s3.us-west-004.backblazeb2.com' }),
    /HTTPS/i,
  );
  assert.throws(
    () => awsEndpointArgs({ AWS_ENDPOINT_URL: 'https://key:secret@s3.us-west-004.backblazeb2.com' }),
    /credentials/i,
  );
});

test('AWS_ENDPOINT_URL rejects path, query, and hash components', () => {
  for (const endpoint of [
    'https://s3.us-west-004.backblazeb2.com/bucket',
    'https://s3.us-west-004.backblazeb2.com?AWS_SECRET_ACCESS_KEY=secret',
    'https://s3.us-west-004.backblazeb2.com#secret',
  ]) {
    assert.throws(
      () => awsEndpointArgs({ AWS_ENDPOINT_URL: endpoint }),
      /path, query, or hash/i,
    );
  }
});
