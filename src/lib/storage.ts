import type { Brand, Brief, ContentCard, ContentPack, Goal, Photo, PhotoChatMessage, PhotoChats, Project, ScheduleItem, Tone } from '../types';

const PROJECTS_KEY = 'moa-studio:projects';
const BRAND_KEY = 'moa-studio:brand';
const PHOTO_CHAT_MAX_THREADS = 10;
const PHOTO_CHAT_MAX_MESSAGES = 200;
const PHOTO_CHAT_USER_MAX_CHARS = 2000;
const PHOTO_CHAT_ASSISTANT_MAX_CHARS = 4000;

function storageError(action: string, error: unknown): Error {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return new Error(`${action} 저장 공간이 부족해요. 오래된 프로젝트나 큰 사진을 삭제한 뒤 다시 시도해 주세요.`);
  }

  if (error instanceof Error) return new Error(`${action} 실패: ${error.message}`);
  return new Error(`${action} 실패: 브라우저 저장소를 사용할 수 없어요.`);
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch (error) {
    throw storageError('저장된 데이터를 불러오기', error);
  }
}

function writeJson(key: string, value: unknown, action: string): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    throw storageError(action, error);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isTone(value: unknown): value is Tone {
  return value === 'warm' || value === 'simple' || value === 'playful';
}

function isGoal(value: unknown): value is Goal {
  return value === 'new' || value === 'daily' || value === 'event';
}

function isBrand(value: unknown): value is Brand {
  if (!isRecord(value)) return false;
  return (
    isString(value.name) &&
    isString(value.tagline) &&
    isString(value.location) &&
    isString(value.instagram) &&
    isString(value.color)
  );
}

function isBrief(value: unknown): value is Brief {
  if (!isRecord(value)) return false;
  return (
    isString(value.productName) &&
    isString(value.description) &&
    isString(value.price) &&
    isTone(value.tone) &&
    isGoal(value.goal) &&
    (value.includeSchedule === undefined || typeof value.includeSchedule === 'boolean') &&
    (value.scheduleStartDate === undefined || isString(value.scheduleStartDate))
  );
}

function isPhoto(value: unknown): value is Photo {
  if (!isRecord(value)) return false;
  return isString(value.id) && isString(value.name) && isString(value.dataUrl);
}

function isLayout(value: unknown): value is ContentCard['layout'] {
  return ['editorial', 'minimal', 'bold', 'split', 'poster', 'menu'].includes(String(value));
}

function isCardStyle(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const color = (v: unknown) => v === undefined || (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v));
  return color(value.textColor) && color(value.backgroundColor) &&
    (value.fontScale === undefined || (typeof value.fontScale === 'number' && value.fontScale >= 0.85 && value.fontScale <= 1.2)) &&
    (value.align === undefined || ['left', 'center', 'right'].includes(String(value.align)));
}

function isContentCard(value: unknown): value is ContentCard {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.title) &&
    isString(value.subtitle) &&
    isString(value.eyebrow) &&
    isString(value.body) &&
    isString(value.imageId) &&
    isLayout(value.layout) &&
    (value.style === undefined || isCardStyle(value.style))
  );
}

function isScheduleItem(value: unknown): value is ScheduleItem {
  if (!isRecord(value)) return false;
  return isString(value.day) && isString(value.title) && isString(value.format) && isString(value.description) && (value.date === undefined || isString(value.date));
}

function isContentPack(value: unknown): value is ContentPack {
  if (!isRecord(value)) return false;
  return (
    (value.source === 'ai' || value.source === 'template') &&
    Array.isArray(value.cards) &&
    value.cards.length > 0 &&
    value.cards.length <= 10 &&
    value.cards.every(isContentCard) &&
    isString(value.caption) &&
    Array.isArray(value.hashtags) &&
    value.hashtags.every(isString) &&
    Array.isArray(value.schedule) &&
    value.schedule.every(isScheduleItem)
  );
}

