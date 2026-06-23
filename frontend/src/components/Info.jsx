// A small "?" badge that reveals an explanation on hover or keyboard focus.
export default function Info({ text }) {
  return (
    <span className="info" tabIndex={0} role="note" aria-label={text}>
      ?
      <span className="info-tip">{text}</span>
    </span>
  );
}
