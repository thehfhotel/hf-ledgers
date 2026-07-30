import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { computeBookingTotals, lineArithmeticMismatch } from "../../shared/bookings.ts";
import { parseAmountToSatang } from "../../shared/money.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "../../shared/textAmount.ts";
import { shouldLeaveCell, stepColumn, stepRow } from "../../shared/gridNav.ts";
import {
  BOOKING_NO_MAX_LEN,
  COUNT_MAX,
  GUEST_NAME_MAX_LEN,
  REMARK_MAX_LEN,
  ROOM_NO_MAX_LEN,
  TENDERS,
  TENDER_LABELS_TH,
  type BookingLine,
  type Tender,
} from "../../shared/types.ts";
import type { BookingLineInput } from "../api.ts";
import {
  BookingGridColgroup,
  BookingGridFoot,
  BookingGridHead,
  countText,
  moneyText,
} from "./bookingGridFrame.tsx";

// The office sheet as a spreadsheet: one row per booking, every cell an
// in-place input, three-row grouped header reproduced with colspan/rowspan
// exactly as the workbook prints it. This is the strongest familiarity cue
// in the app — the header wording is verbatim from the paper (and from
// TENDER_LABELS_TH, whose eight labels are the row-2 + row-3 pairs of the
// จำนวนเงินรับ group), so it is not paraphrased or "improved" here. The
// frame (column widths, that header, the totals row) lives in
// bookingGridFrame.tsx because the printable day sheet renders the SAME
// frame read-only — see components/ReportSheet.tsx.
//
// Keyboard model: Tab/Shift+Tab move between cells, Enter moves DOWN the same
// column, and the arrow keys move a cell in each direction (Excel muscle
// memory). Left/Right only leave a cell once the caret is already at that
// edge, so typing a guest name still works normally. Deliberately NOT built:
// a formula bar, range selection, clipboard handling.

/** Plain non-negative integer count (roomCount/nights), never money — a
 * lighter parse than shared money.ts's baht parser, clamped to COUNT_MAX. */
function parseCount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) return null;
  return Math.min(Number(trimmed), COUNT_MAX);
}

// ── Keyboard: Enter and the arrow keys move between cells ────────────────
// Resolved by data attributes rather than refs so the blank bottom row (row
// index = lines.length) is just "the next row down" with no special case.
// The decisions that do not need the DOM live in shared/gridNav.ts.

/** Left-to-right editable column order, the same order the cells are emitted
 *  in below. Built from TENDERS so the money block can never drift out of
 *  step with the printed sheet. */
const NAV_COLUMNS: readonly string[] = [
  "bookingNo",
  "guestName",
  "roomNo",
  "roomCount",
  "nights",
  "grossRoomSatang",
  "grossOtherSatang",
  "discountSatang",
  ...TENDERS,
  "remark",
];

/** Focus the cell at (col,row) if it exists and is editable. Re-queried live
 *  every time — an uncontrolled cell's <input> is replaced whenever its
 *  committed value changes, so a cached ref would point at a dead node. */
function focusCell(table: HTMLTableElement | null, col: string, row: number): boolean {
  const next = table?.querySelector<HTMLInputElement>(`input[data-col="${col}"][data-row="${row}"]`);
  if (!next || next.disabled) return false;
  next.focus();
  next.select();
  // The grid scrolls inside its own box under a sticky header and footer, so
  // plain focus() can park the row beneath one of them.
  next.scrollIntoView({ block: "nearest", inline: "nearest" });
  return true;
}

