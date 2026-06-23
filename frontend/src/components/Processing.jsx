import { useEffect, useState } from "react";

const MESSAGES = [
  "Running Demucs…",
  "Separating stems…",
  "Generating spectrograms…",
];

export default function Processing({ status }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((p) => (p + 1) % MESSAGES.length), 3500);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="processing">
      <div className="spinner" />
      <div className="status">{status || MESSAGES[i]}</div>
    </div>
  );
}
