// The studio copilot: a chat whose assistant edits the project only through
// validated tools. Each mutating turn is one undoable revision; changes show
// as chips with an Undo affordance.
import { useEffect, useRef, useState } from "react";
import { api, ChatEvent } from "../api";

interface Msg {
  role: "user" | "assistant" | "event";
  text: string;
  changes?: string[];
}

interface Props {
  runId: string;
  onProjectChanged: () => void;       // reload project after tool mutations
  onPreviewJob: (jobId: string) => void;
}

export default function ChatPanel({ runId, onProjectChanged, onPreviewJob }: Props) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.chatHistory(runId).then((h) => {
      const restored: Msg[] = [];
      for (const m of h) {
        if (m.role === "user") restored.push({ role: "user", text: m.text });
        else if (m.role === "assistant" && m.text)
          restored.push({ role: "assistant", text: m.text });
      }
      setMsgs(restored);
    }).catch(() => {});
  }, [runId]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); },
    [msgs]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setErr("");
    setBusy(true);
    setMsgs((m) => [...m, { role: "user", text }]);
    let mutated = false;
    try {
      await api.chat(runId, text, (e: ChatEvent) => {
        if (e.type === "text" && e.text) {
          setMsgs((m) => [...m, { role: "assistant", text: e.text! }]);
        } else if (e.type === "tool_call") {
          setMsgs((m) => [...m, { role: "event",
            text: `⚙ ${e.name}(${JSON.stringify(e.input).slice(0, 80)}…)` }]);
        } else if (e.type === "done") {
          mutated = (e.changes?.length ?? 0) > 0;
          if (e.changes?.length) {
            setMsgs((m) => [...m, { role: "event", text: "", changes: e.changes }]);
          }
          if (e.preview_job) onPreviewJob(e.preview_job);
          if (e.render_job) onPreviewJob(e.render_job);
        } else if (e.type === "error") {
          setErr(e.error || "chat failed");
        }
      });
    } catch (e: any) {
      setErr(String(e.message || e));
    } finally {
      setBusy(false);
      if (mutated) onProjectChanged();
    }
  };

  const undo = async () => {
    const revs = await api.revisions(runId);
    if (!revs.length) return;
    await api.restoreRevision(runId, revs[revs.length - 1].index);
    onProjectChanged();
    setMsgs((m) => [...m, { role: "event", text: "↩ restored previous state" }]);
  };

  return (
    <div className="card chat">
      <div className="chat-log">
        {msgs.length === 0 && (
          <p className="muted" style={{ fontSize: 12 }}>
            Describe a change — e.g. “at 2 seconds, I want 3 sources aligned
            horizontally in the center” or “make the drop more violent”. The
            copilot edits the recipe through validated tools and previews the
            result. Configure the LLM provider in Settings (⚙ top right).
          </p>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={`chat-msg ${m.role}`}>
            {m.changes ? (
              <span className="chips">
                {m.changes.map((c, k) => <span key={k} className="chip">{c}</span>)}
                <button className="btn ghost slim" onClick={undo}>Undo</button>
              </span>
            ) : m.text}
          </div>
        ))}
        {busy && <div className="chat-msg event">thinking…</div>}
        {err && <p className="err">{err}</p>}
        <div ref={endRef} />
      </div>
      <div className="chat-input">
        <input type="text" value={input} placeholder="Ask for a change…"
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="btn" disabled={busy || !input.trim()} onClick={send}>
          Send
        </button>
      </div>
    </div>
  );
}
