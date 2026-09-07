import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const projectRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const distRoot = join(projectRoot, 'dist');
const ssrRoot = join(projectRoot, 'dist-ssr', 'public');
const entryName = 'public-entry.mjs';

await rm(ssrRoot, { recursive: true, force: true });
await build({
  root: projectRoot,
  configFile: false,
  logLevel: 'warn',
  plugins: [(await import('@vitejs/plugin-react')).default()],
  build: {
    ssr: 'src/public-entry.tsx',
    outDir: ssrRoot,
    emptyOutDir: true,
    copyPublicDir: false,
    rollupOptions: { output: { entryFileNames: entryName } },
  },
});

const template = await readFile(join(distRoot, 'index.html'), 'utf8');
const { appShellRoutes, publicRoutes, renderPublicPath } = await import(pathToFileURL(join(ssrRoot, entryName)).href);

for (const pathname of publicRoutes) {
  const rendered = renderPublicPath(pathname);
  await writeHtml(pathname, applyMeta(template, rendered));
}

const notFound = renderPublicPath('/404');
await writeFile(join(distRoot, '404.html'), applyMeta(template, notFound));

const appShell = applyMeta(template, {
  title: '모아 스튜디오 앱',
  description: '모아 스튜디오 작업 화면입니다.',
  canonical: 'https://moa-studio.pages.dev/studio',
  html: '',
  noindex: true,
});
for (const pathname of appShellRoutes) await writeHtml(pathname, appShell);

await rm(join(projectRoot, 'dist-ssr'), { recursive: true, force: true });
console.log(`Prerendered ${publicRoutes.length} public pages, 404.html, and ${appShellRoutes.length} app shell copies.`);

async function writeHtml(pathname, html) {
  const file = pathname === '/' ? join(distRoot, 'index.html') : join(distRoot, pathname, 'index.html');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, html);
}

function applyMeta(templateHtml, rendered) {
  const robots = rendered.noindex ? '<meta name="robots" content="noindex,nofollow" />' : '<meta name="robots" content="index,follow" />';
  return templateHtml
    .replace(/<html lang="ko">/, `<html lang="ko" data-prerender-status="${rendered.status ?? 200}">`)
    .replace(/<title>.*?<\/title>/, `<title>${escapeHtml(rendered.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeAttribute(rendered.description)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeAttribute(rendered.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeAttribute(rendered.description)}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${escapeAttribute(rendered.canonical)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${escapeAttribute(rendered.canonical)}" />`)
    .replace('</head>', `    ${robots}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${rendered.html}</div>`);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
