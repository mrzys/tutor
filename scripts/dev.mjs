import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['scripts/server.mjs'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, stop);
for (const child of children) {
  child.on('error', error => { console.error(error.message); process.exitCode = 1; stop(); });
  child.on('exit', code => { if (!stopping) { process.exitCode = code || 0; stop(); } });
}
