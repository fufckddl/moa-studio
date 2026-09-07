import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const { outputText } = ts.transpileModule(readFileSync(new URL('../src/lib/photoChatLayout.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { clampChatWidth, chatWidthBounds } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
test('dragging cannot expand chat beyond half of any viewport', () => {
  for (const viewport of [390, 768, 1150, 1440, 1900, 2560]) {
    assert.equal(clampChatWidth(10000, viewport), Math.floor(viewport / 2));
    assert.ok(clampChatWidth(390, viewport) <= viewport / 2);
    assert.ok(chatWidthBounds(viewport).min <= chatWidthBounds(viewport).max);
  }
});
test('drag shrink has a usable minimum and intermediate widths remain precise', () => {
  assert.equal(clampChatWidth(-100, 1440), 320);
  assert.equal(clampChatWidth(565, 1440), 565);
  assert.equal(clampChatWidth(390, 1440), 390);
  assert.equal(clampChatWidth(700, 900), 450);
});
