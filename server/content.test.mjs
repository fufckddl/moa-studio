import test from 'node:test';
import assert from 'node:assert/strict';
import { generateContentPack, makeTemplatePack, parseGenerateRequest, parseProviderOutput, validateGeneratePayload } from './content.mjs';

const payload = {
  brand: {
    name: '카페 모아',
    tagline: '동네의 작은 쉼',
    location: '연남동',
    instagram: '@cafe_moa',
    color: '#254a3b',
  },
  brief: {
    productName: '시그니처 크림 라떼',
    description: '부드러운 크림과 에스프레소의 조화',
    price: '6,500원',
    tone: 'warm',
    goal: 'daily',
  },
  images: [
    {
      id: 'photo-1',
      name: 'latte.png',
      dataUrl: 'data:image/png;base64,aGVsbG8=',
    },
  ],
};

test('invalid JSON returns a 400 error', () => {
  assert.throws(() => parseGenerateRequest('{bad'), /JSON 형식/);
});

test('rejects missing required content fields', () => {
  assert.throws(() => validateGeneratePayload({ brand: payload.brand, brief: { ...payload.brief, productName: '' }, images: [] }), /메뉴 이름/);
});

test('template mode grounds content in provided cafe data', () => {
  const pack = makeTemplatePack(validateGeneratePayload(payload));
  assert.equal(pack.source, 'template');
  assert.equal(pack.cards.length, 3);
  assert.equal(pack.schedule.length, 0);
  assert.match(pack.cards[0].title, /시그니처 크림 라떼/);
  assert.match(pack.caption, /카페 모아/);
  assert.match(pack.caption, /6,500원/);
  assert.ok(pack.hashtags.includes('#시그니처크림라떼'));
});

test('numeric price gets a won suffix without changing an existing suffix', () => {
  const numericPack = makeTemplatePack(validateGeneratePayload({ ...payload, brief: { ...payload.brief, price: '6,500' } }));
  const suffixedPack = makeTemplatePack(validateGeneratePayload(payload));
  assert.match(numericPack.caption, /가격 6,500원/);
  assert.match(numericPack.cards[0].subtitle, /6,500원/);
  assert.match(suffixedPack.caption, /가격 6,500원/);
});

test('template cards use consecutive image ids when three images are provided', () => {
  const request = validateGeneratePayload({
    ...payload,
    images: [
      { id: 'photo-1', name: 'first.png', dataUrl: 'data:image/png;base64,aGVsbG8=' },
      { id: 'photo-2', name: 'second.jpg', dataUrl: 'data:image/jpeg;base64,aGVsbG8=' },
      { id: 'photo-3', name: 'third.webp', dataUrl: 'data:image/webp;base64,aGVsbG8=' },
    ],
  });
  const pack = makeTemplatePack(request);
  assert.deepEqual(pack.cards.map((card) => card.imageId), ['photo-1', 'photo-2', 'photo-3']);
});

test('tone and goal combinations produce distinct template copy', () => {
  const outputs = new Set();
  for (const tone of ['warm', 'simple', 'playful']) {
    for (const goal of ['daily', 'new', 'event']) {
      const pack = makeTemplatePack(validateGeneratePayload({ ...payload, brief: { ...payload.brief, tone, goal } }));
      outputs.add(`${pack.cards[0].title}|${pack.cards[0].eyebrow}|${pack.cards[0].body}`);
      assert.match(pack.cards.map((card) => card.body).join(' '), /부드러운 크림과 에스프레소의 조화/);
      assert.match(pack.caption, /6,500원/);
    }
  }
  assert.equal(outputs.size, 9);
});

test('unsupported image data urls are rejected', () => {
  assert.throws(
    () => validateGeneratePayload({ ...payload, images: [{ id: 'bad', name: 'bad.gif', dataUrl: 'data:image/gif;base64,aGVsbG8=' }] }),
    /PNG, JPG, WEBP/,
  );
});

test('image data urls are validated without truncating provider input', () => {
  const dataUrl = `data:image/png;base64,${'a'.repeat(900)}`;
  const request = validateGeneratePayload({ ...payload, images: [{ id: 'long', name: 'long.png', dataUrl }] });
  assert.equal(request.images[0].dataUrl, dataUrl);
});

