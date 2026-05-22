#!/usr/bin/env node
// Render the Beam glyph SVG to the PNG sizes Chrome expects.
//
// MV3 manifests can reference 16/32/48/128 px icons under public/icon/<size>.png.
// WXT auto-detects this convention — no wxt.config.ts changes needed.
//
// Run via `pnpm icons` whenever icon.svg changes. Outputs are committed; the
// build doesn't depend on this script at runtime.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'icon.svg');
const OUT_DIR = resolve(HERE, '..', 'public', 'icon');

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="128" y2="128" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#6366f1"/>
      <stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="28" fill="url(#g)"/>
  <path d="M36 88V40h24a18 18 0 0 1 10.4 32.8A18 18 0 0 1 62 88zm12-28h12a6 6 0 0 0 0-12H48zm0 20h14a6 6 0 0 0 0-12H48z" fill="#fff"/>
</svg>
`;

writeFileSync(SRC, SVG);
mkdirSync(OUT_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const resvg = new Resvg(SVG, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  const out = resolve(OUT_DIR, `${size}.png`);
  writeFileSync(out, png);
  console.log(`  ${size}×${size} → ${out} (${png.length} B)`);
}
