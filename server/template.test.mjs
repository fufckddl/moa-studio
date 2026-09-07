import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTemplatePack, validateTemplateRequest } from '../shared/template.mjs';

const input = {
  brand: { name: '작은 카페', tagline: '한 잔의 쉼', location: '안성', instagram: '@small', color: '#254a3b' },
  brief: { productName: '라떼', description: '우유와 에스프레소', price: '5,000', tone: 'warm', goal: 'new' },
  images: [{ id: 'photo', name: '커피', dataUrl: '/assets/cafe-latte.png' }],
};

test('promotion schedule is optional and not added to an ordinary content pack', () => {
  assert.deepEqual(makeTemplatePack(validateTemplateRequest(input)).schedule, []);
  const falseString = { ...input, brief: { ...input.brief, includeSchedule: 'true' } };
  assert.deepEqual(makeTemplatePack(validateTemplateRequest(falseString)).schedule, []);
});

test('requested promotion dates cross month boundaries with matching weekdays', () => {
  const pack = makeTemplatePack(validateTemplateRequest({ ...input, brief: { ...input.brief, includeSchedule: true, scheduleStartDate: '2026-12-30' } }));
  assert.deepEqual(pack.schedule.map(({ date, day }) => [date, day]), [
    ['2026-12-30', '수요일'], ['2027-01-01', '금요일'], ['2027-01-03', '일요일'],
  ]);
});

test('impossible dates do not silently roll to a different date', () => {
  const pack = makeTemplatePack(validateTemplateRequest({ ...input, brief: { ...input.brief, includeSchedule: true, scheduleStartDate: '2026-02-30' } }));
  assert.equal(pack.schedule.length, 3);
  assert.ok(pack.schedule.every(item => !item.date));
});

test('template output is publishable copy rather than generator instructions', () => {
  const pack = makeTemplatePack(validateTemplateRequest(input));
  const copy = pack.cards.map(card => `${card.title} ${card.body}`).join(' ') + pack.caption;
  assert.doesNotMatch(copy, /입력한 설명|구성했습니다|정보만 사용|문장을 직접 다듬|반영했습니다/);
  assert.match(copy, /우유와 에스프레소/);
  assert.match(copy, /5,000원/);
  assert.doesNotMatch(copy, /할인|무료 증정|수상|영업시간/);
});
