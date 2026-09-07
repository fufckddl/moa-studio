import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/storage.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const storage = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

test('browser storage restores ten edited cards, all six templates, style and dated schedules', () => {
  const values = new Map();
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
  const layouts = ['editorial', 'minimal', 'bold', 'split', 'poster', 'menu'];
  const project = {
    id: 'edited', name: '직접 편집한 카드', updatedAt: '2026-09-06T12:00:00.000Z', brandId: 'brand-2',
    brand: { name: '모아', tagline: '', location: '', instagram: '', color: '#254a3b' },
    brief: { productName: '라떼', description: '직접 쓴 설명', price: '6500원', tone: 'warm', goal: 'new', includeSchedule: true, scheduleStartDate: '2026-09-07' },
    photos: [],
    pack: { source: 'template', cards: Array.from({ length: 10 }, (_, i) => ({ id: `card-${i}`, title: `제목 ${i}`, subtitle: '부제', eyebrow: '소개', body: '본문', imageId: '', layout: layouts[i % layouts.length], style: { textColor: '#123456', backgroundColor: '#fedcba', fontScale: 1.15, align: 'right' } })), caption: '수정한 게시글', hashtags: ['#직접편집'], schedule: [{ day: '월', date: '2026-09-07', title: '새 일정', format: '릴스', description: '수정한 설명' }] },
    photoChats: {
      'card-0': [
        { role: 'user', content: '배경을 따뜻하게 바꿔 줘' },
        { role: 'assistant', content: '따뜻한 카페 조명으로 바꾼 변경안을 만들었어요.' },
      ],
      'card-9': Array.from({ length: 200 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `대화 ${index}` })),
    },
  };
  storage.saveProject(project);
  assert.deepEqual(storage.loadProjects(), [project]);
  const legacy = structuredClone(project);
  legacy.id = 'legacy';
  delete legacy.brief.includeSchedule;
  delete legacy.brief.scheduleStartDate;
  legacy.pack.cards = legacy.pack.cards.slice(0, 1);
  delete legacy.photoChats;
  delete legacy.pack.cards[0].style;
  delete legacy.pack.schedule[0].date;
  storage.saveProject(legacy);
  assert.equal(storage.loadProjects().length, 2);
  const invalid = structuredClone(project);
  invalid.pack.cards[0].style.fontScale = 99;
  assert.throws(() => storage.saveProject(invalid), /형식/);
  assert.equal(storage.loadProjects().length, 2);
  const invalidAttachment = structuredClone(project);
  invalidAttachment.photoChats['card-0'][0].references = [];
  assert.throws(() => storage.saveProject(invalidAttachment), /형식/);
  const invalidUnknownCard = structuredClone(project);
  invalidUnknownCard.photoChats['missing-card'] = [{ role: 'user', content: '없는 카드' }];
  assert.throws(() => storage.saveProject(invalidUnknownCard), /형식/);
  const invalidMessageLimit = structuredClone(project);
  invalidMessageLimit.photoChats['card-0'] = Array.from({ length: 201 }, () => ({ role: 'user', content: '너무 많은 대화' }));
  assert.throws(() => storage.saveProject(invalidMessageLimit), /형식/);
  delete globalThis.window;
});

test('guest brand profiles persist selection, deletion and an intentionally empty list', () => {
  const values = new Map();
  globalThis.window = { localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } };
  const brand = { name: '첫 카페', tagline: '', location: '', instagram: '', color: '#254a3b' };
  storage.saveBrand(brand);
  assert.equal(storage.loadBrandProfiles(), null);
  const profiles = [{ ...brand, id: 'a' }, { ...brand, id: 'b', name: '두 번째 카페' }];
  storage.saveBrandProfiles(profiles, 'b');
  assert.deepEqual(storage.loadBrandProfiles(), { brandProfiles: profiles, activeBrandId: 'b' });
  assert.throws(() => storage.saveBrandProfiles(profiles, 'missing'), /형식/);
  assert.throws(() => storage.saveBrandProfiles([profiles[0], profiles[0]], 'a'), /형식/);
  assert.throws(() => storage.saveBrandProfiles(Array.from({length:4}, (_,i)=>({...brand,id:String(i)})), '0'), /형식/);
  storage.saveBrandProfiles([profiles[0]], 'a');
  assert.equal(storage.loadBrandProfiles().brandProfiles.length, 1);
  storage.saveBrandProfiles([], null);
  assert.deepEqual(storage.loadBrandProfiles(), { brandProfiles: [], activeBrandId: null });
  delete globalThis.window;
});
