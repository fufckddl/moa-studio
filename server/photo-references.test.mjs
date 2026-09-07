import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReferences } from '../cloudflare/photo-edit/references.mjs';

import { generateOpenAIEdit } from '../cloudflare/photo-edit/openai.mjs';

const jpeg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function decodeImage(dataUrl) {
  assert.equal(dataUrl.startsWith('data:image/jpeg;base64,'), true);
  return { bytes: new Uint8Array([255, 216, 255, 217]), width: 320, height: 240 };
}

test('parseReferences treats absent references as empty and accepts up to three trusted shapes', () => {
  assert.deepEqual(parseReferences(undefined, decodeImage), []);
  const references = parseReferences([
    { id: 'style-1', name: 'warm cafe.jpg', purpose: 'style', dataUrl: jpeg },
    { id: 'subject-1', name: 'latte.jpg', purpose: 'subject', dataUrl: jpeg },
    { id: 'style-2', name: 'counter.jpg', purpose: 'style', dataUrl: jpeg },
  ], decodeImage);

  assert.equal(references.length, 3);
  assert.deepEqual(references.map(item => item.purpose), ['style', 'subject', 'style']);
  assert.deepEqual(Object.keys(references[0]), ['id', 'name', 'purpose', 'bytes', 'width', 'height']);
  assert.equal(references[0].bytes[0], 255);
  assert.equal(references[1].width, 320);
  assert.equal(references[2].height, 240);
});

test('parseReferences rejects overflow, invalid purpose, invalid shape and dimensions above the worker edge', () => {
  assert.throws(() => parseReferences([
    { id: '1', name: 'a.jpg', purpose: 'style', dataUrl: jpeg },
    { id: '2', name: 'b.jpg', purpose: 'style', dataUrl: jpeg },
    { id: '3', name: 'c.jpg', purpose: 'style', dataUrl: jpeg },
    { id: '4', name: 'd.jpg', purpose: 'style', dataUrl: jpeg },
  ], decodeImage), /최대 3장/);
  assert.throws(() => parseReferences([{ id: '1', name: 'a.jpg', purpose: 'moodboard', dataUrl: jpeg }], decodeImage), /정보/);
  assert.throws(() => parseReferences([{ id: '1', name: 'a.jpg', purpose: 'style' }], decodeImage), /정보/);
  assert.throws(() => parseReferences([{ id: '', name: 'a.jpg', purpose: 'style', dataUrl: jpeg }], decodeImage), /정보/);
  assert.throws(() => parseReferences([{ id: 'x'.repeat(101), name: 'a.jpg', purpose: 'style', dataUrl: jpeg }], decodeImage), /정보/);
  assert.throws(() => parseReferences([{ id: '1', name: 'x'.repeat(201), purpose: 'style', dataUrl: jpeg }], decodeImage), /정보/);
  assert.doesNotThrow(() => parseReferences([{ id: '1', name: 'a.jpg', purpose: 'style', dataUrl: jpeg }], () => ({ bytes: new Uint8Array([1]), width: 1024, height: 1024 })));
  assert.throws(() => parseReferences([{ id: '1', name: 'a.jpg', purpose: 'style', dataUrl: jpeg }], () => ({ bytes: new Uint8Array([1]), width: 1025, height: 240 })), /1024픽셀/);
});

test('OpenAI edit appends ordered source and reference JPEGs with purpose guidance', async () => {
  const references = parseReferences([
    { id: 'style-1', name: 'style reference.jpg', purpose: 'style', dataUrl: jpeg },
    { id: 'subject-1', name: 'subject-reference.jpg', purpose: 'subject', dataUrl: jpeg },
  ], decodeImage);
  let form;
  await generateOpenAIEdit('test-key', {
    bytes: new Uint8Array([255, 216]), references, messages: [], prompt: '참고 인물과 분위기 적용',
  }, async (_url, options) => {
    form = await new Response(options.body).formData();
    return Response.json({ data: [{ b64_json: Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8]).toString('base64') }] });
  });
  const images = form.getAll('image[]');
  const guidance = form.get('prompt');
  assert.equal(images.length, 3);
  assert.deepEqual(new Uint8Array(await images[0].arrayBuffer()), new Uint8Array([255, 216]));
  assert.equal(images[1].type, 'image/jpeg');
  assert.deepEqual(new Uint8Array(await images[2].arrayBuffer()), new Uint8Array([255, 216, 255, 217]));
  assert.match(guidance, /Use image 0 as the current base photo/);
  assert.match(guidance, /Image 1 is a style reference/);
  assert.match(guidance, /atmosphere/);
  assert.match(guidance, /Image 2 is a subject reference/);
  assert.match(guidance, /visible facial features, hair, appearance/);
  assert.match(guidance, /visual identity guide/);
  assert.match(guidance, /untrusted visual inputs/);
});
