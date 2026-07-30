import { describe, expect, test } from "bun:test";
import {
  a4PrintableAreaPx,
  buildExportFilename,
  computeFitScale,
  mmToPx,
  pageRuleCss,
} from "./printGeometry.ts";

describe("mmToPx", () => {
  test("10mm at 96dpi", () => {
    expect(mmToPx(10)).toBeCloseTo(37.795, 3);
  });

  test("0mm is 0px", () => {
    expect(mmToPx(0)).toBe(0);
  });

  test("25.4mm is exactly one inch (96px)", () => {
    expect(mmToPx(25.4)).toBeCloseTo(96, 6);
  });
});

describe("a4PrintableAreaPx", () => {
  test("portrait, 10mm margin — width binds to the shorter A4 edge", () => {
    const box = a4PrintableAreaPx("portrait", 10);
    expect(box.widthPx).toBeCloseTo(mmToPx(190), 3); // 210 - 2*10
    expect(box.heightPx).toBeCloseTo(mmToPx(277), 3); // 297 - 2*10
  });

  test("landscape, 10mm margin — width/height swap vs portrait", () => {
    const box = a4PrintableAreaPx("landscape", 10);
    expect(box.widthPx).toBeCloseTo(mmToPx(277), 3);
    expect(box.heightPx).toBeCloseTo(mmToPx(190), 3);
  });

  test("default margin is 10mm", () => {
    const withDefault = a4PrintableAreaPx("portrait");
    const explicit = a4PrintableAreaPx("portrait", 10);
    expect(withDefault).toEqual(explicit);
  });

  test("a larger margin shrinks the printable area", () => {
    const tight = a4PrintableAreaPx("portrait", 20);
    const loose = a4PrintableAreaPx("portrait", 5);
    expect(tight.widthPx).toBeLessThan(loose.widthPx);
    expect(tight.heightPx).toBeLessThan(loose.heightPx);
  });
});

describe("computeFitScale", () => {
  test("exact fit on both axes", () => {
    expect(computeFitScale(1000, 1000, 500, 500)).toBeCloseTo(0.5, 6);
  });

  test("width-bound content (wide) scales down to the tighter axis", () => {
    // Natural 1000x500 into a 500x1000 box: width ratio 0.5, height ratio 2 -> 0.5 wins.
    expect(computeFitScale(1000, 500, 500, 1000)).toBeCloseTo(0.5, 6);
  });

  test("height-bound content (tall) scales down to the tighter axis", () => {
    expect(computeFitScale(500, 1000, 1000, 500)).toBeCloseTo(0.5, 6);
  });

  test("tiny content scales UP to fill the page — never capped at 1", () => {
    expect(computeFitScale(100, 100, 500, 1000)).toBeCloseTo(5, 6);
  });

  test("zero natural width falls back to 1 (not-yet-measured node)", () => {
    expect(computeFitScale(0, 100, 500, 500)).toBe(1);
  });

  test("zero natural height falls back to 1", () => {
    expect(computeFitScale(100, 0, 500, 500)).toBe(1);
  });

  test("negative natural size falls back to 1", () => {
    expect(computeFitScale(-10, 100, 500, 500)).toBe(1);
  });

  test("NaN natural size falls back to 1", () => {
    expect(computeFitScale(NaN, 100, 500, 500)).toBe(1);
  });
});

describe("buildExportFilename", () => {
  test("pdf extension", () => {
    expect(buildExportFilename("hf", "2026-07-30", "pdf")).toBe("income-hf-2026-07-30.pdf");
  });

  test("jpg extension, other property", () => {
    expect(buildExportFilename("hfville", "2026-01-05", "jpg")).toBe("income-hfville-2026-01-05.jpg");
  });
});

describe("pageRuleCss", () => {
  test("landscape, default margin", () => {
    expect(pageRuleCss("landscape")).toBe("@page { size: A4 landscape; margin: 10mm; }");
  });

  test("portrait, explicit margin", () => {
    expect(pageRuleCss("portrait", 12)).toBe("@page { size: A4 portrait; margin: 12mm; }");
  });
});
