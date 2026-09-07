import { spawn } from 'node:child_process';
const processes = [spawn(process.execPath, ['--watch', 'server/index.mjs'], { stdio: 'inherit' }), spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' })];
function close() { for (const child of processes) child.kill('SIGTERM'); }
process.on('SIGINT', () => { close(); process.exit(0); });
process.on('SIGTERM', () => { close(); process.exit(0); });
for (const child of processes) child.on('exit', (code) => { if (code && code !== 0) { close(); process.exit(code); } });
