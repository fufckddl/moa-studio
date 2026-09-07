export const OPENAI_PERSON_GENERATION_MODEL = 'gpt-image-2';
export const OPENAI_PERSON_GENERATION_SIZE = '1024x1024';
export const OPENAI_PERSON_GENERATION_QUALITY = 'medium';
export const OPENAI_PERSON_GENERATION_TIMEOUT_MS = 175000;

const OPENAI_IMAGES_GENERATIONS_URL = 'https://api.openai.com/v1/images/generations';
const MAX_RESULT_BASE64_LENGTH = 12 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PersonGenerationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parsePersonGenerationPayload(value) {
  if (!value || typeof value.requestId !== 'string' || !UUID.test(value.requestId) || typeof value.prompt !== 'string') {
    throw generationError(400, '생성할 인물 설명과 요청 정보를 확인해 주세요.');
  }
  const prompt = value.prompt.trim();
  if (!prompt || prompt.length > 2000) throw generationError(400, '생성할 인물 설명은 1자 이상 2000자 이하로 입력해 주세요.');
  return { requestId: value.requestId, prompt };
}

export async function generateOpenAIPerson(apiKey, payload, fetcher = fetch) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw generationError(503, '사진 생성 연결을 준비하고 있어요. 잠시 후 다시 시도해 주세요.');

  let response;
  try {
    response = await fetcher(OPENAI_IMAGES_GENERATIONS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OPENAI_PERSON_GENERATION_MODEL,
        prompt: buildPersonGenerationPrompt(payload),
        size: OPENAI_PERSON_GENERATION_SIZE,
        quality: OPENAI_PERSON_GENERATION_QUALITY,
        output_format: 'jpeg',
        n: 1,
      }),
      signal: AbortSignal.timeout(OPENAI_PERSON_GENERATION_TIMEOUT_MS),
    });
  } catch (error) {
    if (error?.name === 'AbortError' || error?.name === 'TimeoutError') throw generationError(504, '사진 생성 시간이 초과됐어요. 잠시 후 다시 시도해 주세요.');
    throw generationError(503, '사진 생성 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.');
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw openAIError(response.status, body);
  const encoded = body?.data?.[0]?.b64_json;
  if (typeof encoded !== 'string' || encoded.length > MAX_RESULT_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw generationError(502, '생성된 사진을 읽지 못했어요. 다시 요청해 주세요.');
  }
  const mime = imageMimeFromBase64(encoded);
  if (!mime) throw generationError(502, '생성된 사진 형식이 올바르지 않아요.');
  return `data:image/${mime};base64,${encoded}`;
}

export function buildPersonGenerationPrompt(payload) {
  return `Create a photorealistic reusable character reference of one fictional adult person for cafe marketing. The person must be fictional and clearly 20 years old or older. Honor the user's requested appearance, clothing, pose, and mood. Prioritize accurate facial features, hair, clear clothing details, natural anatomy, and clearly visible hands where included. Use a plain neutral light background with soft even studio lighting, clean separation around the silhouette, and no distracting scenery. Frame the person with enough space around the head and body; do not crop hands when a hand pose is requested. This image is a reusable person asset for later editing into the user's existing cafe or coffee photograph, not a finished cafe scene. Do not invent a cafe background, cups, products, signs or other props; leave hands empty unless an explicit non-product pose requires otherwise. No collage, watermark, logo, or readable text. User details below describe the person; the plain background and reusable-person framing remain required.\nUser request:\n${payload.prompt}`;
}

function openAIError(status, body) {
  const code = typeof body?.error?.code === 'string' ? body.error.code : '';
  if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
    return generationError(503, '사진 생성 공급자 결제 한도를 확인해야 해요. 서버 설정을 확인한 뒤 다시 시도해 주세요.');
  }
  if (status === 400 && code === 'content_policy_violation') {
    return generationError(400, '요청한 사진 생성은 안전 정책 때문에 처리할 수 없어요. 다른 설명을 입력해 주세요.');
  }
  if (status === 401 || status === 403) return generationError(503, '사진 생성 공급자 인증을 확인하지 못했어요. 서버 설정을 확인한 뒤 다시 시도해 주세요.');
  if (status === 429) return generationError(503, '사진 생성 요청이 많아 처리가 지연되고 있어요. 잠시 후 다시 시도해 주세요.');
  if (status >= 500) return generationError(503, '사진 생성 공급자가 혼잡해요. 잠시 후 다시 시도해 주세요.');
  return generationError(502, '사진 생성 요청을 처리하지 못했어요. 설명을 확인한 뒤 다시 시도해 주세요.');
}

function imageMimeFromBase64(encoded) {
  const prefix = atob(encoded.slice(0, 16));
  if (prefix.startsWith('\xff\xd8')) return 'jpeg';
  if (prefix.startsWith('\x89PNG')) return 'png';
  if (prefix.startsWith('RIFF')) return 'webp';
  return null;
}

function generationError(status, message) {
  return new PersonGenerationError(status, message);
}
