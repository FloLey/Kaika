import { useEffect, useRef } from "react";

// Stop POLLING a background job when the card unmounts — without cancelling the job.
//
// The distinction is the whole point and is easy to get wrong: the backend job keeps
// running (a generated image still lands in the asset library, a stylized clip still
// becomes an asset), we just stop fetching its status and calling setState on a component
// that is gone. Aborting the fetch is therefore *local* cleanup, not cancellation — which
// is why the caller's catch has to tell an abort apart from a real failure and swallow it
// rather than showing the user an error for something they caused by navigating away.
//
// Written out in ImagegenNode and StylizeNode, identical apart from a variable name.
//
// Deliberately NOT a full `useJobRun({busy, err, run})`: the four job-running surfaces do
// not share a shape. ImagegenNode's busy state is a row index (`number | "all" | null`)
// because one prompt can regenerate on its own; StylizeNode's is a boolean; AssetLibrary
// and useAssetUpload don't use an AbortController at all (AssetLibrary tracks a
// `closedRef` instead). A hook spanning all four would take a props bag encoding which
// caller it is, which is the same code with more indirection.
export function useUnmountAbort() {
  const controller = useRef(new AbortController());

  useEffect(() => {
    const c = controller.current;
    return () => c.abort();
  }, []);

  return {
    /** Pass to fetch/poll calls so they stop when the card goes away. */
    get signal() {
      return controller.current.signal;
    },
    /** The abort we caused ourselves — swallow it instead of surfacing an error. */
    isAbort: (ex: unknown) => ex instanceof DOMException && ex.name === "AbortError",
    controller,
  };
}
