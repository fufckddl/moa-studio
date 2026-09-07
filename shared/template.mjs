const TONES = new Set(['warm', 'simple', 'playful']);
const GOALS = new Set(['new', 'daily', 'event']);

export function validateTemplateRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw templateError('요청 데이터가 올바르지 않습니다.');
  }

  const brand = payload.brand;
  const brief = payload.brief;
  const images = Array.isArray(payload.images) ? payload.images : [];

  if (!brand || typeof brand !== 'object') throw templateError('브랜드 정보를 입력해 주세요.');
  if (!brief || typeof brief !== 'object') throw templateError('콘텐츠 정보를 입력해 주세요.');

  return {
    brand: {
      name: requiredText(brand.name, '브랜드 이름'),
      tagline: optionalText(brand.tagline),
      location: optionalText(brand.location),
      instagram: optionalText(brand.instagram),
      color: normalizeColor(brand.color),
    },
    brief: {
      productName: requiredText(brief.productName, '메뉴 이름'),
      description: requiredText(brief.description, '설명'),
      price: optionalText(brief.price),
      tone: TONES.has(brief.tone) ? brief.tone : 'warm',
      goal: GOALS.has(brief.goal) ? brief.goal : 'daily',
      includeSchedule: brief.includeSchedule === true,
      scheduleStartDate: validDate(brief.scheduleStartDate),
    },
    images: images.map((image, index) => {
      if (!image || typeof image !== 'object') throw templateError('이미지 데이터가 올바르지 않습니다.');
      return {
        id: optionalText(image.id) || `image-${index + 1}`,
        name: optionalText(image.name) || `photo-${index + 1}`,
        dataUrl: typeof image.dataUrl === 'string' ? image.dataUrl : '',
        storagePath: typeof image.storagePath === 'string' ? image.storagePath : undefined,
      };
    }),
  };
}

export function syncTemplateCards({ pack, brand, previousBrief, brief, images }) {
  if (pack.source !== 'template') return pack;
  if (['productName', 'description', 'price', 'tone', 'goal'].every(field => previousBrief[field] === brief[field])) return pack;
  const previous = makeTemplatePack({ brand, brief: previousBrief, images });
  const next = makeTemplatePack({ brand, brief, images });
  const fields = ['title', 'subtitle', 'eyebrow', 'body'];
  return {
    ...pack,
    cards: pack.cards.map(card => {
      const before = previous.cards.find(item => item.id === card.id);
      const after = next.cards.find(item => item.id === card.id);
      if (!before || !after) return card;
      const patch = {};
      for (const field of fields) {
        if (card[field] !== after[field] && card[field] === before[field]) {
          patch[field] = after[field];
        }
      }
      return Object.keys(patch).length ? { ...card, ...patch } : card;
    }),
  };
}

export function makeTemplatePack({ brand, brief, images }) {
  const product = brief.productName;
  const brandName = brand.name;
  const imageIds = [0, 1, 2].map((index) => images[index]?.id ?? images[0]?.id ?? 'sample-latte');
  const toneText = tonePhrase(brief.tone);
  const goalText = goalPhrase(brief.goal);
  const price = normalizePrice(brief.price);
  const priceLine = price ? `${price}에 만나는 ${product}` : `${product} 한 잔`;
  const locationLine = brand.location ? `${brand.location}에서` : brandName;

  return {
    source: 'template',
    cards: [
      {
        id: 'card-1',
        title: titleForTone(brief.tone, product),
        subtitle: priceLine,
        eyebrow: goalText,
        body: `${brief.description}\n${toneText}`,
        imageId: imageIds[0],
        layout: 'editorial',
      },
      {
        id: 'card-2',
        title: `${locationLine} 준비한 오늘의 메뉴`,
        subtitle: brand.tagline || brandName,
        eyebrow: '메뉴 소개',
        body: `${brief.description}${price ? `\n${product} · ${price}` : ''}`,
        imageId: imageIds[1],
        layout: 'minimal',
      },
      {
        id: 'card-3',
        title: `이번 주에는 ${product}`,
        subtitle: brand.instagram || brandName,
        eyebrow: '방문 유도',
        body: `${brand.tagline || `${brandName}에서 만나요.`}${brand.location ? `\n${brand.location}` : ''}${price ? `\n${product} · ${price}` : ''}`,
        imageId: imageIds[2],
        layout: 'bold',
      },
    ],
    caption: `${brandName}의 ${product}. ${brief.description}${price ? `\n가격 ${price}` : ''}${brand.location ? `\n${brand.location}` : ''}`,
    hashtags: buildHashtags(brand, brief),
    schedule: brief.includeSchedule ? [
      {
        day: '월',
        title: `${product} 첫 소개`,
        format: '카드뉴스',
        description: '대표 사진과 메뉴 설명을 중심으로 저장하고 싶은 첫 게시물을 올립니다.',
      },
      {
        day: '수',
        title: '제조 순간 공유',
        format: '릴스/스토리',
        description: '음료가 완성되는 짧은 장면에 핵심 설명 한 문장을 붙입니다.',
      },
      {
        day: '금',
        title: '주말 방문 리마인드',
        format: '게시글',
        description: `${brand.location || '매장'} 정보와 ${product} 소개를 함께 올립니다.`,
      },
    ].map((item, index) => {
      if (!validDate(brief.scheduleStartDate)) return item;
      const date = new Date(`${brief.scheduleStartDate}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + index * 2);
      return { ...item, date: date.toISOString().slice(0, 10), day: ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'][date.getUTCDay()] };
    }) : [],
  };
}

function buildHashtags(brand, brief) {
  const tags = ['카페', sanitizeTag(brief.productName), '카페메뉴', '동네카페'];
  if (brand.location) tags.push(sanitizeTag(brand.location));
  return [...new Set(tags.filter(Boolean))].slice(0, 6).map((tag) => `#${tag}`);
}

function tonePhrase(tone) {
  if (tone === 'simple') return '오늘의 한 잔을 만나보세요.';
  if (tone === 'playful') return '오늘은 이 한 잔, 어때요?';
  return '잠시 쉬어가는 시간에 함께해요.';
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(`${value}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

function titleForTone(tone, product) {
  if (tone === 'simple') return `오늘의 ${product}`;
  if (tone === 'playful') return `${product}, 오늘 마셔볼까요?`;
  return `오늘의 여유, ${product}`;
}

function goalPhrase(goal) {
  if (goal === 'new') return '신메뉴';
  if (goal === 'event') return '이벤트';
  return '오늘의 추천';
}

function requiredText(value, label) {
  const text = optionalText(value);
  if (!text) throw templateError(`${label}을 입력해 주세요.`);
  return text;
}

function optionalText(value) {
  return typeof value === 'string' ? value.trim().slice(0, 500) : '';
}

function normalizeColor(value) {
  const text = optionalText(value);
  return /^#[0-9a-f]{6}$/i.test(text) ? text : '#254a3b';
}

function normalizePrice(value) {
  const text = optionalText(value);
  if (!text) return '';
  return /^[\d,\s]+$/.test(text) ? `${text.replace(/\s/g, '')}원` : text;
}

function sanitizeTag(text) {
  return String(text ?? '').replace(/[^0-9a-zA-Z가-힣]/g, '').slice(0, 18);
}

function templateError(message) {
  return new Error(message);
}
