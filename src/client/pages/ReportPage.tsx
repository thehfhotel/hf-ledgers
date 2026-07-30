import { useEffect, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { getDay, listBookingLines } from "../api.ts";
import { downloadReportJpeg, shareReportJpeg } from "../components/exportJpeg.ts";
import { ReportSheet, REPORT_SHEET_WIDTH } from "../components/ReportSheet.tsx";
import { FIXTURE_DATE, fixtureBookingLines, fixtureDaySheet } from "../fixtures.ts";
import type { BookingLine, DaySheet, Property } from "../../shared/types.ts";

// /:property/report/:date — the report preview + JPEG export screen.
//
// Special case: property === "demo" renders src/client/fixtures.ts's
// fixtureDaySheet instead of fetching from the server. This has no live
// route in App.tsx today (its router only accepts "hf"/"hfville") — it
// exists so a later headless visual-verification pass can mount
// <ReportPage property="demo" date="..." /> directly and get a fully
// populated report with zero server/network dependency. It is harmless in
// prod: nothing routes here today, and even if it did, "demo" never
// touches the real API.

const DEMO_PROPERTY: Property = "hf";

type ReportPageProperty = Property | "demo";

interface ReportPageProps {
  property: ReportPageProperty;
  date: string;
}

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; sheet: DaySheet; lines: BookingLine[] };

export function ReportPage({ property, date }: ReportPageProps) {
  const isDemo = property === "demo";
  const effectiveProperty: Property = isDemo ? DEMO_PROPERTY : property;
  const effectiveDate = isDemo ? FIXTURE_DATE : date;

  const [state, setState] = useState<LoadState>(
    isDemo ? { status: "ready", sheet: fixtureDaySheet, lines: fixtureBookingLines } : { status: "loading" },
  );
  const [busy, setBusy] = useState<"" | "share" | "download">("");
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (isDemo) return;
    let cancelled = false;
    setState({ status: "loading" });
    // The sheet now prints the per-booking grid, so the report needs both
    // halves of the paper: the day summary AND its booking rows.
    Promise.all([getDay(effectiveProperty, effectiveDate), listBookingLines(effectiveProperty, effectiveDate)])
      .then(([sheet, bookings]) => {
        if (!cancelled) setState({ status: "ready", sheet, lines: bookings.lines });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [isDemo, effectiveProperty, effectiveDate]);

  // Responsive preview: the report sheet is a fixed REPORT_SHEET_WIDTH
  // (~1180px, A4-landscape-ish) document, wider than the shell it previews
  // in. It is scaled down purely visually (CSS transform on a wrapper) so
  // it's visible without the PAGE scrolling horizontally; the sheet's own
  // DOM node never changes size.
  const containerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const [previewScale, setPreviewScale] = useState(1);
  const [sheetHeight, setSheetHeight] = useState<number | null>(null);
  // While true, the preview transform is forced to 1 regardless of
  // previewScale so html2canvas-pro always captures the sheet at its true,
  // unscaled print layout — never the shrunk-to-fit preview.
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const available = el.clientWidth;
      setPreviewScale(available > 0 ? Math.min(1, available / REPORT_SHEET_WIDTH) : 1);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = sheetRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setSheetHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [state.status]);

  const displayScale = capturing ? 1 : previewScale;

  const waitForLayout = () =>
    new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

  const runExport = async (mode: "share" | "download") => {
    if (busy) return;
    const node = sheetRef.current;
    if (!node) return;
    setBusy(mode);
    setActionError(null);
    setCapturing(true);
    try {
      await waitForLayout();
      const target = { node, property: effectiveProperty, date: effectiveDate };
      if (mode === "share") await shareReportJpeg(target);
      else await downloadReportJpeg(target);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setCapturing(false);
      setBusy("");
    }
  };

  const backHref = `/${effectiveProperty}/day/${effectiveDate}`;

  return (
    <div className="pb-8">
      <div className="mb-4 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate(backHref)}
          className="text-sm font-medium text-ink hover:underline"
        >
          กลับ
        </button>
        <h1 className="text-sm font-semibold text-ink">ออกรายงานประจำวัน</h1>
        <span aria-hidden className="w-8" />
      </div>

      {state.status === "loading" && (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-ink-muted">
          กำลังโหลดข้อมูล...
        </div>
      )}

      {state.status === "error" && (
        <div className="rounded-lg border border-line bg-panel p-6 text-sm text-bad">
          โหลดข้อมูลไม่สำเร็จ: {state.message}
        </div>
      )}

      {state.status === "ready" && (
        <>
          <div ref={containerRef} className="w-full overflow-hidden">
            <div
              style={{
                width: REPORT_SHEET_WIDTH,
                transform: `scale(${displayScale})`,
                transformOrigin: "top left",
                height: sheetHeight != null ? sheetHeight * displayScale : undefined,
              }}
            >
              <ReportSheet
                ref={sheetRef}
                property={effectiveProperty}
                date={effectiveDate}
                sheet={state.sheet}
                lines={state.lines}
              />
            </div>
          </div>

          {actionError && <div className="mt-3 text-sm text-bad">{actionError}</div>}

          <div className="mt-4 flex gap-2">
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => runExport("share")}
              className="rounded-md bg-brand-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-600 disabled:opacity-50"
            >
              {busy === "share" ? "กำลังสร้างรูปภาพ..." : "แชร์รูปภาพ"}
            </button>
            <button
              type="button"
              disabled={busy !== ""}
              onClick={() => runExport("download")}
              className="rounded-md border border-line-strong bg-white px-4 py-2 text-sm font-medium text-ink transition hover:bg-tint disabled:opacity-50"
            >
              {busy === "download" ? "กำลังสร้างรูปภาพ..." : "ดาวน์โหลด"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
