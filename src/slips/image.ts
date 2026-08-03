// Ingest-time re-encode (docs/plan-audit-hub-slips.md's binding "Storage
// rules"): EXIF stripped, long edge capped ~2200px, quality tuned for
// crisp slip-text legibility (amounts/account numbers readable), plus a
// small cached thumbnail derivative. Two independent codecs:
//
// - sharp (preferred): native libvips binding, fast, high quality.
// - jimp (fallback): pure JS, zero native bindings, works on any platform.
//
// Verdict (2026-08-03, no Docker available in this environment): `bun add
// sharp` + a real re-encode (EXIF strip, long-edge cap, no-upscale-on-small-
// input, orientation-aware rotation) were verified working end-to-end under
// Bun 1.3.9 on darwin-arm64 — see image.test.ts. sharp 0.35.3 ships a
// prebuilt `@img/sharp-linuxmusl-x64` binary matching the Dockerfile's
// actual deploy target (oven/bun:1.3-alpine, linux/amd64 per deploy.yml),
// and this Bun version was independently observed to install ONLY the
// platform-matching optional package locally (not every platform), which is
// encouraging evidence for correct libc-aware resolution — but the alpine/
// musl combination itself was never run here. `loadSharp()` below therefore
// loads sharp lazily and falls back to jimp on ANY failure (missing
// binding, wrong libc variant, whatever) so a load failure degrades a
// single upload's quality instead of crash-looping the container — the same
// class of failure this repo family's Dockerfile-COPY gotcha already caused
// once (see CLAUDE.md).

export class SlipImageError extends Error {}

export type SniffedFormat = "jpeg" | "png";

const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesMagic(bytes: Uint8Array, magic: readonly number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) {
    if (bytes[i] !== magic[i]) return false;
  }
  return true;
}

/** Sniffs the real file type from its own leading bytes — NEVER trusts a
 * declared Content-Type/filename extension, which a client can set to
 * anything. `null` for anything that isn't a JPEG or PNG. PURE. */
export function sniffImageFormat(bytes: Uint8Array): SniffedFormat | null {
  if (matchesMagic(bytes, JPEG_MAGIC)) return "jpeg";
  if (matchesMagic(bytes, PNG_MAGIC)) return "png";
  return null;
}

export const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const LONG_EDGE = 2200;
const QUALITY = 82;
const THUMB_LONG_EDGE = 480;
const THUMB_QUALITY = 70;

// B3 (Opus security review, 2026-08-03, CONFIRMED EXPLOITABLE): a
// 17000x17000 PNG (~860KB compressed, 289 megapixels) was submitted and
// SUCCEEDED via the jimp fallback (12s CPU, +420MB RSS) — jimp has NO pixel
// cap, and the old code treated EVERY sharp failure (including sharp's own
// "Input image exceeds pixel limit" rejection) as "sharp unavailable,
// retry with jimp", laundering a deliberate rejection into an unlimited-
// engine success. Two independent fixes:
//
// 1. `readImageDimensions` parses width/height straight from the PNG IHDR
//    chunk / JPEG SOF marker — a few bytes, BEFORE either engine ever
//    touches the pixel data — and `encodeSlipImage` rejects anything over
//    `MAX_INPUT_PIXELS` immediately. This is the primary, engine-
//    independent gate.
// 2. `encodeSlipImage` no longer falls back to jimp on a per-image sharp
//    failure — see its own doc comment below for why that distinction
//    (module-load failure vs. per-image rejection) is what actually closes
//    this hole.
//
// 40 megapixels is comfortably above any real phone/camera slip photo
// (a 48MP phone photo is ~48M px; slips are typically far smaller) and far
// below the proven 289-megapixel bomb.
export const MAX_INPUT_PIXELS = 40_000_000;

export interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Parses width/height directly from the PNG IHDR chunk or the first JPEG
 * SOF (Start Of Frame) marker — a header-only read of a handful of bytes,
 * never a full decode. `null` when the bytes don't parse this way cleanly
 * (never expected for a magic-byte-sniffed JPEG/PNG in practice, but this
 * runs over fully untrusted bytes, so it degrades to "can't tell" rather
 * than throwing — the caller treats `null` as "no pre-check possible",
 * NOT as "safe", so a format this can't parse still goes through the
 * engines' own limits). PURE.
 */
export function readImageDimensions(bytes: Uint8Array, format: SniffedFormat): ImageDimensions | null {
  return format === "png" ? readPngDimensions(bytes) : readJpegDimensions(bytes);
}

/** PNG: 8-byte signature, then the IHDR chunk is ALWAYS first — 4-byte
 * length, 4-byte "IHDR" ascii, then big-endian width (4 bytes) and height
 * (4 bytes). */
function readPngDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 24) return null;
  const chunkType = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
  if (chunkType !== "IHDR") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16, false), height: view.getUint32(20, false) };
}

