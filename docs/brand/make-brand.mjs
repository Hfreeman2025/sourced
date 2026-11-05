// Builds Harry Freeman's maker's mark: the README badge and the square monogram.
//
// The look is the brass nameplate from his site's office door: an ink cell and a
// brass plate with a darker bevelled edge, the name engraved with a light line
// beneath it. Lettering is IBM Plex Sans Condensed SemiBold, converted to outlined
// paths so the SVGs need no font (GitHub strips web fonts from READMEs).
//
// Usage: node make-brand.mjs <ibm-plex-sans-condensed-latin-600-normal.woff> <opentype.js module path>
// The WOFF ships in @fontsource/ibm-plex-sans-condensed 5.3.0 (files/); opentype.js 1.3.4 reads WOFF.
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const [fontFile, opentypeModule] = process.argv.slice(2);
if (!fontFile || !opentypeModule) throw new Error('Usage: node make-brand.mjs <font.woff> <opentype.module.js>');
const { default: opentype } = await import(pathToFileURL(opentypeModule).href);
const bytes = await readFile(fontFile);
const font = opentype.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));

const INK = '#1f2433';
const BRASS_EDGE = '#d9a63b';
const BRASS_FACE = '#f0c766';
const ENGRAVED = '#3b2a08';
const HIGHLIGHT = '#fbe6ad';
const SCREW = '#c48f2a';
const SCREW_SLOT = '#7d5a17';

const round = (n) => Math.round(n * 100) / 100;
/** Outlined text: its path, its width, and its cap height, at a size. */
function lettering(text, size, x, baseline) {
  const path = font.getPath(text, x, baseline, size, { kerning: true });
  return { d: path.toPathData(2), width: font.getAdvanceWidth(text, size, { kerning: true }) };
}
const capHeight = (size) => (font.tables.os2.sCapHeight / font.unitsPerEm) * size;

function screw(cx, cy) {
  return `<circle cx="${round(cx)}" cy="${round(cy)}" r="1.5" fill="${SCREW}"/><path d="M${round(cx - 1)} ${round(cy + 0.55)}L${round(cx + 1)} ${round(cy - 0.55)}" stroke="${SCREW_SLOT}" stroke-width="0.6"/>`;
}

/** The badge: 24px tall, an ink cell with the monogram, then the brass plate. */
function badge(name) {
  const height = 24, cell = 28, size = 13, pad = 11;
  const baseline = height / 2 + capHeight(size) / 2;
  const nameWidth = lettering(name, size, 0, 0).width;
  const width = Math.ceil(cell + pad + nameWidth + pad);
  const monogram = lettering('HF', size, 0, 0);
  const mono = lettering('HF', size, round(1 + (cell - 1 - monogram.width) / 2), round(baseline));
  const engraved = lettering(name, size, cell + pad, round(baseline));
  const highlight = lettering(name, size, cell + pad, round(baseline + 0.75));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${name}">
<title>${name}</title>
<rect width="${width}" height="${height}" rx="3" fill="${BRASS_EDGE}"/>
<rect x="${cell}" y="1.5" width="${width - cell - 1.5}" height="${height - 3}" rx="1.5" fill="${BRASS_FACE}"/>
<rect x="1" y="1" width="${cell - 1}" height="${height - 2}" rx="2" fill="${INK}"/>
<path d="${mono.d}" fill="${BRASS_FACE}"/>
<path d="${highlight.d}" fill="${HIGHLIGHT}"/>
<path d="${engraved.d}" fill="${ENGRAVED}"/>
${screw(cell + 5, height / 2)}${screw(width - 5, height / 2)}
</svg>
`;
}

/** The square monogram for favicons: a brass edge round an ink field, HF in brass. */
function mark() {
  const size = 64, edge = 4, letter = 42;
  const probe = lettering('HF', letter, 0, 0);
  const baseline = size / 2 + capHeight(letter) / 2;
  const hf = lettering('HF', letter, round((size - probe.width) / 2), round(baseline));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" role="img" aria-label="Harry Freeman">
<title>Harry Freeman</title>
<rect width="${size}" height="${size}" rx="10" fill="${BRASS_EDGE}"/>
<rect x="${edge}" y="${edge}" width="${size - 2 * edge}" height="${size - 2 * edge}" rx="7" fill="${INK}"/>
<path d="${hf.d}" fill="${BRASS_FACE}"/>
</svg>
`;
}

const here = new URL('.', import.meta.url);
await writeFile(new URL('hf-badge.svg', here), badge('Harry Freeman'));
await writeFile(new URL('hf-badge-lab.svg', here), badge('Harry Freeman · Lab'));
await writeFile(new URL('hf-mark.svg', here), mark());
console.log('Wrote hf-badge.svg, hf-badge-lab.svg and hf-mark.svg.');
