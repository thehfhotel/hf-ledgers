import { describe, expect, test } from "bun:test";
import {
  classifyRoomCell,
  classifyRoomToken,
  classifySheetProperty,
  classifyTitleProperty,
  splitRoomTokens,
} from "./classify.ts";

describe("classifyRoomToken", () => {
  test("classifies 1xx/2xx rooms as HF Ville", () => {
    expect(classifyRoomToken("112")).toBe("hfville");
    expect(classifyRoomToken("204")).toBe("hfville");
  });

  test("classifies 3xx/4xx/5xx rooms as Harbour Front", () => {
    expect(classifyRoomToken("416")).toBe("hf");
    expect(classifyRoomToken("302")).toBe("hf");
    expect(classifyRoomToken("504")).toBe("hf");
  });

  test("classifies the A-block as Harbour Front", () => {
    expect(classifyRoomToken("A2-1")).toBe("hf");
    expect(classifyRoomToken("A4-3")).toBe("hf");
  });

  test("classifies a V.-prefixed room via the leading-digit rule", () => {
    expect(classifyRoomToken("V.201")).toBe("hfville");
    expect(classifyRoomToken("v.201")).toBe("hfville");
  });

  test("returns undefined for an unrecognized token", () => {
    expect(classifyRoomToken("890")).toBeUndefined();
    expect(classifyRoomToken("")).toBeUndefined();
  });
});

describe("splitRoomTokens", () => {
  test("decomposes a concatenated pair of 3-digit room numbers", () => {
    expect(splitRoomTokens("504505")).toEqual(["504", "505"]);
    expect(splitRoomTokens("510511")).toEqual(["510", "511"]);
  });

  test("decomposes a concatenated triple of 3-digit room numbers", () => {
    expect(splitRoomTokens("311312313")).toEqual(["311", "312", "313"]);
  });

  test("splits a comma-separated room list", () => {
    expect(splitRoomTokens("A4-2,A4-3")).toEqual(["A4-2", "A4-3"]);
  });

  test("splits a space-separated room list", () => {
    expect(splitRoomTokens("A3-2 A2-1")).toEqual(["A3-2", "A2-1"]);
  });

  test("splits a mixed comma list with a V.-prefixed entry", () => {
    expect(splitRoomTokens("V.201,504")).toEqual(["V.201", "504"]);
  });

  test("returns an empty array for a blank cell", () => {
    expect(splitRoomTokens("")).toEqual([]);
  });
});

describe("classifyRoomCell", () => {
  test("agrees when a concatenated pair is both Harbour Front", () => {
    const result = classifyRoomCell("504505");
    expect(result.agreedProperty).toBe("hf");
    expect(result.mixed).toBe(false);
  });

  test("flags mixed when tokens disagree on property", () => {
    const result = classifyRoomCell("112,416"); // 1xx (Ville) + 4xx (HF)
    expect(result.mixed).toBe(true);
    expect(result.agreedProperty).toBeUndefined();
  });
});

describe("classifyTitleProperty", () => {
  test("classifies the bare title as HF", () => {
    expect(classifyTitleProperty("รายงานรายรับของโรงแรม")).toBe("hf");
  });

  test("classifies the Ville-tagged title as HF Ville", () => {
    expect(classifyTitleProperty("รายงานรายรับของโรงแรม (Hf -Ville)")).toBe("hfville");
  });

  test("returns undefined for missing or unrecognized text", () => {
    expect(classifyTitleProperty(undefined)).toBeUndefined();
    expect(classifyTitleProperty(null)).toBeUndefined();
    expect(classifyTitleProperty("")).toBeUndefined();
    expect(classifyTitleProperty("something else entirely")).toBeUndefined();
  });
});

describe("classifySheetProperty", () => {
  test("confidently classifies HF when room majority and bare title agree", () => {
    const result = classifySheetProperty("รายงานรายรับของโรงแรม", ["416", "411", "417", "302"]);
    expect(result.property).toBe("hf");
    expect(result.quarantineReason).toBeNull();
  });

  test("confidently classifies HF Ville when room majority and tagged title agree", () => {
    const result = classifySheetProperty("รายงานรายรับของโรงแรม (Hf -Ville)", ["112", "204", "116"]);
    expect(result.property).toBe("hfville");
    expect(result.quarantineReason).toBeNull();
  });

  test("quarantines when the room majority and title disagree", () => {
    const result = classifySheetProperty("รายงานรายรับของโรงแรม (Hf -Ville)", ["416", "411", "417"]);
    expect(result.property).toBeNull();
    expect(result.quarantineReason).toBe("room-title-mismatch");
  });

  test("confidently classifies from a bare title alone when there is no room signal (real case: an informal cash note with no room number)", () => {
    const result = classifySheetProperty("รายงานรายรับของโรงแรม", []);
    expect(result.property).toBe("hf");
    expect(result.quarantineReason).toBeNull();
  });

  test("confidently classifies from room majority alone when the title is missing (real case: sheet '16-3-69' has no A1 title row at all)", () => {
    const result = classifySheetProperty(undefined, ["416", "411", "417"]);
    expect(result.property).toBe("hf");
    expect(result.quarantineReason).toBeNull();
  });

  test("confidently classifies from room majority alone when the title is unrecognized", () => {
    const result = classifySheetProperty("some unrelated text", ["112", "204", "116"]);
    expect(result.property).toBe("hfville");
    expect(result.quarantineReason).toBeNull();
  });

  test("quarantines only when NEITHER signal resolves (no room votes and no usable title)", () => {
    const result = classifySheetProperty(undefined, []);
    expect(result.property).toBeNull();
    expect(result.quarantineReason).toBe("no-signal");
  });

  test("quarantines when room votes are tied and the title is also uninformative", () => {
    const result = classifySheetProperty(null, ["416", "112"]); // one HF, one Ville room -> tied
    expect(result.property).toBeNull();
    expect(result.quarantineReason).toBe("no-signal");
  });
});
