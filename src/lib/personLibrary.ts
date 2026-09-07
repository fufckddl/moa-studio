import { getSupabaseClient, isCloudConfigured } from './supabase';

export interface SavedPerson {
  id: string;
  name: string;
  prompt: string;
  dataUrl: string;
  storagePath?: string;
  createdAt: string;
}

interface PersonInput {
  id: string;
  name: string;
  prompt: string;
  dataUrl: string;
}

interface LocalPersonRecord extends SavedPerson {
  storagePath?: undefined;
}

interface CloudPersonRow {
  id: string;
  name: string;
  prompt: string;
  storage_path: string;
  created_at: string | null;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const PEOPLE_BUCKET = 'moa-people';
const LOCAL_PREFIX = 'moa-studio:person-library:v1';
const DB_NAME = 'moa-studio-person-library';
const STORE_NAME = 'people';
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_NAME_CHARS = 80;
const MAX_PROMPT_CHARS = 2000;
const MAX_ID_CHARS = 120;
const localQueues = new Map<string, Promise<unknown>>();
let dbPromise: Promise<IDBDatabase | null> | null = null;

export class PersonLibraryError extends Error {
  readonly status?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'PersonLibraryError';
    this.status = options.status;
    this.retryable = options.retryable ?? true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function storage(): StorageLike | null {
  const localStorage = globalThis.window?.localStorage ?? globalThis.localStorage;
  if (localStorage) return localStorage;
  return null;
}

function localKey(userId: string): string {
  return `${LOCAL_PREFIX}:${encodeURIComponent(normalizeUserId(userId))}`;
}

function normalizeUserId(userId: string): string {
  const value = userId.trim();
  if (!value) throw new PersonLibraryError('로그인 세션을 다시 확인해 주세요.', { status: 401, retryable: false });
  return value;
}

function normalizeId(id: string): string {
  const value = id.trim();
  if (!value || value.length > MAX_ID_CHARS || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new PersonLibraryError('인물 저장 ID가 올바르지 않아요.', { status: 400, retryable: false });
  }
  return value;
}

function normalizeText(value: string, label: string, max: number): string {
  const text = value.trim();
  if (!text || text.length > max) {
    throw new PersonLibraryError(`${label}은 1자 이상 ${max}자 이하로 입력해 주세요.`, { status: 400, retryable: false });
  }
  return text;
}

function normalizeDataUrl(dataUrl: string): string {
  const value = dataUrl.trim();
  if (!/^data:image\/jpe?g;base64,/i.test(value)) {
    throw new PersonLibraryError('인물 이미지는 JPG 데이터 URL이어야 해요.', { status: 400, retryable: false });
  }
  return value;
}

function personPath(userId: string, id: string): string {
  return `${userId}/${id}.jpg`;
}

function normalizeInput(userId: string, input: PersonInput): { userId: string; id: string; name: string; prompt: string; dataUrl: string; storagePath: string } {
  const normalizedUserId = normalizeUserId(userId);
  const id = normalizeId(input.id);
  return {
    userId: normalizedUserId,
    id,
    name: normalizeText(input.name, '인물 이름', MAX_NAME_CHARS),
    prompt: normalizeText(input.prompt, '인물 설명', MAX_PROMPT_CHARS),
    dataUrl: normalizeDataUrl(input.dataUrl),
    storagePath: personPath(normalizedUserId, id),
  };
}

function libraryError(error: unknown): PersonLibraryError {
  if (error instanceof PersonLibraryError) return error;
  if (error instanceof Error) return new PersonLibraryError(error.message);
  if (isRecord(error) && typeof error.message === 'string') {
    const status = typeof error.status === 'number' ? error.status : undefined;
    return new PersonLibraryError(error.message, { status });
  }
  return new PersonLibraryError('인물 보관함을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

async function verifyCloudUser(userId: string): Promise<void> {
  const { data, error } = await getSupabaseClient().auth.getUser();
  if (error) throw libraryError(error);
  if (data.user?.id !== userId) {
    throw new PersonLibraryError('로그인 세션을 다시 확인해 주세요.', { status: 401, retryable: false });
  }
}

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new PersonLibraryError('인물 이미지는 5MB보다 작아야 해요.', { status: 400, retryable: false });
  }
  return blob;
}

function openDb(): Promise<IDBDatabase | null> {
  if (!globalThis.indexedDB) return Promise.resolve(null);
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(new PersonLibraryError('인물 보관함 저장소를 열지 못했어요. 잠시 후 다시 시도해 주세요.'));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new PersonLibraryError('인물 보관함 저장소가 다른 창에서 사용 중이에요. 잠시 후 다시 시도해 주세요.'));
    };
  });
  return dbPromise;
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const request = run(transaction.objectStore(STORE_NAME));
    let result: T | null = null;
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => {
      transaction.abort();
      reject(request.error ?? new Error('IndexedDB request failed'));
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
  });
}

