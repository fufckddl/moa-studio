import type { Brand, ContentCard, ContentPack, Photo, ScheduleItem } from '../types';
import { supabaseUrl } from './supabase';

const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1350;
const CREAM = '#f5efe4';
const INK = '#253229';
const MUTED = '#6e6b62';
const GREEN = '#254a3b';
const DARK_GREEN = '#17342b';
const LINE = '#d6d0c3';

type CanvasContext = CanvasRenderingContext2D;

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WrappedText {
  lines: string[];
  fontSize: number;
  lineHeight: number;
}

function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || 'moa-card';
}

function get2dContext(canvas: HTMLCanvasElement): CanvasContext {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('카드 이미지를 만들 수 없어요. 브라우저 Canvas를 사용할 수 없습니다.');
  return context;
}

function font(size: number, weight = 600, serif = false): string {
  const family = serif
    ? '"Noto Serif KR", "Apple SD Gothic Neo", "Malgun Gothic", serif'
    : '"Noto Sans KR", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif';
  return `${weight} ${size}px ${family}`;
}

function validColor(value: string | undefined, fallback: string): string {
  return value && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function fontScale(card: ContentCard): number {
  const scale = card.style?.fontScale ?? 1;
  return Math.min(1.2, Math.max(0.85, Number.isFinite(scale) ? scale : 1));
}

function scaled(card: ContentCard, size: number): number {
  return Math.round(size * fontScale(card));
}

function textX(card: ContentCard, box: Box): number {
  if (card.style?.align === 'center') return box.x + box.width / 2;
  if (card.style?.align === 'right') return box.x + box.width;
  return box.x;
}

function applyTextAlign(context: CanvasContext, card: ContentCard): void {
  context.textAlign = card.style?.align ?? 'left';
}

function drawRoundRect(context: CanvasContext, box: Box, radius: number): void {
  context.beginPath();
  context.roundRect(box.x, box.y, box.width, box.height, radius);
  context.closePath();
}

function wrapText(
  context: CanvasContext,
  text: string,
  maxWidth: number,
  maxLines: number,
  startingSize: number,
  minSize: number,
  weight = 700,
  serif = true,
): WrappedText {
  for (let size = startingSize; size >= minSize; size -= 2) {
    context.font = font(size, weight, serif);
    const lines = text
      .split('\n')
      .flatMap((paragraph) => wrapParagraph(context, paragraph, maxWidth));
    const lineHeight = Math.round(size * 1.22);

    if (lines.length <= maxLines) {
      return { lines, fontSize: size, lineHeight };
    }
  }

  context.font = font(minSize, weight, serif);
  const lines = text
    .split('\n')
    .flatMap((paragraph) => wrapParagraph(context, paragraph, maxWidth))
    .slice(0, maxLines);
  const lastLine = lines[lines.length - 1];
  if (lastLine) lines[lines.length - 1] = ellipsize(context, lastLine, maxWidth);

  return { lines, fontSize: minSize, lineHeight: Math.round(minSize * 1.22) };
}

function wrapParagraph(context: CanvasContext, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];

  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
      continue;
    }

    if (line) lines.push(line);
    if (context.measureText(word).width <= maxWidth) {
      line = word;
    } else {
      const split = splitLongWord(context, word, maxWidth);
      lines.push(...split.slice(0, -1));
      line = split[split.length - 1] ?? '';
    }
  }

  if (line) lines.push(line);
  return lines;
}

function splitLongWord(context: CanvasContext, word: string, maxWidth: number): string[] {
  const pieces: string[] = [];
  let line = '';
  for (const char of Array.from(word)) {
    const candidate = `${line}${char}`;
    if (context.measureText(candidate).width <= maxWidth) {
      line = candidate;
    } else {
      if (line) pieces.push(line);
      line = char;
    }
  }
  if (line) pieces.push(line);
  return pieces;
}

function ellipsize(context: CanvasContext, text: string, maxWidth: number): string {
  let result = text;
  while (result.length > 0 && context.measureText(`${result}...`).width > maxWidth) {
    result = result.slice(0, -1);
  }
  return result ? `${result}...` : '...';
}

function drawWrapped(context: CanvasContext, wrapped: WrappedText, x: number, y: number): void {
  wrapped.lines.forEach((line, index) => {
    context.fillText(line, x, y + index * wrapped.lineHeight);
  });
}

