// The `settings-remote` section of the in-app user guide. Split out of a single 1557-line
// Docs.tsx (cleanup step 13) — pure static JSX, no props, no shared state.
// The anchor id is load-bearing: every "?" in the UI deep-links to /?doc=settings-remote,
// and paramHelp.test.tsx asserts the rendered ids match DOC_SECTION_IDS exactly.
export default function SettingsRemote() {
  return (
    <section id="settings-remote">
      <h2>
        <span className="num">⚙</span>Remote inference — rent a GPU for the AI cards
      </h2>
      <p>
        The AI generation (AI Stylize, Dream, Image gen, Extract depth) normally runs on this
        machine, which can be slow — an HD stylize or Dream clip takes tens of minutes locally,
        since both spend one diffusion call per frame. The <strong>⚙ settings</strong> (header, any
        screen) can send that work to a <strong>remote GPU server</strong> you rent (RunPod, Lambda,
        any box with a CUDA GPU) instead. Everything else — fluid simulation, stem separation,
        rendering — always stays local.
      </p>
      <h3>Setting up the server</h3>
      <p>
        On the GPU machine, from a checkout of this repo:{" "}
        <code>VOL=/workspace KAIKA_REMOTE_TOKEN=&lt;secret&gt; ./scripts/remote_pod.sh</code>. That
        installs the dependencies, checks the GPU, downloads the models onto the persistent volume
        and then serves on port 5100, supervised — and it is safe to use as the pod's start command,
        since a warm box skips straight to serving. (By hand:{" "}
        <code>pip install -r requirements.txt</code>, then{" "}
        <code>KAIKA_REMOTE_TOKEN=&lt;secret&gt; python -m backend.remote_app</code>.) It's the{" "}
        <em>same generation code</em> the app runs locally, so results match seed for seed. Models
        download from Hugging Face on the first request — slow once, then cached. Paste the server's
        URL and token into the ⚙ settings and hit <strong>test connection</strong>: you should see
        its GPU and latency.
      </p>
      <h3>Choosing what runs remotely</h3>
      <p>
        Each operation has its own toggle — check <strong>AI Stylize</strong> and{" "}
        <strong>Dream</strong> to offload the heavy per-frame clips while keeping quick Image-gen
        drafts local, or check everything. Dream's frame cache stays on this machine either way, so
        a re-run after a small edit still skips everything it already has. Changes apply to the{" "}
        <em>next</em> generation immediately, no restart. If the server is unreachable, the
        generation <strong>fails with a clear error</strong> on the card — nothing silently falls
        back to a slow local run; flip the master toggle off to go back to local.
      </p>
    </section>
  );
}