function readLocalFallback(userId: string): LocalPersonRecord[] {
  const fallback = storage();
  if (!fallback) return [];
  const raw = fallback.getItem(localKey(userId));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSavedPerson);
  } catch {
    return [];
  }
}

function writeLocalFallback(userId: string, people: LocalPersonRecord[]): void {
  const fallback = storage();
  if (!fallback) {
    throw new PersonLibraryError('인물 보관함을 저장할 브라우저 저장소를 사용할 수 없어요. 잠시 후 다시 시도해 주세요.');
  }
  fallback.setItem(localKey(userId), JSON.stringify(people));
}

function isSavedPerson(value: unknown): value is LocalPersonRecord {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.prompt === 'string'
    && typeof value.dataUrl === 'string'
    && typeof value.createdAt === 'string';
}

async function readLocal(userId: string): Promise<LocalPersonRecord[]> {
  const key = localKey(userId);
  const indexed = await withStore<{ key: string; people: LocalPersonRecord[] }>('readonly', store => store.get(key));
  if (globalThis.indexedDB) return indexed && Array.isArray(indexed.people) ? indexed.people.filter(isSavedPerson) : [];
  return readLocalFallback(userId);
}

async function writeLocal(userId: string, people: LocalPersonRecord[]): Promise<void> {
  const key = localKey(userId);
  const stored = people
    .filter(isSavedPerson)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (globalThis.indexedDB) {
    await withStore<IDBValidKey>('readwrite', store => store.put({ key, people: stored }));
    return;
  }
  writeLocalFallback(userId, stored);
}

async function serializeLocal<T>(userId: string, task: () => Promise<T>): Promise<T> {
  const key = localKey(userId);
  const previous = localQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  localQueues.set(key, next);
  void next.then(() => {
    if (localQueues.get(key) === next) localQueues.delete(key);
  }, () => {
    if (localQueues.get(key) === next) localQueues.delete(key);
  });
  return next;
}

async function saveLocalPerson(userId: string, input: PersonInput): Promise<SavedPerson> {
  const normalized = normalizeInput(userId, input);
  return serializeLocal(normalized.userId, async () => {
    const people = await readLocal(normalized.userId);
    const existing = people.find(person => person.id === normalized.id);
    const saved: LocalPersonRecord = {
      id: normalized.id,
      name: normalized.name,
      prompt: normalized.prompt,
      dataUrl: normalized.dataUrl,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await writeLocal(normalized.userId, [saved, ...people.filter(person => person.id !== saved.id)]);
    return saved;
  });
}

async function listLocalPeople(userId: string): Promise<SavedPerson[]> {
  return readLocal(normalizeUserId(userId));
}

async function renameLocalPerson(userId: string, id: string, name: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedId = normalizeId(id);
  const normalizedName = normalizeText(name, '인물 이름', MAX_NAME_CHARS);
  await serializeLocal(normalizedUserId, async () => {
    const people = await readLocal(normalizedUserId);
    await writeLocal(normalizedUserId, people.map(person => person.id === normalizedId ? { ...person, name: normalizedName } : person));
  });
}

async function deleteLocalPerson(userId: string, id: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedId = normalizeId(id);
  await serializeLocal(normalizedUserId, async () => {
    const people = await readLocal(normalizedUserId);
    await writeLocal(normalizedUserId, people.filter(person => person.id !== normalizedId));
  });
}

async function signedUrls(rows: CloudPersonRow[]): Promise<Map<string, string>> {
  const paths = rows.map(row => row.storage_path);
  const urls = new Map<string, string>();
  if (paths.length === 0) return urls;

  const { data, error } = await getSupabaseClient()
    .storage
    .from(PEOPLE_BUCKET)
    .createSignedUrls(paths, 60 * 60 * 24);

  if (error) throw libraryError(error);
  for (const item of data ?? []) {
    if (item.path && item.signedUrl && !item.error) urls.set(item.path, item.signedUrl);
  }
  const unsigned = paths.find(path => !urls.has(path));
  if (unsigned) {
    throw new PersonLibraryError('인물 이미지를 불러오지 못했어요. 잠시 후 다시 시도해 주세요.');
  }
  return urls;
}

async function listCloudPeople(userId: string): Promise<SavedPerson[]> {
  const normalizedUserId = normalizeUserId(userId);
  await verifyCloudUser(normalizedUserId);
  const { data, error } = await getSupabaseClient()
    .from('generated_people')
    .select('id, name, prompt, storage_path, created_at')
    .eq('user_id', normalizedUserId)
    .order('created_at', { ascending: false });

  if (error) throw libraryError(error);
  const rows = (data ?? []) as CloudPersonRow[];
  const urls = await signedUrls(rows);
  return rows.map(row => ({
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    dataUrl: urls.get(row.storage_path) ?? '',
    storagePath: row.storage_path,
    createdAt: row.created_at ?? new Date(0).toISOString(),
  }));
}

async function saveCloudPerson(userId: string, input: PersonInput): Promise<SavedPerson> {
  const normalized = normalizeInput(userId, input);
  await verifyCloudUser(normalized.userId);
  const blob = await dataUrlToBlob(normalized.dataUrl);
  const upload = await getSupabaseClient()
    .storage
    .from(PEOPLE_BUCKET)
    .upload(normalized.storagePath, blob, {
      contentType: 'image/jpeg',
      cacheControl: '31536000, immutable',
      upsert: false,
    });

  if (upload.error && !isDuplicateError(upload.error)) throw libraryError(upload.error);

  const insert = await getSupabaseClient()
    .from('generated_people')
    .insert({
      user_id: normalized.userId,
      id: normalized.id,
      name: normalized.name,
      prompt: normalized.prompt,
      storage_path: normalized.storagePath,
    })
    .select('id, name, prompt, storage_path, created_at')
    .single();

  if (insert.error && isDuplicateError(insert.error)) {
    const existing = await getSupabaseClient()
      .from('generated_people')
      .select('id, name, prompt, storage_path, created_at')
      .eq('user_id', normalized.userId)
      .eq('id', normalized.id)
      .single();
    if (existing.error) throw libraryError(existing.error);
    const row = existing.data as CloudPersonRow;
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      dataUrl: normalized.dataUrl,
      storagePath: row.storage_path,
      createdAt: row.created_at ?? new Date().toISOString(),
    };
  }

  const { data, error } = insert;
  if (error) throw libraryError(error);
  const createdAt = (data as CloudPersonRow | null)?.created_at ?? new Date().toISOString();
  return {
    id: normalized.id,
    name: normalized.name,
    prompt: normalized.prompt,
    dataUrl: normalized.dataUrl,
    storagePath: normalized.storagePath,
    createdAt,
  };
}

