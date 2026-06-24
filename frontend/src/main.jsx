import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import Docs from "./components/Docs.jsx";
import "./styles.css";

// `?doc=<section>` opens the in-app user guide (its own root) instead of the app,
// so every "?" can deep-link to a section in a new tab. Empty value = top.
const doc = new URLSearchParams(window.location.search).get("doc");

// No StrictMode: it double-invokes effects in dev, which conflicts with
// Web Audio's "one MediaElementSource per <audio> element" rule.
createRoot(document.getElementById("root")).render(
  doc !== null ? <Docs section={doc} /> : <App />
);
