#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import {
  requireEnv,
  assertNoLinks,
  safeJoinWithin,
  sha256File,
  validateTarPathListing,
  validateTarVerboseListing,
  validateManifestPaths,
  validateRestoreTarget,
} from './backup-helpers.mjs';
import { buildRestoreLists, extractApplicationPrivileges, parseCopyBlocks } from './restore-plan.mjs';

const args = new Set(process.argv.slice(2));
const execute = args.has('--execute');

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

async function decryptArchive(outputRoot) {
  const archivePath = requireEnv(process.env, 'RESTORE_ARCHIVE_PATH');
  const passphrase = requireEnv(process.env, 'RESTORE_ENCRYPTION_PASSPHRASE');
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const tarPath = join(outputRoot, `${basename(archivePath).replace(/\.gpg$/, '')}.tar.gz`);
  await run('gpg', [
    '--batch',
    '--yes',
    '--pinentry-mode',
    'loopback',
    '--passphrase-fd',
    '0',
    '--decrypt',
    '--output',
    tarPath,
    archivePath,
  ], { input: passphrase });
  validateTarPathListing(await capture('tar', ['-tzf', tarPath]));
  validateTarVerboseListing(await capture('tar', ['-tzvf', tarPath]));
  await run('tar', ['-xzf', tarPath, '-C', outputRoot]);
  await assertNoLinks(outputRoot);
  return outputRoot;
}

