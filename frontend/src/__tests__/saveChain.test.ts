import { describe, it, expect } from "vitest";

import { createSaveChain } from "../lib/saveChain";

// The autosave ordering rules. App.tsx's comment names the failure mode outright — "two
// overlapping saves could commit out of order server-side (the DB would keep the OLDER
// payload while the UI thinks everything saved)" — and nothing tested it, because the
// logic lived inside a component body.

/** A controllable async task: resolve/reject it by hand to force an interleaving. */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("save chain", () => {
  it("runs queued saves strictly in order, never overlapping", async () => {
    // Uses `exclusive`, which never skips — this is about ORDERING, not superseding.
    const chain = createSaveChain();
    const order: string[] = [];
    const a = deferred();
    const b = deferred();

    chain.exclusive(async () => {
      order.push("a:start");
      await a.promise;
      order.push("a:end");
    });
    const second = chain.exclusive(async () => {
      order.push("b:start");
      await b.promise;
      order.push("b:end");
    });

    await flush();
    expect(order).toEqual(["a:start"]); // b must not start while a is in flight

    a.resolve();
    await flush();
    b.resolve();
    await second;

    expect(order).toEqual(["a:start", "a:end", "b:start", "b:end"]);
  });

  it("when autosaves pile up, ONLY the newest writes — including skipping the first", async () => {
    // The subtle part, and the reason this is worth a test. The ticket is taken when a
    // save is QUEUED but checked when its turn comes to RUN. So three autosaves queued
    // while the chain is busy collapse to one write: the newest. Even the one that was
    // first in line is dropped, because by the time it ran the user had already moved
    // past its payload twice.
    //
    // That is deliberate — every autosave sends the WHOLE project state, so an older
    // payload carries no information the newest one lacks, and sending it is both stale
    // and a wasted round-trip. (Contrast `exclusive` above, whose payloads differ.)
    const chain = createSaveChain();
    const ran: string[] = [];

    chain.supersedable(async () => void ran.push("first"));
    chain.supersedable(async () => void ran.push("second"));
    const third = chain.supersedable(async () => void ran.push("third"));

    await third;
    await flush();
    expect(ran).toEqual(["third"]);
  });

  it("a save already RUNNING is never abandoned mid-flight", async () => {
    // Superseding drops queued work, not work in progress: a PUT already sent must be
    // awaited, or the next write could overtake it on the wire — the out-of-order commit
    // this whole chain exists to prevent.
    const chain = createSaveChain();
    const ran: string[] = [];
    const inFlight = deferred();

    const first = chain.supersedable(async () => {
      ran.push("first:start");
      await inFlight.promise;
      ran.push("first:end");
    });
    await flush(); // let `first` actually start

    const second = chain.supersedable(async () => void ran.push("second"));
    inFlight.resolve();
    await first;
    await second;

    expect(ran).toEqual(["first:start", "first:end", "second"]);
  });

  it("keeps writing after a save fails", async () => {
    const chain = createSaveChain();
    const ran: string[] = [];

    const failing = chain.supersedable(async () => {
      ran.push("boom");
      throw new Error("network down");
    });
    await expect(failing).rejects.toThrow("network down");

    await chain.supersedable(async () => void ran.push("after"));
    expect(ran).toEqual(["boom", "after"]);
  });

  it("surfaces the failure to the caller AND keeps the chain usable", async () => {
    // App.tsx needs both: it flags `saveError` from the rejection, and the next edit
    // must still be able to retry.
    const chain = createSaveChain();
    await expect(
      chain.exclusive(async () => {
        throw new Error("nope");
      })
    ).rejects.toThrow("nope");

    await expect(chain.exclusive(async () => "ok")).resolves.toBe("ok");
  });

  it("never skips an exclusive save, however many queue up", async () => {
    // Lyric edits and the fixture capture carry data the autosave payload does not, so
    // superseding one would silently drop the user's words.
    const chain = createSaveChain();
    const ran: string[] = [];
    const gate = deferred();

    chain.exclusive(async () => {
      ran.push("1");
      await gate.promise;
    });
    chain.exclusive(async () => void ran.push("2"));
    const last = chain.exclusive(async () => void ran.push("3"));

    gate.resolve();
    await last;
    expect(ran).toEqual(["1", "2", "3"]);
  });

  it("an exclusive save does not interleave with an in-flight autosave", async () => {
    const chain = createSaveChain();
    const order: string[] = [];
    const auto = deferred();

    chain.supersedable(async () => {
      order.push("auto:start");
      await auto.promise;
      order.push("auto:end");
    });
    const lyrics = chain.exclusive(async () => void order.push("lyrics"));

    await flush();
    expect(order).toEqual(["auto:start"]);
    auto.resolve();
    await lyrics;
    expect(order).toEqual(["auto:start", "auto:end", "lyrics"]);
  });

  it("an exclusive save does not count as a supersede ticket", async () => {
    // Only supersedable calls take tickets. An interleaved lyric save must not cause a
    // pending autosave to consider itself stale and skip.
    const chain = createSaveChain();
    const ran: string[] = [];
    const gate = deferred();

    chain.exclusive(async () => {
      await gate.promise;
    });
    const auto = chain.supersedable(async () => void ran.push("auto"));
    chain.exclusive(async () => void ran.push("lyrics"));

    gate.resolve();
    await auto;
    await flush();
    expect(ran).toContain("auto");
  });
});