/** JPEG: walk markers after the SOI (0xFFD8) until a SOF marker (0xC0-0xCF,
 * excluding 0xC4/DHT, 0xC8/JPG, 0xCC/DAC, which share the numeric range but
 * aren't frame headers) — its payload is `[precision:1][height:2][width:2]`
 * (big-endian), all after the 2-byte segment-length field every OTHER
 * marker also carries. Markers with no length/payload (RST0-7, TEM) are
 * skipped without reading a length. */
function readJpegDimensions(bytes: Uint8Array): ImageDimensions | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2; // skip SOI
  while (offset + 2 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null; // malformed — not a marker where one was expected
    const marker = bytes[offset + 1]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2; // RST0-7 / TEM / SOI / EOI — no length field
      continue;
    }
    if (offset + 4 > bytes.length) return null;
    const segmentLength = view.getUint16(offset + 2, false);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > bytes.length) return null;
      return { height: view.getUint16(offset + 5, false), width: view.getUint16(offset + 7, false) };
    }
    if (segmentLength < 2) return null; // malformed — would loop forever otherwise
    offset += 2 + segmentLength;
  }
  return null;
}

export type ImageEngine = "sharp" | "jimp";

export interface EncodedSlipImage {
  buffer: Uint8Array;
  thumbBuffer: Uint8Array;
  width: number;
  height: number;
  format: "jpeg";
  engine: ImageEngine;
}

type SharpFactory = (input: Buffer) => import("sharp").Sharp;

let sharpModuleCache: SharpFactory | null | undefined;

/** Loads sharp lazily, caching success OR failure for the process's whole
 * life — a failed load never retries on every request. */
export async function loadSharp(): Promise<SharpFactory | null> {
  if (sharpModuleCache !== undefined) return sharpModuleCache;
  try {
    const mod: unknown = await import("sharp");
    const fn = typeof mod === "function" ? mod : (mod as { default?: unknown }).default;
    if (typeof fn !== "function") throw new Error("unexpected sharp module shape");
    sharpModuleCache = fn as SharpFactory;
  } catch (err) {
    console.warn(
      `slips/image: sharp unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to jimp for every re-encode this process`,
    );
    sharpModuleCache = null;
  }
  return sharpModuleCache;
}

/**
 * `.rotate()` (no args) bakes the EXIF orientation into the actual pixels
 * BEFORE resize runs — resize's own `{width:LONG_EDGE,height:LONG_EDGE,
 * fit:"inside"}` box then caps whichever edge ends up longest post-rotation,
 * with no need to pre-compute rotated dimensions (verified in image.test.ts:
 * pre-computing from PRE-rotation metadata under-shoots the cap by
 * double-constraining the resize box against the wrong orientation).
 * `.clone()` branches the decoded pipeline so main + thumb share one decode.
 * Output is never `.withMetadata()`'d, so EXIF/ICC/XMP are dropped by
 * sharp's own default (verified: the re-encoded bytes contain no `Exif`
 * marker at all).
 */
async function encodeWithSharp(sharpFn: SharpFactory, input: Uint8Array): Promise<EncodedSlipImage> {
  const base = sharpFn(Buffer.from(input)).rotate();
  const mainResult = await base
    .clone()
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  const thumbBuffer = await base
    .clone()
    .resize({ width: THUMB_LONG_EDGE, height: THUMB_LONG_EDGE, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY })
    .toBuffer();

  return {
    buffer: new Uint8Array(mainResult.data),
    thumbBuffer: new Uint8Array(thumbBuffer),
    width: mainResult.info.width,
    height: mainResult.info.height,
    format: "jpeg",
    engine: "sharp",
  };
}

/** jimp v1 auto-orients on read (verified in image.test.ts: a source with
 * EXIF orientation 6 decodes straight to its upright pixel dimensions, no
 * separate rotate call needed) and never re-writes EXIF on output — its own
 * default `getBuffer` behavior, verified byte-for-byte (no `Exif` marker in
 * the output). */
