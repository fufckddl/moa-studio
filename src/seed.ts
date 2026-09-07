import type { Brand, Brief, ContentPack, Photo } from './types';
import { makeTemplatePack } from '../shared/template.mjs';

export const defaultBrand: Brand = {
  name: '카페 모아', tagline: '당신의 일상에 작은 쉼표',
  location: '', instagram: '@cafe_moa', color: '#254a3b',
};
export const defaultBrief: Brief = {
  productName: '시그니처 크림 라떼',
  description: '부드러운 크림과 진한 에스프레소의 조화.\n천천히 머물고 싶은 오후를 위한 한 잔.',
  price: '6,500', tone: 'warm', goal: 'new', includeSchedule: false,
};
export const samplePhotos: Photo[] = [{ id: 'sample-latte', name: '예시 · 크림 라떼', dataUrl: '/assets/cafe-latte.png' }];
export const initialPack: ContentPack = makeTemplatePack({ brand: defaultBrand, brief: defaultBrief, images: samplePhotos });
