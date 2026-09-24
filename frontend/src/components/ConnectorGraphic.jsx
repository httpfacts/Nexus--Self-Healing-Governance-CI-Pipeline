import { TerminalIcon, ShieldIcon, ArrowRightIcon } from "./Icons.jsx";

// Purely decorative -- a curved-line "flow" motif (failing pipeline -> the
// classifier -> a verdict) inspired by the connector graphics on modern
// SaaS marketing pages. Built from inline SVG + a cluster of icon nodes,
// not copied from any one product.
export default function ConnectorGraphic() {
  return (
    <div className="connector-graphic" aria-hidden="true">
      <svg viewBox="0 0 800 90" preserveAspectRatio="none" className="connector-svg">
        <path
          d="M 0 22 C 220 22, 260 55, 350 55"
          fill="none"
          stroke="url(#connectorGradA)"
          strokeWidth="2"
        />
        <path
          d="M 450 55 C 540 55, 580 22, 800 22"
          fill="none"
          stroke="url(#connectorGradB)"
          strokeWidth="2"
        />
        <circle cx="4" cy="22" r="4" fill="#8e1d46" />
        <circle cx="796" cy="22" r="4" fill="#ff8a80" />
        <defs>
          <linearGradient id="connectorGradA" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8e1d46" />
            <stop offset="1" stopColor="#ff8a80" />
          </linearGradient>
          <linearGradient id="connectorGradB" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#ff8a80" />
            <stop offset="1" stopColor="#8e1d46" />
          </linearGradient>
        </defs>
      </svg>

      <div className="connector-nodes">
        <span className="connector-node fail">
          <TerminalIcon width="18" height="18" />
        </span>
        <span className="connector-node core">
          <ShieldIcon width="20" height="20" />
        </span>
        <span className="connector-node verdict">
          <ArrowRightIcon width="16" height="16" />
        </span>
      </div>
    </div>
  );
}
