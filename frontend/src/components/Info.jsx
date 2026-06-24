// A small "?" badge. Hover or keyboard-focus reveals an explanation; when a
// `section` is given it's also a link that opens the in-app guide (new tab)
// scrolled to that section. `section` matches an id in Docs.jsx.
export default function Info({ text, section }) {
  const tip = <span className="info-tip">{text}</span>;
  if (section) {
    return (
      <a
        className="info info-link"
        href={`/?doc=${section}`}
        target="_blank"
        rel="noopener noreferrer"
        role="note"
        aria-label={`${text} — open the guide`}
        title="Open the guide"
      >
        ?{tip}
      </a>
    );
  }
  return (
    <span className="info" tabIndex={0} role="note" aria-label={text}>
      ?{tip}
    </span>
  );
}
