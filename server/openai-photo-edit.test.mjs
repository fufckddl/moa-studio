import test from 'node:test';
import assert from 'node:assert/strict';
import { generateOpenAIEdit } from '../cloudflare/photo-edit/openai.mjs';
import { parsePayload } from '../cloudflare/photo-edit/index.mjs';

const requestId = '00000000-0000-4000-8000-000000000002';

function input(width = 1024, height = 768) {
  const jpeg = Buffer.from([255,216,255,192,0,11,8,height >> 8,height & 255,width >> 8,width & 255,1,1,0x11,0,255,217]);
  return { requestId, photo: { dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}` }, prompt: '참고 인물의 얼굴 특징을 유지하고 컵은 하나만 들게 해 줘', messages: [] };
}

function reference(name = 'face.jpg') {
  return { id: crypto.randomUUID(), name, purpose: 'subject', dataUrl: input(1024, 1024).photo.dataUrl };
}

test('OpenAI image edit request uses GPT Image 2 multipart image array settings without input_fidelity', async () => {
  let captured;
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/images/edits');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer test-key');
    captured = await new Response(options.body).formData();
    return Response.json({ data: [{ b64_json: Buffer.from([255,216,255,224,1,2,3,4,5,6,7,8]).toString('base64') }] });
  };

  const result = await generateOpenAIEdit('test-key', parsePayload({ ...input(), references: [reference()] }), fetcher);

  assert.match(result, /^data:image\/jpeg;base64,/);
  assert.equal(captured.get('model'), 'gpt-image-2');
  assert.equal(captured.get('size'), '1024x1024');
  assert.equal(captured.get('quality'), 'medium');
  assert.equal(captured.get('output_format'), 'jpeg');
  assert.equal(captured.get('n'), '1');
  assert.equal(captured.get('input_fidelity'), null);
  assert.equal(captured.getAll('image[]').length, 2);
  assert.ok(captured.getAll('image[]')[0] instanceof Blob);
  assert.match(captured.get('prompt'), /Preserve reference facial features as closely as possible/);
  assert.match(captured.get('prompt'), /Do not add extra people, duplicate objects/);
  assert.match(captured.get('prompt'), /컵은 하나만/);
});

test('OpenAI image edit maps auth, billing, rate limit and content-policy failures without leaking upstream details', async () => {
  const payload = parsePayload(input());
  const cases = [
    [401, { error: { message: 'bad key sk-secret' } }, /공급자 인증/, /sk-secret|bad key/],
    [403, { error: { code: 'billing_hard_limit_reached', message: 'billing raw' } }, /결제 한도/, /billing raw/],
    [429, { error: { code: 'insufficient_quota', message: 'quota raw' } }, /결제 한도/, /quota raw/],
    [429, { error: { code: 'rate_limit_exceeded', message: 'rate raw' } }, /요청이 많아/, /rate raw/],
    [400, { error: { code: 'content_policy_violation', message: 'policy raw' } }, /안전 정책/, /policy raw/],
  ];

  for (const [status, body, message, leak] of cases) {
    await assert.rejects(
      () => generateOpenAIEdit('test-key', payload, async () => Response.json(body, { status })),
      error => {
        assert.match(error.message, message);
        assert.doesNotMatch(error.message, leak);
        assert.equal(Number.isInteger(error.status), true);
        return true;
      },
    );
  }
});

test('OpenAI image edit maps timeout errors and rejects malformed image responses', async () => {
  const payload = parsePayload(input());
  await assert.rejects(
    () => generateOpenAIEdit('test-key', payload, async () => { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }),
    /시간이 초과/,
  );
  await assert.rejects(
    () => generateOpenAIEdit('test-key', payload, async () => Response.json({ data: [{ b64_json: Buffer.from('not an image').toString('base64') }] })),
    /형식/,
  );
});
