// Builds the editor page (dist/app) and the VS Code extension (extension/dist).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const r = (...p) => path.join(root, ...p);

await build({ entryPoints: [r('app/src/main.ts')], bundle: true, format: 'iife', platform: 'browser', target: 'es2022', outfile: r('dist/app/app.js'), logLevel: 'warning' });
for (const f of ['index.html', 'app.css']) fs.copyFileSync(r('app', f), r('dist/app', f));

if (fs.existsSync(r('extension/src/extension.ts'))) {
  await build({ entryPoints: [r('extension/src/extension.ts')], bundle: true, format: 'cjs', platform: 'node', target: 'node20', external: ['vscode'], define: { 'import.meta.dirname': '__dirname', 'import.meta.filename': '__filename' }, outfile: r('extension/dist/extension.js'), logLevel: 'warning' });
  fs.mkdirSync(r('extension/dist/app'), { recursive: true });
  for (const f of ['app.js', 'app.css']) fs.copyFileSync(r('dist/app', f), r('extension/dist/app', f));
}
console.log('built');
