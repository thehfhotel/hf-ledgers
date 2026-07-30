// PDF export for the พิมพ์/PDF buttons (BookingDayPage, DaySheetPage) — a
// direct download, no print dialog. Pipeline: render the print layout ->
// html2canvas-pro at scale 2 (same capture technique as exportJpeg.ts's
// JPEG share/download) -> place that capture onto a jsPDF A4 page sized to
// fill the printable area minus margins, preserving aspect ratio.
//
// html2canvas-pro and jspdf are both imported lazily — same estate-proven
// pattern as exportJpeg.ts's html2canvas-pro import — so neither loads on
// screens that never touch a PDF/JPEG export button.

import { A4_MM, buildExportFilename, computeFitScale, type PageOrientation } from "./printGeometry.ts";
import type { Property } from "../../shared/types.ts";

export interface PdfExportTarget {
  /** The print sheet's own root element, at its true (unscaled) natural
   * size — see usePrintExport.ts, which keeps this untransformed
   * (printScale is a print-only CSS transform, never applied while a PDF
   * capture runs). */
  node: HTMLElement;
  property: Property;
  date: string;
  orientation: PageOrientation;
  marginMm?: number;
}

// Thai sample string used to force-load the glyphs actually on the sheet
// (stacked vowels + tone marks included) before rasterising — a font that
// reports "loaded" for Latin text can still be missing Thai glyph coverage
// at capture time. Mirrors exportJpeg.ts's own warm-up.
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
    // Best-effort font warm-up — if the probe throws (unsupported browser),
    // still attempt the capture with whatever is loaded.
  }
}

/** 2x device scale — same as exportJpeg.ts's CAPTURE_SCALE, for the same
 * reason (the sheet's small print-density type stays legible when someone
 * zooms into the PDF). Not devicePixelRatio: the export must be identical
 * regardless of what screen it was generated on. */
const CAPTURE_SCALE = 2;

async function captureCanvas(node: HTMLElement): Promise<HTMLCanvasElement> {
  const html2canvas = (await import("html2canvas-pro")).default;
  // width/windowWidth are passed explicitly so html2canvas renders the
  // sheet at its own natural size regardless of the print-stage ancestor
  // that visually clips it on screen (see style.css's `.print-stage` —
  // clipped-but-laid-out, never display:none) — same reasoning as
  // exportJpeg.ts's capture of ReportPage's (differently) clipped preview.
  return html2canvas(node, {
    scale: CAPTURE_SCALE,
    backgroundColor: "#ffffff",
    logging: false,
    width: node.offsetWidth,
    height: node.offsetHeight,
    windowWidth: node.offsetWidth,
    windowHeight: node.offsetHeight,
  });
}

const DEFAULT_MARGIN_MM = 10;

export async function downloadPrintPdf(target: PdfExportTarget): Promise<void> {
  const marginMm = target.marginMm ?? DEFAULT_MARGIN_MM;
  await ensureFontsReady();
  const canvas = await captureCanvas(target.node);

  const pageWidthMm = target.orientation === "landscape" ? A4_MM.height : A4_MM.width;
  const pageHeightMm = target.orientation === "landscape" ? A4_MM.width : A4_MM.height;
  const availWidthMm = pageWidthMm - marginMm * 2;
  const availHeightMm = pageHeightMm - marginMm * 2;

  // Fit the captured image (its own pixel aspect ratio) into the printable
  // area, preserving aspect ratio and filling as much of the page as
  // possible — the same "scale = min(availW/natW, availH/natH)" formula the
  // print button applies as a CSS transform, here used as a px -> mm
  // placement factor instead (see computeFitScale's docstring: unit-
  // agnostic, a plain ratio either way).
  const scale = computeFitScale(canvas.width, canvas.height, availWidthMm, availHeightMm);
  const drawWidthMm = canvas.width * scale;
  const drawHeightMm = canvas.height * scale;
  // Centered within the printable area on whichever axis doesn't bind, so a
  // content aspect ratio that doesn't exactly match A4's never looks
  // shoved into a corner.
  const offsetXMm = marginMm + (availWidthMm - drawWidthMm) / 2;
  // Top-aligned, not vertically centered: a paper report reads from the top,
  // and a fuller day grows DOWN into the remaining space — centering a short
  // sheet leaves a dead band above the title (seen in the first live PDF).
  const offsetYMm = marginMm;

  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ orientation: target.orientation, unit: "mm", format: "a4" });
  const imgData = canvas.toDataURL("image/jpeg", 0.92);
  pdf.addImage(imgData, "JPEG", offsetXMm, offsetYMm, drawWidthMm, drawHeightMm);
  pdf.save(buildExportFilename(target.property, target.date, "pdf"));
}
