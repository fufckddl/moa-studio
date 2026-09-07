import type { Brand, Project } from '../types';
import type { User as SupabaseAuthUser } from '@supabase/supabase-js';
import { getAccessToken, getSupabaseClient, isCloudConfigured } from './supabase';

export interface User { id: string; name: string; email: string }
export interface BrandProfile extends Brand { id: string }
export interface AccountWorkspace { brand: Brand | null; projects: Project[]; brandProfiles?: BrandProfile[]; activeBrandId?: string | null }
export interface AuthResult { user: User | null; confirmationRequired?: boolean }
export interface AuthValues { name?: string; email: string; password: string; captchaToken?: string }
export interface DeleteAccountValues { password: string; confirmation: string; captchaToken?: string }
export interface EraseAccountDataValues { password: string; confirmation: string; captchaToken?: string }

const PHOTO_BUCKET = 'moa-photos';
const ACCOUNT_FUNCTION = 'moa-account';
const MAX_PROJECTS = 100;
const MAX_PHOTOS_PER_PROJECT = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SHARED_ASSETS = new Set(['/assets/cafe-latte.png']);
const TURNSTILE_SITE_KEY = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_SITE_KEY ?? '').trim();
const TURNSTILE_REQUIRED = ((import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_TURNSTILE_REQUIRED ?? '').trim().toLowerCase() === 'true';
const uploadedPhotos = new Map<string, { fingerprint: string; path: string }>();

async function request<T>(path: string, method = 'GET', body?: unknown, userId?: string): Promise<T> {
  const response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(userId ? { 'X-Moa-User': userId } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '요청을 처리하지 못했어요. 다시 시도해 주세요.');
  return result as T;
}

function toUser(user: SupabaseAuthUser): User {
  const name = typeof user.user_metadata?.name === 'string' && user.user_metadata.name.trim()
    ? user.user_metadata.name.trim()
    : user.email?.split('@')[0] || '사용자';
  return { id: user.id, name, email: user.email ?? '' };
}

function authError(message: string): Error {
  const normalized = message.toLowerCase();
  if (normalized.includes('invalid login credentials')) return new Error('이메일 또는 비밀번호가 올바르지 않아요.');
  if (normalized.includes('email not confirmed')) return new Error('이메일 확인을 먼저 완료한 뒤 로그인해 주세요.');
  if (normalized.includes('email address not authorized')) return new Error('Supabase 이메일 발송 설정을 확인해 주세요. 현재 이 이메일 주소로 확인 메일을 보낼 수 없어요.');
  if (normalized.includes('rate limit') || normalized.includes('too many requests')) return new Error('요청이 너무 많아요. 잠시 후 다시 시도해 주세요.');
  if (normalized.includes('password')) return new Error('비밀번호 조건을 확인해 주세요.');
  return new Error(message || '계정 요청을 처리하지 못했어요. 다시 시도해 주세요.');
}

function workspaceError(message: string): Error {
  return new Error(message || '계정 보관함을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
}

function neutralResetMessage(): Error {
  return new Error('비밀번호 재설정 메일을 보낼 수 없어요. 잠시 후 다시 시도해 주세요.');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStoredWorkspace(value: unknown): AccountWorkspace {
  if (!isRecord(value)) return { brand: null, projects: [] };
  const brand = isRecord(value.brand) ? value.brand as unknown as Brand : null;
  const projects = Array.isArray(value.projects) ? value.projects as Project[] : [];
  const brandProfiles = Array.isArray(value.brandProfiles) ? value.brandProfiles as BrandProfile[] : Array.isArray(value.brand_profiles) ? value.brand_profiles as BrandProfile[] : undefined;
  const activeBrandId = typeof value.activeBrandId === 'string' ? value.activeBrandId : typeof value.active_brand_id === 'string' ? value.active_brand_id : null;
  return { brand, projects, brandProfiles, activeBrandId };
}

function sanitizePathPart(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'photo';
}

function assertOwnPhotoPath(userId: string, path: string, photoName: string): void {
  if (!path || path.includes('..') || path.startsWith('/') || !path.startsWith(`${userId}/`)) {
    throw new Error(`${photoName} 사진의 저장 위치가 현재 계정과 맞지 않아요. 사진을 다시 추가해 주세요.`);
  }
}

function parseDataUrl(dataUrl: string): { contentType: string; extension: string } {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,/i.exec(dataUrl);
  if (!match) throw new Error('사진은 JPG, PNG, WEBP 형식만 저장할 수 있어요.');
  const contentType = match[1].toLowerCase().replace('image/jpg', 'image/jpeg');
  const extension = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
  return { contentType, extension };
}

async function dataUrlToBlob(dataUrl: string, photoName: string): Promise<{ blob: Blob; contentType: string; extension: string }> {
  const { contentType, extension } = parseDataUrl(dataUrl);
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  if (blob.size > MAX_PHOTO_BYTES) {
    throw new Error(`${photoName} 사진은 저장 후 5MB보다 작아야 해요.`);
  }
  return { blob, contentType, extension };
}

async function persistPhoto(userId: string, projectId: string, photo: Project['photos'][number]): Promise<Project['photos'][number]> {
  if (SHARED_ASSETS.has(photo.dataUrl)) return photo;
  if (photo.storagePath && !photo.dataUrl.startsWith('data:')) {
    assertOwnPhotoPath(userId, photo.storagePath, photo.name);
    return { ...photo, dataUrl: '', storagePath: photo.storagePath, unavailable: undefined };
  }
  if (!photo.dataUrl.startsWith('data:')) {
    throw new Error(`${photo.name} 사진 원본을 다시 추가한 뒤 저장해 주세요.`);
  }

  const cacheKey = `${userId}/${projectId}/${photo.id}`;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(photo.dataUrl));
  const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  const cached = uploadedPhotos.get(cacheKey);
  if (cached?.fingerprint === fingerprint) {
    return { ...photo, dataUrl: '', storagePath: cached.path, unavailable: undefined };
  }

  const { blob, contentType, extension } = await dataUrlToBlob(photo.dataUrl, photo.name);
  const path = `${userId}/${sanitizePathPart(projectId)}/${sanitizePathPart(photo.id)}.${extension}`;
  const { error } = await getSupabaseClient()
    .storage
    .from(PHOTO_BUCKET)
    .upload(path, blob, { contentType, upsert: true });

  if (error) throw workspaceError(error.message);
  uploadedPhotos.delete(cacheKey);
  uploadedPhotos.set(cacheKey, { fingerprint, path });
  if (uploadedPhotos.size > MAX_PROJECTS * MAX_PHOTOS_PER_PROJECT) {
    const oldest = uploadedPhotos.keys().next().value;
    if (oldest) uploadedPhotos.delete(oldest);
  }
  return { ...photo, dataUrl: '', storagePath: path, unavailable: undefined };
}

async function persistProjects(userId: string, projects: Project[]): Promise<Project[]> {
  if (projects.length > MAX_PROJECTS) throw new Error(`프로젝트는 최대 ${MAX_PROJECTS}개까지 저장할 수 있어요.`);

  return Promise.all(projects.map(async (project) => {
    if (project.photos.length > MAX_PHOTOS_PER_PROJECT) {
      throw new Error('프로젝트 하나에는 사진을 최대 3장까지 저장할 수 있어요.');
    }
    return {
      ...project,
      photos: await Promise.all(project.photos.map((photo) => persistPhoto(userId, project.id, photo))),
    };
  }));
}

async function hydrateWorkspace(userId: string, workspace: AccountWorkspace): Promise<AccountWorkspace> {
  const storedPhotos = workspace.projects.flatMap((project) => project.photos.filter((photo) => photo.storagePath));
  for (const photo of storedPhotos) assertOwnPhotoPath(userId, photo.storagePath ?? '', photo.name);

  const signedUrls = new Map<string, string>();
  if (storedPhotos.length > 0) {
    const paths = Array.from(new Set(storedPhotos.map((photo) => photo.storagePath ?? '')));
    const { data } = await getSupabaseClient()
      .storage
      .from(PHOTO_BUCKET)
      .createSignedUrls(paths, 60 * 60 * 24);

    for (const item of data ?? []) {
      if (item.path && item.signedUrl && !item.error) signedUrls.set(item.path, item.signedUrl);
    }
  }

  return {
    ...workspace,
    projects: workspace.projects.map((project) => ({
      ...project,
      photos: project.photos.map((photo) => {
        if (!photo.storagePath) return photo;
        const signedUrl = signedUrls.get(photo.storagePath);
        return signedUrl
          ? { ...photo, dataUrl: signedUrl, unavailable: undefined }
          : { ...photo, dataUrl: '', unavailable: true };
      }),
    })),
  };
}

async function cloudGetSession(): Promise<{ user: User | null }> {
  const supabase = getSupabaseClient();
  const session = await supabase.auth.getSession();
  if (session.error) throw authError(session.error.message);
  if (!session.data.session) return { user: null };

  const { data, error } = await supabase.auth.getUser();
  if (error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('jwt') || normalized.includes('expired') || normalized.includes('invalid')) {
      await supabase.auth.signOut();
      return { user: null };
    }
    throw authError(error.message);
  }
  return { user: data.user ? toUser(data.user) : null };
}

async function cloudAuthenticate(mode: 'login' | 'signup', values: AuthValues): Promise<AuthResult> {
  const email = values.email.trim();
  const password = values.password;
  const supabase = getSupabaseClient();

  if (mode === 'signup') {
    assertCaptchaReady(values.captchaToken);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: values.name?.trim() || email.split('@')[0] },
        emailRedirectTo: new URL('/', window.location.origin).href,
        captchaToken: values.captchaToken,
      },
    });
    if (error) throw authError(error.message);
    if (!data.session) return { user: null, confirmationRequired: true };
    if (!data.user) return { user: null };
    return { user: toUser(data.user) };
  }

  assertCaptchaReady(values.captchaToken);
  const { data, error } = await supabase.auth.signInWithPassword({ email, password, options: { captchaToken: values.captchaToken } });
  if (error) throw authError(error.message);
  if (!data.user) throw new Error('로그인 세션을 만들지 못했어요.');
  return { user: toUser(data.user) };
}