function drawTextBlock(
  context: CanvasContext,
  text: string,
  maxWidth: number,
  maxLines: number,
  startingSize: number,
  minSize: number,
  weight: number,
  serif: boolean,
  x: number,
  y: number,
): number {
  const wrapped = wrapText(context, text, maxWidth, maxLines, startingSize, minSize, weight, serif);
  context.font = font(wrapped.fontSize, weight, serif);
  drawWrapped(context, wrapped, x, y);
  return wrapped.lines.length * wrapped.lineHeight;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const configuredOrigin = supabaseUrl;
    let cloudPhoto = false;
    try {
      const url = new URL(src, window.location.origin);
      cloudPhoto = !!configuredOrigin && url.origin === new URL(configuredOrigin).origin && url.pathname.startsWith('/storage/v1/object/sign/moa-photos/');
    } catch { /* Invalid URLs are rejected below. */ }
    if (!src.startsWith('data:') && !src.startsWith('/') && !src.startsWith('./') && !cloudPhoto) {
      reject(new Error('보관함 또는 업로드한 사진만 카드로 내보낼 수 있어요.'));
      return;
    }

    const image = new Image();
    if (cloudPhoto) image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('카드에 사용할 사진을 불러오지 못했어요.'));
    image.src = src;
  });
}

function drawCoverImage(context: CanvasContext, image: HTMLImageElement, box: Box): void {
  const scale = Math.max(box.width / image.naturalWidth, box.height / image.naturalHeight);
  const width = image.naturalWidth * scale;
  const height = image.naturalHeight * scale;
  const x = box.x + (box.width - width) / 2;
  const y = box.y + (box.height - height) / 2;
  context.drawImage(image, x, y, width, height);
}

function drawPhoto(context: CanvasContext, image: HTMLImageElement | undefined, box: Box, radius = 0): void {
  context.save();
  drawRoundRect(context, box, radius);
  context.clip();

  if (image) {
    drawCoverImage(context, image, box);
  } else {
    context.fillStyle = '#d9d0c0';
    context.fillRect(box.x, box.y, box.width, box.height);
    context.fillStyle = '#756c5f';
    context.font = font(42, 600);
    context.textAlign = 'center';
    context.fillText('사진을 추가해 주세요', box.x + box.width / 2, box.y + box.height / 2);
  }
  context.restore();
}

function drawEditorial(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  drawPhoto(context, image, { x: 0, y: 0, width: CARD_WIDTH, height: CARD_HEIGHT });

  const shade = context.createLinearGradient(0, 0, 0, CARD_HEIGHT);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.46)');
  shade.addColorStop(0.45, 'rgba(0, 0, 0, 0.06)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.58)');
  context.fillStyle = shade;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = validColor(card.style?.textColor, CREAM);
  context.textBaseline = 'top';
  applyTextAlign(context, card);

  const textBox = { x: 96, y: 0, width: 800, height: 0 };
  drawTextBlock(context, card.eyebrow, 800, 1, scaled(card, 28), scaled(card, 20), 700, false, textX(card, textBox), 82);
  const title = wrapText(context, card.title, 800, 3, scaled(card, 84), scaled(card, 52), 600, true);
  context.font = font(title.fontSize, 600, true);
  drawWrapped(context, title, textX(card, textBox), 150);

  const subtitleY = 150 + title.lines.length * title.lineHeight + 40;
  const subtitleHeight = drawTextBlock(context, card.subtitle, 760, 2, scaled(card, 34), scaled(card, 24), 400, false, textX(card, { x: 100, y: 0, width: 760, height: 0 }), subtitleY);
  if (card.body) {
    drawTextBlock(context, card.body, 800, 5, scaled(card, 30), scaled(card, 22), 500, false, textX(card, textBox), subtitleY + subtitleHeight + 34);
  }

  context.textAlign = 'left';
  drawTextBlock(context, brand.name, 600, 1, 31, 22, 700, false, 92, 1130);
  drawTextBlock(context, brand.instagram || brand.tagline, 600, 1, 29, 20, 500, false, 92, 1174);
}

