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

export function printWithPageRule(orientation: PageOrientation, marginMm: number, onDone?: () => void): void {
  const style = document.createElement("style");
  style.textContent = pageRuleCss(orientation, marginMm);
  document.head.appendChild(style);

  const cleanup = () => {
    style.remove();
    window.removeEventListener("afterprint", cleanup);
    onDone?.();
  };
  window.addEventListener("afterprint", cleanup);

  try {
    window.print();
  } catch (err) {
    // Printing disabled by browser/OS policy: afterprint will never fire, so
    // clean up here or the injected @page rule dangles and the caller's busy
    // state never resets. Rethrow so the caller can surface an error.
    cleanup();
    throw err;
  }
}
