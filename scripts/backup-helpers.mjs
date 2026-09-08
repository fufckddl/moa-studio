import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, posix, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCTION_SUPABASE_REF = 'mbmxkathxgvznuphbfbg';
export const PRODUCTION_SUPABASE_URL = `https://${PRODUCTION_SUPABASE_REF}.supabase.co`;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const FORBIDDEN_POSTGRES_QUERY_PARAMS = new Set([
  'host',
  'hostaddr',
  'port',
  'user',
  'dbname',
  'service',
  'servicefile',
]);

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
    if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) {
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
    const path = fileURLToPath(url);
    return { type: 'local', path, display: path };
  }
  return { type: 'local', path: value, display: value };
}

function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(hostname);
}

function parseUrl(value, label) {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
}

function supabaseRefFromTargetUrl(targetUrl) {
  if (
    targetUrl.protocol !== 'https:'
    || targetUrl.username
    || targetUrl.password
    || targetUrl.pathname !== '/'
    || targetUrl.search
    || targetUrl.hash
    || targetUrl.port
  ) {
    return null;
  }
  const match = /^([a-z0-9-]+)\.supabase\.co$/.exec(targetUrl.hostname);
  return match?.[1] ?? null;
}

function supabaseRefFromDbUrl(dbUrl) {
  if (!['postgres:', 'postgresql:'].includes(dbUrl.protocol)) {
    throw new Error('RESTORE_TARGET_DB_URL must be a postgres URL');
  }
  for (const param of dbUrl.searchParams.keys()) {
    if (FORBIDDEN_POSTGRES_QUERY_PARAMS.has(param.toLowerCase())) {
      throw new Error(`RESTORE_TARGET_DB_URL must not override libpq connection target with ${param}.`);
    }
  }
  const decodedUsername = decodeURIComponent(dbUrl.username);
  const usernameMatch = /^postgres\.([a-z0-9-]+)$/.exec(decodedUsername);
  const usernameRef = usernameMatch?.[1] ?? null;

  const directHostMatch = /^(?:db|directdb)\.([a-z0-9-]+)\.supabase\.co$/.exec(dbUrl.hostname);
  const directHostRef = directHostMatch?.[1] ?? null;

  if (directHostRef && usernameRef && directHostRef !== usernameRef) {
    throw new Error('RESTORE_TARGET_DB_URL host and username project refs must match.');
  }
  if (directHostRef) return directHostRef;
  if (usernameRef && /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(dbUrl.hostname)) return usernameRef;

  return null;
}

function validateApiUrlShape(url, label, { allowLoopback }) {
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} must not include credentials, path, query, or hash.`);
  }
  if (allowLoopback) {
    if (!['http:', 'https:'].includes(url.protocol)) {
      throw new Error(`${label} must use http or https for local restore targets.`);
    }
    if (!isLoopbackHost(url.hostname)) {
      throw new Error('Local restore targets require a loopback RESTORE_TARGET_SUPABASE_URL.');
    }
    return;
  }
  if (url.port) {
    throw new Error(`${label} must not include a non-default port.`);
  }
}

function rejectProductionRestoreTarget(targetRef, targetUrl, dbUrl) {
  const checked = [
    targetRef,
    targetUrl.hostname,
    dbUrl?.hostname,
    dbUrl ? decodeURIComponent(dbUrl.username) : '',
  ].filter(Boolean);
  if (checked.some(value => value.includes(PRODUCTION_SUPABASE_REF))) {
    throw new Error('Refusing to restore into the production Supabase project.');
  }
}

export function validateRestoreTarget(env) {
  const targetRef = requireEnv(env, 'RESTORE_TARGET_PROJECT_REF');
  const expectedRef = requireEnv(env, 'RESTORE_EXPECTED_PROJECT_REF');
  const targetUrlValue = requireEnv(env, 'RESTORE_TARGET_SUPABASE_URL').replace(/\/+$/, '');
  const targetUrl = parseUrl(targetUrlValue, 'RESTORE_TARGET_SUPABASE_URL');
  const dbUrlValue = env.RESTORE_TARGET_DB_URL?.trim();
  const dbUrl = dbUrlValue ? parseUrl(dbUrlValue, 'RESTORE_TARGET_DB_URL') : null;
  const isLocalTarget = env.RESTORE_ALLOW_LOCAL_TARGET === '1';
  if (env.RESTORE_CONFIRM_ISOLATED_TARGET !== '1') {
    throw new Error('Set RESTORE_CONFIRM_ISOLATED_TARGET=1 after confirming this is an isolated non-production restore target.');
  }
  if (targetRef !== expectedRef) {
    throw new Error('RESTORE_TARGET_PROJECT_REF must exactly match RESTORE_EXPECTED_PROJECT_REF.');
  }
  rejectProductionRestoreTarget(targetRef, targetUrl, dbUrl);

  if (isLocalTarget) {
    validateApiUrlShape(targetUrl, 'RESTORE_TARGET_SUPABASE_URL', { allowLoopback: true });
    if (dbUrl && !isLoopbackHost(dbUrl.hostname)) {
      throw new Error('Local restore targets require a loopback RESTORE_TARGET_DB_URL host.');
    }
    if (dbUrl) supabaseRefFromDbUrl(dbUrl);
    return { targetRef, targetUrl: targetUrlValue };
  }

  validateApiUrlShape(targetUrl, 'RESTORE_TARGET_SUPABASE_URL', { allowLoopback: false });
  const targetUrlRef = supabaseRefFromTargetUrl(targetUrl);
  if (!targetUrlRef) {
    throw new Error('RESTORE_TARGET_SUPABASE_URL must be an exact https://<project-ref>.supabase.co target URL.');
  }
  if (targetUrlRef !== targetRef) {
    throw new Error('RESTORE_TARGET_SUPABASE_URL project ref must match RESTORE_TARGET_PROJECT_REF.');
  }
  if (dbUrl) {
    const dbRef = supabaseRefFromDbUrl(dbUrl);
    if (!dbRef) {
      throw new Error('RESTORE_TARGET_DB_URL must identify the target project via db.<ref>.supabase.co or postgres.<ref> pooler username.');
    }
    if (dbRef !== targetRef) {
      throw new Error('RESTORE_TARGET_DB_URL project ref must match RESTORE_TARGET_PROJECT_REF.');
    }
  }
  return { targetRef, targetUrl: targetUrlValue };
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
