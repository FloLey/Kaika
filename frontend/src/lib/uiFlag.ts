// The `?ui=next` opt-in, now a constant.
//
// It shipped a UI proposal as LIVE code beside the current UI — same project, same
// data, one URL apart — so the two could be compared on real work instead of on a
// mockup, and nothing was deleted until one of them won. The routed shell won.
//
// This returns `true` rather than being deleted outright, and that is deliberate. Six
// components branch on it. Folding all six de-branchings into the commit that flips the
// root would make the flip unreviewable and its revert a rewrite; as a constant, the
// flip is two files and six lines, and each branch site collapses — and reverts — on
// its own.
//
// Scheduled for deletion with the last caller. If `grep -rn 'isNext' frontend/src`
// finds only this file, delete it.
export function isNext(): boolean {
  return true;
}