function gridKeys(event: ReactKeyboardEvent<HTMLInputElement>) {
  // Thai IME: while a syllable is being composed the arrows belong to the
  // candidate window, never to the grid.
  if (event.nativeEvent.isComposing) return;
  if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;

  const el = event.currentTarget;
  const col = el.dataset.col;
  const row = Number(el.dataset.row);
  if (!col || Number.isNaN(row)) return;
  const table = el.closest("table");

  if (event.key === "Enter" || event.key === "ArrowDown") {
    event.preventDefault();
    const target = stepRow(row, "down");
    if (target !== null && focusCell(table, col, target)) return;
    // Bottom of the column: commit in place (blur fires the save) and stay.
    if (event.key === "Enter") el.blur();
    return;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    const target = stepRow(row, "up");
    if (target !== null) focusCell(table, col, target);
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const dir = event.key === "ArrowLeft" ? "left" : "right";
    // Inside the text, the arrow is the caret's — only step out at the edge.
    if (!shouldLeaveCell(dir, el.selectionStart, el.selectionEnd, el.value.length)) return;
    const target = stepColumn(col, dir, NAV_COLUMNS);
    if (!target) return;
    event.preventDefault();
    focusCell(table, target, row);
  }
}

// border-separate (not collapse) on purpose: collapsed borders are dropped
// on sticky thead/tfoot cells in Chrome, so the grid rules live on the cells
// themselves (bottom + right) and the panel around the grid closes the top
// and left edges.
const CELL = "border-b border-r border-line p-0 align-middle";
const CELL_INPUT =
  "w-full bg-transparent px-1.5 py-1 text-sm text-ink outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 disabled:text-ink-muted";
const CELL_INPUT_NUM = CELL_INPUT + " text-right tabular-nums";

interface CellProps {
  row: number;
  col: string;
  disabled: boolean;
  ariaLabel: string;
}

function TextCell({
  row,
  col,
  disabled,
  ariaLabel,
  value,
  maxLength,
  onCommit,
  onDraftChange,
  warnAmountInText = false,
}: CellProps & {
  value: string | null;
  maxLength: number;
  onCommit: (next: string | null) => void;
  /** Report every keystroke up so the parent can run the amount-in-text
   * tripwire while the cell is still being typed (หมายเหตุ only). */
  onDraftChange?: (text: string) => void;
  /** The tripwire fired for this cell's current text. */
  warnAmountInText?: boolean;
}) {
  const input = (
    <input
      type="text"
      // defaultValue + key: the committed value always wins on the next
      // render without React resetting the field while it is being typed.
      key={`${col}-${row}-${value ?? ""}`}
      defaultValue={value ?? ""}
      data-row={row}
      data-col={col}
      maxLength={maxLength}
      disabled={disabled}
      aria-label={ariaLabel}
      // An input clips rather than wraps, and real guest names and
      // group-booking room lists outrun any column width. The full value is
      // always intact in the field; this makes it readable without it.
      title={value ?? undefined}
      onKeyDown={gridKeys}
      onChange={onDraftChange ? (e) => onDraftChange(e.target.value) : undefined}
      onBlur={(e) => {
        const trimmed = e.target.value.trim();
        const next = trimmed === "" ? null : trimmed.slice(0, maxLength);
        if (next !== value) onCommit(next);
      }}
      className={warnAmountInText ? CELL_INPUT + " bg-gold-50" : CELL_INPUT}
    />
  );
  if (!onDraftChange) return input;
  // The หมายเหตุ column is 104px wide, so the full Thai sentence cannot live
  // in the cell — this mark carries it as a tooltip, and BookingGrid repeats
  // the sentence in full, once, in a bar under the table.
  return (
    <span className="flex items-center">
      {input}
      {warnAmountInText && (
        <span
          title={AMOUNT_IN_TEXT_WARNING_TH}
          aria-label={AMOUNT_IN_TEXT_WARNING_TH}
          className="shrink-0 pr-1 text-xs font-bold text-warn"
        >
          !
        </span>
      )}
    </span>
  );
}

