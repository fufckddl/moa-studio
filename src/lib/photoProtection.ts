import type { Photo } from '../types';

export interface ProtectedRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PixelRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PHOTO_PROTECTION_MAX_PNG_BYTES = 5 * 1024 * 1024;

function sanitizeError(message: string): Error {
  return new Error(message.replace(/[<>]/g, ''));
}

function shouldLoadWithAnonymousCors(src: string): boolean {
  if (/^(data|blob):/i.test(src)) return false;

  try {
    const appOrigin = typeof window === 'undefined' ? undefined : window.location.origin;
    const url = new URL(src, appOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return Boolean(appOrigin && url.origin !== appOrigin);
  } catch {
    return false;
  }
}

function loadImageFromUrl(src: string, errorMessage: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    if (shouldLoadWithAnonymousCors(src)) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(sanitizeError(errorMessage));
    image.src = src;
  });
}

export function clampProtectedRegion(region: ProtectedRegion): ProtectedRegion {
  const values = [region.x, region.y, region.width, region.height];
  if (!values.every(Number.isFinite)) {
    throw sanitizeError('보호할 영역 좌표가 올바르지 않아요.');
  }

  if (region.width <= 0 || region.height <= 0) {
    throw sanitizeError('보호할 영역은 너비와 높이가 필요해요.');
  }

  if (region.x < 0 || region.y < 0 || region.x >= 1 || region.y >= 1) {
    throw sanitizeError('보호할 영역은 사진 안에 있어야 해요.');
  }

  const right = Math.min(1, region.x + region.width);
  const bottom = Math.min(1, region.y + region.height);
  if (right <= region.x || bottom <= region.y) {
    throw sanitizeError('보호할 영역은 사진 안에 있어야 해요.');
  }

  return {
    x: region.x,
    y: region.y,
    width: right - region.x,
    height: bottom - region.y,
  };
}

export function normalizedRegionToPixels(region: ProtectedRegion, imageWidth: number, imageHeight: number): PixelRegion {
  if (!Number.isInteger(imageWidth) || !Number.isInteger(imageHeight) || imageWidth <= 0 || imageHeight <= 0) {
    throw sanitizeError('사진 크기를 확인하지 못했어요.');
  }

  const clamped = clampProtectedRegion(region);
  const x = Math.floor(clamped.x * imageWidth);
  const y = Math.floor(clamped.y * imageHeight);
  const right = Math.ceil((clamped.x + clamped.width) * imageWidth);
  const bottom = Math.ceil((clamped.y + clamped.height) * imageHeight);
  const width = Math.min(imageWidth, right) - x;
  const height = Math.min(imageHeight, bottom) - y;

  if (width <= 0 || height <= 0) {
    throw sanitizeError('보호할 영역이 너무 작아요.');
  }

  return { x, y, width, height };
}

export function featherRadiusForSize(imageWidth: number, imageHeight: number): number {
  return Math.max(2, Math.min(16, Math.round(Math.max(imageWidth, imageHeight) * 0.01)));
}

export function expandPixelRegion(region: PixelRegion, imageWidth: number, imageHeight: number, radius: number): PixelRegion {
  const x = Math.max(0, region.x - radius);
  const y = Math.max(0, region.y - radius);
  const right = Math.min(imageWidth, region.x + region.width + radius);
  const bottom = Math.min(imageHeight, region.y + region.height + radius);
  return { x, y, width: right - x, height: bottom - y };
}

export function blendFeatherOutsideRegion(
  generatedPixels: ImageData,
  sourcePixels: ImageData,
  region: PixelRegion,
  imageWidth: number,
  radius: number,
): ImageData {
  if (radius <= 0) return generatedPixels;

  const imageHeight = Math.round(generatedPixels.data.length / 4 / imageWidth);
  const right = region.x + region.width;
  const bottom = region.y + region.height;

  for (let y = 0; y < imageHeight; y += 1) {
    for (let x = 0; x < imageWidth; x += 1) {
      const globalX = x + 0.5;
      const globalY = y + 0.5;
      if (globalX >= region.x && globalX < right && globalY >= region.y && globalY < bottom) {
        continue;
      }

      const dx = Math.max(region.x - globalX, 0, globalX - right);
      const dy = Math.max(region.y - globalY, 0, globalY - bottom);
      const distance = Math.hypot(dx, dy);
      if (distance > radius) continue;

      const weight = 1 - distance / radius;
      const offset = (y * imageWidth + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        generatedPixels.data[offset + channel] = Math.round(
          generatedPixels.data[offset + channel] * (1 - weight) + sourcePixels.data[offset + channel] * weight,
        );
      }
    }
  }

  return generatedPixels;
}

