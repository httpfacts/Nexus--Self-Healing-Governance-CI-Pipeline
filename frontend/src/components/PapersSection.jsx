import { LayersIcon, TerminalIcon, AlertIcon, ShieldIcon } from "./Icons.jsx";

const PAPER_STYLE = [
  { blob: "green", Icon: LayersIcon },
  { blob: "pink", Icon: TerminalIcon },
  { blob: "amber", Icon: AlertIcon },
  { blob: "purple", Icon: ShieldIcon },
];

export default function PapersSection({ papers }) {
  if (!papers) return null;
  return (
    <section className="section" id="research">
      <div className="section-head">
        <h2>Not a guess — a named gap</h2>
        <p className="section-sub">
          The boundary NEXUS enforces isn't invented in a vacuum. It responds directly to
          what the most recent survey of this space says is missing, and to what every comparable
          tool visibly lacks.
        </p>
      </div>

      <div className="anchor-card">
        <span className="tag tag-anchor">Anchor paper</span>
        <h3>{papers.anchor.citation}</h3>
        <p>{papers.anchor.summary}</p>
      </div>

      <div className="papers-grid">
        {papers.corePapers.map((p, i) => {
          const { blob, Icon } = PAPER_STYLE[i % PAPER_STYLE.length];
          return (
            <div className="paper-card" key={p.citation}>
              <span className={`step-blob ${blob}`}>
                <Icon width="20" height="20" />
              </span>
              <div className="paper-role">{p.role}</div>
              <div className="paper-citation">{p.citation}</div>
              <p className="paper-summary">{p.summary}</p>
            </div>
          );
        })}
      </div>

      <div className="supporting-cluster">
        <h3>{papers.supportingCluster.role}</h3>
        <p>{papers.supportingCluster.summary}</p>
      </div>
    </section>
  );
}
