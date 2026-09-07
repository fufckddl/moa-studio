import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const source = readFileSync(new URL('../src/components/PhotoChat.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('PhotoChat.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = ast.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === 'isUsageExhausted');
const { outputText } = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
const exhausted = new Function(`${outputText}; return isUsageExhausted;`)();
test('quota exempt chat ignores personal zero but respects global zero', () => {
  assert.equal(exhausted({ configured: true, unlimited: true, remaining: 0, globalRemaining: 20 }), false);
  assert.equal(exhausted({ configured: true, unlimited: true, globalRemaining: 0 }), true);
  assert.equal(exhausted({ configured: true, remaining: 0, globalRemaining: 20 }), true);
  assert.equal(exhausted({ configured: true, remaining: 1, globalRemaining: 20 }), false);
});
