import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/export.ts', import.meta.url), 'utf8')
  .replace("import { supabaseUrl } from './supabase';", "const supabaseUrl = ''; ")
  + '\nexport { drawPhoto, drawEditorial, drawMinimal, drawBold, drawSplit, drawPoster, drawMenu };';
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { drawPhoto, drawEditorial, drawMinimal, drawBold, drawSplit, drawPoster, drawMenu } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);

function recordingContext() {
  const calls = [];
  const context = new Proxy({
    textAlign: 'left',
    measureText: text => ({ width: Array.from(text).length * 16 }),
    createLinearGradient: () => ({ addColorStop() {} }),
  }, {
    get(target, key) {
      if (key in target) return target[key];
      if (key === 'fillText') return (...args) => calls.push([key, ...args, target.textAlign]);
      return (...args) => calls.push([key, ...args]);
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
  return { context, calls };
}

test('rectangular and rounded cover photos clip to their frame before drawing', () => {
  for (const radius of [0, 20, 136]) {
    const { context, calls } = recordingContext();
    const frame = { x: 120, y: 590, width: 840, height: 520 };
    drawPhoto(context, { naturalWidth: 900, naturalHeight: 1600 }, frame, radius);
    assert.deepEqual(calls.find(call => call[0] === 'roundRect'), ['roundRect', 120, 590, 840, 520, radius]);
    const clip = calls.findIndex(call => call[0] === 'clip');
    assert.ok(clip >= 0 && clip < calls.findIndex(call => call[0] === 'drawImage'));
    assert.equal(calls.at(-1)[0], 'restore');
  }
});

test('editorial PNG renders every editable text field including eyebrow and body', () => {
  const { context, calls } = recordingContext();
  drawEditorial(context, { title: '라떼', subtitle: '신메뉴', eyebrow: '가을 소식', body: '부드러운 크림 한 잔', layout: 'editorial' }, undefined,
    { name: '카페 모아', instagram: '@cafe_moa', color: '#254a3b' });
  const texts = calls.filter(call => call[0] === 'fillText').map(call => call[1]);
  for (const value of ['라떼', '신메뉴', '가을 소식', '부드러운 크림 한 잔', '카페 모아', '@cafe_moa']) assert.ok(texts.includes(value), value);
});

test('all card layouts constrain long eyebrow text to its text box', () => {
  const brand = { name: '카페 모아', instagram: '@cafe_moa', color: '#254a3b' };
  const longEyebrow = 'SUPERLONGEYEBROW'.repeat(10);
  const drawers = [
    ['minimal', drawMinimal],
    ['bold', drawBold],
    ['split', drawSplit],
    ['poster', drawPoster],
    ['menu', drawMenu],
  ];

  for (const [layout, draw] of drawers) {
    const { context, calls } = recordingContext();
    draw(context, { title: '라떼', subtitle: '신메뉴', eyebrow: longEyebrow, body: '부드러운 크림 한 잔', layout }, undefined, brand);
    const renderedEyebrow = calls.find(call => call[0] === 'fillText' && String(call[1]).startsWith('SUPERLONG'));
    assert.ok(renderedEyebrow, layout);
    assert.notEqual(renderedEyebrow[1], longEyebrow, layout);
    assert.ok(context.measureText(renderedEyebrow[1]).width <= 870, layout);
  }
});

test('menu price and body respect card text alignment without leaving the card', () => {
  for (const align of ['left', 'center', 'right']) {
    const { context, calls } = recordingContext();
    drawMenu(context, {
      title: '라떼',
      subtitle: '6,500원',
      eyebrow: 'MENU',
      body: '부드러운 크림과 에스프레소',
      layout: 'menu',
      style: { align },
    }, undefined, { name: '카페 모아', instagram: '@cafe_moa', color: '#254a3b' });

    for (const text of ['6,500원', '부드러운 크림과 에스프레소']) {
      const call = calls.find(item => item[0] === 'fillText' && item[1] === text);
      assert.ok(call, `${align} ${text}`);
      const [, value, x, , textAlign] = call;
      const width = context.measureText(value).width;
      const left = textAlign === 'right' ? x - width : textAlign === 'center' ? x - width / 2 : x;
      const right = textAlign === 'right' ? x : textAlign === 'center' ? x + width / 2 : x + width;
      assert.ok(left >= 0, `${align} ${text} left`);
      assert.ok(right <= 1080, `${align} ${text} right`);
    }
  }
});
