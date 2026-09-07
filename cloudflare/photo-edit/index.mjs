import { FREE_TRIAL_LIMIT, initializeQuota, reserveQuota, finishQuota, readQuota } from './quota.mjs';
import { parseReferences } from './references.mjs';
import { readVerifiedEntitlement } from './entitlement.mjs';
import { OPENAI_IMAGE_EDIT_MODEL, OPENAI_IMAGE_EDIT_QUALITY, OPENAI_IMAGE_EDIT_SIZE, OpenAIEditError, generateOpenAIEdit } from './openai.mjs';
import { PersonGenerationError, generateOpenAIPerson, parsePersonGenerationPayload } from './person-generation.mjs';
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_DATA_URL_LENGTH = 3000000;
const MAX_IMAGE_EDGE = 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PhotoQuota {
  constructor(ctx) { this.sql = ctx.storage.sql; initializeQuota(this.sql); }
  async fetch(request) {
    const value = await request.json();
    if (new URL(request.url).pathname === '/finish') {
      finishQuota(this.sql, value.requestId, value.succeeded === true);
      return Response.json({ ok: true });
    }
    if (new URL(request.url).pathname === '/usage') return Response.json(readQuota(this.sql, value.userId, value.entitlement));
    const result = reserveQuota(this.sql, value.userId, value.requestId, new Date(), value.entitlement);
    return Response.json(result, { status: result.status });
  }
}

export default { fetch: handleRequest };
export async function handleRequest(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = origin === env.APP_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1):(5173|4173)$/.test(origin || '');
  const headers = { 'Cache-Control': 'no-store', 'Vary': 'Origin', 'X-Content-Type-Options': 'nosniff' };
  if (allowed) Object.assign(headers, { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type, apikey', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  const json = (status, body) => Response.json(body, { status, headers });
  if (origin && !allowed) return json(403, { error: '허용되지 않은 접속입니다.' });
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const path = new URL(request.url).pathname;
  const ready = env.PHOTO_EDIT_ENABLED === '1' && Boolean(env.OPENAI_API_KEY && env.PHOTO_QUOTA && env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY);
  if (request.method === 'GET' && path === '/status') return json(200, {
    imageEditingConfigured: ready,
    imageEditingProvider: 'openai',
    imageEditingModel: OPENAI_IMAGE_EDIT_MODEL,
    imageEditingSize: OPENAI_IMAGE_EDIT_SIZE,
    imageEditingQuality: OPENAI_IMAGE_EDIT_QUALITY,
    imageEditingTrialLimit: FREE_TRIAL_LIMIT,
    imageEditingReason: ready ? undefined : 'image_editing_provider_unavailable',
  });
  const isImageRequest = request.method === 'POST' && (path === '/edit' || path === '/generate-person');
  if (!(isImageRequest || (request.method === 'GET' && path === '/usage'))) return json(404, { error: '요청한 경로를 찾을 수 없습니다.' });
  try {
    if (!ready) throw new EditError(503, '사진 편집 연결을 준비하고 있어요. 잠시 후 다시 시도해 주세요.');
    const authorization = request.headers.get('Authorization') || '';
    if (!/^Bearer \S+$/.test(authorization)) throw new EditError(401, '로그인한 뒤 무료 사진 수정을 이용해 주세요.');
    const auth = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { authorization, apikey: env.SUPABASE_PUBLISHABLE_KEY }, signal: AbortSignal.timeout(10000),
    });
    if (!auth.ok) throw new EditError(401, '로그인이 만료됐어요. 다시 로그인해 주세요.');
    const user = await auth.json();
    if (!UUID.test(user.id || '')) throw new EditError(401, '로그인 정보를 확인하지 못했어요.');
    const entitlement = await readVerifiedEntitlement(env, authorization, user.id);
    const quota = env.PHOTO_QUOTA.get(env.PHOTO_QUOTA.idFromName('free-photo-edit-global'));
    if (path === '/usage') {
      const usage = await quota.fetch('https://quota/usage', { method: 'POST', body: JSON.stringify({ userId: user.id, entitlement }) });
      return json(usage.status, await usage.json());
    }
    const payload = path === '/generate-person' ? parsePersonGenerationPayload(await readBody(request)) : parsePayload(await readBody(request));
    const reserved = await quota.fetch('https://quota/reserve', { method: 'POST', body: JSON.stringify({ userId: user.id, requestId: payload.requestId, entitlement }) });
    if (!reserved.ok) return json(reserved.status, await reserved.json());
    const reservation = await reserved.json();
    let succeeded = false;
    try {
      const imageDataUrl = path === '/generate-person' ? await generateOpenAIPerson(env.OPENAI_API_KEY, payload) : await generateOpenAIEdit(env.OPENAI_API_KEY, payload);
      succeeded = true;
      const message = path === '/generate-person' ? '다시 사용할 수 있는 가상 성인 인물 사진을 만들었어요. 얼굴과 자세를 확인한 뒤 카드 사진 수정에 사용할 인물로 선택해 주세요.' : '사진 변경안을 만들었어요. 요청한 인물과 동작이 반영됐는지 확인한 뒤 적용해 주세요.';
      return json(200, { imageDataUrl, usage: reservation.usage, message });
    } finally {
      // A reservation remains consumed if persistence fails, so retries cannot overspend.
      await quota.fetch('https://quota/finish', { method: 'POST', body: JSON.stringify({ requestId: payload.requestId, succeeded }) });
    }
  } catch (error) {
    if (error instanceof EditError) return json(error.status, { error: error.message });
    if (error instanceof OpenAIEditError) return json(error.status, { error: error.message });
    if (error instanceof PersonGenerationError) return json(error.status, { error: error.message });
    return json(503, { error: '사진 편집을 완료하지 못했어요. 서버가 혼잡할 수 있어요. 잠시 후 다시 시도해 주세요.' });
  }
}