export function pngDataUrlBytes(dataUrl: string): number {
  const base64Prefix = 'data:image/png;base64,';
  if (!dataUrl.startsWith(base64Prefix)) {
    throw sanitizeError('사진을 PNG로 변환하지 못했어요.');
  }

  const base64 = dataUrl.slice(base64Prefix.length);
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function canvasToPngDataUrl(canvas: HTMLCanvasElement): string {
  try {
    const dataUrl = canvas.toDataURL('image/png');
    const bytes = pngDataUrlBytes(dataUrl);
    if (bytes > PHOTO_PROTECTION_MAX_PNG_BYTES) {
      throw sanitizeError('보호된 사진이 5MB보다 커서 저장하지 못했어요. 더 작은 사진으로 다시 시도해 주세요.');
    }
    return dataUrl;
  } catch (error) {
    if (error instanceof Error && error.message.includes('5MB')) throw error;
    throw sanitizeError('사진을 PNG로 변환하지 못했어요.');
  }
}

export async function preservePhotoRegion(source: Photo, generated: Photo, region: ProtectedRegion): Promise<Photo> {
  const [sourceImage, generatedImage] = await Promise.all([
    loadImageFromUrl(source.dataUrl, '원본 사진을 읽지 못했어요.'),
    loadImageFromUrl(generated.dataUrl, '생성된 사진을 읽지 못했어요.'),
  ]);

  const width = sourceImage.naturalWidth;
  const height = sourceImage.naturalHeight;
  const pixelRegion = normalizedRegionToPixels(region, width, height);
  const outputCanvas = document.createElement('canvas');
  outputCanvas.width = width;
  outputCanvas.height = height;

  const outputContext = outputCanvas.getContext('2d');
  if (!outputContext) throw sanitizeError('사진 보호 작업을 준비하지 못했어요.');

  outputContext.drawImage(generatedImage, 0, 0, width, height);

  const sourceCanvas = document.createElement('canvas');
  sourceCanvas.width = width;
  sourceCanvas.height = height;

  const sourceContext = sourceCanvas.getContext('2d');
  if (!sourceContext) throw sanitizeError('원본 사진 보호 작업을 준비하지 못했어요.');

  sourceContext.drawImage(sourceImage, 0, 0, width, height);
  const originalPixels = sourceContext.getImageData(
    pixelRegion.x,
    pixelRegion.y,
    pixelRegion.width,
    pixelRegion.height,
  );
  const featherRadius = featherRadiusForSize(width, height);
  const featherRegion = expandPixelRegion(pixelRegion, width, height, featherRadius);
  const generatedFeatherPixels = outputContext.getImageData(
    featherRegion.x,
    featherRegion.y,
    featherRegion.width,
    featherRegion.height,
  );
  const sourceFeatherPixels = sourceContext.getImageData(
    featherRegion.x,
    featherRegion.y,
    featherRegion.width,
    featherRegion.height,
  );
  outputContext.putImageData(
    blendFeatherOutsideRegion(
      generatedFeatherPixels,
      sourceFeatherPixels,
      {
        x: pixelRegion.x - featherRegion.x,
        y: pixelRegion.y - featherRegion.y,
        width: pixelRegion.width,
        height: pixelRegion.height,
      },
      featherRegion.width,
      featherRadius,
    ),
    featherRegion.x,
    featherRegion.y,
  );
  outputContext.putImageData(originalPixels, pixelRegion.x, pixelRegion.y);

  const protectedPhoto: Photo = {
    id: generated.id,
    name: generated.name,
    dataUrl: canvasToPngDataUrl(outputCanvas),
  };

  if (generated.unavailable !== undefined) {
    protectedPhoto.unavailable = generated.unavailable;
  }

  return protectedPhoto;
}
