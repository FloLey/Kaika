// One serialized queue for every project PUT.
//
// Two overlapping saves can commit out of ORDER server-side: the DB keeps the older
// payload while the UI believes everything saved. So every write — the debounced
// autosave, a lyric-line edit, the Playground fixture capture — rides one promise chain.
//
// The two queueing modes differ in what happens when work piles up:
//
//   `supersedable(run)` — the debounced autosave. Each call takes a ticket; when its turn
//   comes it checks whether a NEWER call has since been queued and, if so, skips. Writing
//   an older payload after a newer one is exactly the out-of-order commit this exists to
//   prevent, and re-sending state that is already stale is pure latency.
//
//   `exclusive(run)` — lyric edits and the fixture capture. These carry data the autosave
//   payload doesn't, so they must never be skipped; they queue behind whatever is running
//   and always execute. The caller gets the promise so it can show success/failure.
//
// Extracted from App.tsx (cleanup step 05) so the ordering rules can be tested. Inside
// the component they were reachable only by rendering the whole app, which is why the
// stated failure mode — "two overlapping saves commit out of order" — had no test.

export interface SaveChain {
  /** Queue a save that is SKIPPED if a newer supersedable save was queued behind it. */
  supersedable(run: () => Promise<void>): Promise<void>;
  /** Queue a save that ALWAYS runs. Rejections don't break the chain for later work. */
  exclusive<T>(run: () => Promise<T>): Promise<T>;
}

export function createSaveChain(): SaveChain {
  let seq = 0;
  let chain: Promise<unknown> = Promise.resolve();

  return {
    supersedable(run) {
      const mine = ++seq;
      const next = chain.then(async () => {
        if (mine !== seq) return; // a newer payload is queued — this one is stale
        await run();
      });
      // Swallow here so one failed autosave doesn't poison every later write. The
      // caller's own try/catch still sees its error (App flags saveError from inside
      // `run`), and `lastSaved` staying stale is what makes the next edit retry.
      chain = next.catch(() => {});
      return next;
    },

    exclusive(run) {
      const next = chain.then(() => run());
      chain = next.catch(() => {}); // keep the chain alive on failure
      return next;
    },
  };
}
