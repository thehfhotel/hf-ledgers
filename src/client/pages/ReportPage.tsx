import type { Property } from "../../shared/types.ts";

// Placeholder — WP-C implements the report preview + JPEG export screen
// for /:property/report/:date per the plan's "JPEG export" spec: renders
// ../components/ReportSheet.tsx VISIBLE as the preview, driven by
// GET day/:date + shared computeDayTotals, exports via
// ../components/exportJpeg.ts.

interface Props {
  property: Property;
  date: string;
}

export function ReportPage(_props: Props) {
  return <div className="p-6 text-sm text-ink-muted">...</div>;
}
