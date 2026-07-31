import { useRef, useState, type CSSProperties, type RefObject } from "react";
import type { Property } from "../../shared/types.ts";
import { downloadPrintPdf } from "./exportPdf.ts";
import { a4PrintableAreaPx, computeFitScale, type PageOrientation } from "./printGeometry.ts";
import { printWithPageRule } from "./printSheet.ts";

// Shared พิมพ์/PDF wiring for BookingDayPage and DaySheetPage. Both actions
// are read-only (never disabled by monthClosed) and target the SAME hidden
// print-stage node (see PrintPortal.tsx, style.css's `.print-stage`):
//   - พิมพ์: measure the node's natural size, compute the CSS scale that
//     fills the A4 printable area (printGeometry.ts's computeFitScale),
//     apply it as a transform, then open the print dialog with the
//     matching @page rule injected (printSheet.ts).
//   - PDF: capture the SAME node at its natural (untransformed) size via
//     html2canvas, then place that image onto a same-shaped jsPDF page
//     (exportPdf.ts) — a direct download, no print dialog.

export interface UsePrintExportArgs {
  orientation: PageOrientation;
  property: Property;
  date: string;
  marginMm?: number;
}

export type PrintExportBusy = "" | "print" | "pdf";

export interface UsePrintExportResult {
  /** Attach to the print sheet's own root (its forwardRef). */
  nodeRef: RefObject<HTMLDivElement | null>;
  /** Merge onto that same root's style — carries the print-only scale
   * transform (a no-op, {}, outside of an in-flight print). */
  sheetStyle: CSSProperties;
  /** Wrap the sheet (the `nodeRef`/`sheetStyle` node) in ONE extra div using
   * this style, inside the .print-stage portal — a no-op, {}, outside of an
   * in-flight print. Chromium's print pagination fragments a page using an
   * element's PRE-transform (natural) box, ignoring `sheetStyle`'s scale
   * transform entirely — an over-tall day summary spills onto a second,
   * mostly-blank page even though the SCALED content clearly fits one (see
   * PrintableDaySummary.tsx's 2026-07-31 comment). Pinning an ancestor to
   * the content's exact PAINTED footprint (natural size × the same scale,
   * on both axes) with `overflow: hidden` gives the fragmenter a box that
   * already fits one page, so it never splits. Only ever set alongside
   * `sheetStyle`'s transform (see handlePrint) — never during PDF/JPEG
   * capture, which reads the node at natural size with no transform. */
  clampStyle: CSSProperties;
  busy: PrintExportBusy;
  error: string | null;
  handlePrint: () => Promise<void>;
  handlePdf: () => Promise<void>;
}

const DEFAULT_MARGIN_MM = 10;

const waitForLayout = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

interface ClampSize {
  widthPx: number;
  heightPx: number;
}