test('provider schema and parser require no schedule when schedule is not requested', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';
  const dataUrl = `data:image/png;base64,${'a'.repeat(900)}`;

  try {
    const pack = await generateContentPack(
      { ...payload, images: [{ id: 'long', name: 'long.png', dataUrl }] },
      {
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body);
          const prompt = body.input[0].content[0].text;
          const schema = body.text.format.schema;
          assert.match(prompt, /false면 빈 배열 0개/);
          assert.equal(schema.properties.schedule.minItems, 0);
          assert.equal(schema.properties.schedule.maxItems, 0);
          assert.equal(body.input[0].content[1].image_url, dataUrl);
          return {
            ok: true,
            json: async () => ({
              output_text: JSON.stringify({
                source: 'ai',
                cards: [
                  { id: 'card-1', title: '첫 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'long', layout: 'editorial' },
                  { id: 'card-2', title: '둘째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'long', layout: 'split' },
                  { id: 'card-3', title: '셋째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'long', layout: 'menu' },
                ],
                caption: '게시글',
                hashtags: ['#카페'],
                schedule: [],
              }),
            }),
          };
        },
      },
    );
    assert.equal(pack.schedule.length, 0);
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('provider schema and parser require three promotion schedules when requested', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    const pack = await generateContentPack(
      { ...payload, brief: { ...payload.brief, includeSchedule: true, scheduleStartDate: '2026-09-07' } },
      {
        fetchImpl: async (_url, init) => {
          const body = JSON.parse(init.body);
          const prompt = body.input[0].content[0].text;
          const schema = body.text.format.schema;
          assert.match(prompt, /true면 홍보 일정 3개/);
          assert.equal(schema.properties.schedule.minItems, 3);
          assert.equal(schema.properties.schedule.maxItems, 3);
          return {
            ok: true,
            json: async () => ({
              output_text: JSON.stringify({
                source: 'ai',
                cards: [
                  { id: 'card-1', title: '첫 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'editorial' },
                  { id: 'card-2', title: '둘째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'poster' },
                  { id: 'card-3', title: '셋째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'bold' },
                ],
                caption: '게시글',
                hashtags: ['#카페'],
                schedule: [
                  { day: '월요일', date: '2026-09-07', title: '첫 소개', format: '카드뉴스', description: '소개합니다.' },
                  { day: '수요일', date: '2026-09-09', title: '제조 순간', format: '릴스', description: '보여줍니다.' },
                  { day: '금요일', date: '2026-09-11', title: '방문 리마인드', format: '게시글', description: '안내합니다.' },
                ],
              }),
            }),
          };
        },
      },
    );
    assert.equal(pack.schedule.length, 3);
    assert.equal(pack.schedule[0].date, '2026-09-07');
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('provider output rejects schedules when schedule is not requested', async () => {
  const previousKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'test-key';

  try {
    await assert.rejects(
      generateContentPack(payload, {
        fetchImpl: async () => ({
          ok: true,
          json: async () => ({
            output_text: JSON.stringify({
              source: 'ai',
              cards: [
                { id: 'card-1', title: '첫 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'editorial' },
                { id: 'card-2', title: '둘째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'minimal' },
                { id: 'card-3', title: '셋째 카드', subtitle: '부제', eyebrow: '소개', body: '본문', imageId: 'photo-1', layout: 'bold' },
              ],
              caption: '게시글',
              hashtags: ['#카페'],
              schedule: [{ day: '월요일', title: '첫 소개', format: '카드뉴스', description: '소개합니다.' }],
            }),
          }),
        }),
      }),
      /비어 있어야/,
    );
  } finally {
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousKey;
  }
});

test('oversized request bodies are rejected before JSON parsing', () => {
  assert.throws(() => parseGenerateRequest('x'.repeat(12 * 1024 * 1024 + 1)), /12MB/);
});

test('invalid brand color normalizes to the default forest color', () => {
  const request = validateGeneratePayload({ ...payload, brand: { ...payload.brand, color: 'green' } });
  assert.equal(request.brand.color, '#254a3b');
});

test('malformed provider JSON is reported as provider failure', () => {
  assert.throws(() => parseProviderOutput('좋은 게시글입니다'), /올바른 JSON/);
});