async function readBody(request) {
  if (Number(request.headers.get('Content-Length')) > MAX_BYTES) throw new EditError(413, '편집용 사진 크기가 너무 커요. 사진을 다시 선택해 주세요.');
  const reader = request.body?.getReader();
  if (!reader) throw new EditError(400, '사진과 수정 내용을 입력해 주세요.');
  let bytes = 0; const chunks = [];
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BYTES) { await reader.cancel(); throw new EditError(413, '편집용 사진 크기가 너무 커요.'); }
    chunks.push(value);
  }
  try { return JSON.parse(await new Blob(chunks).text()); } catch { throw new EditError(400, '요청 형식이 올바르지 않아요.'); }
}

export function parsePayload(value) {
  if (!value || !UUID.test(value.requestId || '') || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 2000) throw new EditError(400, '수정 내용과 요청 정보를 확인해 주세요.');
  const { bytes, width, height } = decodePhoto(value.photo?.dataUrl);
  let references;
  try { references = parseReferences(value.references, decodePhoto); } catch (error) { throw new EditError(400, error.message); }
  const protectedRegion = parseProtectedRegion(value.protectedRegion);
  const messages = Array.isArray(value.messages) ? value.messages.slice(-20) : [];
  if (messages.some(item => !item || !['user', 'assistant'].includes(item.role) || typeof item.content !== 'string' || item.content.length > 2000)) throw new EditError(400, '대화 내용이 올바르지 않아요.');
  return { requestId: value.requestId, prompt: value.prompt.trim(), messages, bytes, width, height, references, protectedRegion };
}

function parseProtectedRegion(value) {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new EditError(400, '보호할 얼굴 영역이 올바르지 않아요.');
  const { x, y, width, height } = value;
  if (![x, y, width, height].every(item => typeof item === 'number' && Number.isFinite(item))) throw new EditError(400, '보호할 얼굴 영역 좌표가 올바르지 않아요.');
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new EditError(400, '보호할 얼굴 영역은 사진 안에 있어야 해요.');
  return { x, y, width, height };
}

export function decodePhoto(data) {
  
  if (typeof data !== 'string' || data.length > MAX_DATA_URL_LENGTH || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new EditError(400, '편집용 JPEG 사진을 다시 준비해 주세요.');
  let bytes;
  try { bytes = Uint8Array.from(atob(data.split(',')[1]), c => c.charCodeAt(0)); } catch { throw new EditError(400, '사진을 읽지 못했어요.'); }
  const { width, height } = jpegDimensions(bytes);
  if (width < 1 || height < 1 || width > MAX_IMAGE_EDGE || height > MAX_IMAGE_EDGE) throw new EditError(400, `편집용 사진은 가로·세로 ${MAX_IMAGE_EDGE}픽셀 이하여야 해요.`);
  return { bytes, width, height };
}

export function jpegDimensions(bytes) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new EditError(400, 'JPEG 사진을 읽지 못했어요.');
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xff) break;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    const length = bytes[offset] * 256 + bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return { height: bytes[offset + 3] * 256 + bytes[offset + 4], width: bytes[offset + 5] * 256 + bytes[offset + 6] };
    offset += length;
  }
  throw new EditError(400, '사진의 크기 정보를 읽지 못했어요.');
}

class EditError extends Error { constructor(status, message) { super(message); this.status = status; } }