function isDuplicateError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  return error.code === '23505'
    || error.status === 409
    || error.statusCode === 409
    || (typeof error.message === 'string' && /duplicate|already exists|already been taken/i.test(error.message));
}

async function renameCloudPerson(userId: string, id: string, name: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedId = normalizeId(id);
  const normalizedName = normalizeText(name, '인물 이름', MAX_NAME_CHARS);
  await verifyCloudUser(normalizedUserId);
  const { error } = await getSupabaseClient()
    .from('generated_people')
    .update({ name: normalizedName })
    .eq('user_id', normalizedUserId)
    .eq('id', normalizedId);

  if (error) throw libraryError(error);
}

async function deleteCloudPerson(userId: string, id: string): Promise<void> {
  const normalizedUserId = normalizeUserId(userId);
  const normalizedId = normalizeId(id);
  const path = personPath(normalizedUserId, normalizedId);
  await verifyCloudUser(normalizedUserId);

  const existing = await getSupabaseClient()
    .from('generated_people')
    .select('storage_path')
    .eq('user_id', normalizedUserId)
    .eq('id', normalizedId)
    .maybeSingle<Pick<CloudPersonRow, 'storage_path'>>();
  if (existing.error) throw libraryError(existing.error);

  const metadataDelete = await getSupabaseClient()
    .from('generated_people')
    .delete()
    .eq('user_id', normalizedUserId)
    .eq('id', normalizedId);
  if (metadataDelete.error) throw libraryError(metadataDelete.error);

  const storagePath = existing.data?.storage_path ?? path;
  const storageDelete = await getSupabaseClient()
    .storage
    .from(PEOPLE_BUCKET)
    .remove([storagePath]);
  if (storageDelete.error) throw libraryError(storageDelete.error);
}

export function listPeople(userId: string): Promise<SavedPerson[]> {
  return isCloudConfigured ? listCloudPeople(userId) : listLocalPeople(userId);
}

export function savePerson(userId: string, input: PersonInput): Promise<SavedPerson> {
  return isCloudConfigured ? saveCloudPerson(userId, input) : saveLocalPerson(userId, input);
}

export function renamePerson(userId: string, id: string, name: string): Promise<void> {
  return isCloudConfigured ? renameCloudPerson(userId, id, name) : renameLocalPerson(userId, id, name);
}

export function deletePerson(userId: string, id: string): Promise<void> {
  return isCloudConfigured ? deleteCloudPerson(userId, id) : deleteLocalPerson(userId, id);
}