async function cloudLogout(): Promise<unknown> {
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) throw authError(error.message);
  uploadedPhotos.clear();
  return {};
}

async function cloudGetWorkspace(): Promise<AccountWorkspace> {
  const session = await cloudGetSession();
  if (!session.user) return { brand: null, projects: [] };

  let { data, error }: { data: Record<string, unknown> | null; error: { message: string } | null } = await getSupabaseClient()
    .from('workspaces')
    .select('brand, projects, brand_profiles, active_brand_id')
    .eq('user_id', session.user.id)
    .maybeSingle();

  if (error && error.message.toLowerCase().includes('brand_profiles')) {
    const legacy = await getSupabaseClient()
      .from('workspaces')
      .select('brand, projects')
      .eq('user_id', session.user.id)
      .maybeSingle();
    data = legacy.data;
    error = legacy.error;
  }

  if (error) throw workspaceError(error.message);
  if (!data) return { brand: null, projects: [] };
  return hydrateWorkspace(session.user.id, isStoredWorkspace(data));
}

async function cloudPutWorkspace(workspace: AccountWorkspace, userId: string): Promise<AccountWorkspace> {
  const session = await cloudGetSession();
  if (!session.user || session.user.id !== userId) {
    throw new Error('로그인 세션을 다시 확인해 주세요.');
  }

  const projects = await persistProjects(userId, workspace.projects);
  const persisted = { ...workspace, projects };
  const { error } = await getSupabaseClient()
    .from('workspaces')
    .upsert({
      user_id: userId,
      brand: persisted.brand,
      projects: persisted.projects,
      brand_profiles: workspace.brandProfiles,
      active_brand_id: workspace.activeBrandId,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

  if (error) throw workspaceError(error.message);
  return hydrateWorkspace(userId, persisted);
}

function assertCaptchaReady(captchaToken?: string): void {
  if (!isTurnstileEnabled()) return;
  if (!TURNSTILE_SITE_KEY) throw new Error('보안 확인 설정이 필요해요. 관리자에게 문의해 주세요.');
  if (!captchaToken) throw new Error('보안 확인을 완료해 주세요.');
}

function resetRedirectUrl(): string {
  return new URL('/auth/reset-password', window.location.origin).href;
}

async function cloudSendPasswordReset(email: string, captchaToken?: string): Promise<void> {
  assertCaptchaReady(captchaToken);
  const { error } = await getSupabaseClient().auth.resetPasswordForEmail(email.trim(), {
    redirectTo: resetRedirectUrl(),
    captchaToken,
  });
  if (error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes('rate limit') || normalized.includes('too many requests')) throw authError(error.message);
    throw neutralResetMessage();
  }
}

async function cloudUpdatePassword(password: string): Promise<User> {
  const { data, error } = await getSupabaseClient().auth.updateUser({ password });
  if (error) throw authError(error.message);
  if (!data.user) throw new Error('비밀번호를 바꾼 뒤 세션을 확인하지 못했어요.');
  return toUser(data.user);
}

async function accountFunction(path: '/erase' | '/delete', body: DeleteAccountValues | EraseAccountDataValues): Promise<void> {
  const token = await getAccessToken();
  if (!token) throw new Error('로그인 세션을 다시 확인해 주세요.');
  const { data, error } = await getSupabaseClient().functions.invoke(`${ACCOUNT_FUNCTION}${path}`, {
    body: { ...body },
    headers: { Authorization: `Bearer ${token}` },
  });
  if (error) {
    let detail = '';
    if (error.context instanceof Response) {
      try {
        const payload: unknown = await error.context.clone().json();
        if (isRecord(payload) && typeof payload.error === 'string') detail = payload.error;
      } catch { /* A network or non-JSON failure uses the retry message below. */ }
    }
    throw new Error(detail || '계정 요청을 처리하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.');
  }
  if (isRecord(data) && typeof data.error === 'string') throw new Error(data.error);
}

async function cloudEraseAccountData(values: EraseAccountDataValues): Promise<void> {
  await accountFunction('/erase', values);
  clearLocalAccountDrafts();
}

async function cloudDeleteAccount(values: DeleteAccountValues): Promise<void> {
  await accountFunction('/delete', values);
  await getSupabaseClient().auth.signOut({ scope: 'local' }).catch(() => undefined);
  clearLocalAccountDrafts();
}

export const getSession = () => isCloudConfigured ? cloudGetSession() : request<{ user: User | null }>('/auth/session');
export const authenticate = (mode: 'login' | 'signup', values: AuthValues): Promise<AuthResult> => (
  isCloudConfigured ? cloudAuthenticate(mode, values) : request<{ user: User }>(`/auth/${mode}`, 'POST', values)
);
export const logout = () => isCloudConfigured ? cloudLogout() : request('/auth/logout', 'POST', {});
export const getWorkspace = () => isCloudConfigured ? cloudGetWorkspace() : request<AccountWorkspace>('/workspace');
export const putWorkspace = (workspace: AccountWorkspace, userId: string) => (
  isCloudConfigured ? cloudPutWorkspace(workspace, userId) : request<AccountWorkspace>('/workspace', 'PUT', workspace, userId)
);
export const sendPasswordReset = (email: string, captchaToken?: string) => (
  isCloudConfigured ? cloudSendPasswordReset(email, captchaToken) : Promise.reject(new Error('비밀번호 재설정은 클라우드 계정에서 사용할 수 있어요.'))
);
export const updatePassword = (password: string) => (
  isCloudConfigured ? cloudUpdatePassword(password) : Promise.reject(new Error('비밀번호 변경은 클라우드 계정에서 사용할 수 있어요.'))
);
export const eraseAccountData = (values: EraseAccountDataValues) => (
  isCloudConfigured ? cloudEraseAccountData(values) : Promise.reject(new Error('계정 데이터 삭제는 클라우드 계정에서 사용할 수 있어요.'))
);
export const deleteAccount = (values: DeleteAccountValues) => (
  isCloudConfigured ? cloudDeleteAccount(values) : Promise.reject(new Error('계정 삭제는 클라우드 계정에서 사용할 수 있어요.'))
);
export const isTurnstileEnabled = () => Boolean(TURNSTILE_SITE_KEY || TURNSTILE_REQUIRED);
export const getTurnstileSiteKey = () => TURNSTILE_SITE_KEY;

export function clearLocalAccountDrafts(): void {
  uploadedPhotos.clear();
  try {
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key));
    for (const key of keys) {
      if (key.startsWith('moa-studio:')) storage.removeItem(key);
    }
  } catch {
    // Browser storage cleanup is best effort after the server has erased account data.
  }
  try {
    if (window.indexedDB) window.indexedDB.deleteDatabase('moa-studio-person-library');
  } catch {
    // IndexedDB cleanup is best effort after the server has erased account data.
  }
}

