import type { Brand, CardLayout, ContentCard, Photo } from '../types';

export const CONTENT_LIMITS = {
  cards: { min: 1, max: 10 },
  captionLength: 5000,
  hashtags: 30,
  schedule: 30,
} as const;

export const CARD_LIMITS = CONTENT_LIMITS.cards;

export const cardLayouts: Array<{ value: CardLayout; label: string; description: string }> = [
  { value: 'editorial', label: '사진 중심', description: '전체 사진 위에 문구를 얹는 감성형' },
  { value: 'minimal', label: '여백형', description: '넓은 여백과 하단 사진으로 정돈된 소개' },
  { value: 'bold', label: '강조형', description: '진한 브랜드 컬러와 큰 제목 중심' },
  { value: 'split', label: '분할형', description: '사진과 텍스트를 좌우로 나누는 메뉴 소개' },
  { value: 'poster', label: '포스터형', description: '행사나 신메뉴 고지에 어울리는 포스터' },
  { value: 'menu', label: '메뉴판형', description: '가격과 설명을 읽기 좋게 정리하는 메뉴판' },
];

export function nextLayout(index: number): CardLayout {
  return cardLayouts[index % cardLayouts.length].value;
}

export function createCardTemplate(index: number, photos: Photo[], brand: Brand, layout = nextLayout(index)): ContentCard {
  const photo = photos[index % Math.max(photos.length, 1)];
  const number = String(index + 1).padStart(2, '0');
  const title = layout === 'menu'
    ? '오늘의 메뉴'
    : layout === 'poster'
      ? '이번 주 추천'
      : layout === 'split'
        ? '한 잔의 이유'
        : '우리 카페의 이야기';

  return {
    id: crypto.randomUUID(),
    title,
    subtitle: brand.tagline || brand.name,
    eyebrow: `CARD ${number}`,
    body: layout === 'menu' ? '메뉴 특징과 가격, 추천 포인트를 직접 적어 보세요.' : '사진에 맞춰 소개 문장을 직접 적어 보세요.',
    imageId: photo?.id ?? '',
    layout,
  };
}

export function normalizeHashtags(value: string): string[] {
  return value
    .split(/[\s,]+/)
    .map((tag) => tag.trim())
    .filter(Boolean)
    .map((tag) => tag.startsWith('#') ? tag : `#${tag}`)
    .map((tag) => tag.slice(0, 60))
    .filter((tag, index, list) => list.indexOf(tag) === index)
    .slice(0, CONTENT_LIMITS.hashtags);
}