async function encodeWithJimp(input: Uint8Array): Promise<EncodedSlipImage> {
  const { Jimp, JimpMime } = await import("jimp");
  const source = await Jimp.read(Buffer.from(input));

  const main = source.clone();
  scaleToLongEdge(main, LONG_EDGE);
  const buffer = await main.getBuffer(JimpMime.jpeg, { quality: QUALITY });

  const thumb = source.clone();
  scaleToLongEdge(thumb, THUMB_LONG_EDGE);
  const thumbBuffer = await thumb.getBuffer(JimpMime.jpeg, { quality: THUMB_QUALITY });

  return {
    buffer: new Uint8Array(buffer),
    thumbBuffer: new Uint8Array(thumbBuffer),
    width: main.bitmap.width,
    height: main.bitmap.height,
    format: "jpeg",
    engine: "jimp",
  };
}

// biome-ignore-start lint — jimp's own instance type is awkward to name
// precisely across its 1.x export surface; `{bitmap:{width,height}}` plus a
// `resize` method is exactly (and only) what this helper touches.
function scaleToLongEdge(image: { bitmap: { width: number; height: number }; resize: (opts: { w: number; h: number }) => void }, longEdge: number): void {
  const { width, height } = image.bitmap;
  const scale = Math.min(1, longEdge / Math.max(width, height));
  if (scale < 1) image.resize({ w: Math.round(width * scale), h: Math.round(height * scale) });
}
// biome-ignore-end lint

/** Strips any raw decoder/library error message down to a generic,
 * client-safe one — full detail goes to the server log only (error-hygiene
 * fix, 2026-08-03 review: a raw sharp/jimp error string is never something
 * a client should see verbatim). */
function sanitizeDecodeError(context: string, err: unknown): SlipImageError {
  console.warn(`slips/image: ${context}: ${err instanceof Error ? err.message : String(err)}`);
  return new SlipImageError("could not process this image — it may be corrupt or in an unsupported format");
}

/**
 * Validates (size bound, magic-byte sniff — never a declared content-type,
 * pre-decode pixel-budget check) then re-encodes: sharp when it loads as a
 * MODULE, jimp otherwise (see this module's own doc comment for the
 * sharp-under-Bun/alpine verdict). Throws `SlipImageError` for anything
 * about the INPUT (too large, too many pixels, not a recognized image, or
 * a genuine decode failure) — callers turn that into a 400, never a 500.
 *
 * B3 (Opus security review, 2026-08-03): `loadSharp()` answers ONE
 * question — "did sharp load as a native module at all", a process-wide,
 * one-time condition it caches. Once that succeeds, EVERY subsequent
 * per-image failure from `encodeWithSharp` is sharp genuinely rejecting or
 * failing to decode THIS SPECIFIC input (corrupt bytes, its own pixel-limit
 * guard, etc.) — never "sharp is unavailable". Falling back to jimp for
 * THAT case is exactly the vulnerability this review found: jimp has no
 * pixel cap, so a sharp-side rejection would silently launder into a
 * successful, unlimited-engine store. So: a per-image sharp failure is now
 * always terminal (a 400), and jimp only ever runs when `loadSharp()`
 * itself returned `null` (sharp never loaded as a module for this whole
 * process) — a state the pre-decode pixel-budget check above ALSO
 * protects, independently of which engine ends up running.
 */
export async function encodeSlipImage(input: Uint8Array): Promise<EncodedSlipImage> {
  if (input.byteLength > MAX_INPUT_BYTES) {
    throw new SlipImageError(`image too large: ${input.byteLength} bytes (max ${MAX_INPUT_BYTES})`);
  }
  const format = sniffImageFormat(input);
  if (format === null) {
    throw new SlipImageError("unrecognized image format — only JPEG and PNG are accepted");
  }

  const dims = readImageDimensions(input, format);
  if (dims && dims.width * dims.height > MAX_INPUT_PIXELS) {
    throw new SlipImageError(`image dimensions too large: ${dims.width}x${dims.height} exceeds the ${MAX_INPUT_PIXELS}-pixel limit`);
  }

  const sharpFn = await loadSharp();
  if (sharpFn) {
    try {
      return await encodeWithSharp(sharpFn, input);
    } catch (err) {
      throw sanitizeDecodeError("sharp rejected/failed on this image (loaded as a module fine — never falling back to jimp for a per-image failure)", err);
    }
  }

  try {
    return await encodeWithJimp(input);
  } catch (err) {
    throw sanitizeDecodeError("jimp rejected/failed on this image", err);
  }
}

// Test-only handles — same shape as every sibling module's `_internal`
// (day-audit.ts, pms-prefill.ts). Exercises the SAME two code paths
// `encodeSlipImage` picks between, without needing to simulate a sharp
// import failure.
export const _internal = { encodeWithSharp, encodeWithJimp };
