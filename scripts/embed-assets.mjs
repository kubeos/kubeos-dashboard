/**
 * Regenerates src/assets.ts from the PNGs in src/assets/.
 *
 * Why base64 instead of importing the PNGs: `@kinvolk/headlamp-plugin build` is an
 * esbuild pipeline tuned for React/SVG imports, and a plugin that ships under
 * /headlamp/plugins has no static-file server behind it. A data URI is the one form
 * that is guaranteed to render in every Headlamp version without bundler config.
 *
 * Run: node scripts/embed-assets.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(here, '..', 'kubeos-branding', 'src', 'assets');
const outFile = join(here, '..', 'kubeos-branding', 'src', 'assets.ts');

const MIME = { '.png': 'image/png', '.svg': 'image/svg+xml' };

const entries = readdirSync(assetsDir)
  .filter(f => MIME[extname(f)])
  .sort();

const lines = [
  '// GENERATED FILE - do not edit by hand. Run: node scripts/embed-assets.mjs',
  '// Source images live in ./assets/ and are KubeOS artwork; do not redraw them.',
  '',
];

for (const file of entries) {
  const name = basename(file, extname(file)).replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
  const b64 = readFileSync(join(assetsDir, file)).toString('base64');
  lines.push(`/** ${file} */`);
  lines.push(`export const ${name} = 'data:${MIME[extname(file)]};base64,${b64}';`);
  lines.push('');
}

writeFileSync(outFile, lines.join('\n'));
const bytes = lines.join('\n').length;
console.log(`wrote ${outFile} (${entries.length} assets, ${(bytes / 1024).toFixed(1)} KiB)`);
