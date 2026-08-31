/**
 * Generates the app icons as PNGs.
 *
 * Written by hand against zlib rather than pulling in an image toolchain: the icon is
 * a gradient, a rounded rectangle and an arrow, which is a page of arithmetic, and a
 * build-time native dependency would cost more than it saves.
 *
 * Run with `npm run icons` after changing the artwork.
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

/** Matches --accent and --ok in styles.css, so the icon and the app agree. */
const FROM = [0x2f, 0x6d, 0xf6];
const TO = [0x17, 0xa6, 0x73];

/** Each pixel is averaged over this many samples per axis to get clean edges. */
const SAMPLES = 4;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Signed-distance style test for a rounded rectangle, in pixel space. */
function insideRoundedRect(x, y, size, radius) {
  const inset = 0;
  const min = inset;
  const max = size - inset;
  const cx = Math.min(Math.max(x, min + radius), max - radius);
  const cy = Math.min(Math.max(y, min + radius), max - radius);
  if (x < min || y < min || x > max || y > max) return false;
  const dx = x - cx;
  const dy = y - cy;
  if (dx === 0 || dy === 0) return true;
  return dx * dx + dy * dy <= radius * radius;
}

/** An upward arrow: triangular head over a rectangular stem. */
function insideArrow(x, y, size) {
  const u = x / size;
  const v = y / size;

  const headTop = 0.24;
  const headBottom = 0.5;
  const headHalfWidth = 0.24;
  if (v >= headTop && v <= headBottom) {
    const spread = ((v - headTop) / (headBottom - headTop)) * headHalfWidth;
    if (Math.abs(u - 0.5) <= spread) return true;
  }

  const stemHalfWidth = 0.085;
  if (v > headBottom - 0.001 && v <= 0.78 && Math.abs(u - 0.5) <= stemHalfWidth) return true;

  return false;
}

function renderIcon(size, { maskable }) {
  const pixels = Buffer.alloc(size * size * 4);
  // Maskable icons get cropped to a circle by the platform, so the background runs to
  // the edges and the glyph shrinks inside the safe zone instead of being clipped.
  const radius = maskable ? 0 : size * 0.22;
  const glyphScale = maskable ? 0.72 : 1;

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let coverage = 0;
      let glyph = 0;

      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = px + (sx + 0.5) / SAMPLES;
          const y = py + (sy + 0.5) / SAMPLES;
          if (!insideRoundedRect(x, y, size, radius)) continue;
          coverage += 1;

          const gx = (x - size / 2) / glyphScale + size / 2;
          const gy = (y - size / 2) / glyphScale + size / 2;
          if (insideArrow(gx, gy, size)) glyph += 1;
        }
      }

      const total = SAMPLES * SAMPLES;
      const alpha = coverage / total;
      const glyphAlpha = glyph / total;

      const t = (px / size + py / size) / 2;
      const base = [lerp(FROM[0], TO[0], t), lerp(FROM[1], TO[1], t), lerp(FROM[2], TO[2], t)];
      const colour = base.map((c) => Math.round(lerp(c, 255, glyphAlpha)));

      const offset = (py * size + px) * 4;
      pixels[offset] = colour[0];
      pixels[offset + 1] = colour[1];
      pixels[offset + 2] = colour[2];
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  }

  return encodePng(size, size, pixels);
}

// --- PNG encoding ----------------------------------------------------------

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
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // colour type: RGBA
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // One filter byte per scanline; filter 0 keeps the encoder trivial.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// --- output ----------------------------------------------------------------

mkdirSync(OUT, { recursive: true });

const targets = [
  { file: "icon-192.png", size: 192, maskable: false },
  { file: "icon-512.png", size: 512, maskable: false },
  { file: "icon-maskable-512.png", size: 512, maskable: true },
  { file: "apple-touch-icon.png", size: 180, maskable: false },
  { file: "favicon-32.png", size: 32, maskable: false },
];

for (const target of targets) {
  const png = renderIcon(target.size, { maskable: target.maskable });
  writeFileSync(join(OUT, target.file), png);
  console.log(`${target.file}  ${target.size}x${target.size}  ${png.length} bytes`);
}
