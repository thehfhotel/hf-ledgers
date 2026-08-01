import { useEffect, useMemo, useState } from "react";
import { daysBetween, isoToBuddhist, monthToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang } from "../../shared/money.ts";
import {
  DEPOSIT_TENDER_LABELS_TH,
  DEPOSIT_THREAD_STATUS_LABELS_TH,
  type DepositThreadStatus,
  type Property,
} from "../../shared/types.ts";
import {
  ApiError,
  getDepositRegister,
  type DepositAgingRow,
  type DepositMismatchedException,
  type DepositMonthlyReconciliation,
  type DepositOrphanAppliedException,
  type DepositOverRefundedException,
  type DepositReceivedTenderAmount,
  type DepositRegisterEvent,
  type DepositRegisterResponse,
} from "../api.ts";
import { DepositNoteEditor } from "../components/DepositNoteEditor.tsx";
import {
  depositFilterBucketForStatus,
  type DepositFilterBucket,
  matchesDepositExceptionFilter,
  matchesDepositFilter,
} from "./depositRegisterFilter.ts";
import { PropertyBadge } from "./PropertyBadge.tsx";

interface Props {
  property: Property;
}

type NoteFields = { note: string | null; resolvedAt: string | null; resolvedBy: string | null };

/** The ทั้งหมด/คงค้าง/เสร็จสิ้น pill's three options, in display order —
 * owner ask (2026-08-01): "create a pill to select finished and
 * outstanding so office can focus only on the outstanding". */
const DEPOSIT_FILTER_OPTIONS: ReadonlyArray<{ value: DepositFilterBucket; label: string }> = [
  { value: "all", label: "ทั้งหมด" },
  { value: "outstanding", label: "คงค้าง" },
  { value: "finished", label: "เสร็จสิ้น" },
];

/** Owner ask (2026-08-01, unified มัดจำ table): the single thread table's
 * heading + empty-state wording, keyed by the same pill that governs its
 * row set — the pill above the table already names the current filter, so
 * these stay short rather than restating "ตามตัวกรอง...". Replaces the old
 * fixed "เงินมัดจำคงค้าง (รอเช็คอิน)" heading, which only ever fit the
 * outstanding-only table it used to be. */
const REGISTER_TABLE_HEADING_TH: Record<DepositFilterBucket, string> = {
  all: "รายการมัดจำ (ทั้งหมด)",
  outstanding: "เงินมัดจำคงค้าง (รอเช็คอิน)",
  finished: "มัดจำที่เสร็จสิ้นแล้ว (ตัดยอด/คืนเงิน)",
};
const REGISTER_TABLE_EMPTY_TH: Record<DepositFilterBucket, string> = {
  all: "ยังไม่มีข้อมูลมัดจำล่วงหน้า",
  outstanding: "ไม่มีมัดจำล่วงหน้าคงค้าง",
  finished: "ยังไม่มีมัดจำที่เสร็จสิ้น",
};

/** The page's top-level tab (owner ask, 2026-08-01: "สรุปรายเดือน — move to
 * another pill as another page/tab"). `"register"` (default) is the office's
 * day-to-day working view; `"summary"` is the accounting view. Component
 * state only, one shared `register` fetch underneath both — see
 * `DepositRegisterPage`'s own doc comment for the full section split. */
type DepositRegisterTab = "register" | "summary";

const DEPOSIT_TABS: ReadonlyArray<{ value: DepositRegisterTab; label: string }> = [
  { value: "register", label: "รายการมัดจำ" },
  { value: "summary", label: "สรุปรายเดือน" },
];

/** รับ / ตัดยอด / คืนเงิน — the section's own wording for a deposit event's
 * kind. Shared by the voided footnote and the สรุปรายเดือน expandable event
 * list so the two never drift apart. */
function depositKindLabelTh(kind: "received" | "applied" | "refunded"): string {
  return kind === "received" ? "รับ" : kind === "applied" ? "ตัดยอด" : "คืนเงิน";
}

/** "R001153 · R2603-0140[ · CH26-005269]" — R-number, pay_no, and (applied
 * events only) the CH ref, so the office can trace an event back to the
 * actual PMS transaction (owner ask, 2026-08-01: "need some ref too so it's
 * map-able"). */
function depositEventRefLabel(event: DepositRegisterEvent): string {
  const parts = [event.rNumber, event.pmsRef, event.kind === "applied" ? event.chRef : null].filter(
    (p): p is string => !!p,
  );
  return parts.join(" · ");
}

/** Guest name (when known) above the event's own `depositEventRefLabel`,
 * demoted to a muted secondary line — owner ask (2026-08-01, guest name):
 * "render the guest name wherever an R-number identifies a deposit". This
 * is the EVENT-level counterpart of `RNumberRef`'s thread-level guest name
 * (the สรุปรายเดือน tab's expanded month event rows are a per-event, not
 * per-thread, view — see `DepositLedgerEvent.guestName`'s doc comment in
 * deposit-register.ts for why each event carries its own copy).
 * `guestName` nullable -> renders exactly the refs alone, today's layout. */
function EventGuestRef({ event }: { event: DepositRegisterEvent }) {
  const refs = depositEventRefLabel(event);
  if (!event.guestName) return <>{refs}</>;
  return (
    <span className="flex flex-col gap-0.5">
      <span>{event.guestName}</span>
      <span className="text-[11px] font-normal text-ink-muted">{refs}</span>
    </span>
  );
}

/** Chip tone per `DepositThreadStatus` — reuses the app's own ok/warn/stone
 * semantic colors rather than inventing a new hue. Gold/warn for anything
 * still holding a balance (รอเช็คอิน, บางส่วน — "money the office is
 * holding"). ตัดยอดแล้ว and คืนเงินแล้ว are deliberately DIFFERENT tones even
 * though both are "closed out": applied means the money became revenue
 * (ok/green, matches the existing "แก้ไขแล้ว" resolved badge), refunded
 * means it left the estate (a neutral stone chip — closed, but not the
 * same "good outcome" signal as applied). */
const DEPOSIT_STATUS_CHIP_CLASS: Record<DepositThreadStatus, string> = {
  waitingCheckin: "bg-gold-100 text-warn",
  partial: "bg-gold-100 text-warn",
  applied: "bg-ok/15 text-ok",
  refunded: "bg-line text-ink-muted",
};