function drawMinimal(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  context.fillStyle = validColor(card.style?.backgroundColor, CREAM);
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = GREEN;
  applyTextAlign(context, card);
  context.textBaseline = 'top';
  drawTextBlock(context, card.eyebrow, 780, 1, scaled(card, 32), scaled(card, 22), 700, false, textX(card, { x: 84, y: 0, width: 780, height: 0 }), 82);

  context.fillStyle = validColor(card.style?.textColor, INK);
  const title = wrapText(context, card.title, 780, 3, scaled(card, 76), scaled(card, 50), 700, true);
  context.font = font(title.fontSize, 700, true);
  drawWrapped(context, title, textX(card, { x: 84, y: 0, width: 780, height: 0 }), 150);

  context.fillStyle = MUTED;
  drawTextBlock(context, card.subtitle, 780, 2, scaled(card, 31), scaled(card, 22), 500, false, textX(card, { x: 84, y: 0, width: 780, height: 0 }), 150 + title.lines.length * title.lineHeight + 36);

  if (card.body) {
    const body = wrapText(context, card.body, 840, 4, scaled(card, 34), scaled(card, 28), 400, false);
    context.font = font(body.fontSize, 400);
    context.fillStyle = '#4b5148';
    drawWrapped(context, body, textX(card, { x: 84, y: 0, width: 840, height: 0 }), 470);
  }

  drawPhoto(context, image, { x: 84, y: 720, width: 912, height: 520 }, 20);

  context.fillStyle = GREEN;
  context.textAlign = 'left';
  drawTextBlock(context, brand.name, 430, 1, 28, 20, 700, false, 84, 1262);
  context.fillStyle = MUTED;
  context.textAlign = 'right';
  drawTextBlock(context, brand.instagram || brand.location || brand.tagline, 430, 1, 24, 18, 500, false, 996, 1266);
}

function drawBold(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  context.fillStyle = validColor(card.style?.backgroundColor, brand.color || GREEN);
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = validColor(card.style?.textColor, CREAM);
  applyTextAlign(context, card);
  context.textBaseline = 'top';
  drawTextBlock(context, card.eyebrow, 870, 1, scaled(card, 31), scaled(card, 22), 700, false, textX(card, { x: 84, y: 0, width: 870, height: 0 }), 74);

  const title = wrapText(context, card.title, 870, 3, scaled(card, 86), scaled(card, 54), 800, true);
  context.font = font(title.fontSize, 800, true);
  drawWrapped(context, title, textX(card, { x: 84, y: 0, width: 870, height: 0 }), 146);

  drawTextBlock(context, card.subtitle, 830, 2, scaled(card, 32), scaled(card, 22), 500, false, textX(card, { x: 88, y: 0, width: 830, height: 0 }), 146 + title.lines.length * title.lineHeight + 36);

  if (card.body) {
    const body = wrapText(context, card.body, 840, 2, scaled(card, 32), scaled(card, 26), 500, false);
    context.font = font(body.fontSize, 500);
    drawWrapped(context, body, textX(card, { x: 88, y: 0, width: 840, height: 0 }), 500);
  }

  context.fillStyle = DARK_GREEN;
  context.fillRect(0, 646, CARD_WIDTH, 704);
  drawPhoto(context, image, { x: 76, y: 696, width: 928, height: 540 }, 18);

  context.fillStyle = CREAM;
  context.textAlign = 'left';
  drawTextBlock(context, brand.name, 430, 1, 29, 20, 700, false, 84, 1264);
  context.textAlign = 'right';
  drawTextBlock(context, brand.instagram || brand.location || brand.tagline, 430, 1, 24, 18, 500, false, 996, 1268);
}

function drawSplit(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  const background = validColor(card.style?.backgroundColor, '#f2eadc');
  const textColor = validColor(card.style?.textColor, INK);
  context.fillStyle = background;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  drawPhoto(context, image, { x: 0, y: 0, width: 500, height: CARD_HEIGHT });
  context.fillStyle = 'rgba(23, 52, 43, 0.1)';
  context.fillRect(500, 0, 1, CARD_HEIGHT);

  context.textBaseline = 'top';
  applyTextAlign(context, card);
  const box = { x: 588, y: 0, width: 370, height: 0 };

  context.fillStyle = GREEN;
  drawTextBlock(context, card.eyebrow, box.width, 1, scaled(card, 28), scaled(card, 20), 700, false, textX(card, box), 120);

  context.fillStyle = textColor;
  const title = wrapText(context, card.title, box.width, 4, scaled(card, 68), scaled(card, 42), 760, true);
  context.font = font(title.fontSize, 760, true);
  drawWrapped(context, title, textX(card, box), 210);

  context.fillStyle = '#4d574d';
  drawTextBlock(context, card.subtitle, box.width, 3, scaled(card, 31), scaled(card, 22), 500, false, textX(card, box), 210 + title.lines.length * title.lineHeight + 42);

  if (card.body) {
    context.fillStyle = textColor;
    drawTextBlock(context, card.body, box.width, 6, scaled(card, 29), scaled(card, 22), 400, false, textX(card, box), 640);
  }

  context.textAlign = 'left';
  context.fillStyle = GREEN;
  drawTextBlock(context, brand.name, 360, 1, 27, 19, 700, false, 588, 1180);
  context.fillStyle = MUTED;
  drawTextBlock(context, brand.instagram || brand.location || brand.tagline, 360, 1, 23, 17, 500, false, 588, 1222);
}

