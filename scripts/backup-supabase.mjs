#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import {
  fileEntry,
  assertSafePathSegment,
  assertSafeStorageObjectName,
  optionalInt,
  parseCsv,
  parseDestinationUri,
  requireEnv,
  safeJoinWithin,
  sha256Buffer,
  sha256File,
  storageObjectLocalPath,
  uniqueList,
} from './backup-helpers.mjs';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const retentionDays = optionalInt(process.env, 'BACKUP_RETENTION_DAYS', 30);
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupName = `moa-studio-supabase-${timestamp}`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (options.input) {
      child.stdin.end(options.input);
    } else {
      child.stdin.end();
    }
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function capture(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}

async function ensureCommand(command) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const checkerArgs = process.platform === 'win32' ? [command] : ['-v', command];
  await new Promise((resolve, reject) => {
    const child = spawn(checker, checkerArgs, { shell: process.platform !== 'win32', stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Required command not found: ${command}`));
    });
  });
}

async function checkRequiredCommands(destination) {
  const commands = ['gpg', 'tar', 'supabase', 'psql', 'pg_dump'];
  if (destination.type === 's3') commands.push('aws');
  for (const command of commands) {
    await ensureCommand(command);
  }
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function discoverDatabaseSchemas() {
  const requiredSchemas = parseCsv(process.env.SUPABASE_DB_SCHEMAS, ['public', 'auth', 'storage']);
  const optionalSchemas = parseCsv(process.env.SUPABASE_OPTIONAL_DB_SCHEMAS, ['moa_private']);
  if (optionalSchemas.length === 0) return uniqueList(requiredSchemas);
  const wanted = uniqueList([...requiredSchemas, ...optionalSchemas]);
  const arrayLiteral = `array[${wanted.map(sqlString).join(',')}]::text[]`;
  const query = [
    'select nspname',
    'from pg_catalog.pg_namespace',
    `where nspname = any(${arrayLiteral})`,
    `order by array_position(${arrayLiteral}, nspname)`,
  ].join(' ');
  const output = await capture('psql', [requireEnv(process.env, 'SUPABASE_DB_URL'), '-AtX', '-v', 'ON_ERROR_STOP=1', '-c', query]);
  const existing = new Set(output.split('\n').map(line => line.trim()).filter(Boolean));
  return uniqueList([...requiredSchemas, ...optionalSchemas.filter(schema => existing.has(schema))]);
}

async function collectDbDump(root, schemas) {
  const dbDir = join(root, 'db');
  await mkdir(dbDir, { recursive: true });
  const dbUrl = requireEnv(process.env, 'SUPABASE_DB_URL');
  const schemaArg = schemas.join(',');
  const dumps = [
    { name: 'roles.sql', args: ['db', 'dump', '--db-url', dbUrl, '--file', 'roles.sql', '--role-only'] },
    { name: 'schema.sql', args: ['db', 'dump', '--db-url', dbUrl, '--file', 'schema.sql', '--schema', schemaArg] },
    { name: 'data.sql', args: ['db', 'dump', '--db-url', dbUrl, '--file', 'data.sql', '--schema', schemaArg, '--data-only', '--use-copy'] },
  ];
  for (const dump of dumps) {
    await run('supabase', dump.args, { cwd: dbDir });
  }
  const rawDump = join(dbDir, 'selected-schemas.pg_dump');
  await run('pg_dump', [
    dbUrl,
    '--format=custom',
    '--blobs',
    '--no-owner',
    '--no-privileges',
    ...schemas.flatMap(schema => ['--schema', schema]),
    '--file',
    rawDump,
  ]);
  return Promise.all([
    ...dumps.map(dump => fileEntry(root, join(dbDir, dump.name), { kind: 'database', mode: 'supabase-cli-sql' })),
    fileEntry(root, rawDump, { kind: 'database', mode: 'raw-pg-dump-custom' }),
  ]);
}

async function discoverStorageBuckets(client) {
  const configured = parseCsv(process.env.SUPABASE_STORAGE_BUCKETS);
  if (configured.length > 0) return configured;
  const { data, error } = await client
    .schema('storage')
    .from('buckets')
    .select('id')
    .order('id', { ascending: true });
  if (error) throw new Error(`Failed to discover storage buckets: ${error.message}`);
  return data.map(bucket => assertSafePathSegment(bucket.id, 'storage bucket id')).filter(Boolean);
}

async function listStorageObjects(client, buckets) {
  const objects = [];
  for (const bucket of buckets) {
    const safeBucket = assertSafePathSegment(bucket, 'storage bucket id');
    let from = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await client
        .schema('storage')
        .from('objects')
        .select('bucket_id,name,metadata,created_at,updated_at,last_accessed_at')
        .eq('bucket_id', safeBucket)
        .order('name', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`Failed to list storage objects for ${safeBucket}: ${error.message}`);
      objects.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }
  }
  return objects;
}

async function collectStorage(root, buckets) {
  const url = requireEnv(process.env, 'SUPABASE_URL');
  const serviceRoleKey = requireEnv(process.env, 'SUPABASE_SERVICE_ROLE_KEY');
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const storageRoot = join(root, 'storage');
  await mkdir(storageRoot, { recursive: true });
  const objects = await listStorageObjects(client, buckets);
  const entries = [];
  for (const object of objects) {
    const safeBucket = assertSafePathSegment(object.bucket_id, 'storage bucket id');
    const safeObjectName = assertSafeStorageObjectName(object.name);
    const outputPath = storageObjectLocalPath(storageRoot, safeBucket, object.name);
    await mkdir(dirname(outputPath), { recursive: true });
    const { data, error } = await client.storage.from(safeBucket).download(object.name);
    if (error) throw new Error(`Failed to download ${safeBucket}/${object.name}: ${error.message}`);
    const buffer = Buffer.from(await data.arrayBuffer());
    await writeFile(outputPath, buffer, { mode: 0o600 });
    entries.push({
      path: `storage/${safeBucket}/${safeObjectName}`,
      bucket: safeBucket,
      object: safeObjectName,
      bytes: buffer.byteLength,
      sha256: sha256Buffer(buffer),
      kind: 'storage',
      metadata: object.metadata ?? null,
      created_at: object.created_at,
      updated_at: object.updated_at,
      last_accessed_at: object.last_accessed_at,
    });
  }
  return { buckets, entries };
}

async function encryptArchive(root) {
  const passphrase = requireEnv(process.env, 'BACKUP_ENCRYPTION_PASSPHRASE');
  const archive = join(tmpdir(), `${backupName}.tar.gz`);
  const encrypted = `${archive}.gpg`;
  await run('tar', ['-czf', archive, '-C', dirname(root), basename(root)]);
  await run('gpg', [
    '--batch',
    '--yes',
    '--pinentry-mode',
    'loopback',
    '--passphrase-fd',
    '0',
    '--symmetric',
    '--cipher-algo',
    'AES256',
    '--output',
    encrypted,
    archive,
  ], { input: passphrase });
  await rm(archive, { force: true });
  return encrypted;
}

async function copyToDestination(encryptedArchive, shaPath) {
  const destination = parseDestinationUri(process.env.BACKUP_DESTINATION_URI ?? process.env.BACKUP_DESTINATION);
  const archiveName = basename(encryptedArchive);
  if (destination.type === 'local') {
    await mkdir(destination.path, { recursive: true, mode: 0o700 });
    await copyFile(encryptedArchive, safeJoinWithin(destination.path, archiveName));
    await copyFile(shaPath, safeJoinWithin(destination.path, basename(shaPath)));
    return destination.display;
  }
  const keyPrefix = destination.prefix ? `${destination.prefix}/` : '';
  await run('aws', ['s3', 'cp', encryptedArchive, `s3://${destination.bucket}/${keyPrefix}${archiveName}`, '--only-show-errors']);
  await run('aws', ['s3', 'cp', shaPath, `s3://${destination.bucket}/${keyPrefix}${basename(shaPath)}`, '--only-show-errors']);
  return destination.display;
}

async function applyRetention(destinationRaw) {
  if (retentionDays === 0) return;
  const destination = parseDestinationUri(destinationRaw);
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  if (destination.type === 'local') {
    if (!existsSync(destination.path)) return;
    const { readdir, stat: statFile, unlink } = await import('node:fs/promises');
    for (const entry of await readdir(destination.path)) {
      if (!entry.startsWith('moa-studio-supabase-')) continue;
      const path = join(destination.path, entry);
      const info = await statFile(path);
      if (info.mtimeMs < cutoff) await unlink(path);
    }
    return;
  }
  const prefix = destination.prefix ? `${destination.prefix}/` : '';
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn('aws', ['s3api', 'list-objects-v2', '--bucket', destination.bucket, '--prefix', `${prefix}moa-studio-supabase-`, '--output', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout }) : reject(new Error(`aws s3api list-objects-v2 exited with code ${code}`)));
  });
  const listed = JSON.parse(stdout || '{}').Contents ?? [];
  for (const object of listed) {
    if (Date.parse(object.LastModified) < cutoff) {
      await run('aws', ['s3api', 'delete-object', '--bucket', destination.bucket, '--key', object.Key, '--output', 'json']);
    }
  }
}

