/**
 * Generates the PWA's PNG icons with no image dependencies at all — Node's
 * built-in zlib plus a ~40-line PNG chunk writer.
 *
 * Run with: npm run icons
 *
 * The mark is a rising line ending in a marker at its high point — a zenith,
 * which is what the name means — on an indigo-to-blue plate. It echoes the
 * end-dot the app's own line charts draw.
 *
 * Two shapes it deliberately is not: bars on a flat blue square (LinkedIn's
 * silhouette), and a dot centred above a symmetric peak (which reads as a
 * person). The dot matches the stroke's weight so the two read as one mark.
 * Shapes are 4× supersampled for smooth edges.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'assets', 'icons');

const PLATE_TOP: RGB = [74, 58, 167];     // #4a3aa7 indigo (series-7)
const PLATE_BOTTOM: RGB = [42, 120, 214]; // #2a78d6 accent blue
const INK: RGB = [255, 255, 255];

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

function crc32(buffer: Uint8Array): number {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, crc]);
}

/** @param rgba RGBA rows, length = width × height × 4. */
function encodePng(rgba: Uint8Array, width: number, height: number): Buffer {
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

interface RoundedRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  r: number;
}

type RGB = [number, number, number];

interface Point {
  x: number;
  y: number;
}

/** Is (x, y) inside a rounded rectangle? */
function inRoundedRect(x: number, y: number, rect: RoundedRect): boolean {
  const { x0, y0, x1, y1, r } = rect;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r + 1e-9;
}

/**
 * Is (x, y) within `halfWidth` of the segment a→b? This is a round-capped
 * stroke: the distance to a segment, thresholded.
 */
function inCapsule(x: number, y: number, a: Point, b: Point, halfWidth: number): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy)) <= halfWidth;
}

function inCircle(x: number, y: number, centre: Point, radius: number): boolean {
  return Math.hypot(x - centre.x, y - centre.y) <= radius;
}

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

function drawIcon(size: number, { maskable = false }: { maskable?: boolean } = {}): Buffer {
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

  // A line rising left to right, with a marker on its final, highest point.
  const unit = (fx: number, fy: number): Point => ({
    x: inner.x0 + innerW * fx,
    y: inner.y0 + innerH * fy,
  });
  const shorter = Math.min(innerW, innerH);
  // Four points with a dip in the middle: nearly-collinear segments just read as
  // a diagonal bar, whereas a bend gives the mark its chart character.
  const path: Point[] = [
    unit(0.12, 0.70),
    unit(0.35, 0.45),
    unit(0.56, 0.60),
    unit(0.82, 0.20),
  ];
  const strokeHalfWidth = shorter * 0.068;
  const apex = path[path.length - 1] as Point;
  // Only a little heavier than the stroke — enough to read as a marker, not so
  // much that it becomes a head on a stick.
  const apexRadius = shorter * 0.092;

  const step = 1 / SAMPLES;
  const offset = step / 2;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let plateHits = 0;
      let markHits = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + offset + sx * step;
          const y = py + offset + sy * step;
          if (!inRoundedRect(x, y, plate)) continue;
          plateHits++;
          let hit = inCircle(x, y, apex, apexRadius);
          for (let i = 0; !hit && i < path.length - 1; i++) {
            hit = inCapsule(x, y, path[i] as Point, path[i + 1] as Point, strokeHalfWidth);
          }
          if (hit) markHits++;
        }
      }

      const total = SAMPLES * SAMPLES;
      const plateAlpha = plateHits / total;
      if (plateAlpha === 0) continue;

      // Indigo at the top easing into the accent blue gives the plate depth and
      // keeps it clearly distinct from a flat corporate blue.
      const base = mix(PLATE_TOP, PLATE_BOTTOM, py / size);
      const markAlpha = markHits / total;
      const colour = markAlpha > 0 ? mix(base, INK, Math.min(1, markAlpha / plateAlpha)) : base;

      const index = (py * size + px) * 4;
      pixels[index] = colour[0];
      pixels[index + 1] = colour[1];
      pixels[index + 2] = colour[2];
      pixels[index + 3] = Math.round(plateAlpha * 255);
    }
  }

  return encodePng(pixels, size, size);
}

// Hand-authored to match drawIcon's geometry at 64×64.
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Zenith">
  <defs>
    <linearGradient id="plate" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4a3aa7"/>
      <stop offset="1" stop-color="#2a78d6"/>
    </linearGradient>
  </defs>
  <rect x="3.5" y="3.5" width="57" height="57" rx="12.5" fill="url(#plate)"/>
  <path
    d="M12.9 42.4 24.7 29.6 35.4 37.3 48.7 16.8"
    fill="none"
    stroke="#ffffff"
    stroke-width="7"
    stroke-linecap="round"
    stroke-linejoin="round"
  />
  <circle cx="48.7" cy="16.8" r="4.7" fill="#ffffff"/>
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