function drawPoster(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  const background = validColor(card.style?.backgroundColor, brand.color || GREEN);
  const textColor = validColor(card.style?.textColor, CREAM);
  context.fillStyle = background;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.fillStyle = 'rgba(245, 239, 228, 0.12)';
  context.fillRect(58, 58, CARD_WIDTH - 116, CARD_HEIGHT - 116);
  drawPhoto(context, image, { x: 120, y: 590, width: 840, height: 520 }, 0);

  const shade = context.createLinearGradient(0, 560, 0, 1110);
  shade.addColorStop(0, 'rgba(0, 0, 0, 0.1)');
  shade.addColorStop(1, 'rgba(0, 0, 0, 0.34)');
  context.fillStyle = shade;
  context.fillRect(120, 590, 840, 520);

  context.textBaseline = 'top';
  applyTextAlign(context, card);
  const box = { x: 116, y: 0, width: 848, height: 0 };
  context.fillStyle = textColor;
  drawTextBlock(context, card.eyebrow, box.width, 1, scaled(card, 30), scaled(card, 22), 800, false, textX(card, box), 112);

  const title = wrapText(context, card.title, box.width, 3, scaled(card, 92), scaled(card, 56), 820, true);
  context.font = font(title.fontSize, 820, true);
  drawWrapped(context, title, textX(card, box), 184);

  drawTextBlock(context, card.subtitle, box.width, 2, scaled(card, 34), scaled(card, 24), 600, false, textX(card, box), 184 + title.lines.length * title.lineHeight + 32);

  context.textAlign = 'left';
  context.fillStyle = CREAM;
  drawTextBlock(context, card.body || brand.tagline, 760, 3, 30, 22, 500, false, 148, 1164);
  context.textAlign = 'right';
  drawTextBlock(context, brand.instagram || brand.location || brand.name, 380, 1, 25, 18, 700, false, 932, 1244);
}

function drawMenu(context: CanvasContext, card: ContentCard, image: HTMLImageElement | undefined, brand: Brand): void {
  const background = validColor(card.style?.backgroundColor, '#fbf7ef');
  const textColor = validColor(card.style?.textColor, INK);
  context.fillStyle = background;
  context.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  context.strokeStyle = LINE;
  context.lineWidth = 2;
  context.strokeRect(72, 72, CARD_WIDTH - 144, CARD_HEIGHT - 144);

  context.textBaseline = 'top';
  applyTextAlign(context, card);
  const box = { x: 124, y: 0, width: 832, height: 0 };

  context.fillStyle = GREEN;
  drawTextBlock(context, card.eyebrow || 'MENU', box.width, 1, scaled(card, 29), scaled(card, 21), 800, false, textX(card, box), 124);

  context.fillStyle = textColor;
  const title = wrapText(context, card.title, box.width, 3, scaled(card, 78), scaled(card, 48), 760, true);
  context.font = font(title.fontSize, 760, true);
  drawWrapped(context, title, textX(card, box), 202);

  context.strokeStyle = GREEN;
  context.beginPath();
  context.moveTo(124, 472);
  context.lineTo(956, 472);
  context.stroke();

  context.fillStyle = textColor;
  const menuTextBox = { x: 124, y: 0, width: 520, height: 0 };
  drawTextBlock(context, card.subtitle, menuTextBox.width, 2, scaled(card, 38), scaled(card, 26), 700, false, textX(card, menuTextBox), 528);
  context.fillStyle = MUTED;
  drawTextBlock(context, card.body, menuTextBox.width, 6, scaled(card, 29), scaled(card, 21), 400, false, textX(card, menuTextBox), 640);

  drawPhoto(context, image, { x: 684, y: 536, width: 272, height: 392 }, 136);

  context.textAlign = 'left';
  context.fillStyle = GREEN;
  drawTextBlock(context, brand.name, 360, 1, 28, 20, 800, false, 124, 1138);
  context.fillStyle = MUTED;
  drawTextBlock(context, brand.instagram || brand.location || brand.tagline, 360, 1, 23, 17, 500, false, 124, 1184);
}

