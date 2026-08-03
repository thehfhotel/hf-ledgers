import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import { _internal, encodeSlipImage, MAX_INPUT_BYTES, MAX_INPUT_PIXELS, readImageDimensions, sniffImageFormat } from "./image.ts";

function hasExifMarker(buf: Uint8Array): boolean {
  return Buffer.from(buf).includes(Buffer.from("Exif"));
}

/** Builds a real JPEG fixture (via sharp, used here purely as a fixture
 * generator — the pipeline under test is exercised separately for each
 * engine below) carrying genuine EXIF (including a fake "account number"
 * in a UserComment field, standing in for what a real slip photo's camera
 * metadata might leak) and an orientation tag, so the strip/rotate/resize
 * behavior is tested against real bytes, not synthetic ones. */
async function jpegFixture(width: number, height: number, orientation?: number): Promise<Uint8Array> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels).fill(100);
  const built = sharp(raw, { raw: { width, height, channels } }).jpeg({ quality: 90 });
  if (orientation !== undefined) {
    built.withMetadata({ exif: { IFD0: { Make: "TestCam", ImageDescription: "acct-1234567890" } }, orientation });
  }
  return new Uint8Array(await built.toBuffer());
}

async function pngFixture(width: number, height: number): Promise<Uint8Array> {
  const channels = 3;
  const raw = Buffer.alloc(width * height * channels).fill(50);
  return new Uint8Array(await sharp(raw, { raw: { width, height, channels } }).png().toBuffer());
}

describe("sniffImageFormat", () => {
  test("recognizes real JPEG and PNG bytes", async () => {
    expect(sniffImageFormat(await jpegFixture(20, 20))).toBe("jpeg");
    expect(sniffImageFormat(await pngFixture(20, 20))).toBe("png");
  });
  test("rejects anything else, including a spoofed extension/declared type — this is a BYTE sniff", () => {
    expect(sniffImageFormat(new TextEncoder().encode("not an image, whatever the filename claims"))).toBeNull();
    expect(sniffImageFormat(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull(); // %PDF magic
    expect(sniffImageFormat(new Uint8Array([]))).toBeNull();
  });
});

describe("encodeSlipImage — size/format gates", () => {
  test("rejects input over MAX_INPUT_BYTES before ever decoding", async () => {
    const oversized = new Uint8Array(MAX_INPUT_BYTES + 1);
    oversized.set([0xff, 0xd8, 0xff]); // valid JPEG magic — size is the only thing wrong
    await expect(encodeSlipImage(oversized)).rejects.toThrow(/too large/);
  });
  test("rejects a non-image payload", async () => {
    await expect(encodeSlipImage(new TextEncoder().encode("hello"))).rejects.toThrow(/unrecognized image format/);
  });
});

// Both engines are exercised directly (via image.ts's `_internal`) so the
// suite verifies BOTH the preferred (sharp) and fallback (jimp) code paths
// independently, without needing to simulate a sharp import failure.
const ENGINES = [
  { name: "sharp" as const, encode: (bytes: Uint8Array) => _internal.encodeWithSharp(sharp as unknown as Parameters<typeof _internal.encodeWithSharp>[0], bytes) },
  { name: "jimp" as const, encode: (bytes: Uint8Array) => _internal.encodeWithJimp(bytes) },
];

for (const engine of ENGINES) {
  describe(`re-encode via ${engine.name}`, () => {
    test("strips EXIF entirely (including a fake embedded account-number-shaped UserComment)", async () => {
      const src = await jpegFixture(2400, 1600, 1);
      expect(hasExifMarker(src)).toBe(true); // sanity: the fixture really carries EXIF
      const out = await engine.encode(src);
      expect(hasExifMarker(out.buffer)).toBe(false);
      expect(hasExifMarker(out.thumbBuffer)).toBe(false);
      expect(out.engine).toBe(engine.name);
      expect(out.format).toBe("jpeg");
    });

    test("caps the long edge at 2200px for a large landscape image", async () => {
      const src = await jpegFixture(4000, 3000);
      const out = await engine.encode(src);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2200);
      expect(out.width).toBeGreaterThan(0);
      expect(out.height).toBeGreaterThan(0);
    });

    test("caps the long edge at 2200px for a large portrait image, honoring EXIF orientation (rotate BEFORE cap)", async () => {
      // 3000x1800 landscape source + orientation 6 (rotate 90 CW to display)
      // becomes a 1800x3000 PORTRAIT image once oriented — the resize must
      // cap against the ROTATED long edge (3000), not the stored one.
      const src = await jpegFixture(3000, 1800, 6);
      const out = await engine.encode(src);
      expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2200);
      expect(out.height).toBeGreaterThan(out.width); // stayed portrait after rotation
    });

    test("never upscales an already-small image", async () => {
      const src = await jpegFixture(300, 200);
      const out = await engine.encode(src);
      expect(out.width).toBeLessThanOrEqual(300);
      expect(out.height).toBeLessThanOrEqual(200);
    });

    test("thumbnail is meaningfully smaller than the main output", async () => {
      const src = await jpegFixture(4000, 3000);
      const out = await engine.encode(src);
      expect(Math.max(out.width, out.height)).toBeGreaterThan(THUMB_UPPER_BOUND_HINT);
      expect(out.thumbBuffer.byteLength).toBeLessThan(out.buffer.byteLength);
    });
  });
}

