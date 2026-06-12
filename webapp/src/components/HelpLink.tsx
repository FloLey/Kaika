// A small "?" that opens the user guide (served at /guide.html) in a new
// tab, anchored to the section relevant to where the button sits.
export default function HelpLink({ anchor, className }:
                                 { anchor?: string; className?: string }) {
  return (
    <a className={`help-link${className ? ` ${className}` : ""}`}
      href={`/guide.html${anchor ? `#${anchor}` : ""}`}
      target="_blank" rel="noreferrer"
      title="Aide — ouvre le guide">?</a>
  );
}
