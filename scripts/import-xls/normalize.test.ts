import { describe, expect, test } from "bun:test";
import { inferIsCashFromFreeText, resolveCashBlockLabel, resolveCategoryLabel, stripWhitespace } from "./normalize.ts";

describe("stripWhitespace", () => {
  test("removes all whitespace, not just leading/trailing", () => {
    expect(stripWhitespace("บัตรเครดิต /กสิกร")).toBe("บัตรเครดิต/กสิกร");
    expect(stripWhitespace("  a  b  ")).toBe("ab");
  });
});

describe("resolveCategoryLabel", () => {
  test("resolves exact known labels", () => {
    expect(resolveCategoryLabel("มัดจำล่วงหน้า")).toBe("depositAdvance");
    expect(resolveCategoryLabel("ค่าห้องเงินสด")).toBe("roomCash");
    expect(resolveCategoryLabel("บัตรเครดิต ICBC")).toBe("creditIcbc");
    expect(resolveCategoryLabel("โอน ICBC")).toBe("transferIcbc");
    expect(resolveCategoryLabel("รายการ อื่นๆ")).toBe("otherItems");
    expect(resolveCategoryLabel("บาร์น้ำ โอน/เครดิต")).toBe("waterBarTransferCredit");
  });

  test("U+0020 case: 'บัตรเครดิต /กสิกร' and the spaceless variant both resolve to creditKbank", () => {
    expect(resolveCategoryLabel("บัตรเครดิต /กสิกร")).toBe("creditKbank");
    expect(resolveCategoryLabel("บัตรเครดิต/กสิกร")).toBe("creditKbank");
  });

  test("KBANK alias: 'บัตรเครดิต KBANK' resolves the same as the slash form", () => {
    expect(resolveCategoryLabel("บัตรเครดิต KBANK")).toBe("creditKbank");
  });

  test("U+0020 case: 'โอน/กสิกร' resolves the same with or without a space around the slash", () => {
    expect(resolveCategoryLabel("โอน/กสิกร")).toBe("transferKbank");
    expect(resolveCategoryLabel("โอน /กสิกร")).toBe("transferKbank");
  });

  test("KBANK alias: 'โอน KBANK' resolves the same as the slash form", () => {
    expect(resolveCategoryLabel("โอน KBANK")).toBe("transferKbank");
  });

  test("both website spellings resolve to the same category", () => {
    expect(resolveCategoryLabel("เว็ปไซด์")).toBe("website");
    expect(resolveCategoryLabel("เว็บไซด์")).toBe("website");
  });

  test("returns null for unrecognized labels", () => {
    expect(resolveCategoryLabel("ยอดพิศดารแปลกใหม่")).toBeNull();
  });
});

describe("resolveCashBlockLabel", () => {
  test("resolves all three spellings of the banked-total line", () => {
    expect(resolveCashBlockLabel("สรุป เงินสดน้ำฝากเข้าบัญชี")).toBe("bankedTotal");
    expect(resolveCashBlockLabel("สรุป เงินสดฝากเข้าบัญชี")).toBe("bankedTotal");
    expect(resolveCashBlockLabel("สรุป เงินสดนำฝากเข้าบัญชี")).toBe("bankedTotal");
  });

  test("resolves the cash-block water-bar line", () => {
    expect(resolveCashBlockLabel("บาร์น้ำเงินสด")).toBe("waterBarCashBlock");
  });

  test("resolves the bare 'รายการอื่นๆ' (no 'เงินสด' suffix) cash-block variant", () => {
    // Real case: sheet "16-7-69" of the HF summary workbook.
    expect(resolveCashBlockLabel("รายการอื่นๆ")).toBe("otherItemsCash");
    expect(resolveCashBlockLabel("รายการอื่นๆเงินสด")).toBe("otherItemsCash");
  });

  test("returns null for a label outside the cash block", () => {
    expect(resolveCashBlockLabel("มัดจำล่วงหน้า")).toBeNull();
  });
});

describe("section-scoped water-bar labels never collide", () => {
  test("the main-block 'บาร์น้ำ เงินสด' and cash-block 'บาร์น้ำเงินสด' normalize identically but resolve via different, section-scoped tables", () => {
    expect(stripWhitespace("บาร์น้ำ เงินสด")).toBe(stripWhitespace("บาร์น้ำเงินสด"));
    expect(resolveCategoryLabel("บาร์น้ำ เงินสด")).toBe("waterBarCash");
    expect(resolveCashBlockLabel("บาร์น้ำเงินสด")).toBe("waterBarCashBlock");
  });
});

describe("inferIsCashFromFreeText", () => {
  test("recognizes a parenthesized cash marker", () => {
    expect(inferIsCashFromFreeText("R.116 ค่าปรับ(เงินสด)")).toBe(true);
  });

  test("recognizes a bare transfer marker", () => {
    expect(inferIsCashFromFreeText("เบาะเสริมR.108 เงินโอน")).toBe(false);
  });

  test("recognizes a bare cash marker", () => {
    expect(inferIsCashFromFreeText("ค่าอาหารเช้า ห้อง 418 เงินสด")).toBe(true);
  });

  test("recognizes a credit-card marker as non-cash", () => {
    expect(inferIsCashFromFreeText("ค่าปรับ เครดิต")).toBe(false);
  });

  test("returns undefined when the text carries neither marker", () => {
    expect(inferIsCashFromFreeText("ค่าปรับ ห้อง 418")).toBeUndefined();
  });
});
