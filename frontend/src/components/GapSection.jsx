import { CheckCircleIcon, AlertIcon, LayersIcon } from "./Icons.jsx";

export default function GapSection({ gap }) {
  if (!gap) return null;
  return (
    <section className="section" id="gap">
      <div className="section-head">
        <span className="eyebrow">
          <LayersIcon width="16" height="16" /> The core distinction
        </span>
        <h2>Two kinds of fix. One of them needs a human.</h2>
        <p className="section-sub">{gap.title}</p>
      </div>

      <div className="plane-grid">
        <div className="plane-card safe">
          <div className="plane-card-icon safe">
            <CheckCircleIcon />
          </div>
          <h3>Data-plane</h3>
          <p>{gap.dataPlane}</p>
          <span className="tag tag-safe">Auto-proposable</span>
        </div>
        <div className="plane-card risky">
          <div className="plane-card-icon risky">
            <AlertIcon />
          </div>
          <h3>Control-plane</h3>
          <p>{gap.controlPlane}</p>
          <span className="tag tag-risky">Always escalated</span>
        </div>
      </div>

      <div className="callout">
        <p>
          Think of a mechanic who can both change your oil and rewire your brakes — and treats both
          jobs the same way. Fine for the oil change. That's what today's self-healing CI/CD tools
          do: fix a broken test and quietly loosen a deployment approval rule, with no distinction
          between the two. NEXUS is the boundary that tells them apart, before either one
          ships.
        </p>
      </div>
    </section>
  );
}
