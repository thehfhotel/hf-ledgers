// Date utilities. Storage format: ISO yyyy-mm-dd — the Bangkok CALENDAR day,
// not the server or browser's own local date (see todayBangkok()). Display
// mirrors the paper sheet: Thai Buddhist Era (พ.ศ. = CE + 543).

/** Today's business date as a Bangkok calendar string, regardless of the
 * server/browser's own timezone. This is THE definition of "today" for
 * every day-sheet route in the app. */
export function todayBangkok(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Compact "HH:MM" Bangkok wall-clock time for an ISO-8601 instant — the
 * payment-time chip on the day-audit (ตรวจรายวัน) and slips (ส่งสลิป) queues,
 * next to each row's refs line, so the newest-first date+time sort (owner
 * ask, 2026-08-04) is actually legible rather than an invisible ordering
 * rule. No seconds (Thai-appropriate, matches every other timestamp chip in
 * this app — `formatCheckedAt`/`formatWhen`). `null` in (a row's
 * `paidAtIso` may legitimately be `null`, or the instant may fail to parse)
 * -> `null` out, never a guessed/blank string. */
export function timeBangkok(iso: string | null): string | null {
  if (iso === null) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function isoToBuddhist(iso: string): string {
  const d = parseIso(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`;
}

const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

export function isoToThaiLong(iso: string): string {
  const d = parseIso(iso);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

const THAI_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

/** "2026-07" -> "กรกฎาคม 2569", for the history-page month stepper header. */
export function monthToThaiLong(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${THAI_MONTHS[m! - 1]} ${y! + 543}`;
}

/** "2026-07" -> "ก.ค. 2569" */
export function monthToThaiShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${THAI_MONTHS_SHORT[m! - 1]} ${y! + 543}`;
}

export function shiftDays(iso: string, delta: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + delta);
  return toIso(d);
}

export function isValidIso(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

export function isValidMonth(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s);
}

/** This month as a Bangkok "YYYY-MM" string. */
export function currentMonthBangkok(): string {
  return todayBangkok().slice(0, 7);
}

export function shiftMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Whole days between two Bangkok calendar date strings (`b` minus `a`) —
 * used for the deposit register's "days outstanding" aging column (Wave D).
 * Both inputs are plain calendar dates (no time-of-day), so this is exact
 * integer day arithmetic via `parseIso`, never wall-clock subtraction. */
export function daysBetween(a: string, b: string): number {
  const msPerDay = 24 * 60 * 60 * 1000;
  return Math.round((parseIso(b).getTime() - parseIso(a).getTime()) / msPerDay);
}
