import type { Property } from "../../shared/types.ts";

// Placeholder — WP-B implements the manager-only category admin screen per
// the plan's "Screens" section for /:property/categories: tabs รายรับ/
// รายจ่าย, inline rename, "นับเป็นเงินสด" toggle, up/down reorder, ซ่อน/
// เรียกคืน (archive/restore), add form. Non-managers must see a
// "สำหรับผู้จัดการเท่านั้น" panel instead — that gating lives HERE, not in
// App.tsx (see App.tsx's routing comment).

interface Props {
  property: Property;
}

export function CategoriesPage(_props: Props) {
  return <div className="p-6 text-sm text-ink-muted">...</div>;
}