export function usePrintExport({
  orientation,
  property,
  date,
  marginMm = DEFAULT_MARGIN_MM,
}: UsePrintExportArgs): UsePrintExportResult {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [printScale, setPrintScale] = useState<number | null>(null);
  const [printClamp, setPrintClamp] = useState<ClampSize | null>(null);
  const [busy, setBusy] = useState<PrintExportBusy>("");
  const [error, setError] = useState<string | null>(null);

  async function handlePrint() {
    if (busy) return;
    const node = nodeRef.current;
    if (!node) return;
    setError(null);
    setBusy("print");
    try {
      const { widthPx, heightPx } = a4PrintableAreaPx(orientation, marginMm);
      let naturalWidth = node.offsetWidth;
      let naturalHeight = node.offsetHeight;
      let scale = computeFitScale(naturalWidth, naturalHeight, widthPx, heightPx);

      // Deliberately nothing is applied to the DOM yet at this point — no
      // transform, no clamp wrapper size — so this first pause is purely
      // "give any asynchronously-mounting content a chance to settle" (see
      // the re-measure comment below), never a wait for our own state to
      // paint. That matters here specifically because the clamp wrapper
      // (below) is a new ancestor of `node`: if it were sized while `node`
      // still measures itself via `width: fit-content` (sheetStyle), a
      // narrower wrapper could feed back into that measurement and shrink
      // `node`'s own reported box before we ever get a true natural
      // reading. Keeping both state setters out of this dance entirely
      // sidesteps that regardless of what's mounted inside the sheet.
      await waitForLayout();

      // Re-measure once: content that finishes mounting asynchronously
      // after the first measure (e.g. the weekly chart, still loading when
      // พิมพ์ was clicked) can change the sheet's natural size between that
      // measure and the print dialog actually opening, leaving the scale
      // computed above wrong for what's now on the page. Nothing has been
      // applied to `node` yet (see above), so this reads the same
      // untransformed, unclamped natural box as the first measurement. One
      // retry is enough — this isn't a loop against a moving target, just a
      // single known race window.
      const remeasuredWidth = node.offsetWidth;
      const remeasuredHeight = node.offsetHeight;
      if (remeasuredWidth !== naturalWidth || remeasuredHeight !== naturalHeight) {
        naturalWidth = remeasuredWidth;
        naturalHeight = remeasuredHeight;
        scale = computeFitScale(naturalWidth, naturalHeight, widthPx, heightPx);
        await waitForLayout();
      }

      // Now that naturalWidth/naturalHeight/scale are final, apply the
      // scale transform AND size the clamp wrapper to match in the SAME
      // update — they must always come and go together (see clampStyle's
      // docstring) — then wait one more layout tick so both are actually
      // painted before window.print() takes its snapshot.
      setPrintScale(scale);
      setPrintClamp({ widthPx: naturalWidth * scale, heightPx: naturalHeight * scale });
      await waitForLayout();

      printWithPageRule(orientation, marginMm, () => {
        setPrintScale(null);
        setPrintClamp(null);
        setBusy("");
      });
    } catch (err) {
      // window.print() can throw (or printing can be disabled by policy).
      // Without this, `busy` sticks at "print" forever and BOTH buttons stay
      // disabled — same lesson as handlePdf's catch, learned the hard way.
      console.error("print failed", err);
      setPrintScale(null);
      setPrintClamp(null);
      setBusy("");
      // Point at the working alternative, not just "try again" — a kiosk with
      // a broken print path can still save the PDF and print that file.
      setError("สั่งพิมพ์ไม่สำเร็จ — ลองใหม่ หรือกดปุ่ม PDF แล้วพิมพ์จากไฟล์แทน");
    }
  }

  async function handlePdf() {
    if (busy) return;
    const node = nodeRef.current;
    if (!node) return;
    setError(null);
    setBusy("pdf");
    try {
      // printScale is print-only (see handlePrint) and is always reset by
      // the time a print dialog closes, so the node is already at its
      // natural, untransformed size here — nothing to undo before capture.
      await downloadPrintPdf({ node, property, date, orientation, marginMm });
    } catch (err) {
      // Always a Thai message — a raw html2canvas/jspdf Error.message is
      // English implementation detail the operator cannot act on.
      console.error("PDF export failed", err);
      setError("สร้าง PDF ไม่สำเร็จ ลองใหม่อีกครั้ง");
    } finally {
      setBusy("");
    }
  }

  const sheetStyle: CSSProperties = {
    // Shrink-wrap to the sheet's own natural width rather than stretching
    // to fill the print-stage ancestor's (arbitrary, viewport-wide)
    // content box — otherwise the scale-to-fit measurement above would
    // read the ancestor's width, not the sheet's.
    width: "fit-content",
    ...(printScale != null ? { transform: `scale(${printScale})`, transformOrigin: "top left" } : {}),
  };

  // {} outside an in-flight print (printClamp is only ever set alongside
  // printScale, see handlePrint) — never constrains the sheet's own layout
  // while idle, so nodeRef's offsetWidth/Height measurement above always
  // reads the sheet's true natural box.
  const clampStyle: CSSProperties =
    printClamp != null
      ? { width: printClamp.widthPx, height: printClamp.heightPx, overflow: "hidden" }
      : {};

  return { nodeRef, sheetStyle, clampStyle, busy, error, handlePrint, handlePdf };
}