function isPhotoChatMessage(value: unknown): value is PhotoChatMessage {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('role') || !keys.includes('content')) return false;
  const maxLength = value.role === 'assistant' ? PHOTO_CHAT_ASSISTANT_MAX_CHARS : PHOTO_CHAT_USER_MAX_CHARS;
  return (
    (value.role === 'user' || value.role === 'assistant') &&
    isString(value.content) &&
    value.content.length > 0 &&
    value.content.length <= maxLength
  );
}

function isPhotoChats(value: unknown, cards: ContentCard[]): value is PhotoChats {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  const cardIds = new Set(cards.map((card) => card.id));
  return (
    entries.length <= PHOTO_CHAT_MAX_THREADS &&
    entries.every(([cardId, messages]) => (
      cardId.length > 0 &&
      cardId.length <= 120 &&
      cardIds.has(cardId) &&
      Array.isArray(messages) &&
      messages.length <= PHOTO_CHAT_MAX_MESSAGES &&
      messages.every(isPhotoChatMessage)
    ))
  );
}

function isProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;
  if (!isContentPack(value.pack)) return false;
  return (
    isString(value.id) &&
    isString(value.name) &&
    isString(value.updatedAt) &&
    isBrand(value.brand) &&
    isBrief(value.brief) &&
    Array.isArray(value.photos) &&
    value.photos.every(isPhoto) &&
    (value.photoChats === undefined || isPhotoChats(value.photoChats, value.pack.cards))
  );
}

export function loadProjects(): Project[] {
  const projects = readJson<unknown>(PROJECTS_KEY, []);
  return Array.isArray(projects)
    ? projects.filter(isProject).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    : [];
}

export function saveProject(project: Project): void {
  if (!isProject(project)) throw new Error('프로젝트 데이터 형식이 올바르지 않아 저장하지 못했어요.');
  const projects = loadProjects();
  const next = [project, ...projects.filter((item) => item.id !== project.id)];
  writeJson(PROJECTS_KEY, next, '프로젝트 저장');
}

export function deleteProject(id: string): void {
  const projects = loadProjects().filter((project) => project.id !== id);
  writeJson(PROJECTS_KEY, projects, '프로젝트 삭제');
}

export function loadBrand(): Brand | null {
  const brand = readJson<unknown>(BRAND_KEY, null);
  return isBrand(brand) ? brand : null;
}

export function saveBrand(brand: Brand): void {
  if (!isBrand(brand)) throw new Error('브랜드 설정 형식이 올바르지 않아 저장하지 못했어요.');
  writeJson(BRAND_KEY, brand, '브랜드 설정 저장');
}


interface StoredBrandProfiles {
  brandProfiles: (Brand & { id: string })[];
  activeBrandId: string | null;
}
const BRAND_PROFILES_KEY = 'moa-studio:brand-profiles';

function isBrandProfiles(value: unknown): value is StoredBrandProfiles {
  if (!isRecord(value) || !Array.isArray(value.brandProfiles) || value.brandProfiles.length > 3) return false;
  const profiles = value.brandProfiles;
  if (!profiles.every(profile => isBrand(profile) && isRecord(profile) && typeof profile.id === 'string' && profile.id.trim().length > 0 && profile.id.length <= 120)) return false;
  const ids = profiles.map(profile => profile.id);
  return new Set(ids).size === ids.length && (profiles.length === 0 ? value.activeBrandId === null : ids.includes(value.activeBrandId));
}

export function loadBrandProfiles(): StoredBrandProfiles | null {
  const value = readJson<unknown>(BRAND_PROFILES_KEY, null);
  if (value === null) return null;
  if (!isBrandProfiles(value)) throw new Error('저장된 브랜드 프로필 형식이 올바르지 않아요.');
  return value;
}

export function saveBrandProfiles(brandProfiles: StoredBrandProfiles['brandProfiles'], activeBrandId: string | null): void {
  const value = { brandProfiles, activeBrandId };
  if (!isBrandProfiles(value)) throw new Error('브랜드 프로필 형식이 올바르지 않아 저장하지 못했어요.');
  writeJson(BRAND_PROFILES_KEY, value, '브랜드 프로필 저장');
}