export async function renderCard(
  canvas: HTMLCanvasElement,
  card: ContentCard,
  photo: Photo | undefined,
  brand: Brand,
): Promise<void> {
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  await document.fonts.ready;

  const context = get2dContext(canvas);
  const image = photo ? await loadImage(photo.dataUrl) : undefined;

  if (card.layout === 'minimal') drawMinimal(context, card, image, brand);
  else if (card.layout === 'bold') drawBold(context, card, image, brand);
  else if (card.layout === 'split') drawSplit(context, card, image, brand);
  else if (card.layout === 'poster') drawPoster(context, card, image, brand);
  else if (card.layout === 'menu') drawMenu(context, card, image, brand);
  else drawEditorial(context, card, image, brand);
}

function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png'): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 파일을 만들지 못했어요.'));
    }, type);
  });
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function downloadText(text: string, filename: string): void {
  downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), filename);
}

export async function downloadCard(
  card: ContentCard,
  photo: Photo | undefined,
  brand: Brand,
  index: number,
): Promise<void> {
  const canvas = document.createElement('canvas');
  await renderCard(canvas, card, photo, brand);
  const blob = await canvasToBlob(canvas);
  downloadBlob(blob, `${String(index + 1).padStart(2, '0')}-${sanitizeFilename(card.title)}.png`);
}

function encodeText(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff];
}

function uint32(value: number): number[] {
  return [value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff];
}

function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function createZip(files: Array<{ name: string; data: Uint8Array }>): Blob {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;
  const now = dosDateTime(new Date());

  for (const file of files) {
    const name = encodeText(file.name);
    const checksum = crc32(file.data);
    const localHeader = new Uint8Array([
      ...uint32(0x04034b50),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(now.time),
      ...uint16(now.date),
      ...uint32(checksum),
      ...uint32(file.data.length),
      ...uint32(file.data.length),
      ...uint16(name.length),
      ...uint16(0),
    ]);
    localParts.push(localHeader, name, file.data);

    const centralHeader = new Uint8Array([
      ...uint32(0x02014b50),
      ...uint16(20),
      ...uint16(20),
      ...uint16(0x0800),
      ...uint16(0),
      ...uint16(now.time),
      ...uint16(now.date),
      ...uint32(checksum),
      ...uint32(file.data.length),
      ...uint32(file.data.length),
      ...uint16(name.length),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint16(0),
      ...uint32(0),
      ...uint32(offset),
    ]);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + file.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array([
    ...uint32(0x06054b50),
    ...uint16(0),
    ...uint16(0),
    ...uint16(files.length),
    ...uint16(files.length),
    ...uint32(centralSize),
    ...uint32(offset),
    ...uint16(0),
  ]);

  return new Blob([concatBytes([...localParts, ...centralParts, end])], { type: 'application/zip' });
}

function concatBytes(parts: Uint8Array[]): ArrayBuffer {
  const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;

  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }

  return bytes.buffer;
}

function captionText(pack: ContentPack): string {
  return `${pack.caption.trim()}\n\n${pack.hashtags.join(' ')}`.trim();
}

function scheduleText(schedule: ScheduleItem[]): string {
  return schedule
    .map((item) => `${[item.date, item.day].filter(Boolean).join(' · ')}${item.date || item.day ? ' · ' : ''}${item.title}\n${item.format}\n${item.description}`)
    .join('\n\n');
}

function findCardPhoto(card: ContentCard, photos: Photo[]): Photo | undefined {
  return photos.find((photo) => photo.id === card.imageId) ?? photos[0];
}

export async function downloadPack(pack: ContentPack, photos: Photo[], brand: Brand): Promise<void> {
  const files: Array<{ name: string; data: Uint8Array }> = [];

  for (const [index, card] of pack.cards.entries()) {
    const canvas = document.createElement('canvas');
    await renderCard(canvas, card, findCardPhoto(card, photos), brand);
    const blob = await canvasToBlob(canvas);
    files.push({
      name: `cards/${String(index + 1).padStart(2, '0')}-${sanitizeFilename(card.title)}.png`,
      data: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  files.push(
    { name: 'caption.txt', data: encodeText(captionText(pack)) },
    { name: 'schedule.txt', data: encodeText(scheduleText(pack.schedule)) },
  );

  downloadBlob(createZip(files), `${sanitizeFilename(brand.name)}-content-pack.zip`);
}
