import { loadEnv } from 'vite';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const env = loadEnv('production', process.cwd(), '');
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url) || !key?.startsWith('sb_publishable_')) {
  throw new Error('cloud.env.example에 따라 .env.production.local의 Supabase 공개 설정을 먼저 입력하세요.');
}
const secrets = ['TOSS_SECRET_KEY', 'OPENAI_API_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']
  .map(name => env[name]).filter(value => value && value.length > 12);
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.env') || entry.name.endsWith('.sqlite')) throw new Error('배포 폴더에 비공개 파일이 있습니다.');
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else {
      const content = await readFile(path);
      if (secrets.some(secret => content.includes(Buffer.from(secret)))) throw new Error('배포 파일에 서버 비밀키가 포함되어 있습니다. 배포를 중단합니다.');
    }
  }
}
await inspect('dist');
console.log('클라우드 빌드 설정과 비밀키 미포함 검사 통과');
