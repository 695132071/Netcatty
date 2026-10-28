import { mkdir, copyFile, rm } from 'node:fs/promises';
import { URL } from 'node:url';
const staging = new URL('./.package/', import.meta.url);
await rm(staging, { recursive: true, force: true });
await mkdir(new URL('./dist/', staging), { recursive: true });
await copyFile(new URL('./src/index.js', import.meta.url), new URL('./dist/index.js', staging));
for (const name of ['netcatty.plugin.json', 'panel.html', 'panel.css', 'panel.js', 'README.md']) {
  await copyFile(new URL(name, import.meta.url), new URL(name, staging));
}
