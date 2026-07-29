import { useEffect, useState } from "react";
import { todayBangkok } from "../shared/date.ts";
import { isProperty, type Property } from "../shared/types.ts";
import { DaySheetPage } from "./pages/DaySheetPage.tsx";
import { HistoryPage } from "./pages/HistoryPage.tsx";
import { CategoriesPage } from "./pages/CategoriesPage.tsx";
import { ReportPage } from "./pages/ReportPage.tsx";

// pushState micro-router (RDR App.tsx pattern). This file is the router +
// chip-rail shell ONLY — page components own their own screens. Every page
// import path here is final for the parallel Phase 1 fan-out (WP-B owns
// DaySheetPage/HistoryPage/CategoriesPage, WP-C owns ReportPage); nobody
// else touches App.tsx until Phase 2 integration.
//
// CategoriesPage is manager-only per the contract's screen spec, but that
// gating happens INSIDE CategoriesPage.tsx (it renders a
// "สำหรับผู้จัดการเท่านั้น" panel for non-managers) — this shell always
// shows the nav item and lets the page itself decide, so App.tsx never
// needs to fetch /api/me.

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

type Route =
  | { kind: "day"; property: Property; date: string }
  | { kind: "history"; property: Property }
  | { kind: "categories"; property: Property }
  | { kind: "report"; property: Property | "demo"; date: string };

function homeRoute(): Extract<Route, { kind: "day" }> {
  return { kind: "day", property: savedProperty(), date: todayBangkok() };
}

function parseRoute(pathname: string): Route {
  const parts = pathname.replace(/\/$/, "").split("/").filter(Boolean);

  // Special case: /demo/report/:date renders ReportPage's fixtures.ts demo
  // data with zero server dependency (see ReportPage.tsx's "demo" property
  // handling) — headless visual-verification only, never a real navigable
  // property, and never persisted as one (see the localStorage effect
  // below).
  if (parts[0] === "demo" && parts[1] === "report" && parts[2]) {
    return { kind: "report", property: "demo", date: parts[2] };
  }

  const property = isProperty(parts[0]) ? parts[0] : undefined;
  if (!property) return homeRoute();

  if (parts[1] === "day" && parts[2]) return { kind: "day", property, date: parts[2] };
  if (parts[1] === "history") return { kind: "history", property };
  if (parts[1] === "categories") return { kind: "categories", property };
  if (parts[1] === "report" && parts[2]) return { kind: "report", property, date: parts[2] };

  return homeRoute();
}

export function navigate(path: string) {
  history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

const PROPERTY_CHIPS: { id: Property; label: string }[] = [
  { id: "hf", label: "โรงแรม HF" },
  { id: "hfville", label: "HF วิลล์" },
];

function routeForProperty(route: Route, property: Property): string {
  switch (route.kind) {
    case "day":
      return `/${property}/day/${route.date}`;
    case "report":
      // A report is property+date specific; land on that property's day
      // sheet rather than re-render someone else's exported sheet.
      return `/${property}/day/${route.date}`;
    case "history":
      return `/${property}/history`;
    case "categories":
      return `/${property}/categories`;
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

  // "/" (and any unrecognized path) redirects to {savedProperty|hf}/day/
  // {todayBangkok()} as a real navigation, so the URL bar reflects reality
  // and back/forward behaves correctly. /demo/report/:date is recognized
  // (not "unrecognized") — it's parseRoute's headless-verification special
  // case — so it must NOT be swept into this redirect.
  useEffect(() => {
    const parts = location.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    const isDemoReport = parts[0] === "demo" && parts[1] === "report" && Boolean(parts[2]);
    if (!isProperty(parts[0]) && !isDemoReport) {
      const home = homeRoute();
      navigate(`/${home.property}/day/${home.date}`);
    }
    // Intentionally run once on mount only — this is a one-time redirect
    // for an unrecognized path, not a reaction to route/property changes.
  }, []);

  const navItems: { key: string; label: string; active: boolean; path: string }[] = [
    {
      key: "day",
      label: "สรุปวัน",
      active: route.kind === "day" || route.kind === "report",
      path: `/${displayProperty}/day/${route.kind === "day" || route.kind === "report" ? route.date : todayBangkok()}`,
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
  ];

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-brand-900 bg-brand-800">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <span className="text-sm font-semibold tracking-wide text-white">
            สรุปรายรับ-รายจ่าย
          </span>
          <div className="rail flex items-center gap-1.5 overflow-x-auto">
            {PROPERTY_CHIPS.map((chip) => (
              <button
                key={chip.id}
                type="button"
                onClick={() => navigate(routeForProperty(route, chip.id))}
                className={
                  "shrink-0 rounded-full border px-3 py-1 text-xs font-medium transition " +
                  (displayProperty === chip.id
                    ? "border-gold-500 bg-gold-500 text-brand-900"
                    : "border-brand-600 text-brand-100 hover:bg-brand-700")
                }
              >
                {chip.label}
              </button>
            ))}
          </div>
        </div>
        <nav className="mx-auto flex max-w-3xl gap-1 px-4 pb-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => navigate(item.path)}
              className={
                "rounded-md px-3 py-1.5 text-xs font-medium transition " +
                (item.active ? "bg-gold-500 text-brand-900" : "text-brand-100 hover:bg-brand-700")
              }
            >
              {item.label}
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-4">
        {route.kind === "day" && <DaySheetPage property={route.property} date={route.date} />}
        {route.kind === "history" && <HistoryPage property={route.property} />}
        {route.kind === "categories" && <CategoriesPage property={route.property} />}
        {route.kind === "report" && <ReportPage property={route.property} date={route.date} />}
      </main>
    </div>
  );
}
