import type { Brand, Brief, ContentPack, Photo } from './types';
import { makeTemplatePack, validateTemplateRequest } from '../shared/template.mjs';
import { getAccessToken, isCloudConfigured, supabasePublishableKey, supabaseUrl } from './lib/supabase';

export type PlanType = 'free' | 'light' | 'studio' | 'plus';
export interface ApiStatus {
  configured: boolean;
  provider: string;
  mode: 'live' | 'template';
  imageEditingConfigured?: boolean;
  imageEditingReason?: string;
  imageEditingTrialLimit?: number;
  imageEditingProvider?: string;
}

export interface PhotoEditMessage { role: 'user' | 'assistant'; content: string; }
export interface PhotoEditReference {
  id: string;
  name: string;
  dataUrl: string;
  purpose: 'style' | 'subject';
}
export interface PhotoEditProtectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PhotoEditRequest {
  photo: Photo;
  prompt: string;
  messages: PhotoEditMessage[];
  requestId: string;
  references?: PhotoEditReference[];
  protectedRegion?: PhotoEditProtectedRegion;
}
export interface PhotoEditUsage {
  configured: boolean;
  unlimited?: boolean;
  plan?: PlanType;
  limit?: number;
  used?: number;
  remaining?: number;
  period?: 'day' | 'month' | 'lifetime';
  periodStart?: string;
  periodEnd?: string;
  globalRemaining?: number;
  reason?: string;
}
export interface PhotoEditResponse { imageDataUrl: string; message: string; usage?: PhotoEditUsage; }
export interface PhotoEditStatus { configured: boolean; reason?: string; provider?: string; usage?: PhotoEditUsage; resetDescription?: string; }

export interface Entitlements {
  plan: PlanType;
  aiLimit: number;
  aiUsed: number;
  aiRemaining: number;
  brandLimit: 1 | 3;
  periodStart: string | null;
  periodEnd: string | null;
  configured: boolean;
}

const PHOTO_EDIT_MAX_IMAGE_BYTES = 3000000;

export const freeEntitlements = (configured = false): Entitlements => ({
  plan: 'free',
  aiLimit: 0,
  aiUsed: 0,
  aiRemaining: 0,
  brandLimit: 1,
  periodStart: null,
  periodEnd: null,
  configured,
});

