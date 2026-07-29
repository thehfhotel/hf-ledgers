import type { Property } from "../../shared/types.ts";

// Placeholder — WP-B implements the month-stepper history screen (Buddhist
// Era header, DaySummary rows -> day, Thai empty-state invite) per the
// plan's "Screens" section for /:property/history.

interface Props {
  property: Property;
}

export function HistoryPage(_props: Props) {
  return <div className="p-6 text-sm text-ink-muted">...</div>;
}
