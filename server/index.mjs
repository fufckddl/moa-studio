import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAuthService } from './auth.mjs';
import { createPaymentService } from './payments.mjs';
import { createStaticHandler } from './static.mjs';
import { generateContentPack, httpError, loadLocalEnv, parseGenerateRequest, statusPayload } from './content.mjs';

loadLocalEnv();
const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
const APP_ORIGIN = new URL(process.env.PUBLIC_APP_URL || 'http://127.0.0.1:5173').origin;

export function createApiServer(options = {}) {
  const auth = options.authService ?? createAuthService({ allowedOrigin: APP_ORIGIN });
  const payments = options.paymentService ?? createPaymentService({ auth, allowedOrigin: APP_ORIGIN });
  const staticDirectory = options.staticDirectory ?? (process.env.NODE_ENV === 'production' ? resolve('dist') : null);
  const serveStatic = staticDirectory ? createStaticHandler(staticDirectory) : null;
  return createServer(async (request, response) => {
    setCors(response);
    if (request.method === 'OPTIONS') return sendJson(response, 204, null);

    try {
      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        response.setHeader('Cache-Control', 'no-store');
        return sendJson(response, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/payments/')) {
        response.setHeader('Cache-Control', 'no-store');
        const rawBody = request.method === 'GET' ? '' : await readBody(request, 32 * 1024);
        const result = await payments.handle(request, rawBody);
        if (result) return sendJson(response, result.status, result.payload);
      }
      if (request.method === 'GET' && url.pathname === '/api/status') {
        return sendJson(response, 200, statusPayload());
      }
      if (request.method === 'POST' && url.pathname === '/api/generate') {
        if (!auth.getUserFromRequest(request)) throw httpError(401, '로그인이 필요합니다.');
        const rawBody = await readBody(request);
        const payload = parseGenerateRequest(rawBody);
        const pack = await generateContentPack(payload);
        return sendJson(response, 200, pack);
      }
      if (url.pathname.startsWith('/api/auth/') || url.pathname === '/api/workspace' || url.pathname === '/api/entitlements') {
        const rawBody = request.method === 'GET' ? '' : await readBody(request);
        const result = await auth.handle(request, rawBody, response);
        if (result?.noStore) response.setHeader('Cache-Control', 'no-store');
        if (result) return sendJson(response, result.status, result.payload);
      }
      if (url.pathname !== '/api' && !url.pathname.startsWith('/api/') && serveStatic && await serveStatic(request, response, url.pathname)) return;
      throw httpError(404, '요청한 경로를 찾을 수 없습니다.');
    } catch (error) {
      const statusCode = error.statusCode || 500;
      const message = statusCode === 500 ? '서버 오류가 발생했습니다.' : error.message;
      return sendJson(response, statusCode, { error: message });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const server = createApiServer();
  server.listen(PORT, HOST, () => {
    console.log(`Moa Studio listening on http://${HOST}:${PORT}`);
  });
}

function readBody(request, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        reject(httpError(413, '요청 본문이 너무 큽니다.'));
        request.pause();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

function setCors(response) {
  response.setHeader('Access-Control-Allow-Origin', APP_ORIGIN);
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Moa-User');
  response.setHeader('Access-Control-Allow-Credentials', 'true');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  if (payload !== null) response.end(JSON.stringify(payload));
  else response.end();
}
