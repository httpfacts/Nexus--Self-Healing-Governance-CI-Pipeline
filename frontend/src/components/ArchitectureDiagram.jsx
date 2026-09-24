import {
  CheckCircleIcon,
  AlertIcon,
  TerminalIcon,
  ShieldIcon,
  LayersIcon,
} from "./Icons.jsx";
import ConnectorGraphic from "./ConnectorGraphic.jsx";

const STEPS = [
  {
    n: "01",
    title: "Pipeline fails",
    body: "A CI/CD run breaks — a failing test, a bad build, a misconfigured job.",
    blob: "green",
    Icon: AlertIcon,
  },
  {
    n: "02",
    title: "AI proposes a fix",
    body: "Any fix-generator (LogSage-, RepairAgent-style, or your own agent) reads the failure and drafts a patch.",
    blob: "pink",
    Icon: TerminalIcon,
  },
  {
    n: "03",
    title: "NEXUS classifies it",
    body: "Every changed file is matched against policy.yaml — a plain, readable rule file, not a learned model.",
    blob: "purple",
    Icon: ShieldIcon,
  },
  {
    n: "04",
    title: "One boundary, two outcomes",
    body: "Data-plane-only changesets can auto-merge. One control-plane file, and the whole changeset is blocked and routed to a human.",
    blob: "amber",
    Icon: LayersIcon,
  },
];

export default function ArchitectureDiagram() {
  return (
    <section className="section" id="how-it-works">
      <div className="section-head">
        <span className="eyebrow">
          <TerminalIcon width="16" height="16" /> How it works
        </span>
        <h2>A policy gate, not another agent</h2>
        <p className="section-sub">
          NEXUS doesn't generate fixes — it decides what's allowed to happen to them next.
        </p>
      </div>

      <ConnectorGraphic />

      <div className="steps-carousel-wrap">
        <div className="steps-carousel">
          {STEPS.map((s) => (
            <div className="step-card" key={s.n}>
              <span className={`step-blob ${s.blob}`}>
                <s.Icon width="20" height="20" />
              </span>
              <span className="step-n">{s.n}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="diagram">
        <div className="diagram-box">CI pipeline fails</div>
        <div className="diagram-arrow">→</div>
        <div className="diagram-box">
          AI fix generator
          <br />
          <span>(LogSage / RepairAgent-style)</span>
        </div>
        <div className="diagram-arrow">→</div>
        <div className="diagram-box highlight">
          NEXUS classifier
          <br />
          <span>policy.yaml</span>
        </div>
        <div className="diagram-fork">
          <div className="diagram-branch">
            <CheckCircleIcon className="branch-icon safe" width="16" height="16" />
            <div className="diagram-box safe">Auto-propose / auto-merge</div>
          </div>
          <div className="diagram-branch">
            <AlertIcon className="branch-icon risky" width="16" height="16" />
            <div className="diagram-box risky">Blocked → human review</div>
          </div>
        </div>
      </div>
    </section>
  );
}
