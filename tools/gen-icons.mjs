/**
 * Generates the PWA's PNG icons with no image dependencies at all — Node's
 * built-in zlib plus a ~40-line PNG chunk writer.
 *
 * Run with: npm run icons
 *
 * The mark is three ascending bars (the app's own chart language) on the accent
 * blue. Shapes are 4× supersampled so the rounded corners are smooth.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'assets', 'icons');

const ACCENT = [42, 120, 214];      // #2a78d6
const ACCENT_DEEP = [28, 92, 171];  // #1c5cab
const INK = [255, 255, 255];

const SAMPLES = 4;

/* ── PNG writing ──────────────────────────────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param {Uint8Array} rgba RGBA rows, length = width*height*4 */
function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // colour type: RGBA
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── Geometry ─────────────────────────────────────────────────────────── */

/** Signed test: is (x, y) inside a rounded rectangle? */
function inRoundedRect(x, y, rect) {
  const { x0, y0, x1, y1, r } = rect;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * @param {number} size
 * @param {{maskable?: boolean}} opts
 */
function drawIcon(size, { maskable = false } = {}) {
  const pixels = new Uint8Array(size * size * 4);

  // Maskable icons must survive an aggressive circular crop: keep the artwork
  // inside the middle 80% and let the background bleed to the edges.
  const pad = maskable ? 0 : size * 0.055;
  const plate = {
    x0: pad,
    y0: pad,
    x1: size - pad,
    y1: size - pad,
    r: maskable ? 0 : size * 0.22,
  };

  const safe = maskable ? size * 0.1 : 0;
  const inner = {
    x0: plate.x0 + safe,
    y0: plate.y0 + safe,
    x1: plate.x1 - safe,
    y1: plate.y1 - safe,
  };
  const innerW = inner.x1 - inner.x0;
  const innerH = inner.y1 - inner.y0;

  // Three ascending bars, 4px-equivalent rounded tops, sharing a baseline.
  const barGap = innerW * 0.085;
  const barW = (innerW * 0.62 - barGap * 2) / 3;
  const barsLeft = inner.x0 + innerW * 0.19;
  const baseline = inner.y0 + innerH * 0.78;
  const heights = [0.3, 0.46, 0.62].map((factor) => innerH * factor);
  const bars = heights.map((height, index) => ({
    x0: barsLeft + index * (barW + barGap),
    x1: barsLeft + index * (barW + barGap) + barW,
    y0: baseline - height,
    y1: baseline,
    r: Math.min(barW / 2, size * 0.03),
  }));

  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let plateHits = 0;
      let barHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + offset + sx * step;
          const y = py + offset + sy * step;
          if (!inRoundedRect(x, y, plate)) continue;
          plateHits++;
          for (const bar of bars) {
            if (inRoundedRect(x, y, bar)) {
              barHits++;
              break;
            }
          }
        }
      }

      const total = SAMPLES * SAMPLES;
      const plateAlpha = plateHits / total;
      if (plateAlpha === 0) continue;

      // Vertical gradient on the plate gives the mark a little depth.
      const base = mix(ACCENT, ACCENT_DEEP, py / size);
      const barAlpha = barHits / total;
      const colour = barAlpha > 0 ? mix(base, INK, Math.min(1, barAlpha / plateAlpha)) : base;

      const index = (py * size + px) * 4;
      pixels[index] = colour[0];
      pixels[index + 1] = colour[1];
      pixels[index + 2] = colour[2];
      pixels[index + 3] = Math.round(plateAlpha * 255);
    }
  }

  return encodePng(pixels, size, size);
}

const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Zenith">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a78d6"/>
      <stop offset="1" stop-color="#1c5cab"/>
    </linearGradient>
  </defs>
  <rect x="3.5" y="3.5" width="57" height="57" rx="13" fill="url(#plate)"/>
  <g fill="#ffffff">
    <rect x="15" y="34.5" width="9" height="14" rx="2.5"/>
    <rect x="27.5" y="27.5" width="9" height="21" rx="2.5"/>
    <rect x="40" y="20.5" width="9" height="28" rx="2.5"/>
  </g>
</svg>
`;

mkdirSync(OUT_DIR, { recursive: true });

const targets = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'maskable-192.png', size: 192, maskable: true },
  { file: 'maskable-512.png', size: 512, maskable: true },
];

for (const target of targets) {
  const png = drawIcon(target.size, { maskable: target.maskable });
  writeFileSync(join(OUT_DIR, target.file), png);
  console.log(`wrote ${target.file} (${target.size}×${target.size}, ${png.length} bytes)`);
}

writeFileSync(join(OUT_DIR, 'favicon.svg'), FAVICON_SVG);
console.log('wrote favicon.svg');