async function findManifest(outputRoot) {
  const { readdir } = await import('node:fs/promises');
  for (const entry of await readdir(outputRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(outputRoot, entry.name, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      validateManifestPaths(manifest);
      for (const file of manifest.files) {
        const path = safeJoinWithin(join(outputRoot, entry.name), ...file.path.split('/'));
        const actual = await sha256File(path);
        if (actual !== file.sha256) {
          throw new Error(`Checksum mismatch for ${file.path}`);
        }
      }
      return { root: join(outputRoot, entry.name), manifest };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  throw new Error('No manifest.json found in restore archive');
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Unsupported restore identifier');
  return `"${value}"`;
}

function tableName(table) {
  return `${identifier(table.schema)}.${identifier(table.table)}`;
}

async function sqlFile(root, name, sql) {
  const path = join(root, name);
  await writeFile(path, sql, { mode: 0o600 });
  return path;
}

async function executeSql(root, name, sql) {
  const path = await sqlFile(root, name, sql);
  await run('psql', [requireEnv(process.env, 'RESTORE_TARGET_DB_URL'), '-X', '-q',
    '--single-transaction', '-v', 'ON_ERROR_STOP=1', '-f', path]);
}

async function prepareDatabase(root, manifest) {
  const schemas = (manifest.database?.schemas ?? ['public']).filter(schema => !['auth', 'storage'].includes(schema));
  schemas.forEach(identifier);
  if (!schemas.includes('public')) throw new Error('Archive must include the public application schema');
  const rawDump = safeJoinWithin(root, 'db', 'selected-schemas.pg_dump');
  const toc = await capture('pg_restore', ['--list', rawDump]);
  const plan = buildRestoreLists(toc, schemas);
  const copies = parseCopyBlocks(await readFile(safeJoinWithin(root, 'db', 'data.sql'), 'utf8'));
  const selected = new Set(plan.dataTables.map(table => `${table.schema}.${table.table}`));
  for (const block of copies) {
    if (!selected.has(`${block.schema}.${block.table}`) && `${block.schema}.${block.table}` !== 'storage.objects' && block.rows.length) {
      throw new Error(`Archive contains unsupported nonempty table ${tableName(block)}; explicit migration is required`);
    }
  }
  const schemaList = await sqlFile(root, 'restore-schema.list', plan.schemaList);
  const dataList = await sqlFile(root, 'restore-data.list', plan.dataList);
  const schemaSql = await capture('pg_restore', ['--schema-only', '--no-owner', '--no-privileges', '--use-list', schemaList, '--file', '-', rawDump]);
  const dataSql = await capture('pg_restore', ['--data-only', '--no-owner', '--no-privileges', '--use-list', dataList, '--file', '-', rawDump]);
  const privileges = extractApplicationPrivileges(await readFile(safeJoinWithin(root, 'db', 'schema.sql'), 'utf8'), schemas);
  const storage = copies.find(block => block.schema === 'storage' && block.table === 'objects');
  if (!storage || storage.rows.length !== manifest.storage.object_count) throw new Error('Storage metadata count does not match manifest');
  return { ...plan, schemas, copies, schemaSql, dataSql, privileges, storage };
}

async function restoreDatabase(root, plan) {
  const dbUrl = requireEnv(process.env, 'RESTORE_TARGET_DB_URL');
  // A fresh target is required. Never truncate an existing user's target data.
  const appSchemaList = plan.schemas.map(schema => `'${schema}'`).join(',');
  const existing = await capture('psql', [dbUrl, '-AtX', '-v', 'ON_ERROR_STOP=1', '-c',
    `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in (${appSchemaList}) and c.relkind in ('r','p','v','m','S');`]);
  if (Number(existing.trim()) !== 0) throw new Error('Restore requires an empty application schema in a fresh target');
  const emptyChecks = plan.dataTables.filter(table => !plan.schemas.includes(table.schema)).map(table =>
    `IF EXISTS (SELECT 1 FROM ${tableName(table)}) THEN RAISE EXCEPTION 'Restore requires empty target table ${tableName(table)}'; END IF;`).join('\n');
  const clearGrants = plan.schemas.map(schema => ['TABLES', 'SEQUENCES', 'FUNCTIONS'].map(kind =>
    `REVOKE ALL ON ALL ${kind} IN SCHEMA ${identifier(schema)} FROM PUBLIC, anon, authenticated, service_role;`).join('\n')).join('\n');
  await executeSql(root, 'restore-database.sql', [
    `DO $restore$ BEGIN ${emptyChecks} END $restore$;`,
    'SET ROLE postgres;',
    ...plan.schemas.filter(schema => schema !== 'public').map(schema => `CREATE SCHEMA IF NOT EXISTS ${identifier(schema)} AUTHORIZATION postgres;`),
    plan.schemaSql,
    clearGrants,
    plan.privileges,
    'RESET ROLE;',
    'SET session_replication_role = replica;',
    plan.dataSql,
  ].join('\n'));
  log('Application schema, permissions and selected Auth/Storage data restored; managed platform DDL and role grants preserved.');
}

async function restoreStorage(root, manifest) {
  const client = createClient(
    requireEnv(process.env, 'RESTORE_TARGET_SUPABASE_URL'),
    requireEnv(process.env, 'RESTORE_TARGET_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const storageFiles = manifest.files.filter(file => file.kind === 'storage');
  for (const [index, file] of storageFiles.entries()) {
    const path = safeJoinWithin(root, ...file.path.split('/'));
    const body = await readFile(path);
    const contentType = file.metadata?.mimetype ?? file.metadata?.contentType ?? 'application/octet-stream';
    const { error } = await client.storage.from(file.bucket).upload(file.object, body, {
      upsert: true,
      contentType,
      cacheControl: /(?:^|,)\s*max-age=(\d+)/.exec(file.metadata?.cacheControl ?? '')?.[1] ?? '3600',
    });
    if (error) throw new Error(`Storage upload failed at manifest object ${index + 1}: ${error.message}`);
  }
  return client;
}

function stageCopy(block, temporaryName) {
  return [
    `CREATE TEMP TABLE ${identifier(temporaryName)} (LIKE ${tableName(block)} INCLUDING GENERATED) ON COMMIT DROP;`,
    `COPY ${identifier(temporaryName)} (${block.columns.map(identifier).join(', ')}) FROM stdin;`,
    ...block.rows,
    '\\.',
  ].join('\n');
}

async function reconcileStorage(root, block) {
  // Storage's version addresses the newly uploaded physical file; changing it breaks downloads.
  const preserved = block.columns.filter(column => !['bucket_id', 'name', 'version'].includes(column));
  const assignments = preserved.map(column => `${identifier(column)} = source.${identifier(column)}`).join(', ');
  await executeSql(root, 'restore-storage-metadata.sql', [
    'SET session_replication_role = replica;',
    stageCopy(block, 'restore_storage_source'),
    `DO $restore$ BEGIN
      IF EXISTS (SELECT 1 FROM restore_storage_source source LEFT JOIN storage.objects target
        ON target.bucket_id = source.bucket_id AND target.name = source.name WHERE target.id IS NULL)
      THEN RAISE EXCEPTION 'Missing uploaded Storage object'; END IF;
    END $restore$;`,
    `UPDATE storage.objects target SET ${assignments} FROM restore_storage_source source
      WHERE target.bucket_id = source.bucket_id AND target.name = source.name;`,
  ].join('\n'));
}

async function verifyRestoredData(root, plan, manifest, client) {
  const selected = new Set(plan.dataTables.map(table => `${table.schema}.${table.table}`));
  const blocks = plan.copies.filter(block => selected.has(`${block.schema}.${block.table}`) || block === plan.storage);
  const statements = [];
  for (const [index, block] of blocks.entries()) {
    const temporaryName = `restore_expected_${index}`;
    const columns = block.columns.filter(column => block !== plan.storage || column !== 'version').map(identifier).join(', ');
    statements.push(stageCopy(block, temporaryName),
      `DO $restore$ BEGIN IF EXISTS (
        (SELECT to_jsonb(ROW(${columns})) FROM ${identifier(temporaryName)} EXCEPT ALL SELECT to_jsonb(ROW(${columns})) FROM ${tableName(block)})
        UNION ALL
        (SELECT to_jsonb(ROW(${columns})) FROM ${tableName(block)} EXCEPT ALL SELECT to_jsonb(ROW(${columns})) FROM ${identifier(temporaryName)})
      ) THEN RAISE EXCEPTION 'Restored rows differ in ${tableName(block)}'; END IF; END $restore$;`);
  }
  await executeSql(root, 'verify-restored-rows.sql', statements.join('\n'));
  const storageFiles = manifest.files.filter(file => file.kind === 'storage');
  for (const [index, file] of storageFiles.entries()) {
    const { data, error } = await client.storage.from(file.bucket).download(file.object);
    if (error) throw new Error(`Restored download failed at manifest object ${index + 1}: ${error.message}`);
    const hash = createHash('sha256').update(Buffer.from(await data.arrayBuffer())).digest('hex');
    if (hash !== file.sha256) throw new Error(`Restored Storage checksum mismatch at manifest object ${index + 1}`);
  }
  log(`Verified restored rows in ${blocks.length} tables and downloaded SHA-256 for ${storageFiles.length} Storage objects.`);
  log('Storage logical metadata preserved; physical object versions regenerated for the target.');
}

async function main() {
  if (execute) requireEnv(process.env, 'RESTORE_TARGET_DB_URL');
  const target = validateRestoreTarget(process.env);
  log(`Restore target verified: ${target.targetRef}`);
  await ensureCommand('gpg');
  await ensureCommand('tar');
  if (execute) { await ensureCommand('psql'); await ensureCommand('pg_restore'); }
  if (!execute) {
    log('Dry run mode. The archive will be decrypted and checksummed, but no DB or Storage writes will be made.');
  }
  const outputRoot = join(tmpdir(), `moa-restore-${Date.now()}`);
  try {
    await decryptArchive(outputRoot);
    const { root, manifest } = await findManifest(outputRoot);
    const storageCount = manifest.files.filter(file => file.kind === 'storage').length;
    const dbCount = manifest.files.filter(file => file.kind === 'database').length;
    log(`Archive project: ${manifest.project?.supabase_project_ref ?? 'unknown'}`);
    log(`Verified files: ${manifest.files.length}`);
    log(`Database dump files: ${dbCount}`);
    log(`Storage objects: ${storageCount}`);
    if (!execute) {
      log('Dry run complete. Use --execute only after this isolated target has been reviewed.');
      return;
    }
    const plan = await prepareDatabase(root, manifest);
    await restoreDatabase(root, plan);
    const client = await restoreStorage(root, manifest);
    await reconcileStorage(root, plan.storage);
    await verifyRestoredData(root, plan, manifest, client);
    log('Restore complete.');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Restore failed: ${error.message}\n`);
  process.exitCode = 1;
});
