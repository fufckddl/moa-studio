import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const source = readFileSync(new URL('../src/components/PhotoChat.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PhotoChat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let handlerSource;
function visit(node) {
  if (ts.isJsxAttribute(node) && node.name.getText(ast) === 'onKeyDown') handlerSource = node.initializer.expression.getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
assert.ok(handlerSource, 'Chat input must have a keyboard handler');
const { outputText } = ts.transpileModule(`const handler = ${handlerSource};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
function run(overrides = {}, composing = false) {
  let prevented = 0;
  let submitted = 0;
  const handler = new Function('composing', `${outputText}; return handler;`)({ current: composing });
  handler({ key: 'Enter', shiftKey: false, repeat: false, nativeEvent: {}, preventDefault: () => prevented++, currentTarget: { form: { requestSubmit: () => submitted++ } }, ...overrides });
  return { prevented, submitted };
}

test('Enter submits through the form once and suppresses its newline', () => {
  assert.deepEqual(run(), { prevented: 1, submitted: 1 });
  assert.deepEqual(run({ repeat: true }), { prevented: 1, submitted: 0 });
});
test('Shift+Enter and ordinary keys retain native input behavior', () => {
  assert.deepEqual(run({ shiftKey: true }), { prevented: 0, submitted: 0 });
  assert.deepEqual(run({ key: 'a' }), { prevented: 0, submitted: 0 });
});
test('Korean composition Enter never submits or interrupts composition', () => {
  assert.deepEqual(run({}, true), { prevented: 0, submitted: 0 });
  assert.deepEqual(run({ nativeEvent: { isComposing: true } }), { prevented: 0, submitted: 0 });
  assert.deepEqual(run({ nativeEvent: { keyCode: 229 } }), { prevented: 0, submitted: 0 });
});
