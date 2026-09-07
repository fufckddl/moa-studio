const MAX_REFERENCES = 3;
const MAX_ID_LENGTH = 100;
const MAX_NAME_LENGTH = 200;
const MAX_DIMENSION = 1024;
const JPEG_DATA_URL = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
const PURPOSES = new Set(['style', 'subject']);

export function parseReferences(value, decodeImage) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw referenceError('참조 이미지 형식이 올바르지 않아요.');
  if (value.length > MAX_REFERENCES) throw referenceError('참조 이미지는 최대 3장까지 사용할 수 있어요.');
  if (typeof decodeImage !== 'function') throw referenceError('참조 이미지를 읽을 수 없어요.');

  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw referenceError('참조 이미지 형식이 올바르지 않아요.');
    const id = cleanRequiredText(item.id, MAX_ID_LENGTH);
    const name = cleanRequiredText(item.name, MAX_NAME_LENGTH);
    const purpose = typeof item.purpose === 'string' ? item.purpose.trim() : '';
    const dataUrl = typeof item.dataUrl === 'string' ? item.dataUrl : '';
    if (!id || !name || !PURPOSES.has(purpose) || !JPEG_DATA_URL.test(dataUrl)) {
      throw referenceError('참조 이미지 정보가 올바르지 않아요.');
    }

    const decoded = decodeImage(dataUrl);
    const bytes = decoded?.bytes;
    const width = decoded?.width;
    const height = decoded?.height;
    if (!(bytes instanceof Uint8Array) || !validDimension(width) || !validDimension(height)) {
      throw referenceError('참조 이미지 크기를 확인하지 못했어요.');
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      throw referenceError(`참조 이미지는 가로·세로 ${MAX_DIMENSION}픽셀 이하여야 해요.`);
    }

    return { id, name, purpose, bytes, width, height };
  });
}

function cleanRequiredText(value, maxLength) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > maxLength) return '';
  return text;
}

function validDimension(value) {
  return Number.isInteger(value) && value >= 1;
}

function referenceError(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}