export async function getStatus(): Promise<ApiStatus> {
  const response = await fetch(contentUrl('/status'), {
    headers: cloudHeaders(),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('생성 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  return response.json();
}

export async function getPhotoEditStatus(): Promise<PhotoEditStatus> {
  const endpoint = photoEditUrl('/status');
  const token = endpoint.external ? await getAccessToken() : isCloudConfigured ? await getAccessToken() : null;
  if (endpoint.external && !token) {
    return {
      configured: false,
      reason: '로그인하면 AI 사진 편집 사용량을 확인할 수 있어요.',
      provider: 'openai',
    };
  }

  const response = await fetch(endpoint.url, {
    credentials: endpoint.external || isCloudConfigured ? undefined : 'same-origin',
    headers: {
      ...(!endpoint.external ? cloudHeaders() : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('사진 편집 서버에 연결하지 못했어요. 잠시 후 다시 확인해 주세요.');
  const status = await response.json();
  return {
    configured: status.imageEditingConfigured === true,
    reason: status.imageEditingConfigured === true ? undefined : status.imageEditingReason ?? '아직 사진을 AI로 수정할 수 없어요. 기존 수정 도구는 계속 사용할 수 있습니다.',
    provider: typeof status.imageEditingProvider === 'string' ? status.imageEditingProvider : undefined,
    usage: normalizePhotoEditUsage(status),
    resetDescription: resetDescription(status),
  };
}

export async function getPhotoEditUsage(): Promise<PhotoEditUsage> {
  const endpoint = photoEditUrl('/usage');
  const token = endpoint.external ? await getAccessToken() : isCloudConfigured ? await getAccessToken() : null;
  if (endpoint.external && !token) {
    return {
      configured: false,
      reason: '로그인하면 AI 사진 편집 사용량을 확인할 수 있어요.',
    };
  }

  const response = await fetch(endpoint.url, {
    credentials: endpoint.external || isCloudConfigured ? undefined : 'same-origin',
    headers: {
      ...(!endpoint.external ? cloudHeaders() : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(body, '사진 편집 사용량을 불러오지 못했어요.'));
  return normalizePhotoEditUsage(body) ?? { configured: false, reason: '사진 편집 사용량 응답이 올바르지 않아요.' };
}

export async function getEntitlements(): Promise<Entitlements> {
  const token = isCloudConfigured ? await getAccessToken() : null;
  const response = await fetch(contentUrl('/entitlements'), {
    credentials: isCloudConfigured ? undefined : 'same-origin',
    headers: {
      ...cloudHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(readError(body, '사용량 정보를 불러오지 못했어요.'));
  return normalizeEntitlements(body);
}

async function inlinePhoto(photo: Photo): Promise<Photo> {
  if (photo.dataUrl.startsWith('data:')) return photo;
  const response = await fetch(photo.dataUrl);
  if (!response.ok) throw new Error('예시 사진을 불러오지 못했어요. 사진을 다시 선택해 주세요.');
  const blob = await response.blob();
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('사진을 읽을 수 없어요.'));
    reader.readAsDataURL(blob);
  });
  return { ...photo, dataUrl };
}

export async function generateContent(brand: Brand, brief: Brief, photos: Photo[], options: { useAI?: boolean } = {}): Promise<ContentPack> {
  if (!options.useAI) {
    return makeTemplatePack(validateTemplateRequest({ brand, brief, images: photos }));
  }

  const images = await Promise.all(photos.map(inlinePhoto));
  const token = isCloudConfigured ? await getAccessToken() : null;
  const response = await fetch(contentUrl('/generate'), {
    method: 'POST',
    credentials: isCloudConfigured ? undefined : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...cloudHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ brand, brief, images, requestId: crypto.randomUUID() }),
    signal: AbortSignal.timeout(95000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error('생성 서버의 응답을 읽지 못했어요. 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : '콘텐츠 생성에 실패했어요. 다시 시도해 주세요.');
  return body;
}

export async function editPhoto(request: PhotoEditRequest, signal?: AbortSignal): Promise<PhotoEditResponse> {
  const photo = await inlinePhoto(request.photo);
  const endpoint = photoEditUrl('/edit');
  const token = endpoint.external ? await getAccessToken() : isCloudConfigured ? await getAccessToken() : null;
  if (endpoint.external && !token) throw new Error('로그인이 필요합니다.');
  if (endpoint.external && !photo.dataUrl.startsWith('data:image/jpeg;base64,')) {
    throw new Error('사진 편집 입력은 JPEG로 준비해야 합니다.');
  }
  if (endpoint.external && byteLength(photo.dataUrl) > PHOTO_EDIT_MAX_IMAGE_BYTES) {
    throw new Error('사진 편집 입력은 3MB 이하여야 합니다.');
  }
  const references = normalizePhotoEditReferences(request.references ?? []);
  if (endpoint.external && references.some(reference => !reference.dataUrl.startsWith('data:image/jpeg;base64,'))) {
    throw new Error('참고 이미지는 JPEG로 준비해야 합니다.');
  }
  if (endpoint.external && references.some(reference => byteLength(reference.dataUrl) > PHOTO_EDIT_MAX_IMAGE_BYTES)) {
    throw new Error('참고 이미지는 장당 3MB 이하여야 합니다.');
  }
  const messages = request.messages.slice(-20).map(message => ({ role: message.role, content: message.content }));
  const response = await fetch(endpoint.url, {
    method: 'POST',
    credentials: endpoint.external || isCloudConfigured ? undefined : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(!endpoint.external ? cloudHeaders() : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ ...request, messages, photo, references }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(185000)]) : AbortSignal.timeout(185000),
  });
  let body;
  try { body = await response.json(); } catch { throw new Error('사진 편집 서버의 응답을 읽지 못했어요. 다시 시도해 주세요.'); }
  if (!response.ok) throw new Error(readError(body, '사진 편집 기능을 아직 사용할 수 없어요.'));
  return normalizePhotoEditResponse(body);
}

export async function generatePerson(prompt: string, requestId: string, signal?: AbortSignal): Promise<PhotoEditResponse> {
  const text = prompt.trim();
  if (!text || text.length > 2000) throw new Error('인물 설명을 1~2,000자로 입력해 주세요.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('생성 요청 정보가 올바르지 않아요.');
  const baseUrl = photoEditApiBaseUrl();
  if (!baseUrl) throw new Error('AI 인물 생성 서버가 아직 연결되지 않았어요.');
  const token = await getAccessToken();
  if (!token) throw new Error('로그인하면 AI 인물을 만들 수 있어요.');
  const response = await fetch(`${baseUrl}/generate-person`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ prompt: text, requestId }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(185000)]) : AbortSignal.timeout(185000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(readError(body, '인물을 생성하지 못했어요. 잠시 후 다시 시도해 주세요.'));
  return normalizePhotoEditResponse(body);
}

function contentUrl(path: string) {
  if (!isCloudConfigured) return `/api${path}`;
  return `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/moa-content${path}`;
}

function photoEditUrl(path: '/status' | '/usage' | '/edit'): { url: string; external: boolean } {
  const baseUrl = photoEditApiBaseUrl();
  if (baseUrl) return { url: `${baseUrl}${path}`, external: true };
  return { url: contentUrl(path), external: false };
}

function photoEditApiBaseUrl() {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
  return normalizeBaseUrl(env.VITE_PHOTO_EDIT_API_URL);
}

function normalizeBaseUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try { return new URL(trimmed).toString().replace(/\/+$/, ''); }
  catch { return ''; }
}

function cloudHeaders(): Record<string, string> {
  return isCloudConfigured ? { apikey: supabasePublishableKey } : {};
}

function readError(value: unknown, fallback: string) {
  if (value && typeof value === 'object' && 'error' in value && typeof value.error === 'string') return value.error;
  return fallback;
}

function normalizeEntitlements(value: unknown): Entitlements {
  if (!value || typeof value !== 'object') return freeEntitlements();
  const input = value as Partial<Entitlements>;
  const plan: PlanType = input.plan === 'light' || input.plan === 'studio' || input.plan === 'plus' ? input.plan : 'free';
  const aiLimit = finiteNumber(input.aiLimit);
  const aiUsed = finiteNumber(input.aiUsed);
  const aiRemaining = finiteNumber(input.aiRemaining, Math.max(0, aiLimit - aiUsed));
  return {
    plan,
    aiLimit,
    aiUsed,
    aiRemaining,
    brandLimit: plan === 'free' ? 1 : 3,
    periodStart: typeof input.periodStart === 'string' ? input.periodStart : null,
    periodEnd: typeof input.periodEnd === 'string' ? input.periodEnd : null,
    configured: input.configured === true,
  };
}

function normalizePhotoEditResponse(value: unknown): PhotoEditResponse {
  if (!value || typeof value !== 'object') throw new Error('사진 편집 응답이 올바르지 않아요.');
  const input = value as Partial<PhotoEditResponse>;
  if (typeof input.imageDataUrl !== 'string' || input.imageDataUrl.length > 12 * 1024 * 1024 || !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(input.imageDataUrl)) {
    throw new Error('편집된 사진 응답이 올바르지 않아요.');
  }
  return {
    imageDataUrl: input.imageDataUrl,
    message: typeof input.message === 'string' && input.message.trim() ? input.message : '편집된 사진을 만들었어요.',
    usage: normalizePhotoEditUsage(input.usage),
  };
}

function normalizePhotoEditReferences(references: PhotoEditReference[]): PhotoEditReference[] {
  if (references.length > 3) throw new Error('참고 이미지는 최대 3장까지 사용할 수 있습니다.');
  return references.map(reference => {
    if (reference.purpose !== 'style' && reference.purpose !== 'subject') {
      throw new Error('참고 이미지 용도가 올바르지 않습니다.');
    }
    return {
      id: reference.id,
      name: reference.name,
      dataUrl: reference.dataUrl,
      purpose: reference.purpose,
    };
  });
}

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown, fallback?: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function byteLength(value: string) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizePhotoEditUsage(value: unknown): PhotoEditUsage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<PhotoEditUsage> & { imageEditingConfigured?: boolean };
  const configured = input.configured === true || input.imageEditingConfigured === true;
  const plan = input.plan === 'free' || input.plan === 'light' || input.plan === 'studio' || input.plan === 'plus' ? input.plan : undefined;
  const period = input.period === 'lifetime' || input.period === 'day' || input.period === 'month' ? input.period : undefined;
  const usage: PhotoEditUsage = { configured };
  if (input.unlimited === true) usage.unlimited = true;
  const limit = optionalNumber(input.limit);
  const used = optionalNumber(input.used);
  const remaining = optionalNumber(input.remaining);
  const globalRemaining = optionalNumber(input.globalRemaining);
  if (plan) usage.plan = plan;
  if (limit !== undefined) usage.limit = limit;
  if (used !== undefined) usage.used = used;
  if (remaining !== undefined) usage.remaining = remaining;
  if (period) usage.period = period;
  if (typeof input.periodStart === 'string') usage.periodStart = input.periodStart;
  if (typeof input.periodEnd === 'string') usage.periodEnd = input.periodEnd;
  if (globalRemaining !== undefined) usage.globalRemaining = globalRemaining;
  if (typeof input.reason === 'string') usage.reason = input.reason;
  return usage;
}

function resetDescription(value: unknown) {
  const usage = normalizePhotoEditUsage(value);
  if (usage?.period === 'lifetime') return '무료 체험은 가입 후 총 3회이며 자동 충전되지 않아요.';
  if (!usage?.periodEnd) return undefined;
  if (usage.period === 'day') return 'UTC 기준 자정, 한국 시간 오전 9시에 다시 사용할 수 있어요.';
  const date = new Date(usage.periodEnd);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${date.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })}까지 사용할 수 있어요.`;
}
