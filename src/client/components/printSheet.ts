// Print machinery for the พิมพ์ buttons (BookingDayPage, DaySheetPage). A
// single HTML document can only carry one effective @page size, so the
// orientation-specific rule (landscape for the booking sheet, portrait for
// the day summary — see printGeometry.ts) is injected as a <style> element
// right before window.print() and removed once the print interaction is
// over.
//
// 'afterprint' — not the return of window.print() — is the cleanup signal:
// window.print() opens the OS print dialog and, per spec, does not
// reliably block until it closes (some browsers return immediately). Every
// browser fires 'afterprint' once the dialog is dismissed either way, so
// that is the only place it's safe to remove the injected rule (and let
// the caller reset its own print-scale state).

import { pageRuleCss, type PageOrientation } from "./printGeometry.ts";

/** How long after window.print() we wait for SOME end-of-print signal before
 *  force-recovering. Generous: an operator can sit in the dialog a while. */
const PRINT_WATCHDOG_MS = 90_000;

export function printWithPageRule(orientation: PageOrientation, marginMm: number, onDone?: () => void): void {
  const style = document.createElement("style");
  style.textContent = pageRuleCss(orientation, marginMm);
  document.head.appendChild(style);

  // One cleanup, three triggers. 'afterprint' is the correct signal, but a
  // print attempt that dies inside the browser's print subsystem (driver
  // error, wedged preview — seen on the office-1 kiosk) can fail WITHOUT
  // ever firing it. When that happened the caller's busy flag stayed stuck,
  // the button went dead, and every later press was a silent no-op. So:
  //   1. afterprint            — the normal path;
  //   2. window refocus        — the dialog (or an error dialog) closed;
  //   3. a 90s watchdog        — nothing signalled at all; force recovery.
  // Focus fires slightly early on some platforms (before the OS dialog is
  // fully torn down) but by then the print snapshot is already taken, so
  // removing the @page rule and unsticking the UI is safe.
  let done = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => {
    if (done) return;
    done = true;
    style.remove();
    window.removeEventListener("afterprint", cleanup);
    window.removeEventListener("focus", cleanup);
    if (watchdog !== undefined) clearTimeout(watchdog);
    onDone?.();
  };
  window.addEventListener("afterprint", cleanup);
  window.addEventListener("focus", cleanup);
  watchdog = setTimeout(cleanup, PRINT_WATCHDOG_MS);

  try {
    window.print();
  } catch (err) {
    // Printing disabled by browser/OS policy: no signal will ever come.
    // Clean up here and rethrow so the caller can surface an error.
    cleanup();
    throw err;
  }
}
