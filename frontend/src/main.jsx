import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";

// No StrictMode: it double-invokes effects in dev, which conflicts with
// Web Audio's "one MediaElementSource per <audio> element" rule.
createRoot(document.getElementById("root")).render(<App />);
