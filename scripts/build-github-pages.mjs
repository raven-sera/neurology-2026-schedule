import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const repository = process.env.GITHUB_REPOSITORY || 'raven-sera/neurology-2026-schedule';
const [owner, name] = repository.split('/');
if (!owner || !name) throw new Error('GITHUB_REPOSITORY must be owner/repository.');
const basePath = (process.env.NEXT_PUBLIC_BASE_PATH ?? (name.toLowerCase() === `${owner}.github.io`.toLowerCase() ? '' : `/${name}`)).replace(/\/$/, '');
if (!/^(?:\/[A-Za-z0-9._-]+)*$/.test(basePath)) throw new Error('Invalid GitHub Pages base path.');
const origin = new URL(process.env.NEXT_PUBLIC_SITE_ORIGIN || `https://${owner}.github.io`).origin;
const result = spawnSync(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_BASE_PATH: basePath, NEXT_PUBLIC_SITE_ORIGIN: origin },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
for (const page of ['index.html', 'learning/index.html', 'schedule/index.html', 'library/index.html', '404.html', 'favicon.svg', 'data/2026神经病学年会日程.xlsx']) {
  if (!existsSync(new URL(`../out/${page}`, import.meta.url))) throw new Error(`Missing export: ${page}`);
}
writeFileSync(new URL('../out/.nojekyll', import.meta.url), '');
writeFileSync(new URL('../out/site-config.json', import.meta.url), JSON.stringify({ basePath, origin }));
console.log(`Website ready: ${origin}${basePath}/`);