async function main() {
  const projectRef = requireEnv(process.env, 'SUPABASE_PROJECT_REF');
  const destinationRaw = process.env.BACKUP_DESTINATION_URI ?? process.env.BACKUP_DESTINATION;
  const destination = parseDestinationUri(destinationRaw);
  const url = requireEnv(process.env, 'SUPABASE_URL');
  const serviceRoleKey = requireEnv(process.env, 'SUPABASE_SERVICE_ROLE_KEY');
  log(`Backup target: Supabase project ${projectRef}`);
  log(`Encrypted destination: ${destination.display}`);
  log(`Retention: ${retentionDays} days`);
  await checkRequiredCommands(destination);
  const schemas = await discoverDatabaseSchemas();
  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const buckets = await discoverStorageBuckets(client);
  log(`Database schemas: ${schemas.join(', ')}`);
  log(`Storage buckets: ${buckets.length === 0 ? '(none)' : buckets.join(', ')}`);
  if (dryRun) {
    requireEnv(process.env, 'BACKUP_ENCRYPTION_PASSPHRASE');
    log('Dry run complete. Metadata was discovered, but no backup archive was created.');
    return;
  }

  const root = join(tmpdir(), backupName);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true, mode: 0o700 });
  try {
    const dbEntries = await collectDbDump(root, schemas);
    const storage = await collectStorage(root, buckets);
    const manifest = {
      version: 1,
      created_at: new Date().toISOString(),
      project: {
        name: 'moa-studio',
        supabase_project_ref: projectRef,
        supabase_url: requireEnv(process.env, 'SUPABASE_URL').replace(/\/+$/, ''),
      },
      retention_days: retentionDays,
      database: {
        schemas,
        dumps: dbEntries.map(entry => entry.path),
      },
      storage: {
        buckets: storage.buckets,
        object_count: storage.entries.length,
      },
      files: [...dbEntries, ...storage.entries],
    };
    await writeFile(join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    const encryptedArchive = await encryptArchive(root);
    const archiveSha = await sha256File(encryptedArchive);
    const shaPath = `${encryptedArchive}.sha256`;
    await writeFile(shaPath, `${archiveSha}  ${basename(encryptedArchive)}\n`, { mode: 0o600 });
    const destinationDisplay = await copyToDestination(encryptedArchive, shaPath);
    await applyRetention(destinationRaw);
    log(`Backup archive written: ${basename(encryptedArchive)}`);
    log(`Destination: ${destinationDisplay}`);
    log(`DB dumps: ${dbEntries.length}`);
    log(`Storage objects: ${storage.entries.length}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Backup failed: ${error.message}\n`);
  process.exitCode = 1;
});
