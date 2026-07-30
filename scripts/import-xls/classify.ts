// Property classifier: room number + A1 title, cross-checked. A room cell
// may hold several concatenated 3-digit room numbers ("504505", "510511") or
// a comma/space list ("A4-2,A4-3", "A3-2 A2-1"); a "V." prefix (e.g.
// "V.201") just marks the building and still follows the leading-digit rule.
//
// Both signals (room-number majority + title) must agree for a per-booking
// sheet to be classified with confidence — quarantine the sheet, never pick
// one, when they disagree. Summary sheets carry no room numbers and their A1
// title never distinguishes the property (verified: identical title text,
// often absent, on both the HF and Ville summary workbooks) — property for
// those sheets is simply which workbook the caller is parsing, not something
// this classifier resolves.

import type { PropertyCode, QuarantineReason } from "./types.ts";

const A_BLOCK_PATTERN = /^A\d+-\d+$/i;
const V_PREFIX_PATTERN = /^[Vv]\.?\s*(\d{3,})$/;
const THREE_DIGIT_PATTERN = /^\d{3}$/;
const ALL_DIGITS_PATTERN = /^\d+$/;

function classifyByLeadingDigit(digits: string): PropertyCode | undefined {
  const firstDigit = digits[0];
  if (firstDigit === "1" || firstDigit === "2") return "hfville";
  if (firstDigit === "3" || firstDigit === "4" || firstDigit === "5") return "hf";
  return undefined;
}

function chunkConcatenatedRoomNumbers(token: string): string[] {
  if (ALL_DIGITS_PATTERN.test(token) && token.length > 3 && token.length % 3 === 0) {
    const chunks: string[] = [];
    for (let i = 0; i < token.length; i += 3) chunks.push(token.slice(i, i + 3));
    return chunks;
  }
  return [token];
}

/** Split a raw room cell into atomic room-number tokens, decomposing
 *  comma lists, space lists, and concatenated 3-digit runs. */
export function splitRoomTokens(raw: string | number): string[] {
  const text = String(raw).trim();
  if (!text) return [];
  return text
    .split(",")
    .flatMap((part) => part.trim().split(/\s+/))
    .map((token) => token.trim())
    .filter(Boolean)
    .flatMap(chunkConcatenatedRoomNumbers);
}

/** Classify one atomic room-number token. Undefined when unrecognized. */
export function classifyRoomToken(rawToken: string): PropertyCode | undefined {
  const token = rawToken.trim();
  if (!token) return undefined;
  if (A_BLOCK_PATTERN.test(token)) return "hf";
  const vMatch = token.match(V_PREFIX_PATTERN);
  if (vMatch) return classifyByLeadingDigit(vMatch[1]);
  if (THREE_DIGIT_PATTERN.test(token)) return classifyByLeadingDigit(token);
  return undefined;
}

export interface RoomCellClassification {
  tokens: string[];
  properties: Array<PropertyCode | undefined>;
  /** Set only when every classifiable token agrees on one property. */
  agreedProperty: PropertyCode | undefined;
  /** True when classifiable tokens in this one cell disagree with each other. */
  mixed: boolean;
}

export function classifyRoomCell(raw: string | number): RoomCellClassification {
  const tokens = splitRoomTokens(raw);
  const properties = tokens.map(classifyRoomToken);
  const known = properties.filter((p): p is PropertyCode => p !== undefined);
  const uniqueKnown = new Set(known);
  return {
    tokens,
    properties,
    agreedProperty: uniqueKnown.size === 1 ? known[0] : undefined,
    mixed: uniqueKnown.size > 1,
  };
}

/** Classify the A1 title text: "...(Hf -Ville)" style markers vs the bare
 *  "รายงานรายรับของโรงแรม" title. Undefined for missing/unrecognized text. */
export function classifyTitleProperty(a1Text: string | undefined | null): PropertyCode | undefined {
  if (!a1Text) return undefined;
  const trimmed = a1Text.trim();
  if (/ville/i.test(trimmed)) return "hfville";
  if (trimmed === "รายงานรายรับของโรงแรม") return "hf";
  return undefined;
}

export interface SheetPropertyClassification {
  /** null whenever quarantined — see quarantineReason/detail. */
  property: PropertyCode | null;
  quarantineReason: QuarantineReason | null;
  detail: string;
  roomVotes: { hf: number; hfville: number };
  titleProperty: PropertyCode | undefined;
}

/**
 * Classify a whole per-booking sheet from its A1 title plus the room-number
 * values across its booking rows.
 *
 * A quarantine means the two signals genuinely disagree, or both are
 * uninformative — never that just one of them happened to be missing. When
 * only one signal resolves, trust it: a confident room majority with a
 * missing/unrecognized title is a confident classification (verified real
 * case: sheet "16-3-69" is missing its A1 title row entirely, but its ten
 * booking rows are unambiguously Harbour Front rooms); symmetrically, a
 * confident title with no usable room signal (verified real case: an
 * informal cash note recorded as a single booking row with no room number)
 * is also a confident classification via the title alone.
 */
export function classifySheetProperty(
  a1Text: string | undefined | null,
  roomCellValues: Array<string | number>,
): SheetPropertyClassification {
  const votes = { hf: 0, hfville: 0 };
  for (const raw of roomCellValues) {
    const { agreedProperty } = classifyRoomCell(raw);
    if (agreedProperty === "hf") votes.hf++;
    else if (agreedProperty === "hfville") votes.hfville++;
  }

  const roomMajority: PropertyCode | null =
    votes.hf === votes.hfville ? null : votes.hf > votes.hfville ? "hf" : "hfville";
  const titleProperty = classifyTitleProperty(a1Text);

  if (roomMajority !== null && titleProperty !== undefined) {
    if (roomMajority === titleProperty) {
      return {
        property: roomMajority,
        quarantineReason: null,
        detail: "room majority and title agree",
        roomVotes: votes,
        titleProperty,
      };
    }
    return {
      property: null,
      quarantineReason: "room-title-mismatch",
      detail: `room majority=${roomMajority} title=${titleProperty}`,
      roomVotes: votes,
      titleProperty,
    };
  }

  if (roomMajority !== null) {
    return {
      property: roomMajority,
      quarantineReason: null,
      detail: `confident from room majority alone (title ${a1Text ? "unrecognized" : "missing"}: ${JSON.stringify(a1Text ?? null)})`,
      roomVotes: votes,
      titleProperty,
    };
  }

  if (titleProperty !== undefined) {
    return {
      property: titleProperty,
      quarantineReason: null,
      detail: `confident from title alone (room votes tied or empty: hf=${votes.hf} hfville=${votes.hfville})`,
      roomVotes: votes,
      titleProperty,
    };
  }

  return {
    property: null,
    quarantineReason: "no-signal",
    detail: `neither signal resolves: room votes hf=${votes.hf} hfville=${votes.hfville}, title ${a1Text ? "unrecognized" : "missing"}: ${JSON.stringify(a1Text ?? null)}`,
    roomVotes: votes,
    titleProperty,
  };
}
