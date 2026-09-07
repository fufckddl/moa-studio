import type { Brand, Brief, ContentPack, Photo, Project } from '../types';
import type { BrandProfile } from './auth';

export const AUTOSAVE_DELAY_MS = 850;
const LAST_PROJECT_KEY = 'moa-studio:last-project-id';

export type AutosaveState = 'readonly' | 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

export interface WorkspaceProject extends Project {
  brandId?: string;
}

export interface NormalizedWorkspace {
  brand: Brand;
  projects: WorkspaceProject[];
  brandProfiles: BrandProfile[];
  activeBrandId: string;
}

export interface DraftProjectInput {
  projectId: string | null;
  brand: Brand;
  activeBrandId: string;
  brief: Brief;
  photos: Photo[];
  pack: ContentPack;
}

export function createDraftProject(input: DraftProjectInput): WorkspaceProject {
  const id = input.projectId ?? crypto.randomUUID();
  return {
    id,
    name: input.brief.productName.trim() || '새 콘텐츠',
    updatedAt: new Date().toISOString(),
    brand: input.brand,
    brandId: input.activeBrandId,
    brief: input.brief,
    photos: input.photos,
    pack: input.pack,
  };
}

export function mergeWorkspaceForProject(remote: NormalizedWorkspace, _localProjects: WorkspaceProject[], project: WorkspaceProject): WorkspaceProject[] {
  const known = new Map<string, WorkspaceProject>();
  for (const item of remote.projects) known.set(item.id, item);
  known.set(project.id, project);
  return [project, ...Array.from(known.values()).filter(item => item.id !== project.id)]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function mergeWorkspaceProjects(remote: NormalizedWorkspace, _localProjects: WorkspaceProject[]): WorkspaceProject[] {
  return [...remote.projects].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function preserveVisiblePhotoUrls(stored: Photo[], visible: Photo[]): Photo[] {
  return stored.map(storedPhoto => {
    const current = visible.find(photo => photo.id === storedPhoto.id);
    return current?.dataUrl ? { ...storedPhoto, dataUrl: current.dataUrl } : storedPhoto;
  });
}

export function readLastProjectId(userId: string): string | null {
  try {
    return window.localStorage.getItem(`${LAST_PROJECT_KEY}:${userId}`);
  } catch {
    return null;
  }
}

export function writeLastProjectId(userId: string, projectId: string): void {
  try {
    window.localStorage.setItem(`${LAST_PROJECT_KEY}:${userId}`, projectId);
  } catch {
    // Losing this pointer should not block autosave.
  }
}

export function autoSaveStatusText(state: AutosaveState, error = ''): string {
  if (state === 'readonly') return '로그인하면 자동 저장돼요';
  if (state === 'saving') return '자동 저장 중...';
  if (state === 'dirty') return '수정 내용을 저장할 준비 중...';
  if (state === 'saved') return '자동 저장됨';
  if (state === 'error') return error || '자동 저장 실패';
  return '';
}
