import { useEffect, useState } from "react";
import { todayBangkok } from "../shared/date.ts";
import { PROPERTIES, PROPERTY_LABELS, isProperty, type Property } from "../shared/types.ts";
import { PROPERTY_BADGE_LABELS } from "./labels.ts";
import { DaySheetPage } from "./pages/DaySheetPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { CategoriesPage } from "./pages/CategoriesPage.tsx";
import { ReportPage } from "./pages/ReportPage.tsx";
import { BookingDayPage } from "./pages/BookingDayPage.tsx";
import { DepositRegisterPage } from "./pages/DepositRegisterPage.tsx";

// pushState micro-router (RDR App.tsx pattern). This file is the router +
// chip-rail shell ONLY — page components own their own screens. Every page
// import path here is final for the parallel Phase 1 fan-out (WP-B owns
// DaySheetPage/HistoryPage/CategoriesPage, WP-C owns ReportPage); nobody
// else touches App.tsx until Phase 2 integration.
//
// There are NO roles in this app (Cloudflare Access is the only gate), so
// every nav item — Categories included — is available to everyone the app
// admits, and App.tsx never needs to fetch /api/me.

const PROPERTY_STORAGE_KEY = "ledger.property";

function savedProperty(): Property {
  try {
    const v = localStorage.getItem(PROPERTY_STORAGE_KEY);
    if (isProperty(v)) return v;
  } catch {
    /* localStorage unavailable (private mode, etc.) — fall through */
  }
  return "hf";
}

// The office does this work on a desktop PC: one wide layout, no second
// thumb-optimised one. Narrow screens stay readable because the wide
// booking grid scrolls inside its own container — the PAGE never scrolls
// horizontally.
const SHELL_WIDTH = "mx-auto w-full max-w-[1400px]";

type Route =
  | { kind: "day"; property: Property; date: string }
  | { kind: "bookings"; property: Property | "demo"; date: string }
  | { kind: "history"; property: Property }
  | { kind: "categories"; property: Property }
  | { kind: "deposits"; property: Property }
  | { kind: "report"; property: Property | "demo"; date: string };

function homeRoute(): Extract<Route, { kind: "day" }> {
  return { kind: "day", property: savedProperty(), date: todayBangkok() };
}

function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);

  // Special case: /demo/report/:date and /demo/bookings/:date render
  // fixtures.ts demo data with zero server dependency (see the "demo"
  // property handling in ReportPage.tsx / BookingDayPage.tsx) — headless
  // visual-verification only, never a real navigable property, and never
  // persisted as one (see the localStorage effect below).
  if (parts[0] === "demo" && parts[1] === "report" && parts[2]) {
    return { kind: "report", property: "demo", date: parts[2] };
  }
  if (parts[0] === "demo" && parts[1] === "bookings" && parts[2]) {
    return { kind: "bookings", property: "demo", date: parts[2] };
  }

  const property = isProperty(parts[0]) ? parts[0] : undefined;
  if (!property) return homeRoute();

  if (parts[1] === "day" && parts[2]) return { kind: "day", property, date: parts[2] };
  if (parts[1] === "bookings" && parts[2]) return { kind: "bookings", property, date: parts[2] };
  if (parts[1] === "history") return { kind: "history", property };
  if (parts[1] === "categories") return { kind: "categories", property };
  // "audit" is a bare alias (Wave 1, docs/plan-audit-hub-slips.md) for the
  // SAME route/page — "deposits" stays canonical (bookmarks/deep-links);
  // DepositRegisterPage.tsx itself reads `location.search` for the
  // ?tab=&date= deep-link params, so no query-string handling belongs here.
  if (parts[1] === "deposits" || parts[1] === "audit") return { kind: "deposits", property };
  if (parts[1] === "report" && parts[2]) return { kind: "report", property, date: parts[2] };

  return homeRoute();
}

export function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

// Chip labels come from PROPERTY_BADGE_LABELS (client/labels.ts) ONLY —
// never re-declare them here. That is the single source both this switcher
// and every page-level PropertyBadge read from, so a wording change never
// needs a second edit. Owner ask (2026-08-01): compact Latin form ("HF"/
// "HF Ville") rather than PROPERTY_LABELS[...].th's full Thai names — the
// document.title effect below deliberately keeps reading PROPERTY_LABELS
// directly (not this constant), since the owner's ask was scoped to the
// switcher chip + PropertyBadge only.
const PROPERTY_CHIPS: { id: Property; label: string }[] = PROPERTIES.map((id) => ({
  id,
  label: PROPERTY_BADGE_LABELS[id],
}));

// document.title's screen half, keyed by route kind — same names as
// navItems' labels below (kept as a separate map since navItems only exists
// inside the component, closed over `route`).
// "deposits" is now "ตรวจสอบ" (Wave 1, docs/plan-audit-hub-slips.md — the
// page became a 3-tab hub: ตรวจรายวัน (new, default) | รายการมัดจำ | สรุปรายเดือน).
// The route/kind name itself stays "deposits" (bookmarks/deep-links).
const SCREEN_LABEL_TH: Record<Route["kind"], string> = {
  day: "สรุปวัน",
  bookings: "รายละเอียดรายรับ",
  history: "ประวัติ",
  categories: "หมวดหมู่",
  deposits: "ตรวจสอบ",
  report: "รายงาน",
};