/** "โอน" / "เงินสด 200.00 · โอน 195.00" — a thread's METHOD OF PAYMENT text
 * (owner ask, 2026-08-01, มัดจำ register tender visibility: "the unified
 * thread table ... must show the method of payment (tender) of each
 * deposit"). A single tender renders as its bare label — no amount, since
 * the row's own รับ column already shows the total and repeating it here
 * would be noise. A genuine split receipt (rare: two received events on the
 * same R-number using different tenders) shows each tender's own amount so
 * the split reads without opening the PMS. `receivedTenders` empty (the
 * zeroTenderRow edge case, or an exceptions row that never carries this
 * field at all) renders nothing. */
function depositTenderSummaryLabel(receivedTenders: readonly DepositReceivedTenderAmount[]): string | null {
  if (receivedTenders.length === 0) return null;
  if (receivedTenders.length === 1) return DEPOSIT_TENDER_LABELS_TH[receivedTenders[0]!.tender];
  return receivedTenders.map((t) => `${DEPOSIT_TENDER_LABELS_TH[t.tender]} ${formatSatang(t.amountSatang)}`).join(" · ");
}

/** Owner ask (2026-08-01, explicit deposit state): every thread-shaped row
 * shows its status via this chip — see `DepositThreadStatus`'s doc comment
 * (shared/types.ts) for the four values' exact definitions. When the
 * status is `"applied"`/`"partial"` and a mapping exists, shows "where it
 * went" (the CH ref + applied date) right next to the chip so a used
 * deposit is traceable without opening the PMS. `tenderLabel` (owner ask,
 * 2026-08-01, tender visibility) — optional, only the register's unified
 * thread table (`ThreadRow`) passes one; renders as a small muted chip/text
 * right next to the state chip, in the SAME flex-wrap row. */
function StatusChip({
  status,
  appliedChRef,
  appliedDateBangkok,
  tenderLabel,
}: {
  status: DepositThreadStatus;
  appliedChRef?: string | null;
  appliedDateBangkok?: string | null;
  tenderLabel?: string | null;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <span
        className={"rounded-full px-2 py-0.5 text-[11px] font-medium leading-none " + DEPOSIT_STATUS_CHIP_CLASS[status]}
      >
        {DEPOSIT_THREAD_STATUS_LABELS_TH[status]}
      </span>
      {(status === "applied" || status === "partial") && appliedChRef && (
        <span className="text-[11px] text-ink-muted">
          → {appliedChRef}
          {appliedDateBangkok && <> ({isoToBuddhist(appliedDateBangkok)})</>}
        </span>
      )}
      {tenderLabel && <span className="text-[11px] text-ink-muted">{tenderLabel}</span>}
    </span>
  );
}

/** Small pill badge for an aging row's note state — gold whenever
 * unresolved (whether or not a note has been typed yet, so an untouched
 * exception still gets an office's attention), green once resolved. Click
 * toggles the row's inline editor. */
function NoteBadge({ note, resolvedAt, onClick }: NoteFields & { onClick: () => void }) {
  const label = resolvedAt !== null ? "แก้ไขแล้ว" : note !== null ? "มีบันทึก" : "ยังไม่มีบันทึก";
  const className =
    resolvedAt !== null
      ? "bg-ok/15 text-ok"
      : "bg-gold-100 text-warn"; // gold-when-unresolved, per the plan
  return (
    <button
      type="button"
      onClick={onClick}
      className={"rounded-full px-2 py-0.5 text-[11px] font-medium leading-none " + className}
    >
      {label}
    </button>
  );
}

/**
 * ทะเบียนมัดจำล่วงหน้า — the office deposit register (Wave D, issue #5). A
 * read-only view over the PMS's full deposit-lifecycle history (money is
 * never editable here — only office notes are), route `/:property/deposits`,
 * nav label "มัดจำ". No gating beyond the property's own PMS configuration:
 * this app carries no roles.
 *
 * Two top-level tabs (D5, 2026-08-01, "move สรุปรายเดือน to another page/
 * tab" — see `DEPOSIT_TABS`), one shared fetch underneath both. The tab pill
 * and (on the working tab) the ทั้งหมด/คงค้าง/เสร็จสิ้น filter pill share ONE
 * line (owner ask, 2026-08-01, มัดจำ page UI fix round):
 *
 * - รายการมัดจำ (default) — the working view: the ทั้งหมด/คงค้าง/เสร็จสิ้น
 *   focus-filter pill, then ONE unified thread table (`ThreadRow`, owner
 *   ask 2026-08-01) fed by `register.aging` (outstanding, oldest-first) and
 *   `register.finished` (closed-out, newest-closed-first) filtered through
 *   the pill — every row carries an explicit `DepositThreadStatus` chip.
 *   Replaces the old two-table split (an outstanding-only aging table plus
 *   a separate, capped ตัดยอดแล้วล่าสุด event list that "เสร็จสิ้น" couldn't
 *   even populate) — a fully-applied/refunded deposit now has a real row in
 *   the SAME table, no hunting through months required. ข้อยกเว้น
 *   (mismatched, orphanApplied — these demand office action) stays below
 *   it, never moving to the other tab, but AS OF 2026-08-01 it DOES share
 *   this tab's ทั้งหมด/คงค้าง/เสร็จสิ้น pill: bucketed by each exception's own
 *   note resolution (unresolved -> คงค้าง, keeps its warn styling; resolved
 *   -> เสร็จสิ้น, calm/ok-toned) rather than by thread status — see the
 *   ข้อยกเว้น section's own comment below for the full rule. The tab label's
 *   count badge counts UNRESOLVED exceptions only, so it stays visible (and
 *   accurate) from สรุปรายเดือน even though the list itself can be filtered
 *   out of view on this tab.
 * - สรุปรายเดือน — the accounting view: the tripwire completeness lines,
 *   the monthly reconciliation table (owner ask, 2026-08-01, live-register
 *   fix round: oldest first / ascending — was newest-first, each month
 *   expandable into its chronological event list — with the focus filter
 *   gone from this tab, every expanded event renders undimmed), and the
 *   collapsed, greyed voided footnote.
 *
 * Desktop-wide layout, same shell width convention as HistoryPage.tsx (this
 * office runs on one desktop PC, not a thumb-optimised second layout).
 */