export function subscribeWorkspace(userId: string, onChange: () => void): () => void {
  let closed = false;
  let pending: number | undefined;
  const visibleNotify = () => {
    if (closed || document.visibilityState !== 'visible') return;
    if (pending !== undefined) window.clearTimeout(pending);
    pending = window.setTimeout(() => {
      pending = undefined;
      if (!closed && document.visibilityState === 'visible') onChange();
    }, 120);
  };
  const timer = window.setInterval(visibleNotify, 15000);
  window.addEventListener('focus', visibleNotify);
  window.addEventListener('online', visibleNotify);
  document.addEventListener('visibilitychange', visibleNotify);

  const channel = isCloudConfigured
    ? getSupabaseClient()
      .channel(`workspace:${userId}:${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'workspaces', filter: `user_id=eq.${userId}` }, visibleNotify)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'workspaces', filter: `user_id=eq.${userId}` }, visibleNotify)
      .subscribe(status => { if (status === 'SUBSCRIBED') visibleNotify(); })
    : null;

  return () => {
    closed = true;
    if (pending !== undefined) window.clearTimeout(pending);
    window.clearInterval(timer);
    window.removeEventListener('focus', visibleNotify);
    window.removeEventListener('online', visibleNotify);
    document.removeEventListener('visibilitychange', visibleNotify);
    if (channel) void getSupabaseClient().removeChannel(channel);
  };
}
