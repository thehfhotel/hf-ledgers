import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";

// No service worker / no PWA — same deliberate call as the ledger's own
// main.tsx (CLAUDE.md).

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
