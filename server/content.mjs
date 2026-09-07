import { makeTemplatePack as makeSharedTemplatePack } from '../shared/template.mjs';

const TONES = new Set(['warm', 'simple', 'playful']);
const GOALS = new Set(['new', 'daily', 'event']);
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES = 3;

export function hasOpenAIKey() {
  loadLocalEnv();
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0);
}

export function statusPayload() {
  return {
    configured: hasOpenAIKey(),
    provider: 'openai',
    mode: hasOpenAIKey() ? 'live' : 'template',
  };
}

export function loadLocalEnv() {
  if (typeof process.loadEnvFile !== 'function') return;
  for (const path of ['.env.local', '.env']) {
    try {
      process.loadEnvFile(path);
    } catch {
      // Missing local env files are expected in template mode.
    }
  }
}

export function validateRawBody(rawBody) {
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    throw httpError(413, '요청 본문은 12MB 이하여야 합니다.');
  }
}

export function parseGenerateRequest(rawBody) {
  validateRawBody(rawBody);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw httpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
  return validateGeneratePayload(payload);
}

export function validateGeneratePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw httpError(400, '요청 데이터가 올바르지 않습니다.');
  }

  const brand = payload.brand;
  const brief = payload.brief;
  const images = Array.isArray(payload.images) ? payload.images : [];

  if (!brand || typeof brand !== 'object') throw httpError(400, '브랜드 정보를 입력해 주세요.');
  if (!brief || typeof brief !== 'object') throw httpError(400, '콘텐츠 정보를 입력해 주세요.');
  if (images.length > MAX_IMAGES) throw httpError(400, '이미지는 최대 3장까지 사용할 수 있습니다.');

  const cleanBrand = {
    name: requiredText(brand.name, '브랜드 이름'),
    tagline: optionalText(brand.tagline),
    location: optionalText(brand.location),
    instagram: optionalText(brand.instagram),
    color: normalizeColor(brand.color),
  };

  const cleanBrief = {
    productName: requiredText(brief.productName, '메뉴 이름'),
    description: requiredText(brief.description, '설명'),
    price: optionalText(brief.price),
    tone: TONES.has(brief.tone) ? brief.tone : 'warm',
    goal: GOALS.has(brief.goal) ? brief.goal : 'daily',
    includeSchedule: brief.includeSchedule === true,
    scheduleStartDate: typeof brief.scheduleStartDate === 'string' ? brief.scheduleStartDate : '',
  };

  const cleanImages = images.map((image, index) => {
    if (!image || typeof image !== 'object') throw httpError(400, '이미지 데이터가 올바르지 않습니다.');
    const id = optionalText(image.id) || `image-${index + 1}`;
    const name = optionalText(image.name) || `photo-${index + 1}`;
    const dataUrl = requiredImageDataUrl(image.dataUrl);
    return { id, name, dataUrl };
  });

  return { brand: cleanBrand, brief: cleanBrief, images: cleanImages };
}

export function makeTemplatePack({ brand, brief, images }) {
  return makeSharedTemplatePack({ brand, brief, images });
}

export async function generateContentPack(payload, options = {}) {
  const request = validateGeneratePayload(payload);
  if (!hasOpenAIKey()) return makeTemplatePack(request);
  const text = await callOpenAI(request, options);
  const pack = parseProviderOutput(text);
  assertPackShape(pack, request.brief.includeSchedule);
  return { ...pack, source: 'ai' };
}

export async function callOpenAI({ brand, brief, images }, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 25000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const model = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
  const scheduleCount = brief.includeSchedule ? 3 : 0;
  const content = [
    {
      type: 'input_text',
      text: [
        '카페 운영자를 위한 인스타그램 콘텐츠 팩을 한국어로 생성하세요.',
        '사용자가 입력한 사실만 사용하고, 할인/효능/리뷰/수상 이력은 만들지 마세요.',
        `반드시 JSON만 반환하세요. cards는 정확히 3개입니다. schedule은 includeSchedule이 true면 홍보 일정 3개, false면 빈 배열 0개입니다. 일정은 자동게시가 아닌 게시계획 제안입니다.${brief.scheduleStartDate ? ' scheduleStartDate 이후 날짜를 YYYY-MM-DD 형식 date로 넣으세요.' : ''}`,
        JSON.stringify({ brand: redactImageData({ brand, brief, images }) }),
      ].join('\n'),
    },
    ...images.slice(0, MAX_IMAGES).map((image) => ({
      type: 'input_image',
      image_url: image.dataUrl,
      detail: 'auto',
    })),
  ];

  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        input: [{ role: 'user', content }],
        text: {
          format: {
            type: 'json_schema',
            name: 'moa_content_pack',
            strict: true,
            schema: createContentPackSchema(scheduleCount),
          },
        },
      }),
    });
    if (!response.ok) {
      throw httpError(502, `OpenAI 요청이 실패했습니다. status=${response.status}`);
    }
    const data = await response.json();
    return extractOutputText(data);
  } catch (error) {
    if (error.name === 'AbortError') throw httpError(504, 'OpenAI 요청 시간이 초과되었습니다.');
    if (error.statusCode) throw error;
    throw httpError(502, 'OpenAI 응답을 처리하지 못했습니다.');
  } finally {
    clearTimeout(timer);
  }
}

