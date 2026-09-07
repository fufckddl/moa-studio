import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

export function createStaticHandler(directory) {
  const root = resolve(directory);
  return async function serveStatic(request, response, pathname) {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return false; }
    if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) return false;
    const extension = extname(decoded);
    const appRoute = /^\/studio(?:\/(?:library|brand))?\/?$/.test(decoded) || decoded === '/auth/reset-password';
    let status = 200;
    let file = resolve(root, '.' + (extension ? decoded : decoded === '/' ? '/index.html' : `${decoded.replace(/\/$/, '')}/index.html`));
    if (!extension) {
      try { await stat(file); } catch {
        if (appRoute) file = resolve(root, 'index.html');
        else { file = resolve(root, '404.html'); status = 404; }
      }
    }
    if (!file.startsWith(root + sep) || !TYPES[extname(file)]) return false;
    try {
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(file)]);
      if (!actualFile.startsWith(actualRoot + sep)) return false;
      const info = await stat(actualFile);
      if (!info.isFile()) return false;
      const content = request.method === 'HEAD' ? null : await readFile(actualFile);
      response.writeHead(status, {
        'Content-Type': TYPES[extname(file)],
        'Content-Length': content?.length ?? info.size,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
      });
      response.end(content);
      return true;
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes(error.code)) return false;
      throw error;
    }
  };
}
