// Development runner: Vite dev server for the renderer + compiled Electron main.
// Usage: npm run dev
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const electronPath = require('electron');
const tsc = require.resolve('typescript/bin/tsc');

const compiled = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.node.json'], { stdio: 'inherit' });
if (compiled.status !== 0) process.exit(compiled.status ?? 1);

const server = await createServer({ configFile: 'vite.config.mts' });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Vite did not report a local URL.');
console.log(`[dev] renderer at ${url}`);

const electron = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, AEGIS_DEV_SERVER_URL: url },
});
electron.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
