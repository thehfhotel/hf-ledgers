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
  busy: PrintExportBusy;
  error: string | null;
  handlePrint: () => Promise<void>;
  handlePdf: () => Promise<void>;
}

const DEFAULT_MARGIN_MM = 10;

const waitForLayout = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

export function usePrintExport({
  orientation,
  property,
  date,
  marginMm = DEFAULT_MARGIN_MM,
}: UsePrintExportArgs): UsePrintExportResult {
  const nodeRef = useRef<HTMLDivElement>(null);
  const [printScale, setPrintScale] = useState<number | null>(null);
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
      const scale = computeFitScale(node.offsetWidth, node.offsetHeight, widthPx, heightPx);
      setPrintScale(scale);
      await waitForLayout();
      printWithPageRule(orientation, marginMm, () => {
        setPrintScale(null);
        setBusy("");
      });
    } catch {
      // window.print() can throw (or printing can be disabled by policy).
      // Without this, `busy` sticks at "print" forever and BOTH buttons stay
      // disabled — same lesson as handlePdf's catch, learned the hard way.
      setPrintScale(null);
      setBusy("");
      setError("สั่งพิมพ์ไม่สำเร็จ ลองใหม่อีกครั้ง");
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

  return { nodeRef, sheetStyle, busy, error, handlePrint, handlePdf };
}
