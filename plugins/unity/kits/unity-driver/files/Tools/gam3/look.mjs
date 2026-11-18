#!/usr/bin/env node
// Two checks on pictures that a single screenshot cannot make. No dependencies; reads 8-bit PNG files.
//
//   node Tools/gam3/look.mjs blink A.png B.png C.png [...] [--out heat.png] [--threshold 24] [--max-percent 0.5]
//       Blinking, as opposed to motion. A burst of frames taken a fraction of a second apart, same size. A pixel
//       blinks when it changes in one frame and changes back in the next: for frames a, b, c it differs from both
//       neighbours while the neighbours agree. A moving camera or character never does that, so the burst may be
//       taken during play. Reports the worst frame's share of blinking pixels and, with --out, a picture with the
//       blinking pixels in red. This is how shadow crawl, z-fighting and flickering lights are caught: none of them
//       shows in one frame.
//
//   node Tools/gam3/look.mjs shimmer A.png B.png C.png [...] [--out heat.png] [--threshold 20] [--max-percent 2]
//       For a burst taken with the camera and the scene held still (a fixed camera, nothing moving): the share of
//       pixels whose brightness wanders by more than the threshold across the burst. A still scene should not
//       change at all, so this catches the slower faults blink misses: a shadow edge that crawls, noise that
//       boils, an edge that shimmers without anti-aliasing.
//
//   node Tools/gam3/look.mjs compare REFERENCE.png OTHER.png [--max-contrast-loss 25] [--max-brightness-shift 25]
//                                                            [--max-black-lift 8]
//       The same view on two renderers, tiers or platforms (full quality against the mobile or web build). The
//       pictures need not match pixel for pixel or in size. Reports brightness, contrast, how much of the picture
//       is dark, the black level (how dark the darkest twentieth is) and saturation for each, and fails when the other
//       has lost its contrast, shifted in brightness or lifted its blacks:
//       the washed-out, flat or blown-out look that a platform build gets when its lighting path differs.
//
// Exit code 1 when a limit is passed. The summary line starts GAM3LOOK:.
import fs from 'node:fs';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

/** Decode an 8-bit, non-interlaced PNG (grey, RGB or RGBA) to { width, height, lum: Uint8Array, rgb: Uint8Array }. */
export function readPng(file) {
  const buf = fs.readFileSync(file);
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);
  let pos = 8, width = 0, height = 0, type = 0;
  const data = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const name = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (name === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4); type = body[9];
      if (body[8] !== 8 || body[12] !== 0 || ![0, 2, 4, 6].includes(type)) throw new Error(`${file}: only 8-bit, non-interlaced grey, RGB or RGBA PNG is read`);
    } else if (name === 'IDAT') data.push(body);
    else if (name === 'IEND') break;
    pos += 12 + len;
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(data));
  const stride = width * bpp;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = up ? up[x] : 0;
      const c = up && x >= bpp ? up[x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[x] = v & 255;
    }
  }
  const lum = new Uint8Array(width * height);
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    const r = px[i * bpp], g = bpp >= 3 ? px[i * bpp + 1] : r, b = bpp >= 3 ? px[i * bpp + 2] : r;
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
    lum[i] = (r * 54 + g * 183 + b * 19) >> 8;
  }
  return { width, height, lum, rgb };
}