function CountCell({
  row,
  col,
  disabled,
  ariaLabel,
  value,
  onCommit,
}: CellProps & { value: number | null; onCommit: (next: number | null) => void }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      key={`${col}-${row}-${value ?? ""}`}
      defaultValue={countText(value)}
      data-row={row}
      data-col={col}
      disabled={disabled}
      aria-label={ariaLabel}
      onKeyDown={gridKeys}
      onBlur={(e) => {
        const next = parseCount(e.target.value);
        if (next !== value) onCommit(next);
      }}
      className={CELL_INPUT_NUM}
    />
  );
}

/**
 * Money cell: same contract as components/AmountInput.tsx (focused = plain
 * draft text, blurred = formatSatang, save on blur, integer satang via the
 * shared parser) minus the chrome AmountInput adds — no fixed width, no
 * save mark, and Enter navigates instead of blurring in place, which is
 * what makes a whole column typeable.
 */
function MoneyCell({
  row,
  col,
  disabled,
  ariaLabel,
  value,
  onCommit,
}: CellProps & { value: number; onCommit: (next: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const shown = editing ? draft : moneyText(value);

  return (
    <input
      type="text"
      inputMode="decimal"
      value={shown}
      data-row={row}
      data-col={col}
      disabled={disabled}
      aria-label={ariaLabel}
      onFocus={() => {
        setDraft(value !== 0 ? (value / 100).toFixed(2) : "");
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={gridKeys}
      onBlur={() => {
        setEditing(false);
        const parsed = parseAmountToSatang(draft) ?? 0;
        if (parsed !== value) onCommit(parsed);
      }}
      className={CELL_INPUT_NUM}
    />
  );
}

// ── The blank bottom row's local draft ───────────────────────────────────

interface NewRowDraft {
  bookingNo: string | null;
  guestName: string | null;
  roomNo: string | null;
  roomCount: number | null;
  nights: number | null;
  grossRoomSatang: number;
  grossOtherSatang: number;
  discountSatang: number;
  tenders: Record<Tender, number>;
  remark: string | null;
}

function emptyDraft(): NewRowDraft {
  return {
    bookingNo: null,
    guestName: null,
    roomNo: null,
    roomCount: null,
    nights: null,
    grossRoomSatang: 0,
    grossOtherSatang: 0,
    discountSatang: 0,
    tenders: Object.fromEntries(TENDERS.map((tender) => [tender, 0])) as Record<Tender, number>,
    remark: null,
  };
}

function draftIsEmpty(draft: NewRowDraft): boolean {
  return (
    draft.bookingNo === null &&
    draft.guestName === null &&
    draft.roomNo === null &&
    draft.roomCount === null &&
    draft.nights === null &&
    draft.grossRoomSatang === 0 &&
    draft.grossOtherSatang === 0 &&
    draft.discountSatang === 0 &&
    draft.remark === null &&
    TENDERS.every((tender) => draft.tenders[tender] === 0)
  );
}

interface BookingGridProps {
  /** Already sorted by seq. */
  lines: BookingLine[];
  disabled: boolean;
  onPatch: (line: BookingLine, patch: BookingLineInput) => void;
  /** Resolves false when the row could not be saved, so the typed values can
   *  be put back in the blank row instead of being lost. */
  onCreate: (input: BookingLineInput) => void | Promise<boolean>;
  onDelete: (line: BookingLine) => void;
}

/** Key for a หมายเหตุ draft: a saved row by id, the blank bottom row as "new". */
const NEW_ROW_REMARK_KEY = "new";

export function BookingGrid({ lines, disabled, onPatch, onCreate, onDelete }: BookingGridProps) {
  const totals = computeBookingTotals(lines);
  // The draft lives in a ref as well as state: a cell's own onBlur and the
  // row's bubbling onBlur run in the SAME event, so the row handler would
  // otherwise read a pre-update copy and drop the last cell typed.
  const gridRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<NewRowDraft>(emptyDraft());
  const [draft, setDraft] = useState<NewRowDraft>(draftRef.current);
  const newRow = lines.length;

  // ── Amount-in-text tripwire on หมายเหตุ ────────────────────────────────
  // Live text per row while it is being typed; a row with no entry here
  // falls back to its saved remark, so an imported row that already carries
  // the defect ("...(โอนเงิน300)") is flagged on arrival, not only once
  // someone edits it. Cleared on commit so the saved value takes over again.
  const [remarkDrafts, setRemarkDrafts] = useState<Record<string, string>>({});

  function setRemarkDraft(key: string, text: string) {
    setRemarkDrafts((prev) => ({ ...prev, [key]: text }));
  }
  function clearRemarkDraft(key: string) {
    setRemarkDrafts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }
  function remarkText(key: string, saved: string | null): string {
    return remarkDrafts[key] ?? saved ?? "";
  }

  const warnRemarkSeqs = lines
    .filter((line) => looksLikeAmountInText(remarkText(String(line.id), line.remark)))
    .map((line) => line.seq);
  const warnNewRowRemark = looksLikeAmountInText(remarkText(NEW_ROW_REMARK_KEY, draft.remark));

  function patchDraft(patch: Partial<NewRowDraft>) {
    draftRef.current = { ...draftRef.current, ...patch };
    setDraft(draftRef.current);
  }

  // Excel's own rule: the blank row becomes a real row when you leave it,
  // not on the first keystroke — so tabbing across it types one booking,
  // not six half-empty ones.
  function commitDraftRow() {
    const pending = draftRef.current;
    if (disabled || draftIsEmpty(pending)) return;
    draftRef.current = emptyDraft();
    setDraft(draftRef.current);
    clearRemarkDraft(NEW_ROW_REMARK_KEY);
    const result = onCreate({ ...pending, source: "manual", draft: false, sourceSheet: null });
    // The page inserts the row optimistically, so the blank row can clear at
    // once. If the save then fails it says so — put the typed values back
    // rather than leaving the operator retyping a booking from memory.
    void Promise.resolve(result).then((ok) => {
      if (ok === false && draftIsEmpty(draftRef.current)) {
        draftRef.current = pending;
        setDraft(pending);
      }
    });
  }

  /** The blank bottom row is the "new row" — this just puts the caret in it.
   *  Creation still happens the Excel way, when the row is left. */
  function focusNewRow() {
    const table = gridRef.current?.querySelector("table") ?? null;
    focusCell(table, "bookingNo", newRow);
  }

  return (
    // The scrolling grid, plus the tripwire's warning bar under it. Children
    // keep the grid's own indentation — the wrapper is layout only.
    <div className="flex flex-col" ref={gridRef}>
    {/* Height budgeted so the sticky header AND the pinned totals row are
        both on screen without scrolling the page — the rows scroll inside
        here instead. The floor keeps it usable on a short window. */}
    <div className="overflow-auto" style={{ maxHeight: "max(18rem, calc(100vh - 24rem))" }}>
      <table className="w-full min-w-[1360px] border-separate border-spacing-0 bg-panel text-sm">
        <BookingGridColgroup withActions />
        <BookingGridHead withActions sticky />

        <tbody>
          {lines.map((line, rowIndex) => (
            <BookingRow
              key={line.id}
              line={line}
              row={rowIndex}
              disabled={disabled}
              onPatch={(patch) => onPatch(line, patch)}
              onDelete={() => onDelete(line)}
              onRemarkDraft={(text) => setRemarkDraft(String(line.id), text)}
              onRemarkCommitted={() => clearRemarkDraft(String(line.id))}
              warnRemarkAmountInText={looksLikeAmountInText(remarkText(String(line.id), line.remark))}
            />
          ))}

          {/* Blank row: typing in it creates the next booking. */}
          <tr
            className="bg-shell hover:bg-tint"
            onBlur={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) commitDraftRow();
            }}
          >
            <td className={CELL + " px-1.5 text-center text-xs text-ink-muted"}>{newRow + 1}</td>
            <td className={CELL}>
              <TextCell
                row={newRow}
                col="bookingNo"
                disabled={disabled}
                ariaLabel="เลขที่ใบกำกับภาษี แถวใหม่"
                value={draft.bookingNo}
                maxLength={BOOKING_NO_MAX_LEN}
                onCommit={(bookingNo) => patchDraft({ bookingNo })}
              />
            </td>
            <td className={CELL}>
              <TextCell
                row={newRow}
                col="guestName"
                disabled={disabled}
                ariaLabel="ชื่อลูกค้า แถวใหม่"
                value={draft.guestName}
                maxLength={GUEST_NAME_MAX_LEN}
                onCommit={(guestName) => patchDraft({ guestName })}
              />
            </td>
            <td className={CELL}>
              <TextCell
                row={newRow}
                col="roomNo"
                disabled={disabled}
                ariaLabel="เลขที่ห้อง แถวใหม่"
                value={draft.roomNo}
                maxLength={ROOM_NO_MAX_LEN}
                onCommit={(roomNo) => patchDraft({ roomNo })}
              />
            </td>
            <td className={CELL}>
              <CountCell
                row={newRow}
                col="roomCount"
                disabled={disabled}
                ariaLabel="จำนวนห้อง แถวใหม่"
                value={draft.roomCount}
                onCommit={(roomCount) => patchDraft({ roomCount })}
              />
            </td>
            <td className={CELL}>
              <CountCell
                row={newRow}
                col="nights"
                disabled={disabled}
                ariaLabel="จำนวนคืน แถวใหม่"
                value={draft.nights}
                onCommit={(nights) => patchDraft({ nights })}
              />
            </td>
            <td className={CELL}>
              <MoneyCell
                row={newRow}
                col="grossRoomSatang"
                disabled={disabled}
                ariaLabel="จำนวนเงินก่อนหักส่วนลด ค่าห้อง แถวใหม่"
                value={draft.grossRoomSatang}
                onCommit={(grossRoomSatang) => patchDraft({ grossRoomSatang })}
              />
            </td>
            <td className={CELL}>
              <MoneyCell
                row={newRow}
                col="grossOtherSatang"
                disabled={disabled}
                ariaLabel="จำนวนเงินก่อนหักส่วนลด อื่นๆ แถวใหม่"
                value={draft.grossOtherSatang}
                onCommit={(grossOtherSatang) => patchDraft({ grossOtherSatang })}
              />
            </td>
            <td className={CELL}>
              <MoneyCell
                row={newRow}
                col="discountSatang"
                disabled={disabled}
                ariaLabel="ส่วนลด แถวใหม่"
                value={draft.discountSatang}
                onCommit={(discountSatang) => patchDraft({ discountSatang })}
              />
            </td>
            {TENDERS.map((tender) => (
              <td key={tender} className={CELL}>
                <MoneyCell
                  row={newRow}
                  col={tender}
                  disabled={disabled}
                  ariaLabel={`${TENDER_LABELS_TH[tender]} แถวใหม่`}
                  value={draft.tenders[tender]}
                  onCommit={(satang) => patchDraft({ tenders: { ...draft.tenders, [tender]: satang } })}
                />
              </td>
            ))}
            <td className={CELL}>
              <TextCell
                row={newRow}
                col="remark"
                disabled={disabled}
                ariaLabel="หมายเหตุ แถวใหม่"
                value={draft.remark}
                maxLength={REMARK_MAX_LEN}
                onCommit={(remark) => patchDraft({ remark })}
                onDraftChange={(text) => setRemarkDraft(NEW_ROW_REMARK_KEY, text)}
                warnAmountInText={warnNewRowRemark}
              />
            </td>
            <td className={CELL} />
          </tr>
        </tbody>

        {/* Totals pinned at the bottom — every figure from
            computeBookingTotals(), never recomputed here. */}
        <BookingGridFoot totals={totals} withActions sticky />
      </table>
    </div>

    {/* The blank bottom row is easy to miss on a full sheet, so name it. The
        button only moves the caret there — the row still becomes real when
        it is left, so there is never a half-empty booking sitting in the
        day. Hidden once the month is closed, like every other write. */}
    {!disabled && (
      <div className="flex items-center gap-2 border-t border-line px-4 py-2">
        <button
          type="button"
          onClick={focusNewRow}
          className="rounded-lg border border-brand-500 px-2.5 py-1 text-xs font-medium text-brand-500 hover:bg-brand-500 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
        >
          + เพิ่มรายการจอง
        </button>
        <span className="text-xs text-ink-muted">
          พิมพ์ในแถวว่างท้ายตาราง แล้วออกจากแถวเพื่อบันทึก
        </span>
      </div>
    )}

    {/* The tripwire's full wording, once, where it cannot be clipped by the
        104px หมายเหตุ column. A warning only: the row is already saved and
        stays saved. */}
    {(warnRemarkSeqs.length > 0 || warnNewRowRemark) && (
      <p className="border-t border-warn/40 bg-gold-50 px-4 py-2 text-xs text-warn">
        {AMOUNT_IN_TEXT_WARNING_TH}
        {warnRemarkSeqs.length > 0 && <span className="ml-1 tabular-nums">(แถว {warnRemarkSeqs.join(", ")})</span>}
      </p>
    )}
    </div>
  );
}

interface BookingRowProps {
  line: BookingLine;
  row: number;
  disabled: boolean;
  onPatch: (patch: BookingLineInput) => void;
  onDelete: () => void;
  onRemarkDraft: (text: string) => void;
  onRemarkCommitted: () => void;
  warnRemarkAmountInText: boolean;
}

function BookingRow({
  line,
  row,
  disabled,
  onPatch,
  onDelete,
  onRemarkDraft,
  onRemarkCommitted,
  warnRemarkAmountInText,
}: BookingRowProps) {
  const mismatch = !line.draft && lineArithmeticMismatch(line);

  return (
    <tr className={line.draft ? "bg-gold-50 hover:bg-gold-100" : "hover:bg-tint"}>
      <td className={CELL + " px-1 text-center align-top"}>
        <span className="tabular-nums text-xs text-ink-muted">{line.seq}</span>
        {mismatch && (
          <span
            title="ยอดที่ได้รับไม่ตรงกับยอดห้อง+อื่นๆ-ส่วนลด (รายการจากช่องทางออนไลน์มักต่างกันได้ ไม่ใช่ข้อผิดพลาดเสมอไป)"
            aria-label="ยอดไม่ตรง"
            className="ml-0.5 align-super text-[11px] font-bold text-warn"
          >
            *
          </span>
        )}
        {line.draft && (
          <button
            type="button"
            onClick={() => onPatch({ draft: false })}
            disabled={disabled}
            title="ร่างจากระบบจองอัตโนมัติ - กดเพื่อยืนยันรายการ"
            className="mt-0.5 block w-full rounded-sm border border-line-strong text-[11px] font-medium text-ink-muted hover:bg-panel focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
          >
            ร่าง
          </button>
        )}
        {!line.draft && line.sourceSheet && (
          <span
            title={`นำเข้าจาก: ${line.sourceSheet}`}
            className="mt-0.5 block text-[11px] leading-tight text-ink-muted"
          >
            นำเข้า
          </span>
        )}
      </td>
      <td className={CELL}>
        <TextCell
          row={row}
          col="bookingNo"
          disabled={disabled}
          ariaLabel={`เลขที่ใบกำกับภาษี แถว ${line.seq}`}
          value={line.bookingNo}
          maxLength={BOOKING_NO_MAX_LEN}
          onCommit={(bookingNo) => onPatch({ bookingNo })}
        />
      </td>
      <td className={CELL}>
        <TextCell
          row={row}
          col="guestName"
          disabled={disabled}
          ariaLabel={`ชื่อลูกค้า แถว ${line.seq}`}
          value={line.guestName}
          maxLength={GUEST_NAME_MAX_LEN}
          onCommit={(guestName) => onPatch({ guestName })}
        />
      </td>
      <td className={CELL}>
        <TextCell
          row={row}
          col="roomNo"
          disabled={disabled}
          ariaLabel={`เลขที่ห้อง แถว ${line.seq}`}
          value={line.roomNo}
          maxLength={ROOM_NO_MAX_LEN}
          onCommit={(roomNo) => onPatch({ roomNo })}
        />
      </td>
      <td className={CELL}>
        <CountCell
          row={row}
          col="roomCount"
          disabled={disabled}
          ariaLabel={`จำนวนห้อง แถว ${line.seq}`}
          value={line.roomCount}
          onCommit={(roomCount) => onPatch({ roomCount })}
        />
      </td>
      <td className={CELL}>
        <CountCell
          row={row}
          col="nights"
          disabled={disabled}
          ariaLabel={`จำนวนคืน แถว ${line.seq}`}
          value={line.nights}
          onCommit={(nights) => onPatch({ nights })}
        />
      </td>
      <td className={CELL}>
        <MoneyCell
          row={row}
          col="grossRoomSatang"
          disabled={disabled}
          ariaLabel={`จำนวนเงินก่อนหักส่วนลด ค่าห้อง แถว ${line.seq}`}
          value={line.grossRoomSatang}
          onCommit={(grossRoomSatang) => onPatch({ grossRoomSatang })}
        />
      </td>
      <td className={CELL}>
        <MoneyCell
          row={row}
          col="grossOtherSatang"
          disabled={disabled}
          ariaLabel={`จำนวนเงินก่อนหักส่วนลด อื่นๆ แถว ${line.seq}`}
          value={line.grossOtherSatang}
          onCommit={(grossOtherSatang) => onPatch({ grossOtherSatang })}
        />
      </td>
      <td className={CELL}>
        <MoneyCell
          row={row}
          col="discountSatang"
          disabled={disabled}
          ariaLabel={`ส่วนลด แถว ${line.seq}`}
          value={line.discountSatang}
          onCommit={(discountSatang) => onPatch({ discountSatang })}
        />
      </td>
      {TENDERS.map((tender) => (
        <td key={tender} className={CELL}>
          <MoneyCell
            row={row}
            col={tender}
            disabled={disabled}
            ariaLabel={`${TENDER_LABELS_TH[tender]} แถว ${line.seq}`}
            value={line.tenders[tender]}
            onCommit={(satang) => onPatch({ tenders: { ...line.tenders, [tender]: satang } })}
          />
        </td>
      ))}
      <td className={CELL}>
        <TextCell
          row={row}
          col="remark"
          disabled={disabled}
          ariaLabel={`หมายเหตุ แถว ${line.seq}`}
          value={line.remark}
          maxLength={REMARK_MAX_LEN}
          onCommit={(remark) => {
            // Hand the row back to its saved value: the parent updates
            // line.remark optimistically, so the tripwire keeps reading the
            // text that is actually in the row (and un-fires on a rollback).
            onRemarkCommitted();
            onPatch({ remark });
          }}
          onDraftChange={onRemarkDraft}
          warnAmountInText={warnRemarkAmountInText}
        />
      </td>
      {/* Delete sits at the row edge, after หมายเหตุ — never a tab stop in
          the middle of a row being typed across. */}
      <td className={CELL + " text-center"}>
        <button
          type="button"
          onClick={onDelete}
          disabled={disabled}
          title={`ลบแถว ${line.seq}`}
          aria-label={`ลบแถว ${line.seq}`}
          className="px-1 py-1 text-xs font-medium text-bad hover:underline focus:outline-none focus:ring-2 focus:ring-inset focus:ring-brand-500/40 disabled:opacity-40"
        >
          ลบ
        </button>
      </td>
    </tr>
  );
}
