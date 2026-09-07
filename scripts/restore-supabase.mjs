#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
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

async function restoreDatabase(root) {
  const dbUrl = requireEnv(process.env, 'RESTORE_TARGET_DB_URL');
  const rolesPath = safeJoinWithin(root, 'db', 'roles.sql');
  const schemaPath = safeJoinWithin(root, 'db', 'schema.sql');
  const dataPath = safeJoinWithin(root, 'db', 'data.sql');
  await run('psql', [
    dbUrl,
    '--single-transaction',
    '-v',
    'ON_ERROR_STOP=1',
    '-f',
    rolesPath,
    '-f',
    schemaPath,
    '-c',
    'SET session_replication_role = replica',
    '-f',
    dataPath,
  ]);
}

async function restoreStorage(root, manifest) {
  const client = createClient(
    requireEnv(process.env, 'RESTORE_TARGET_SUPABASE_URL'),
    requireEnv(process.env, 'RESTORE_TARGET_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  const storageFiles = manifest.files.filter(file => file.kind === 'storage');
  for (const file of storageFiles) {
    const path = safeJoinWithin(root, ...file.path.split('/'));
    const body = await readFile(path);
    const contentType = file.metadata?.mimetype ?? file.metadata?.contentType ?? 'application/octet-stream';
    const { error } = await client.storage.from(file.bucket).upload(file.object, body, {
      upsert: true,
      contentType,
    });
    if (error) throw new Error(`Failed to restore ${file.bucket}/${file.object}: ${error.message}`);
  }
}

async function main() {
  const target = validateRestoreTarget(process.env);
  log(`Restore target verified: ${target.targetRef}`);
  await ensureCommand('gpg');
  await ensureCommand('tar');
  if (execute) await ensureCommand('psql');
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
    await restoreDatabase(root);
    await restoreStorage(root, manifest);
    log('Restore complete.');
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  process.stderr.write(`Restore failed: ${error.message}\n`);
  process.exitCode = 1;
});
