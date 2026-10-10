import { copyFile } from 'node:fs/promises';
await copyFile(new URL('../src/model.mjs', import.meta.url), new URL('../public/model.mjs', import.meta.url));
console.log('Browser financial model copied from tested source');
