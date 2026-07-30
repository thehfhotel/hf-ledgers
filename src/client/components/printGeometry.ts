// Pure print/PDF sizing math — the "make use of the whole A4 page" logic
// for the พิมพ์ (print) and PDF buttons (BookingDayPage, DaySheetPage). Kept
// dependency-free (no DOM) so it can be unit-tested directly; the DOM-
// touching halves live in printSheet.ts (window.print()) and exportPdf.ts
// (html2canvas + jsPDF).

export const MM_PER_INCH = 25.4;
/** CSS reference pixel density — the same 96dpi every browser uses to
 * convert CSS mm/in lengths to px, so a value computed here always matches
 * the `@page { margin: ... }` rule injected alongside it. */
export const CSS_PX_PER_INCH = 96;

export const A4_MM = { width: 210, height: 297 } as const;

export type PageOrientation = "landscape" | "portrait";

export function mmToPx(mm: number): number {
  return (mm / MM_PER_INCH) * CSS_PX_PER_INCH;
}

export interface PageBoxPx {
  widthPx: number;
  heightPx: number;
}

/** The printable area inside an A4 page at the given orientation, in CSS px
 * at 96dpi, after subtracting `marginMm` on every side — matching a
 * `@page { size: A4 <orientation>; margin: <marginMm>mm }` rule exactly. */
export function a4PrintableAreaPx(orientation: PageOrientation, marginMm = 10): PageBoxPx {
  const widthMm = orientation === "landscape" ? A4_MM.height : A4_MM.width;
  const heightMm = orientation === "landscape" ? A4_MM.width : A4_MM.height;
  return {
    widthPx: mmToPx(widthMm - marginMm * 2),
    heightPx: mmToPx(heightMm - marginMm * 2),
  };
}

/**
 * scale = min(availW/naturalW, availH/naturalH) — the largest uniform scale
 * that fits content of `naturalWidth x naturalHeight` inside an
 * `availWidth x availHeight` box without spilling either dimension onto a
 * second page. Deliberately uncapped above 1: the owner explicitly wants
 * the page USED, so small content scales UP to fill it, not just down to
 * fit it. Falls back to 1 for a degenerate (not-yet-measured, zero, or
 * negative) natural size rather than returning 0/NaN/Infinity.
 *
 * Unit-agnostic by design: pass px on both sides for the print button's CSS
 * transform, or px-natural/mm-available for the PDF button's page
 * placement (see exportPdf.ts) — the formula is a plain ratio either way.
 */
export function computeFitScale(
  naturalWidth: number,
  naturalHeight: number,
  availWidth: number,
  availHeight: number,
): number {
  if (!(naturalWidth > 0) || !(naturalHeight > 0)) return 1;
  const scale = Math.min(availWidth / naturalWidth, availHeight / naturalHeight);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** income-<property>-<date>.<ext> — mirrors exportJpeg.ts's reportFilename
 * convention for the JPEG share/download, so every export off this app
 * (JPEG, PDF) names files the same way. */
export function buildExportFilename(property: string, date: string, ext: "pdf" | "jpg"): string {
  return `income-${property}-${date}.${ext}`;
}

/** The @page rule text injected by printSheet.ts just before window.print()
 * — a plain string so it's trivially unit-testable without touching the
 * DOM. */
export function pageRuleCss(orientation: PageOrientation, marginMm = 10): string {
  return `@page { size: A4 ${orientation}; margin: ${marginMm}mm; }`;
}
