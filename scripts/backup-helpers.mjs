import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, posix, relative, sep } from 'node:path';

export const PRODUCTION_SUPABASE_REF = 'mbmxkathxgvznuphbfbg';
export const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;

export function requireEnv(env, name) {
  const value = env[name];
  if (!value || !String(value).trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return String(value).trim();
}

export function optionalInt(env, name, fallback) {
  const value = env[name];
  if (!value) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

export function parseCsv(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
}

export function uniqueList(values) {
  return [...new Set(values.filter(Boolean))];
}

export function assertSafeStorageObjectName(name) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error('Storage object name must be a non-empty string');
  }
  if (name.includes('\0') || name.includes('\\')) {
    throw new Error(`Unsafe storage object name: ${name}`);
  }
  if (name.startsWith('/') || isAbsolute(name)) {
    throw new Error(`Unsafe absolute storage object name: ${name}`);
  }
  if (name.split('/').includes('..')) {
    throw new Error(`Unsafe path traversal in storage object name: ${name}`);
  }
  const normalized = posix.normalize(name);
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') {
    throw new Error(`Unsafe path traversal in storage object name: ${name}`);
  }
  return normalized;
}

export function assertSafePathSegment(name, label = 'path segment') {
  if (typeof name !== 'string' || !name.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (name.includes('\0') || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || isAbsolute(name)) {
    throw new Error(`Unsafe ${label}: ${name}`);
  }
  return name;
}

export function safeJoinWithin(root, ...parts) {
  const resolved = normalize(join(root, ...parts));
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Resolved path escapes root: ${parts.join('/')}`);
  }
  return resolved;
}

export function storageObjectLocalPath(storageRoot, bucket, objectName) {
  const safeBucket = assertSafePathSegment(bucket, 'storage bucket id');
  const safeName = assertSafeStorageObjectName(objectName);
  return safeJoinWithin(storageRoot, safeBucket, ...safeName.split('/'));
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve);
  });
  return hash.digest('hex');
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function manifestRelativePath(root, path) {
  const rel = relative(root, path).split(sep).join('/');
  if (!rel || rel.startsWith('../') || rel.includes('/../') || isAbsolute(rel)) {
    throw new Error(`Manifest path escapes backup root: ${path}`);
  }
  return rel;
}

export async function fileEntry(root, path, extra = {}) {
  const info = await stat(path);
  return {
    path: manifestRelativePath(root, path),
    bytes: info.size,
    sha256: await sha256File(path),
    ...extra,
  };
}

export async function assertNoLinks(root, current = root) {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(current, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.nlink > 1) {
      throw new Error(`Refusing archive link entry after extraction: ${manifestRelativePath(root, path)}`);
    }
    if (entry.isDirectory()) {
      await assertNoLinks(root, path);
    }
  }
}

export function parseDestinationUri(rawValue) {
  if (!rawValue || !String(rawValue).trim()) {
    throw new Error('BACKUP_DESTINATION_URI is required');
  }
  const value = String(rawValue).trim();
  if (value.startsWith('s3://')) {
    const withoutScheme = value.slice('s3://'.length).replace(/\/+$/, '');
    const slash = withoutScheme.indexOf('/');
    const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1).replace(/^\/+|\/+$/g, '');
    if (!bucket) throw new Error('S3 backup destination must include a bucket name');
    return { type: 's3', bucket, prefix, display: `s3://${bucket}/${prefix}`.replace(/\/$/, '') };
  }
  if (value.startsWith('file://')) {
    const url = new URL(value);
    return { type: 'local', path: decodeURIComponent(url.pathname), display: url.pathname };
  }
  return { type: 'local', path: value, display: value };
}

export function validateRestoreTarget(env) {
  const targetRef = requireEnv(env, 'RESTORE_TARGET_PROJECT_REF');
  const expectedRef = requireEnv(env, 'RESTORE_EXPECTED_PROJECT_REF');
  const targetUrl = requireEnv(env, 'RESTORE_TARGET_SUPABASE_URL').replace(/\/+$/, '');
  if (env.RESTORE_CONFIRM_ISOLATED_TARGET !== '1') {
    throw new Error('Set RESTORE_CONFIRM_ISOLATED_TARGET=1 after confirming this is an isolated non-production restore target.');
  }
  if (targetRef !== expectedRef) {
    throw new Error('RESTORE_TARGET_PROJECT_REF must exactly match RESTORE_EXPECTED_PROJECT_REF.');
  }
  if (targetRef === PRODUCTION_SUPABASE_REF || targetUrl === PRODUCTION_SUPABASE_URL) {
    throw new Error('Refusing to restore into the production Supabase project.');
  }
  return { targetRef, targetUrl };
}

export function validateManifestPaths(manifest) {
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error('Manifest is missing a files array');
  }
  for (const file of manifest.files) {
    if (!file.path || file.path.includes('\0') || file.path.includes('\\') || file.path.startsWith('/')) {
      throw new Error(`Unsafe manifest path: ${file.path}`);
    }
    if (file.path.split('/').includes('..')) {
      throw new Error(`Unsafe manifest path traversal: ${file.path}`);
    }
    const normalized = posix.normalize(file.path);
    if (normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
      throw new Error(`Unsafe manifest path traversal: ${file.path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(file.sha256 || '')) {
      throw new Error(`Invalid manifest sha256 for ${file.path}`);
    }
  }
}

export function validateTarPathListing(listing) {
  for (const entry of listing.split('\n').filter(Boolean)) {
    if (entry.includes('\0') || entry.includes('\\') || entry.startsWith('/') || entry.split('/').includes('..')) {
      throw new Error(`Unsafe archive path: ${entry}`);
    }
  }
}

export function validateTarVerboseListing(listing) {
  for (const line of listing.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type === 'l' || type === 'h') {
      throw new Error(`Refusing archive link entry: ${line}`);
    }
    if (line.includes(' -> ') || line.includes(' link to ')) {
      throw new Error(`Refusing archive link entry: ${line}`);
    }
  }
}
