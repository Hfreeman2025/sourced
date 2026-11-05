import { preview } from 'vite';
import { writeFile, mkdir } from 'node:fs/promises';
const server = await preview({
  configFile: false,
  preview: { host: '127.0.0.1', port: 0, strictPort: true },
});
const address = server.httpServer.address();
if (!address || typeof address === 'string') throw new Error('Preview did not bind a TCP port.');
const info = { pid: process.pid, url: `http://127.0.0.1:${address.port}` };
await mkdir('shots', { recursive: true });
await writeFile('shots/preview-process.json', `${JSON.stringify(info, null, 2)}\n`);
console.log(JSON.stringify(info));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => server.httpServer.close(() => process.exit(0)));