// A loose sanity bound for the "thumbnail is smaller" assertion above —
// not the actual constant (kept private to image.ts), just proof the main
// output is well above thumbnail scale.
const THUMB_UPPER_BOUND_HINT = 600;

// ── B3 (Opus security review, 2026-08-03): decompression-bomb defense ────
// Proven exploit: a 17000x17000 PNG (~860KB compressed, 289 megapixels)
// succeeded via the jimp fallback (12s CPU, +420MB RSS) because a sharp
// rejection (its own "exceeds pixel limit" guard) was treated as "sharp
// unavailable, retry with jimp" — jimp has no pixel cap at all. The fix has
// two independent layers: a pre-decode header-parsed pixel budget (tested
// directly below, and via `encodeSlipImage` with both a CRAFTED lying
// header and a REAL, fully decodable oversized image), and never falling
// back to jimp on a per-image sharp failure once sharp has loaded as a
// module (tested via the corrupted-input case further down).

/** Crafts a MINIMAL but magic-valid PNG whose IHDR claims arbitrary
 * width/height — the CRC is deliberately left zeroed (a real decoder would
 * reject it) because this fixture exists to prove `readImageDimensions`
 * and the pre-decode gate in `encodeSlipImage` NEVER reach a real decoder
 * for a file shaped like this at all; a correct CRC is irrelevant to that
 * proof. This is the exact "small compressed file, huge claimed
 * dimensions" shape of a decompression bomb, without needing to actually
 * materialize hundreds of megabytes of real pixel data to prove it. */
function craftLyingPng(width: number, height: number): Uint8Array {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 2; // color type: truecolor
  const length = Buffer.alloc(4);
  length.writeUInt32BE(ihdrData.length, 0);
  const crc = Buffer.alloc(4);
  return new Uint8Array(Buffer.concat([Buffer.from(sig), length, Buffer.from("IHDR"), ihdrData, crc]));
}

/** Crafts a minimal magic-valid JPEG (SOI + a single SOF0 marker claiming
 * arbitrary width/height + EOI, no real scan data) — same "lying header,
 * no real pixel data" shape as `craftLyingPng` above, for the JPEG SOF
 * parsing path. */
function craftLyingJpeg(width: number, height: number): Uint8Array {
  const payload = [8, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  const length = payload.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xc0, (length >> 8) & 0xff, length & 0xff, ...payload, 0xff, 0xd9]);
}

