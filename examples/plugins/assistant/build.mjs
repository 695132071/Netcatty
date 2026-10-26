import { URL } from 'node:url';
import { mkdir, copyFile, rm } from 'node:fs/promises';
await mkdir(new URL('./dist/', import.meta.url), { recursive: true });
await copyFile(new URL('./src/index.js', import.meta.url), new URL('./dist/index.js', import.meta.url));
// Build a six-file staging directory. Build scripts and source tooling are never
// part of the installed browser package.
const staging = new URL('./.package/', import.meta.url);
await rm(staging, { recursive: true, force: true });
await mkdir(new URL('./dist/', staging), { recursive: true });
for (const file of ['netcatty.plugin.json', 'panel.html', 'panel.css', 'panel.js', 'README.md', 'dist/index.js']) {
  await copyFile(new URL(file, import.meta.url), new URL(file, staging));
}
