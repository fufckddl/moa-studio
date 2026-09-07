import type { Brand, Project } from '../types';
import type { User as SupabaseAuthUser } from '@supabase/supabase-js';
import { getSupabaseClient, isCloudConfigured } from './supabase';

export interface User { id: string; name: string; email: string }
export interface BrandProfile extends Brand { id: string }
export interface AccountWorkspace { brand: Brand | null; projects: Project[]; brandProfiles?: BrandProfile[]; activeBrandId?: string | null }
export interface AuthResult { user: User | null; confirmationRequired?: boolean }

const PHOTO_BUCKET = 'moa-photos';
const MAX_PROJECTS = 100;
const MAX_PHOTOS_PER_PROJECT = 3;
const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const SHARED_ASSETS = new Set(['/assets/cafe-latte.png']);
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

async function cloudAuthenticate(mode: 'login' | 'signup', values: { name?: string; email: string; password: string }): Promise<AuthResult> {
  const email = values.email.trim();
  const password = values.password;
  const supabase = getSupabaseClient();

  if (mode === 'signup') {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { name: values.name?.trim() || email.split('@')[0] },
        emailRedirectTo: new URL('/', window.location.origin).href,
      },
    });
    if (error) throw authError(error.message);
    if (!data.session) return { user: null, confirmationRequired: true };
    if (!data.user) return { user: null };
    return { user: toUser(data.user) };
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
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

export const getSession = () => isCloudConfigured ? cloudGetSession() : request<{ user: User | null }>('/auth/session');
export const authenticate = (mode: 'login' | 'signup', values: { name?: string; email: string; password: string }): Promise<AuthResult> => (
  isCloudConfigured ? cloudAuthenticate(mode, values) : request<{ user: User }>(`/auth/${mode}`, 'POST', values)
);
export const logout = () => isCloudConfigured ? cloudLogout() : request('/auth/logout', 'POST', {});
export const getWorkspace = () => isCloudConfigured ? cloudGetWorkspace() : request<AccountWorkspace>('/workspace');
export const putWorkspace = (workspace: AccountWorkspace, userId: string) => (
  isCloudConfigured ? cloudPutWorkspace(workspace, userId) : request<AccountWorkspace>('/workspace', 'PUT', workspace, userId)
);

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