const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc(buf) { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(name, body) {
  const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(name, 4, 'latin1');
  const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, tail]);
}
export function writePng(file, width, height, rgb) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * width * 3, width * 3).copy(raw, y * (width * 3 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

/** Share of pixels (percent) that blink in the worst frame of a burst, and a mask of every pixel that ever blinked. */
export function blink(frames, threshold = 24) {
  const { width, height } = frames[0];
  for (const f of frames) if (f.width !== width || f.height !== height) throw new Error('the frames of a burst must be the same size');
  const mask = new Uint8Array(width * height);
  let worst = 0;
  for (let i = 1; i + 1 < frames.length; i++) {
    const a = frames[i - 1].lum, b = frames[i].lum, c = frames[i + 1].lum;
    let n = 0;
    for (let p = 0; p < b.length; p++) {
      if (Math.abs(b[p] - a[p]) > threshold && Math.abs(b[p] - c[p]) > threshold && Math.abs(a[p] - c[p]) < threshold / 2) { n++; mask[p] = 1; }
    }
    worst = Math.max(worst, (100 * n) / b.length);
  }
  return { worst, mask, width, height };
}

/** Brightness, contrast, dark share and saturation of one picture, each 0-100. */
export function lookOf(img) {
  let sum = 0, sq = 0, dark = 0, sat = 0;
  const n = img.lum.length;
  for (let i = 0; i < n; i++) {
    const l = img.lum[i];
    sum += l; sq += l * l;
    if (l < 40) dark++;
    const r = img.rgb[i * 3], g = img.rgb[i * 3 + 1], b = img.rgb[i * 3 + 2];
    const mx = Math.max(r, g, b);
    sat += mx ? (mx - Math.min(r, g, b)) / mx : 0;
  }
  const mean = sum / n;
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[img.lum[i]]++;
  let black = 0;
  for (let seen = 0; black < 255 && (seen += hist[black]) < n / 20; black++);
  return { black: (100 * black) / 255, brightness: (100 * mean) / 255, contrast: (100 * Math.sqrt(Math.max(0, sq / n - mean * mean))) / 128, dark: (100 * dark) / n, saturation: (100 * sat) / n };
}

function parse(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (m) out[m[1]] = argv[++i]; else out._.push(argv[i]);
  }
  return out;
}

function main(argv) {
  const a = parse(argv);
  const [cmd, ...files] = a._;
  if (cmd === 'blink' && files.length >= 3) {
    const r = blink(files.map(readPng), Number(a.threshold ?? 24));
    if (a.out) {
      const base = readPng(files[0]);
      const rgb = new Uint8Array(base.rgb.length);
      for (let p = 0; p < r.mask.length; p++) {
        if (r.mask[p]) { rgb[p * 3] = 255; } else { const v = base.lum[p] / 3; rgb[p * 3] = v; rgb[p * 3 + 1] = v; rgb[p * 3 + 2] = v; }
      }
      writePng(a.out, r.width, r.height, rgb);
    }
    const max = Number(a['max-percent'] ?? 0.5);
    const ok = r.worst <= max;
    console.log(`GAM3LOOK: ${ok ? 'ok' : 'FAILED'} blink frames=${files.length} worst_percent=${r.worst.toFixed(2)} limit=${max}${a.out ? ` heat=${a.out}` : ''}`);
    return ok ? 0 : 1;
  }
  if (cmd === 'shimmer' && files.length >= 3) {
    const frames = files.map(readPng);
    const { width, height } = frames[0];
    const t = Number(a.threshold ?? 20);
    const rgb = new Uint8Array(width * height * 3);
    let n = 0;
    for (let p = 0; p < width * height; p++) {
      let lo = 255, hi = 0;
      for (const f of frames) { const v = f.lum[p]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const moved = hi - lo > t;
      if (moved) n++;
      const v = frames[0].lum[p] / 3;
      rgb[p * 3] = moved ? 255 : v; rgb[p * 3 + 1] = moved ? 0 : v; rgb[p * 3 + 2] = moved ? 0 : v;
    }
    if (a.out) writePng(a.out, width, height, rgb);
    const share = (100 * n) / (width * height);
    const max = Number(a['max-percent'] ?? 2);
    console.log(`GAM3LOOK: ${share <= max ? 'ok' : 'FAILED'} shimmer frames=${files.length} percent=${share.toFixed(2)} limit=${max}${a.out ? ` heat=${a.out}` : ''}`);
    return share <= max ? 0 : 1;
  }
  if (cmd === 'compare' && files.length === 2) {
    const [ref, other] = files.map((f) => lookOf(readPng(f)));
    const line = (name, l) => `${name.padEnd(10)} brightness ${l.brightness.toFixed(0).padStart(3)}  contrast ${l.contrast.toFixed(0).padStart(3)}  black level ${l.black.toFixed(0).padStart(3)}  dark ${l.dark.toFixed(0).padStart(3)}%  saturation ${l.saturation.toFixed(0).padStart(3)}`;
    console.log(line('reference', ref));
    console.log(line('other', other));
    const loss = ref.contrast ? (100 * (ref.contrast - other.contrast)) / ref.contrast : 0;
    const shift = other.brightness - ref.brightness;
    const lift = other.black - ref.black;
    const ok = loss <= Number(a['max-contrast-loss'] ?? 25) && Math.abs(shift) <= Number(a['max-brightness-shift'] ?? 25) && lift <= Number(a['max-black-lift'] ?? 8);
    console.log(`GAM3LOOK: ${ok ? 'ok' : 'FAILED'} compare contrast_loss_percent=${loss.toFixed(0)} brightness_shift=${shift.toFixed(0)} black_lift=${lift.toFixed(0)} dark_share=${ref.dark.toFixed(0)}->${other.dark.toFixed(0)}`);
    return ok ? 0 : 1;
  }
  console.error('usage: look.mjs blink A.png B.png C.png [...] [--out heat.png] [--threshold 24] [--max-percent 0.5]\n       look.mjs shimmer A.png B.png C.png [...] [--out heat.png] [--threshold 20] [--max-percent 2]\n       look.mjs compare REFERENCE.png OTHER.png [--max-contrast-loss 25] [--max-brightness-shift 25]');
  return 2;
}

if (process.argv[1] && pathToFileURL(fs.realpathSync(path.resolve(process.argv[1]))).href === import.meta.url) {
  try { process.exit(main(process.argv.slice(2))); } catch (e) { console.error(e.message); process.exit(2); }
}
