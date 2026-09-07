import type { Photo } from '../types';

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_EDGE = 1600;
const PHOTO_EDIT_MAX_EDGE = 1024;
const OUTPUT_QUALITY = 0.85;
const PHOTO_EDIT_OUTPUT_QUALITY = 0.9;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function sanitizeError(message: string): Error {
  return new Error(message.replace(/[<>]/g, ''));
}

function stripExtension(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function createPhotoId(name: string, index: number): string {
  const safeName = stripExtension(name)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${safeName || 'photo'}-${Date.now().toString(36)}-${index.toString(36)}`;
}

function loadImageFromFile(file: File): Promise<HTMLImageElement> {
  return loadImageFromUrl(URL.createObjectURL(file), `${file.name} 사진을 읽지 못했어요.`, true);
}

function loadImageFromUrl(src: string, errorMessage: string, revoke = false): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (shouldLoadWithAnonymousCors(src)) image.crossOrigin = 'anonymous';
    image.onload = () => {
      if (revoke) URL.revokeObjectURL(src);
      resolve(image);
    };
    image.onerror = () => {
      if (revoke) URL.revokeObjectURL(src);
      reject(sanitizeError(errorMessage));
    };
    image.src = src;
  });
}

function canvasToDataUrl(canvas: HTMLCanvasElement, quality = OUTPUT_QUALITY): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            reject(sanitizeError('사진을 저장용 이미지로 변환하지 못했어요.'));
            return;
          }

          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(sanitizeError('변환된 사진을 읽지 못했어요.'));
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        quality,
      );
    } catch {
      reject(sanitizeError('사진을 저장용 이미지로 변환하지 못했어요.'));
    }
  });
}

function shouldLoadWithAnonymousCors(src: string): boolean {
  if (/^(data|blob):/i.test(src)) return false;

  try {
    const appOrigin = window.location.origin;
    const url = new URL(src, appOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.origin !== appOrigin;
  } catch {
    return false;
  }
}

function targetSize(width: number, height: number, maxEdge = MAX_EDGE): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };

  const scale = maxEdge / longest;
  return {
    width: Math.round(width * scale),
    height: Math.round(height * scale),
  };
}

async function preparePhoto(file: File, index: number): Promise<Photo> {
  if (!ACCEPTED_TYPES.has(file.type)) {
    throw sanitizeError(`${file.name}은 JPG, PNG, WEBP 형식만 사용할 수 있어요.`);
  }

  if (file.size > MAX_FILE_SIZE) {
    throw sanitizeError(`${file.name}은 10MB보다 작아야 해요.`);
  }

  const image = await loadImageFromFile(file);
  const size = targetSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (!context) throw sanitizeError('이미지 편집 환경을 준비하지 못했어요.');

  context.fillStyle = '#f7f2e8';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);

  return {
    id: createPhotoId(file.name, index),
    name: stripExtension(file.name) || file.name,
    dataUrl: await canvasToDataUrl(canvas),
  };
}

export async function preparePhotos(files: File[]): Promise<Photo[]> {
  return Promise.all(files.map(preparePhoto));
}

export async function preparePhotoForEdit(photo: Photo): Promise<Photo> {
  const image = await loadImageFromUrl(photo.dataUrl, '사진 편집용 이미지를 준비하지 못했어요.');
  const size = targetSize(image.naturalWidth, image.naturalHeight, PHOTO_EDIT_MAX_EDGE);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;

  const context = canvas.getContext('2d');
  if (!context) throw sanitizeError('이미지 편집 환경을 준비하지 못했어요.');

  context.fillStyle = '#f7f2e8';
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.width, size.height);

  return {
    ...photo,
    dataUrl: await canvasToDataUrl(canvas, PHOTO_EDIT_OUTPUT_QUALITY),
  };
}
