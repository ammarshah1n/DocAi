import "./shell.css";

export function Ruler() {
  return <div className="docs-ruler-wrap" aria-hidden="true"><div className="docs-ruler">
    {Array.from({ length: 69 }, (_, i) => <span key={i} className={`ruler-tick ${i % 8 === 0 ? "inch" : i % 4 === 0 ? "half" : "eighth"}`} style={{ left: `${i / 68 * 100}%` }}>{i % 8 === 0 && i !== 8 ? <span>{Math.abs(i / 8 - 1)}</span> : null}</span>)}
    <span className="ruler-indent left" /><span className="ruler-indent right" />
  </div></div>;
}
