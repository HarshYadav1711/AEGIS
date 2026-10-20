// Launches the built app in smoke mode (see electron/smoke.ts) and relays its verdict.
// Usage: npm run smoke   (optionally set AEGIS_SMOKE_SCREENSHOT_DIR to save screenshots)
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const child = spawn(electronPath, ['.'], {
  stdio: ['ignore', 'pipe', 'inherit'],
  env: { ...process.env, AEGIS_SMOKE: '1', AEGIS_DEV_SERVER_URL: '' },
});
let verdict = null;
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  const match = /AEGIS_SMOKE_RESULT (.+)/.exec(chunk);
  if (match) verdict = JSON.parse(match[1]);
});
const timer = setTimeout(() => {
  console.error('[smoke] timed out after 900 s');
  child.kill();
}, 900_000);
child.on('exit', (code) => {
  clearTimeout(timer);
  if (!verdict) {
    console.error(`[smoke] no result reported (exit ${code})`);
    process.exit(1);
  }
  for (const check of verdict.checks) {
    console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? `  (${check.detail})` : ''}`);
  }
  process.exit(verdict.ok && code === 0 ? 0 : 1);
});
