// JPEG export for the day report — see src/shared/api.md "JPEG export".
//
// html2canvas-pro is imported lazily (estate-proven pattern: RDR's
// ReportExporter.tsx, payroll) so the capture library never loads on the
// day-sheet / history / admin screens, only when a report is actually
// exported.
//
// Capture target: the caller passes the VISIBLE, unscaled ReportSheet DOM
// node (ReportPage.tsx is responsible for neutralising its responsive
// preview transform before calling in — see the plan's "capture the
// unscaled node" note). This mirrors the RDR lesson: html2canvas needs a
// laid-out, on-screen element, never an offscreen/display:none one.

import type { Property } from "../../shared/types.ts";

export interface ExportTarget {
  /** The ReportSheet's own root element, at its true 720px width. */
  node: HTMLElement;
  property: Property;
  date: string;
}

// Thai sample string used to force-load the glyphs actually on the sheet
// (stacked vowels + tone marks included) before rasterising — a font that
// reports "loaded" for Latin text can still be missing Thai glyph
// coverage at capture time.
const SARABUN_SAMPLE = "สรุปยอดรายรับ-รายจ่ายประจำวัน ฝากเข้าบัญชี ๐๑๒๓๔๕๖๗๘๙";
const SARABUN_WEIGHTS = [400, 500, 600, 700] as const;

async function ensureFontsReady(): Promise<void> {
  if (!document.fonts?.load) return;
  try {
    await Promise.all(
      SARABUN_WEIGHTS.map((weight) => document.fonts.load(`${weight} 16px "Sarabun"`, SARABUN_SAMPLE)),
    );
    await document.fonts.ready;
  } catch {
    // Best-effort font warm-up — if the probe throws (unsupported
    // browser), still attempt the capture with whatever is loaded.
  }
}

async function captureCanvas(node: HTMLElement): Promise<HTMLCanvasElement> {
  const html2canvas = (await import("html2canvas-pro")).default;
  return html2canvas(node, {
    scale: 2,
    backgroundColor: "#ffffff",
    logging: false,
  });
}

function canvasToJpegBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("สร้างไฟล์รูปภาพไม่สำเร็จ"));
      },
      "image/jpeg",
      0.92,
    );
  });
}

function reportFilename(property: Property, date: string): string {
  return `income-${property}-${date}.jpg`;
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Give the browser a moment to pick up the object URL before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function buildReportJpeg(
  target: ExportTarget,
): Promise<{ blob: Blob; file: File; filename: string }> {
  await ensureFontsReady();
  const canvas = await captureCanvas(target.node);
  const blob = await canvasToJpegBlob(canvas);
  const filename = reportFilename(target.property, target.date);
  const file = new File([blob], filename, { type: "image/jpeg" });
  return { blob, file, filename };
}

/**
 * "แชร์รูปภาพ" (primary action): capture, then hand the JPEG to the OS
 * share sheet (LINE etc.) via navigator.share when the platform supports
 * sharing files. A user-cancelled share (AbortError) is a no-op, not a
 * failure. Falls back to a direct download when Web Share (or file
 * sharing specifically) isn't available.
 */
export async function shareReportJpeg(target: ExportTarget): Promise<void> {
  const { blob, file, filename } = await buildReportJpeg(target);

  const nav = navigator;
  if (typeof nav.canShare === "function" && typeof nav.share === "function" && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      // Any other share failure falls through to the download fallback.
    }
  }

  triggerDownload(blob, filename);
}

/** "ดาวน์โหลด" (secondary action, desktop path): always a direct download. */
export async function downloadReportJpeg(target: ExportTarget): Promise<void> {
  const { blob, filename } = await buildReportJpeg(target);
  triggerDownload(blob, filename);
}