export function DepositRegisterPage({ property }: Props) {
  const [register, setRegister] = useState<DepositRegisterResponse | null>(null);
  const [pmsNotConfigured, setPmsNotConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedAgingR, setExpandedAgingR] = useState<Set<string>>(new Set());
  const [expandedMonths, setExpandedMonths] = useState<Set<string>>(new Set());
  // Owner ask (2026-08-01, ทั้งหมด/คงค้าง/เสร็จสิ้น pill): defaults to
  // "outstanding", NOT "all" — the owner's stated purpose for this control
  // is letting the office focus on what still needs attention ("so office
  // can focus only on the outstanding"); opening on the full unfiltered
  // register would bury that intent under every already-closed-out thread
  // on day one. Component state only (no URL hash): the pill is a per-visit
  // view preference, not something worth round-tripping through a
  // bookmarkable link — see `matchesDepositFilter`'s doc comment
  // (depositRegisterFilter.ts) for the exact status -> bucket rule.
  const [filter, setFilter] = useState<DepositFilterBucket>("outstanding");
  // Owner ask (2026-08-01, D5): top-level tab, component state, defaults to
  // the working view. Not reset by the property-switch effect below, same
  // as `filter` above — a per-visit view preference the office likely wants
  // to keep while flipping between properties, not something tied to any
  // one property's data.
  const [activeTab, setActiveTab] = useState<DepositRegisterTab>("register");

  useEffect(() => {
    let cancelled = false;
    setRegister(null);
    setPmsNotConfigured(false);
    setError(null);
    setExpandedAgingR(new Set());
    setExpandedMonths(new Set());

    getDepositRegister(property)
      .then((res) => {
        if (!cancelled) setRegister(res);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 503) {
          setPmsNotConfigured(true);
          return;
        }
        setError(err instanceof Error ? err.message : "โหลดข้อมูลไม่สำเร็จ");
      });

    return () => {
      cancelled = true;
    };
  }, [property]);

  /** Applies a saved note onto EVERY row (aging AND both exception lists)
   * sharing this `rNumber` — a thread can be aging (still outstanding) and
   * separately flagged mismatched at once, and the note is the same
   * conversation either way (see DepositNoteEditor's own doc comment). */
  function applyNoteChange(rNumber: string, fields: NoteFields) {
    setRegister((prev) => {
      if (!prev) return prev;
      const patchRow = <T extends { rNumber: string }>(rows: T[]): T[] =>
        rows.map((row) => (row.rNumber === rNumber ? { ...row, ...fields } : row));
      return {
        ...prev,
        aging: patchRow(prev.aging),
        finished: patchRow(prev.finished),
        exceptions: {
          mismatched: patchRow(prev.exceptions.mismatched),
          orphanApplied: patchRow(prev.exceptions.orphanApplied),
          overRefunded: patchRow(prev.exceptions.overRefunded),
        },
      };
    });
  }

  // Owner ask (2026-08-01, live มัดจำ register fix round): render ascending
  // (oldest first) — was newest-first via `.reverse()`. `register.monthly`
  // already arrives in chronological order (buildMonthlyReconciliation,
  // deposit-register.ts), so this is now a direct pass-through; kept as its
  // own `useMemo`'d binding (rather than reading `register.monthly` inline
  // below) so a future re-sort has one place to change.
  const monthlyAscending = useMemo(() => register?.monthly ?? [], [register]);
  const today = todayBangkok();

  // Owner ask (2026-08-01, unified มัดจำ table): ONE thread list backs the
  // register's single table — `aging` (outstanding, server-sorted
  // oldest-first) and `finished` (closed-out, server-sorted
  // newest-closed-first) concatenated in that order, then filtered through
  // the same `matchesDepositFilter` predicate every bucketed row in this
  // app uses (defensive: never assume the server's own bucketing invariant
  // holds forever). Replaces the old outstanding-only `filteredAging` AND
  // the retired ตัดยอดแล้วล่าสุด section's capped, event-level
  // `recentlyApplied` derivation — a fully-applied/refunded deposit now has
  // a real row in `finished` instead of a 20-item quick-scan list built
  // from raw events.
  const unifiedRows = useMemo(
    () =>
      register
        ? [...register.aging, ...register.finished].filter((row) => matchesDepositFilter(row.status, filter))
        : [],
    [register, filter],
  );

  // Owner ask (2026-08-01, exceptions respect the focus filter once
  // resolved): ข้อยกเว้น now shares the SAME ทั้งหมด/คงค้าง/เสร็จสิ้น pill as
  // the unified thread table above, but bucketed by each exception's OWN
  // note resolution (`matchesDepositExceptionFilter`, keyed off
  // `resolvedAt`) rather than its thread's `DepositThreadStatus` — an
  // unresolved exception must keep shouting under "คงค้าง" regardless of
  // whether its thread already reads "ตัดยอดแล้ว" (the proven R015834
  // shape), and a resolved one moves to "เสร็จสิ้น" the moment its note is
  // saved with the resolved mark (no extra wiring needed: `applyNoteChange`
  // already patches `resolvedAt` in place, so this filter re-evaluates on
  // the very next render).
  const filteredMismatched = useMemo(
    () => (register ? register.exceptions.mismatched.filter((row) => matchesDepositExceptionFilter(row.resolvedAt, filter)) : []),
    [register, filter],
  );
  const filteredOrphanApplied = useMemo(
    () =>
      register ? register.exceptions.orphanApplied.filter((row) => matchesDepositExceptionFilter(row.resolvedAt, filter)) : [],
    [register, filter],
  );
  // Owner fix round (2026-08-01, the R015832 case): the new overRefunded
  // bucket shares the SAME `matchesDepositExceptionFilter` predicate as the
  // two exception lists above — its own note's `resolvedAt`, never its
  // thread's `DepositThreadStatus`, same reasoning throughout this file.
  const filteredOverRefunded = useMemo(
    () =>
      register ? register.exceptions.overRefunded.filter((row) => matchesDepositExceptionFilter(row.resolvedAt, filter)) : [],
    [register, filter],
  );

  function toggleAgingExpanded(rNumber: string) {
    setExpandedAgingR((prev) => {
      const next = new Set(prev);
      if (next.has(rNumber)) next.delete(rNumber);
      else next.add(rNumber);
      return next;
    });
  }

  function toggleMonthExpanded(month: string) {
    setExpandedMonths((prev) => {
      const next = new Set(prev);
      if (next.has(month)) next.delete(month);
      else next.add(month);
      return next;
    });
  }

  if (pmsNotConfigured) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="rounded-lg border border-line bg-panel px-4 py-6 text-center text-sm text-ink-muted">
          ยังไม่ได้เชื่อมต่อ PMS สำหรับโรงแรมนี้
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="rounded-lg border border-bad/30 bg-panel p-4 text-sm text-bad">
          โหลดข้อมูลไม่สำเร็จ: {error}
        </div>
      </div>
    );
  }

  if (!register) {
    return (
      <div className="flex flex-col gap-4">
        <PageHeader property={property} />
        <div className="p-6 text-sm text-ink-muted">กำลังโหลด...</div>
      </div>
    );
  }

  // Owner ask (2026-08-01, D5, exceptions badge; narrowed 2026-08-01,
  // exceptions respect the focus filter once resolved): UNRESOLVED count
  // only, across both exception lists — an exceptional deposit demands
  // office action only until its note is explicitly marked resolved, so a
  // resolved mismatch (now living under the เสร็จสิ้น filter, de-emphasized)
  // must stop inflating this badge. The tab label still doesn't distinguish
  // mismatched from orphanApplied, just "there is still something to look
  // at".
  const exceptionCount =
    register.exceptions.mismatched.filter((e) => e.resolvedAt === null).length +
    register.exceptions.orphanApplied.filter((e) => e.resolvedAt === null).length +
    register.exceptions.overRefunded.filter((e) => e.resolvedAt === null).length;

  return (
    <div className="flex flex-col gap-4 pb-10">
      <PageHeader property={property} />

      {/* Top-level tab (owner ask, 2026-08-01, D5: "สรุปรายเดือน — move to
          another pill as another page/tab") plus, on the working tab only,
          the ทั้งหมด/คงค้าง/เสร็จสิ้น status filter pill — SAME LINE (owner
          ask, 2026-08-01, มัดจำ page UI fix round: the two pills used to
          stack on separate rows). `flex-wrap` lets the pair drop to two
          rows only when the viewport is too narrow to fit both, never by
          default. Same rounded-full dark-housing pill shape on both — the
          tab row's active segment lights up GOLD (the same signal App.tsx's
          own top nav-tab row uses for "which page") so it still reads as a
          navigation control, distinct from the filter pill's ivory "which
          subset" signal, even sitting on the same line. ข้อยกเว้น lives only
          on the working tab (it demands action) but a non-empty count still
          surfaces as a badge on the tab label so it's visible while parked
          on สรุปรายเดือน. */}
      <div className="flex flex-wrap items-center gap-3 self-start">
        <div className="flex items-center gap-0.5 rounded-full bg-brand-900 p-1 ring-1 ring-inset ring-brand-600">
          {DEPOSIT_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setActiveTab(tab.value)}
              aria-pressed={activeTab === tab.value}
              className={
                "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold transition " +
                (activeTab === tab.value ? "bg-gold-500 text-brand-900 shadow-sm" : "text-brand-200 hover:text-white")
              }
            >
              {tab.label}
              {tab.value === "register" && exceptionCount > 0 && (
                <span className="rounded-full bg-warn px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
                  {exceptionCount}
                </span>
              )}
            </button>
          ))}
        </div>

        {/* ทั้งหมด/คงค้าง/เสร็จสิ้น pill (owner ask, 2026-08-01) — same
            segmented-toggle shape as App.tsx's property switcher (dark
            housing, one segment lit ivory): this picks a VIEW FILTER, the
            same kind of question ("which subset am I looking at") the
            property switcher answers, not a navigation target — that's the
            tab row it now shares a line with. Governs only the working
            tab's unified thread table below (never ข้อยกเว้น — see that
            section's own comment). Only rendered on the working tab —
            สรุปรายเดือน carries no focus filter of its own (D5). */}
        {activeTab === "register" && (
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-ink-muted">สถานะ</span>
            <div className="flex items-center gap-0.5 rounded-full bg-brand-900 p-1 ring-1 ring-inset ring-brand-600">
              {DEPOSIT_FILTER_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setFilter(opt.value)}
                  aria-pressed={filter === opt.value}
                  className={
                    "rounded-full px-3 py-1 text-xs font-semibold transition " +
                    (filter === opt.value ? "bg-shell text-brand-800 shadow-sm" : "text-brand-200 hover:text-white")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {activeTab === "register" ? (
        <>
          {/* Owner ask (2026-08-01, unified มัดจำ table): ONE thread table
              for the whole working tab, replacing the old two-table split
              (an outstanding-only เงินมัดจำคงค้าง table plus a separate,
              capped ตัดยอดแล้วล่าสุด event list that the "เสร็จสิ้น" filter
              couldn't even populate — it showed a "hidden under this
              filter" note instead). SAME columns/shapes as the old aging
              table (เลขที่ / รับ / ตัดยอด / คืนเงิน / คงค้าง / ค้างมา (วัน) /
              บันทึก) now serve both buckets via `ThreadRow` (below):
              คงค้าง reads 0.00 and ค้างมา (วัน) reads received->closed
              (rather than received->today) for a finished-bucket row — see
              ThreadRow's own comment. Heading/empty-state text still
              reflects the active pill (REGISTER_TABLE_HEADING_TH/
              REGISTER_TABLE_EMPTY_TH) so the table never reads as
              "generic" under a specific filter. */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
              {REGISTER_TABLE_HEADING_TH[filter]}
            </h2>
            {unifiedRows.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">{REGISTER_TABLE_EMPTY_TH[filter]}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[52rem] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                      <th className="px-4 py-2 text-left">เลขที่</th>
                      <th className="px-4 py-2 text-right">รับ</th>
                      <th className="px-4 py-2 text-right">ตัดยอด</th>
                      <th className="px-4 py-2 text-right">คืนเงิน</th>
                      <th className="px-4 py-2 text-right">คงค้าง</th>
                      <th className="px-4 py-2 text-right">ค้างมา (วัน)</th>
                      <th className="px-4 py-2 text-left">บันทึก</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {unifiedRows.map((row) => (
                      <ThreadRow
                        key={row.rNumber}
                        property={property}
                        row={row}
                        today={today}
                        expanded={expandedAgingR.has(row.rNumber)}
                        onToggle={() => toggleAgingExpanded(row.rNumber)}
                        onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* ข้อยกเว้น — UPDATED RULE (owner ask, 2026-08-01, exceptions
              respect the focus filter once resolved): this section now
              DOES share the ทั้งหมด/คงค้าง/เสร็จสิ้น pill above, but bucketed
              by each exception's OWN note resolution
              (`matchesDepositExceptionFilter`), never by its thread's
              `DepositThreadStatus` — an UNRESOLVED exception always shows
              under "คงค้าง"/"ทั้งหมด" regardless of lifecycle state (the
              R015834 mismatch is thread-status ตัดยอดแล้ว yet stays visible
              while unresolved, keeping its warn styling: "a waiting on
              reception note must keep shouting"); once a note is saved WITH
              the resolved mark, the row moves to "เสร็จสิ้น"/"ทั้งหมด" and
              renders calm/ok-toned instead (`exceptionRowClass`,
              `ResolvedByLine`). This SUPERSEDES the prior "never governed by
              the pill" rule. Stays on this tab only (D5, task point 4 —
              exceptions demand action, so they live with the working view);
              the tab row above carries a count badge of UNRESOLVED
              exceptions only, so a non-empty list is never silently missed
              while parked on สรุปรายเดือน. */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">ข้อยกเว้น</h2>

            <div className="flex flex-col gap-1 px-4 py-3">
              <h3 className="text-xs font-semibold text-ink-muted">ยอดตัดยอดไม่ตรงกับยอดรับ</h3>
              {filteredMismatched.length === 0 ? (
                <p className="text-sm text-ink-muted">ไม่มีรายการ</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {filteredMismatched.map((row) => (
                    <MismatchedRow
                      key={row.rNumber}
                      property={property}
                      row={row}
                      onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="flex flex-col gap-1 border-t border-line px-4 py-3">
              <h3 className="text-xs font-semibold text-ink-muted">ตัดยอดโดยไม่มีเงินรับ</h3>
              {filteredOrphanApplied.length === 0 ? (
                <p className="text-sm text-ink-muted">ไม่มีรายการ</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {filteredOrphanApplied.map((row) => (
                    <OrphanAppliedRow
                      key={row.rNumber}
                      property={property}
                      row={row}
                      onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Owner fix round (2026-08-01, the R015832 case): a third
                exception kind — a refund with no active receipt behind it
                (or a refund exceeding what's still actively received). Same
                note/resolve workflow, same ทั้หมด/คงค้าง/เสร็จสิ้น filter
                (`filteredOverRefunded`, `matchesDepositExceptionFilter`),
                same unresolved-count contribution to the tab badge
                (`exceptionCount` above) as the two exception kinds already
                in this section. */}
            <div className="flex flex-col gap-1 border-t border-line px-4 py-3">
              <h3 className="text-xs font-semibold text-ink-muted">คืนเงินโดยไม่มียอดรับ (หรือคืนเกินยอดรับ)</h3>
              {filteredOverRefunded.length === 0 ? (
                <p className="text-sm text-ink-muted">ไม่มีรายการ</p>
              ) : (
                <div className="flex flex-col gap-3">
                  {filteredOverRefunded.map((row) => (
                    <OverRefundedRow
                      key={row.rNumber}
                      property={property}
                      row={row}
                      onNoteSaved={(fields) => applyNoteChange(row.rNumber, fields)}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1 text-xs text-ink-muted">
            <p>ข้อมูล ณ {new Date(register.generatedAt).toLocaleString("th-TH")}</p>
            {/* Tripwire lines — none of these ever invent or drop money;
                each names a way a row can otherwise leave the register with
                zero signal (review fix — see deposit-register.ts's
                DepositRegisterData doc comment for what each one means).
                Completeness concerns, so they live on this tab with the
                reconciliation (D5, task point 3), same reasoning as the
                voided footnote below. */}
            {register.unparsedAppliedRows > 0 && (
              <p className="font-medium text-warn">
                พบรายการตัดยอด {register.unparsedAppliedRows} รายการที่อ่านเลขที่การจองไม่ได้ — ตรวจสอบใน PMS
              </p>
            )}
            {register.zeroTenderRows > 0 && (
              <p className="font-medium text-warn">
                พบรายการรับ/คืนเงิน {register.zeroTenderRows} รายการที่ไม่มีจำนวนเงินในช่องเงินสด/โอน/เครดิต/เว็บ
                แต่มียอดอื่นในรายการ — ตรวจสอบใน PMS
              </p>
            )}
            {register.blankBookingNoRows > 0 && (
              <p className="font-medium text-warn">
                พบรายการรับ/คืนเงิน {register.blankBookingNoRows} รายการที่ไม่มีเลขที่การจอง — ไม่แสดงในทะเบียนคงค้างหรือข้อยกเว้น
              </p>
            )}
            {register.undatedRows > 0 && (
              <p className="font-medium text-warn">
                พบรายการ {register.undatedRows} รายการที่อ่านวันที่ไม่ได้ — ไม่รวมในสรุปรายเดือน
              </p>
            )}
          </div>

          {/* สรุปรายเดือน — its own totals were never governed by the focus
              filter even before D5; now that the filter pill isn't even on
              this tab, the expanded per-event list no longer dims anything
              either (owner ask, 2026-08-01, D5, task point 3) — every event
              in an expanded month renders undimmed. */}
          <section className="overflow-hidden rounded-lg border border-line bg-panel">
            <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">สรุปรายเดือน</h2>
            {monthlyAscending.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-muted">ยังไม่มีข้อมูลมัดจำล่วงหน้า</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[42rem] text-sm">
                  <thead>
                    <tr className="border-b border-line bg-tint text-xs font-semibold text-ink-muted">
                      <th className="px-4 py-2 text-left">เดือน</th>
                      <th className="px-4 py-2 text-right">ยอดยกมา</th>
                      <th className="px-4 py-2 text-right">รับ</th>
                      <th className="px-4 py-2 text-right">ตัดยอด</th>
                      <th className="px-4 py-2 text-right">คืนเงิน</th>
                      <th className="px-4 py-2 text-right">ยอดยกไป</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {monthlyAscending.map((row) => (
                      <MonthlyRow
                        key={row.month}
                        row={row}
                        events={register.events}
                        expanded={expandedMonths.has(row.month)}
                        onToggle={() => toggleMonthExpanded(row.month)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {/* Voided — collapsed, greyed, excluded from every total above;
              a completeness note, so it stays with the reconciliation. */}
          {register.voided.length > 0 && (
            <details className="rounded-lg border border-line bg-panel px-4 py-2.5 text-sm text-ink-muted">
              <summary className="cursor-pointer select-none text-xs font-semibold">
                รายการที่ถูกยกเลิก ({register.voided.length} รายการ)
              </summary>
              <div className="mt-2 flex flex-col gap-1">
                {register.voided.map((v, i) => (
                  <div
                    key={`${v.rNumber ?? "unknown"}-${i}`}
                    className="flex items-center justify-between gap-3 text-xs"
                  >
                    <span>
                      {v.rNumber ?? "(ไม่ทราบเลขที่)"} — {depositKindLabelTh(v.kind)}
                      {v.dateBangkok && <> ({isoToBuddhist(v.dateBangkok)})</>}
                    </span>
                    <span className="tabular-nums">{formatSatang(v.amountSatang)}</span>
                  </div>
                ))}
                <p className="mt-1 text-[11px] italic">ไม่รวมในยอดข้างต้น</p>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}

/** Guest name (when known) as the primary line with the R-number + pay_no
 * refs demoted to a muted secondary line, plus the thread's explicit
 * `StatusChip` — owner ask (2026-08-01, guest name): "show the booking
 * guest name ... full form". `guestName` is nullable (a thread whose
 * `ht_customers` join found nothing anywhere in its events) — renders
 * EXACTLY today's ref-only layout in that case, never an empty name line.
 * `receivedPmsRef` is `null` for `OrphanAppliedRow` (no received event
 * exists by definition) — omitted from the secondary line in that case.
 * `tenderLabel` (owner ask, 2026-08-01, tender visibility) — optional,
 * forwarded straight to `StatusChip`; only `ThreadRow` (the register's
 * unified thread table, which alone carries `receivedTenders` on its row
 * shape) passes one — the exceptions rows (`MismatchedRow`/
 * `OrphanAppliedRow`) omit it, out of scope for this owner ask. */
function RNumberRef({
  rNumber,
  receivedPmsRef,
  status,
  appliedChRef,
  appliedDateBangkok,
  guestName,
  tenderLabel,
}: {
  rNumber: string;
  receivedPmsRef: string | null;
  status: DepositThreadStatus;
  appliedChRef: string | null;
  appliedDateBangkok: string | null;
  guestName: string | null;
  tenderLabel?: string | null;
}) {
  const refs = receivedPmsRef ? `${rNumber} · ${receivedPmsRef}` : rNumber;
  return (
    <span className="flex flex-col gap-1">
      {guestName ? (
        <>
          <span className="font-semibold text-ink">{guestName}</span>
          <span className="text-[11px] font-normal text-ink-muted">{refs}</span>
        </>
      ) : (
        <>
          <span className="font-semibold text-ink">{rNumber}</span>
          {receivedPmsRef && <span className="text-[11px] font-normal text-ink-muted">{receivedPmsRef}</span>}
        </>
      )}
      <StatusChip status={status} appliedChRef={appliedChRef} appliedDateBangkok={appliedDateBangkok} tenderLabel={tenderLabel} />
    </span>
  );
}

function PageHeader({ property }: { property: Property }) {
  return (
    <div className="flex items-center justify-between">
      <h1 className="flex items-center gap-2 text-sm font-semibold text-ink">
        ทะเบียนมัดจำล่วงหน้า
        <PropertyBadge property={property} />
      </h1>
    </div>
  );
}

/**
 * One สรุปรายเดือน row, expandable (owner ask, 2026-08-01: "need some ref
 * too so it's map-able" — a month's totals alone can't be traced back to
 * any actual transaction). Same interaction feel as `ThreadRow`'s inline
 * expand: click toggles, a following `<tr>` (not a nested `<details>`, so
 * it can hold its own `<table>` cleanly inside the outer table's grid)
 * lists that month's events chronologically. `events` is the FULL register
 * feed — filtered here to this row's month by `dateBangkok`'s `"YYYY-MM"`
 * prefix, the same grouping key `buildMonthlyReconciliation` (server)
 * itself uses, so a month's event list can never disagree with its totals
 * row. Voided events are included (greyed, "(ยกเลิก)") but never advance
 * the running balance — mirrors `buildMonthlyReconciliation`'s own
 * voided-excluded sums.
 *
 * Lives on the สรุปรายเดือน tab (D5, 2026-08-01), which carries no focus
 * filter of its own — every event in an expanded month renders undimmed,
 * the dim-not-remove behavior tied to the ทั้งหมด/คงค้าง/เสร็จสิ้น pill was
 * REMOVED here along with the pill (task point 3).
 */
function MonthlyRow({
  row,
  events,
  expanded,
  onToggle,
}: {
  row: DepositMonthlyReconciliation;
  events: DepositRegisterEvent[];
  expanded: boolean;
  onToggle: () => void;
}) {
  // Owner ask (2026-08-01, live มัดจำ register fix round): chronological
  // within the month means pay_date THEN pay_no, not pay_date alone —
  // events sharing a `dateBangkok` used to fall back on `Array#sort`'s
  // stability (i.e. whatever order `events` happened to arrive in), which
  // only accidentally matched the PMS's own row order; `pmsRef` (the
  // payment key — `pay_no`, or `lid:<legacy_id>` when `pay_no` is blank) is
  // now an explicit tiebreaker so the display order is deterministic and
  // documented, not incidental.
  const monthEvents = useMemo(
    () =>
      events
        .filter((e) => e.dateBangkok !== null && e.dateBangkok.slice(0, 7) === row.month)
        .slice()
        .sort((a, b) => {
          const byDate = (a.dateBangkok ?? "").localeCompare(b.dateBangkok ?? "");
          return byDate !== 0 ? byDate : a.pmsRef.localeCompare(b.pmsRef);
        }),
    [events, row.month],
  );

  // Running balance within the month, seeded from ยอดยกมา — voided events
  // never advance it (they carry no `runningBalance`, rendered "-"), same
  // sign convention buildMonthlyReconciliation's closingSatang uses:
  // received adds, applied/refunded subtract.
  let runningBalance = row.openingSatang;
  const eventRows = monthEvents.map((event) => {
    if (event.voided) return { event, runningBalance: null as number | null };
    runningBalance += event.kind === "received" ? event.amountSatang : -event.amountSatang;
    return { event, runningBalance };
  });

  return (
    <>
      <tr>
        <td className="px-4 py-2 text-ink">
          <button
            type="button"
            onClick={onToggle}
            disabled={monthEvents.length === 0}
            className="flex items-center gap-1.5 text-left disabled:cursor-default"
          >
            <span className="w-3 text-[10px] text-ink-muted">
              {monthEvents.length === 0 ? "" : expanded ? "▾" : "▸"}
            </span>
            {monthToThaiLong(row.month)}
          </button>
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.openingSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.receivedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.appliedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.refundedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums font-semibold text-brand-500">
          {formatSatang(row.closingSatang)}
        </td>
      </tr>
      {expanded && eventRows.length > 0 && (
        <tr>
          <td colSpan={6} className="bg-tint px-4 py-2.5">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[40rem] text-xs">
                <thead>
                  <tr className="text-left text-[11px] font-semibold text-ink-muted">
                    <th className="py-1 pr-3">วันที่</th>
                    <th className="py-1 pr-3">รายการ</th>
                    <th className="py-1 pr-3">เลขที่ / อ้างอิง</th>
                    <th className="py-1 pr-3">ช่องทาง</th>
                    <th className="py-1 pr-3 text-right">จำนวนเงิน</th>
                    {/* Owner ask (2026-08-01, live มัดจำ register fix round):
                        explicit header naming this the month's own running
                        net (seeded from ยอดยกมา, never reset within the
                        month) — was the more generic "ยอดคงเหลือ"
                        ("remaining balance"), easily misread as this EVENT's
                        own balance rather than the month's accumulating
                        total. */}
                    <th className="py-1 text-right">ยอดสะสม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line/60">
                  {eventRows.map(({ event, runningBalance: bal }, i) => {
                    return (
                      <tr
                        key={`${event.pmsRef}-${event.kind}-${i}`}
                        className={event.voided ? "text-ink-muted opacity-60" : "text-ink"}
                      >
                        <td className="py-1 pr-3 tabular-nums">
                          {event.dateBangkok ? isoToBuddhist(event.dateBangkok) : "-"}
                        </td>
                        <td className="py-1 pr-3">
                          {depositKindLabelTh(event.kind)}
                          {event.voided && <span className="ml-1 text-[10px] font-semibold text-bad">(ยกเลิก)</span>}
                        </td>
                        <td className="py-1 pr-3">
                          <EventGuestRef event={event} />
                        </td>
                        <td className="py-1 pr-3">{event.tender ? DEPOSIT_TENDER_LABELS_TH[event.tender] : "-"}</td>
                        <td className="py-1 pr-3 text-right tabular-nums">
                          {event.kind === "received" ? "+" : "-"}
                          {formatSatang(event.amountSatang)}
                        </td>
                        <td className="py-1 text-right tabular-nums">{bal !== null ? formatSatang(bal) : "-"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * One row of the register's unified thread table (owner ask, 2026-08-01) —
 * renamed from the old outstanding-only `AgingRow`: now serves BOTH buckets
 * (`register.aging` and `register.finished`), since the SAME columns fit
 * both once the two cells below read the row's own bucket rather than
 * assuming "outstanding":
 *
 * - คงค้าง: an outstanding-bucket row shows its real `outstandingSatang`
 *   (still owed); a finished-bucket row shows a literal 0.00 (nothing is
 *   owed once a thread is closed — printing its raw `outstandingSatang`
 *   here, which can be a negative R015834-style mismatch figure, would
 *   read as a debt or a credit rather than "closed", and that mismatch is
 *   already surfaced on its own in ข้อยกเว้น).
 * - ค้างมา (วัน): an outstanding-bucket row keeps the original
 *   received->TODAY day count (`daysBetween(firstEventDate, today)`,
 *   "how long has this been sitting"); a finished-bucket row instead
 *   shows received->CLOSED (`daysBetween(firstEventDate, closedDateBangkok)`)
 *   — "how long did this sit before it was resolved" — falling back to "-"
 *   when either date is missing.
 */
function ThreadRow({
  property,
  row,
  today,
  expanded,
  onToggle,
  onNoteSaved,
}: {
  property: Property;
  row: DepositAgingRow;
  today: string;
  expanded: boolean;
  onToggle: () => void;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  const isFinished = depositFilterBucketForStatus(row.status) === "finished";
  const outstandingDisplaySatang = isFinished ? 0 : row.outstandingSatang;
  const days = isFinished
    ? row.firstEventDate && row.closedDateBangkok
      ? daysBetween(row.firstEventDate, row.closedDateBangkok)
      : null
    : row.firstEventDate
      ? daysBetween(row.firstEventDate, today)
      : null;
  // Owner ask (2026-08-01, มัดจำ register tender visibility).
  const tenderLabel = depositTenderSummaryLabel(row.receivedTenders);
  return (
    <>
      <tr>
        <td className="px-4 py-2">
          <RNumberRef
            rNumber={row.rNumber}
            receivedPmsRef={row.receivedPmsRef}
            status={row.status}
            appliedChRef={row.appliedChRef}
            appliedDateBangkok={row.appliedDateBangkok}
            guestName={row.guestName}
            tenderLabel={tenderLabel}
          />
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.receivedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.appliedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums text-ink">{formatSatang(row.refundedSatang)}</td>
        <td className="px-4 py-2 text-right tabular-nums font-semibold text-brand-500">
          {formatSatang(outstandingDisplaySatang)}
        </td>
        <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{days ?? "-"}</td>
        <td className="px-4 py-2">
          <NoteBadge note={row.note} resolvedAt={row.resolvedAt} resolvedBy={row.resolvedBy} onClick={onToggle} />
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="bg-tint px-4 py-2.5">
            <DepositNoteEditor
              property={property}
              rNumber={row.rNumber}
              note={row.note}
              resolvedAt={row.resolvedAt}
              onSaved={onNoteSaved}
              onCancel={onToggle}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/** Owner ask (2026-08-01, exceptions respect the focus filter once
 * resolved): an exception row's wrapper tone — warn (existing gold/amber)
 * while unresolved, so it keeps demanding attention; calm ok-toned once its
 * note is saved with the resolved mark, mirroring `NoteBadge`'s own
 * resolved/unresolved color split and `DEPOSIT_STATUS_CHIP_CLASS`'s applied
 * (ok) tone. */
function exceptionRowClass(resolvedAt: string | null): string {
  return resolvedAt !== null ? "rounded-md border border-ok/30 bg-ok/5 p-3" : "rounded-md border border-warn/40 bg-gold-50 p-3";
}

/** "แก้ไขแล้วโดย ... (1/8/2569)" — shown above the note editor once an
 * exception is resolved, so who/when is visible without expanding anything
 * (the note TEXT itself is already visible inside the editor's own
 * textarea, which seeds from `note` — never duplicated here). `null` for an
 * unresolved row (renders nothing). `resolvedAt` is SQLite's
 * `datetime('now')` TEXT column ("YYYY-MM-DD HH:MM:SS" — `db.ts`'s
 * `upsertDepositNote`), NOT a JS `Date#toISOString()` string — `isoToBuddhist`
 * only parses a bare "YYYY-MM-DD" (`parseIso`, shared/date.ts), hence the
 * `.slice(0, 10)` before handing it off rather than passing the raw value. */
function ResolvedByLine({ resolvedAt, resolvedBy }: { resolvedAt: string | null; resolvedBy: string | null }) {
  if (resolvedAt === null) return null;
  return (
    <p className="mb-1.5 text-[11px] font-medium text-ok">
      แก้ไขแล้วโดย {resolvedBy ?? "-"} ({isoToBuddhist(resolvedAt.slice(0, 10))})
    </p>
  );
}

function MismatchedRow({
  property,
  row,
  onNoteSaved,
}: {
  property: Property;
  row: DepositMismatchedException;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  const resolved = row.resolvedAt !== null;
  return (
    <div className={exceptionRowClass(row.resolvedAt)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <RNumberRef
          rNumber={row.rNumber}
          receivedPmsRef={row.receivedPmsRef}
          status={row.status}
          appliedChRef={row.appliedChRef}
          appliedDateBangkok={row.appliedDateBangkok}
          guestName={row.guestName}
        />
        <div className="flex items-center gap-3 tabular-nums">
          <span className="text-ink-muted">รับ {formatSatang(row.receivedSatang)}</span>
          <span className="text-ink-muted">ตัด {formatSatang(row.appliedSatang)}</span>
          <span className={"font-semibold " + (resolved ? "text-ok" : "text-warn")}>
            ส่วนต่าง {row.diffSatang > 0 ? "+" : "-"}
            {formatSatang(Math.abs(row.diffSatang))}
          </span>
        </div>
      </div>
      <ResolvedByLine resolvedAt={row.resolvedAt} resolvedBy={row.resolvedBy} />
      <DepositNoteEditor
        property={property}
        rNumber={row.rNumber}
        note={row.note}
        resolvedAt={row.resolvedAt}
        onSaved={onNoteSaved}
      />
    </div>
  );
}

function OrphanAppliedRow({
  property,
  row,
  onNoteSaved,
}: {
  property: Property;
  row: DepositOrphanAppliedException;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  const resolved = row.resolvedAt !== null;
  return (
    <div className={exceptionRowClass(row.resolvedAt)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <RNumberRef
          rNumber={row.rNumber}
          receivedPmsRef={row.receivedPmsRef}
          status={row.status}
          appliedChRef={row.appliedChRef}
          appliedDateBangkok={row.appliedDateBangkok}
          guestName={row.guestName}
        />
        <span className={"tabular-nums font-semibold " + (resolved ? "text-ok" : "text-warn")}>
          ตัดยอด {formatSatang(row.appliedSatang)}
        </span>
      </div>
      <ResolvedByLine resolvedAt={row.resolvedAt} resolvedBy={row.resolvedBy} />
      <DepositNoteEditor
        property={property}
        rNumber={row.rNumber}
        note={row.note}
        resolvedAt={row.resolvedAt}
        onSaved={onNoteSaved}
      />
    </div>
  );
}

/** Owner fix round (2026-08-01, the R015832 case): a refund that outran its
 * own active receipt — `row.diffSatang` is always negative (the excess
 * refunded), same signed convention `MismatchedRow` already uses for its own
 * `diffSatang`, so this reuses "-" + abs rather than the "+/-" toggle that
 * row needs (that one's diff can go either direction; this one's can't).
 * Below the amounts, a muted helper line names the LIKELY cause + fix
 * (owner ask: "suggest the likely cause") — the R015832 shape specifically:
 * a voided receipt whose refund was never itself voided — so the office
 * knows exactly what to check in iHOTEL without re-deriving it from the
 * numbers alone. Same note/resolve workflow (`DepositNoteEditor`,
 * `ResolvedByLine`, `exceptionRowClass`) as `MismatchedRow`/
 * `OrphanAppliedRow`. */
function OverRefundedRow({
  property,
  row,
  onNoteSaved,
}: {
  property: Property;
  row: DepositOverRefundedException;
  onNoteSaved: (fields: NoteFields) => void;
}) {
  const resolved = row.resolvedAt !== null;
  const tenderLabel = depositTenderSummaryLabel(row.receivedTenders);
  return (
    <div className={exceptionRowClass(row.resolvedAt)}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-sm">
        <RNumberRef
          rNumber={row.rNumber}
          receivedPmsRef={row.receivedPmsRef}
          status={row.status}
          appliedChRef={row.appliedChRef}
          appliedDateBangkok={row.appliedDateBangkok}
          guestName={row.guestName}
          tenderLabel={tenderLabel}
        />
        <div className="flex items-center gap-3 tabular-nums">
          <span className="text-ink-muted">รับ {formatSatang(row.receivedSatang)}</span>
          <span className="text-ink-muted">คืน {formatSatang(row.refundedSatang)}</span>
          <span className={"font-semibold " + (resolved ? "text-ok" : "text-warn")}>
            เกิน {formatSatang(Math.abs(row.diffSatang))}
          </span>
        </div>
      </div>
      <p className="mb-1.5 text-[11px] text-ink-muted">
        ใบรับถูกยกเลิกแต่รายการคืนเงินยังไม่ถูกยกเลิก — ตรวจสอบใน iHOTEL
      </p>
      <ResolvedByLine resolvedAt={row.resolvedAt} resolvedBy={row.resolvedBy} />
      <DepositNoteEditor
        property={property}
        rNumber={row.rNumber}
        note={row.note}
        resolvedAt={row.resolvedAt}
        onSaved={onNoteSaved}
      />
    </div>
  );
}
