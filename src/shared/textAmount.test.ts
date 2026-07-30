import { describe, expect, test } from "bun:test";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "./textAmount.ts";

// Every string below is either verbatim from the imported workbooks or the
// same shape as a row in them. Both directions matter equally: a tripwire
// that cries wolf on "ค่าอาหารเช้า ห้อง 418" gets ignored, and an ignored
// tripwire catches nothing.

describe("looksLikeAmountInText — must fire", () => {
  const firing = [
    "(โอนเงิน350)",
    "โอนเงิน 300",
    "ค่าชาร์จ 3% เป็นเงินสด=30 บาท",
    "เงินสด 1,200",
    // The two full workbook rows the defect was found on.
    "ค่าจัดงานวันเกิดลค.ห้อง506(โอนเงิน350)",
    "ค่าเช่าจอดรถ ก8375 (โอนเงิน300)",
    // Same shape, other wordings.
    "ค่าห้อง 500 บาท",
    "ค่าอาหารเช้า (สด 120)",
    "มัดจำ เครดิต 2,500",
    "ค่าซักรีด เงินโอน 450",
  ];

  for (const text of firing) {
    test(text, () => {
      expect(looksLikeAmountInText(text)).toBe(true);
    });
  }
});

describe("looksLikeAmountInText — must stay silent", () => {
  const silent = [
    // The four the office's real descriptions must never trip.
    "ค่าอาหารเช้า ห้อง 418",
    "Late checkout R.112",
    "เบาะเสริมR.108 เงินโอน",
    "R.505 อาหารเช้า",
    // A room number and a tender, amount in its own column: the digits sit
    // BEFORE the tender word, which is the ordinary "who paid how" note.
    "ห้อง 418 โอน",
    "R.302 เครดิต",
    // สด as the adjective "fresh" — an ordinary shopping note.
    "ซื้อผักสด 500",
    "ค่าอาหารสด 1,200",
    // A single digit beside a money word is not an amount.
    "โอน 5",
    "ค่าชาร์จ 3%",
    // A money word far from the number is not adjacency.
    "โอนแล้วเรียบร้อย ตามรายการห้อง 418",
    // Nothing money-ish at all.
    "ค่าจอดรถ ทะเบียน กก1234",
    "",
  ];

  for (const text of silent) {
    test(text === "" ? "(empty string)" : text, () => {
      expect(looksLikeAmountInText(text)).toBe(false);
    });
  }
});

test("the warning wording is a single shared Thai string", () => {
  expect(AMOUNT_IN_TEXT_WARNING_TH).toBe("จำนวนเงินอยู่ในข้อความ — กรอกในช่องจำนวนหรือไม่?");
});
