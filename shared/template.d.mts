import type { Brand, Brief, ContentPack, Photo } from '../src/types';

export interface TemplateRequest {
  brand: Brand;
  brief: Brief;
  images: Photo[];
}

export function validateTemplateRequest(payload: unknown): TemplateRequest;
export function makeTemplatePack(request: TemplateRequest): ContentPack;
export function syncTemplateCards(request: {
  pack: ContentPack;
  brand: Brand;
  previousBrief: Brief;
  brief: Brief;
  images: Photo[];
}): ContentPack;
