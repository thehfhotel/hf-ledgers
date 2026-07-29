import type { Property } from "../../shared/types.ts";

// Placeholder — WP-B implements the day-sheet workhorse screen per the
// plan's "Screens" section for /:property/day/:date: DateBar, Panel
// รายรับ, Panel รายจ่าย, tinted สรุปเงินสดฝากเข้าบัญชี panel, day note,
// footer บันทึกล่าสุด + primary "ส่งออกรูปภาพ" (navigate to
// /:property/report/:date via navigate() from ../App.tsx).

interface Props {
  property: Property;
  date: string;
}

export function DaySheetPage(_props: Props) {
  return <div className="p-6 text-sm text-ink-muted">...</div>;
}