export function parseProviderOutput(text) {
  const raw = String(text ?? '').trim();
  const jsonText = raw.startsWith('```') ? raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '') : raw;
  try {
    return JSON.parse(jsonText);
  } catch {
    throw httpError(502, 'OpenAI가 올바른 JSON을 반환하지 않았습니다.');
  }
}

export function extractOutputText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const chunks = [];
  for (const item of data?.output ?? []) {
    for (const content of item.content ?? []) {
      if (typeof content.text === 'string') chunks.push(content.text);
    }
  }
  if (!chunks.length) throw httpError(502, 'OpenAI 응답에 텍스트가 없습니다.');
  return chunks.join('\n');
}

function assertPackShape(pack, includeSchedule = false) {
  if (!pack || typeof pack !== 'object') throw httpError(502, 'OpenAI 응답 구조가 올바르지 않습니다.');
  if (!Array.isArray(pack.cards) || pack.cards.length !== 3) throw httpError(502, '카드뉴스는 정확히 3개여야 합니다.');
  const scheduleCount = includeSchedule ? 3 : 0;
  if (!Array.isArray(pack.schedule) || pack.schedule.length !== scheduleCount) {
    throw httpError(502, includeSchedule ? '홍보 일정은 정확히 3개여야 합니다.' : '홍보 일정은 선택하지 않았을 때 비어 있어야 합니다.');
  }
  if (typeof pack.caption !== 'string') throw httpError(502, '게시글 문구가 없습니다.');
  if (!Array.isArray(pack.hashtags)) throw httpError(502, '해시태그 배열이 없습니다.');
}

function requiredText(value, label) {
  const text = optionalText(value);
  if (!text) throw httpError(400, `${label}을 입력해 주세요.`);
  return text;
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function requiredImageDataUrl(value) {
  const dataUrl = typeof value === 'string' ? value.trim() : '';
  if (!dataUrl) throw httpError(400, '이미지를 입력해 주세요.');
  if (Buffer.byteLength(dataUrl, 'utf8') > MAX_BODY_BYTES) {
    throw httpError(413, '이미지는 12MB 이하여야 합니다.');
  }
  if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(dataUrl)) {
    throw httpError(400, '이미지는 PNG, JPG, WEBP data URL만 사용할 수 있습니다.');
  }
  return dataUrl;
}

function normalizeColor(value) {
  const text = optionalText(value);
  return /^#[0-9a-f]{6}$/i.test(text) ? text : '#254a3b';
}

function redactImageData(payload) {
  return {
    ...payload,
    images: payload.images.map((image) => ({ id: image.id, name: image.name })),
  };
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

const cardSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'title', 'subtitle', 'eyebrow', 'body', 'imageId', 'layout'],
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    subtitle: { type: 'string' },
    eyebrow: { type: 'string' },
    body: { type: 'string' },
    imageId: { type: 'string' },
    layout: { type: 'string', enum: ['editorial', 'minimal', 'bold', 'split', 'poster', 'menu'] },
  },
};

const scheduleSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['day', 'title', 'format', 'description'],
  properties: {
    day: { type: 'string' },
    date: { type: 'string' },
    title: { type: 'string' },
    format: { type: 'string' },
    description: { type: 'string' },
  },
};

function createContentPackSchema(scheduleCount) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['source', 'cards', 'caption', 'hashtags', 'schedule'],
    properties: {
      source: { type: 'string', enum: ['ai'] },
      cards: { type: 'array', minItems: 3, maxItems: 3, items: cardSchema },
      caption: { type: 'string' },
      hashtags: { type: 'array', items: { type: 'string' } },
      schedule: { type: 'array', minItems: scheduleCount, maxItems: scheduleCount, items: scheduleSchema },
    },
  };
}