function routeForProperty(route: Route, property: Property): string {
  switch (route.kind) {
    case "day":
      return `/${property}/day/${route.date}`;
    case "bookings":
      return `/${property}/bookings/${route.date}`;
    case "report":
      // A report is property+date specific; land on that property's day
      // sheet rather than re-render someone else's exported sheet.
      return `/${property}/day/${route.date}`;
    case "history":
      return `/${property}/history`;
    case "categories":
      return `/${property}/categories`;
    case "deposits":
      return `/${property}/deposits`;
  }
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(location.pathname));

  useEffect(() => {
    const onPop = () => setRoute(parseRoute(location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Header chrome (chips, nav links) always needs a real Property, even on
  // the demo report route — "demo" itself is never a navigable property and
  // never gets persisted as the saved one.
  const displayProperty: Property = route.property === "demo" ? "hf" : route.property;

  useEffect(() => {
    if (route.property === "demo") return;
    try {
      localStorage.setItem(PROPERTY_STORAGE_KEY, route.property);
    } catch {
      /* localStorage unavailable — property just won't persist */
    }
  }, [route.property]);

  // Tab title names both the hotel and the screen (e.g. "โรงแรม HF ·
  // รายละเอียดรายรับ") so the tab bar — and any screenshot of it — says which
  // property is open, not just which app. The static <title> in index.html
  // stays as the pre-hydration fallback; this effect takes over once React
  // mounts and re-fires on every route change. The /demo route is flagged
  // rather than silently presented as real "hf" data (see PropertyBadge).
  useEffect(() => {
    const propertyLabel =
      PROPERTY_LABELS[displayProperty].th + (route.property === "demo" ? " (ตัวอย่าง)" : "");
    document.title = `${propertyLabel} · ${SCREEN_LABEL_TH[route.kind]}`;
  }, [displayProperty, route.kind, route.property]);

  // "/" (and any unrecognized path) redirects to {savedProperty|hf}/day/
  // {todayBangkok()} as a real navigation, so the URL bar reflects reality
  // and back/forward behaves correctly. /demo/report/:date is recognized
  // (not "unrecognized") — it's parseRoute's headless-verification special
  // case — so it must NOT be swept into this redirect.
  useEffect(() => {
    const parts = location.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    const isDemoRoute =
      parts[0] === "demo" && (parts[1] === "report" || parts[1] === "bookings") && Boolean(parts[2]);
    if (!isProperty(parts[0]) && !isDemoRoute) {
      const home = homeRoute();
      navigate(`/${home.property}/day/${home.date}`);
    }
    // Intentionally run once on mount only — this is a one-time redirect
    // for an unrecognized path, not a reaction to route/property changes.
  }, []);

  // Shared by both date-anchored tabs below — switching between "สรุปวัน"
  // and "รายละเอียดรายรับ" keeps the same date; landing from history/
  // categories falls back to today, same as the pre-existing "day" tab did.
  const currentDate =
    route.kind === "day" || route.kind === "report" || route.kind === "bookings" ? route.date : todayBangkok();

  const navItems: { key: string; label: string; active: boolean; path: string }[] = [
    {
      key: "day",
      label: "สรุปวัน",
      active: route.kind === "day" || route.kind === "report",
      path: `/${displayProperty}/day/${currentDate}`,
    },
    {
      key: "bookings",
      label: "รายละเอียดรายรับ",
      active: route.kind === "bookings",
      path: `/${displayProperty}/bookings/${currentDate}`,
    },
    {
      key: "history",
      label: "ประวัติ",
      active: route.kind === "history",
      path: `/${displayProperty}/history`,
    },
    {
      key: "categories",
      label: "หมวดหมู่",
      active: route.kind === "categories",
      path: `/${displayProperty}/categories`,
    },
    {
      key: "deposits",
      label: "ตรวจสอบ",
      active: route.kind === "deposits",
      path: `/${displayProperty}/deposits`,
    },
  ];

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-20 border-b border-brand-900 bg-brand-800">
        <div className={SHELL_WIDTH + " flex items-center justify-between gap-3 px-4 py-3"}>
          <span className="text-sm font-semibold tracking-wide text-white">
            สรุปรายรับ-รายจ่าย
          </span>
          {/* Property switcher — deliberately NOT a row of gold pills like the
              nav tabs below: this picks WHICH HOTEL, a different question
              than the nav's WHICH SCREEN, so it reads as a physical toggle
              switch (dark housing, one segment lit ivory) instead of another
              set of buttons. The "โรงแรม" tag makes the control
              self-describing even before either segment is read. */}
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="hidden text-[11px] font-semibold uppercase tracking-wider text-brand-300 sm:inline">
              โรงแรม
            </span>
            <div className="flex items-center gap-0.5 rounded-full bg-brand-900 p-1 ring-1 ring-inset ring-brand-600">
              {PROPERTY_CHIPS.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  onClick={() => navigate(routeForProperty(route, chip.id))}
                  aria-pressed={displayProperty === chip.id}
                  className={
                    "rounded-full px-3 py-1 text-xs font-semibold transition " +
                    (displayProperty === chip.id
                      ? "bg-shell text-brand-800 shadow-sm"
                      : "text-brand-200 hover:text-white")
                  }
                >
                  {chip.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <nav className={"rail " + SHELL_WIDTH + " flex gap-1 overflow-x-auto px-4 pb-2"}>
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.path)}
              className={
                "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (item.active ? "bg-gold-500 text-brand-900" : "text-brand-100 hover:bg-brand-700")
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className={SHELL_WIDTH + " min-w-0 px-4 py-4"}>
        {route.kind === "day" && <DaySheetPage property={route.property} date={route.date} />}
        {route.kind === "bookings" && <BookingDayPage property={route.property} date={route.date} />}
        {route.kind === "history" && <HistoryPage property={route.property} />}
        {route.kind === "categories" && <CategoriesPage property={route.property} />}
        {route.kind === "deposits" && <DepositRegisterPage property={route.property} />}
        {route.kind === "report" && <ReportPage property={route.property} date={route.date} />}
      </main>
    </div>
  );
}
