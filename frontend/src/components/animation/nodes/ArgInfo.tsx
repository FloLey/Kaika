import Info from "../../../ui/Info";
import { argHelp } from "../../../lib/paramHelp";

// The per-argument "?" for controls that aren't a `Ctl`/`Toggle` (select rows, button
// clusters) — those two already render `Info` from their `help`/`section` props. Looks
// the argument up in the paramHelp catalog and renders the badge, or nothing if there's
// no entry. `group` disambiguates a fluid param's section (source vs medium).
export default function ArgInfo({ type, k, group }: { type: string; k: string; group?: string }) {
  const { help, section } = argHelp(type, k, group);
  return help ? <Info text={help} section={section} /> : null;
}