describe("readImageDimensions — pre-decode header parsing (PNG IHDR / JPEG SOF)", () => {
  test("parses a crafted PNG's IHDR width/height without decoding", () => {
    expect(readImageDimensions(craftLyingPng(20000, 15000), "png")).toEqual({ width: 20000, height: 15000 });
  });
  test("parses a crafted JPEG's SOF width/height without decoding", () => {
    expect(readImageDimensions(craftLyingJpeg(18000, 12000), "jpeg")).toEqual({ width: 18000, height: 12000 });
  });
  test("parses dimensions from a REAL sharp-produced JPEG/PNG the same way", async () => {
    const jpeg = await jpegFixture(640, 480);
    expect(readImageDimensions(jpeg, "jpeg")).toEqual({ width: 640, height: 480 });
    const png = await pngFixture(320, 240);
    expect(readImageDimensions(png, "png")).toEqual({ width: 320, height: 240 });
  });
  test("degrades to null (never throws) on truncated/malformed bytes", () => {
    expect(readImageDimensions(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "png")).toBeNull();
    expect(readImageDimensions(new Uint8Array([0xff, 0xd8]), "jpeg")).toBeNull();
    expect(readImageDimensions(new Uint8Array([]), "jpeg")).toBeNull();
  });
});

describe("encodeSlipImage — B3 decompression-bomb rejection", () => {
  test("rejects a CRAFTED lying-header bomb (20000x20000, 33-byte file) in well under a decode's worth of time, never touching a decoder", async () => {
    const bomb = craftLyingPng(20000, 20000);
    expect(bomb.byteLength).toBeLessThan(100); // tiny file, huge claimed pixel count — the bomb shape
    const start = Date.now();
    await expect(encodeSlipImage(bomb)).rejects.toThrow(/exceeds the .*-pixel limit/);
    expect(Date.now() - start).toBeLessThan(200); // proves no decode was attempted (a real decode of this claim would take seconds+)
  });

  test("rejects the SAME shape via a crafted JPEG SOF header", async () => {
    const bomb = craftLyingJpeg(19000, 19000);
    await expect(encodeSlipImage(bomb)).rejects.toThrow(/exceeds the .*-pixel limit/);
  });

  test("rejects a REAL, fully decodable, over-budget image (7000x7000 = 49 megapixels > the 40-megapixel budget)", async () => {
    // Real pixel data (not a lying header) — proves the gate also catches
    // a genuinely oversized image, not merely a crafted claim. Kept small
    // enough (7000x7000, solid fill) to build locally without exhausting
    // this test run's memory the way the reviewer's proven 289-megapixel
    // exploit would.
    const width = 7000,
      height = 7000;
    const real = await sharp(Buffer.alloc(width * height * 3).fill(128), { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 6 })
      .toBuffer();
    expect(width * height).toBeGreaterThan(MAX_INPUT_PIXELS);
    await expect(encodeSlipImage(new Uint8Array(real))).rejects.toThrow(/exceeds the .*-pixel limit/);
  });

  test("an image comfortably within the pixel budget still succeeds normally (no regression)", async () => {
    const ok = await jpegFixture(2000, 1500);
    const result = await encodeSlipImage(ok);
    expect(result.width).toBeGreaterThan(0);
  });

  test("a genuinely corrupted (truncated) but within-budget, magic-valid image is REJECTED (400-mappable SlipImageError), never silently produced via a fallback engine", async () => {
    const real = await jpegFixture(1200, 900);
    const truncated = real.slice(0, Math.floor(real.byteLength / 3)); // chop well before the end of the scan data
    expect(sniffImageFormat(truncated)).toBe("jpeg"); // still magic-valid — only the BODY is corrupt
    await expect(encodeSlipImage(truncated)).rejects.toThrow(/could not process this image/);
  });

  test("once sharp has loaded as a module, a per-image failure logs that it is NOT falling back to jimp (B3's exact fix)", async () => {
    const originalWarn = console.warn;
    const logs: string[] = [];
    console.warn = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const real = await jpegFixture(1200, 900);
      const truncated = real.slice(0, Math.floor(real.byteLength / 3));
      await expect(encodeSlipImage(truncated)).rejects.toThrow();
    } finally {
      console.warn = originalWarn;
    }
    expect(logs.some((l) => l.includes("never falling back to jimp"))).toBe(true);
  });
});
