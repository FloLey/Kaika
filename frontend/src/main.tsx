import { Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import AppShell from "./components/next/AppShell";
import { installGlobalCapture } from "./lib/logCapture";
import "./styles/index.css";

// The in-app user guide is ~1000 lines that only render on a `?doc=` deep link —
// lazy-load it so it never ships in the main bundle's critical path.
const Docs = lazy(() => import("./components/Docs"));

// Capture uncaught errors / rejections into the log bus before anything renders.
installGlobalCapture();

// `?doc=<section>` opens the in-app user guide (its own root) instead of the app,
// so every "?" can deep-link to a section in a new tab. Empty value = top.
const doc = new URLSearchParams(window.location.search).get("doc");

// No StrictMode: it double-invokes effects in dev, which conflicts with
// Web Audio's "one MediaElementSource per <audio> element" rule.
//
// `AppShell` is imported statically, not lazily. Lazy was right while it was a proposal
// nobody loaded by default; as THE app it would be a blank first paint on every cold
// load, because the Suspense fallback here is `null`. The guide stays lazy — it is
// still the thing almost nobody opens.
createRoot(document.getElementById("root")!).render(
  doc !== null ? (
    <Suspense fallback={null}>
      <Docs section={doc} />
    </Suspense>
  ) : (
    <AppShell />
  )
);
