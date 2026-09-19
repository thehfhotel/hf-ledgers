// วันที่ลงบิล in the register drawer (owner decision, 2026-09-19 — ADR-0001).
//
// Rendered with react-dom/server rather than a DOM harness: this app ships
// no jsdom/happy-dom and needs none here — the field's LABEL, its pre-filled
// value, its range and the งวด hint are all in the first paint, which is
// exactly what this test is about. Effects (the drawer's `change` listener,
// Escape handling) do not run under renderToStaticMarkup and are not what is
// being asserted; the save path's own payload is covered server-side
// (src/server/server.test.ts's "วันที่ลงบิล" block).

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ApRowDrawer } from "./ApRowDrawer.tsx";
import { PayrollRowDrawer } from "./PayrollRowDrawer.tsx";
import { ReimbursementRowDrawer } from "./ReimbursementRowDrawer.tsx";
import { AP_FIELDS } from "../labels.ts";
import { todayBangkok } from "@shared/date.ts";
import type { ApRow } from "../../shared/apTypes.ts";

const noop = () => {};

function render(row: ApRow | null): string {
  return renderToStaticMarkup(
    <ApRowDrawer row={row} creditors={[]} onClose={noop} onSaved={noop} onDeleted={noop} onPaymentChanged={noop} />,
  );
}

function existingRow(overrides: Partial<ApRow> = {}): ApRow {
  return {
    id: "row-1",
    creditor: "การไฟฟ้าส่วนภูมิภาค",
    item: "ค่าไฟ",
    amountSatang: 9_000_000,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-09-25",
    entity: "HF",
    categoryCode: "electricity-hopinn47",
    note: "",
    createdAt: "2026-09-18T05:00:00.000Z",
    createdBy: "clerk@thehfhotel.org",
    billDate: "2026-08-31",
    filedDate: "2026-09-18",
    settledAt: null,
    grossSatang: 9_000_000,
    outstandingSatang: 9_000_000,
    payments: [],
    photos: [],
    ...overrides,
  };
}

describe("ApRowDrawer: the วันที่ลงบิล field", () => {
  test("renders the field under its Thai label, with the งวด rule spelled out", () => {
    const html = render(existingRow());
    expect(html).toContain(AP_FIELDS.billDate);
    expect(html).toContain("วันที่ลงบิล");
    expect(html).toContain(AP_FIELDS.billDateHint);
    // The rule the accountant needs at the moment of entry: which month the
    // cost lands in, and what to do with a bill covering two months.
    expect(AP_FIELDS.billDateHint).toContain("งวดต้นทุน");
    expect(AP_FIELDS.billDateHint).toContain("เดือนที่รอบบิลสิ้นสุด");
  });

  test("is a native date input, pre-filled with the row's own bill date", () => {
    const html = render(existingRow());
    expect(html).toContain('id="ap-bill-date"');
    expect(html).toMatch(/<input[^>]*id="ap-bill-date"[^>]*type="date"/);
    expect(html).toMatch(/<input[^>]*id="ap-bill-date"[^>]*value="2026-08-31"/);
  });

  test("carries the same 2000-2100 range guard as กำหนดชำระ", () => {
    const html = render(existingRow());
    const input = /<input[^>]*id="ap-bill-date"[^>]*>/.exec(html)?.[0] ?? "";
    expect(input).toContain('min="2000-01-01"');
    expect(input).toContain('max="2100-12-31"');
  });

  test("shows the chosen date in Thai (Buddhist era) next to the picker", () => {
    const html = render(existingRow());
    expect(html).toContain("31 สิงหาคม 2569");
  });

  test("a NEW row defaults to today's Bangkok date — the same default the server applies", () => {
    const html = render(null);
    expect(html).toMatch(new RegExp(`<input[^>]*id="ap-bill-date"[^>]*value="${todayBangkok()}"`));
  });

  test("the field is always visible, never hidden behind the เพิ่มเติม fold that holds กำหนดชำระ", () => {
    const html = render(null);
    const billIndex = html.indexOf('id="ap-bill-date"');
    const detailsIndex = html.indexOf("เพิ่มเติม: ภาษี ส่วนลด วันครบกำหนด หมายเหตุ");
    expect(billIndex).toBeGreaterThan(-1);
    expect(detailsIndex).toBeGreaterThan(-1);
    expect(billIndex).toBeLessThan(detailsIndex);
  });

  test("the filing date is never offered for editing here — it is record metadata", () => {
    const html = render(existingRow());
    expect(html).not.toContain('id="ap-filed-date"');
  });
});

describe("the synced drawers show the งวด but never let it be edited", () => {
  test("PayrollRowDrawer shows วันที่ลงบิล (the period's last day) and calls the filing date วันที่ยื่นบิล", () => {
    const row = existingRow({
      id: "payroll-20260804061357-1tu5fp",
      creditor: "เงินเดือนพนักงาน",
      item: "เงินเดือน กรกฎาคม 2569",
      amountSatang: 17_506_274,
      grossSatang: 17_506_274,
      outstandingSatang: 0,
      billDate: "2026-07-31",
      filedDate: "2026-08-04",
      entity: "รวมทุกโรงแรม",
      categoryCode: "salary",
      payroll: {
        runId: "20260804061357-1tu5fp",
        period: "2026-07",
        effectiveDate: "2026-08-05",
        employeeCount: 15,
        status: "PAID",
        error: false,
        paidDate: "2026-08-05",
      },
    });
    const html = renderToStaticMarkup(<PayrollRowDrawer row={row} onClose={noop} />);
    expect(html).toContain(AP_FIELDS.billDate);
    expect(html).toContain("31/7/2569");
    expect(html).toContain(AP_FIELDS.filedDate);
    expect(html).toContain("4/8/2569");
    // The old label read like the งวด and was not it.
    expect(html).not.toContain("วันที่ลงรายการ");
    // Read-only: no input of any kind in this drawer.
    expect(html).not.toContain("<input");
  });

  test("ReimbursementRowDrawer shows วันที่ลงบิล = the purchase date, read-only", () => {
    const row = existingRow({
      id: "reimbursement-r1",
      creditor: "ผู้สำรองจ่าย",
      item: "แมคโคร",
      amountSatang: 29_600,
      grossSatang: 29_600,
      outstandingSatang: 29_600,
      billDate: "2026-09-15",
      filedDate: "2026-09-18",
      categoryCode: "supplies",
      reimbursement: {
        receiptId: "r1",
        bundleId: "b1",
        requestName: "ซื้อของแมคโคร",
        purchaseDate: "2026-09-15",
        note: "",
        status: "PAID",
        error: false,
      },
    });
    const html = renderToStaticMarkup(<ReimbursementRowDrawer row={row} onClose={noop} />);
    expect(html).toContain(AP_FIELDS.billDate);
    expect(html).toContain("15/9/2569");
    expect(html).toContain(AP_FIELDS.filedDate);
    expect(html).toContain("18/9/2569");
    expect(html).not.toContain("<input");
  });
});
