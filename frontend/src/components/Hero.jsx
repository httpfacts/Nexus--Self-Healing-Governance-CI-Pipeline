import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CheckCircleIcon, AlertIcon, ArrowRightIcon } from "./Icons.jsx";

const DEMO_SCENARIOS = [
  {
    files: [
      { path: "tests/test_login.py", plane: "data-plane" },
      { path: "src/auth/session.py", plane: "data-plane" },
    ],
    verdict: "safe",
    title: "Auto-merge eligible",
    detail: "All files match data-plane patterns — proposed without escalation.",
  },
  {
    files: [
      { path: "tests/test_login.py", plane: "data-plane" },
      { path: ".github/workflows/deploy.yml", plane: "control-plane" },
    ],
    verdict: "risky",
    title: "Escalated to human",
    detail: "One control-plane file blocks the entire changeset.",
  },
];

const STEP_MS = 1500;

export default function Hero({ pitch }) {
  const [scenarioIndex, setScenarioIndex] = useState(0);
  const [step, setStep] = useState(0); // 0..files.length-1 reveal rows, files.length = show verdict

  const scenario = DEMO_SCENARIOS[scenarioIndex];
  const maxStep = scenario.files.length; // one extra step shows the verdict

  useEffect(() => {
    const id = setInterval(() => {
      setStep((s) => {
        if (s < maxStep) return s + 1;
        return s; // hold on verdict, handled by separate timeout below
      });
    }, STEP_MS);
    return () => clearInterval(id);
  }, [maxStep, scenarioIndex]);

  useEffect(() => {
    if (step !== maxStep) return;
    const id = setTimeout(() => {
      setScenarioIndex((i) => (i + 1) % DEMO_SCENARIOS.length);
      setStep(0);
    }, STEP_MS * 1.6);
    return () => clearTimeout(id);
  }, [step, maxStep]);

  const showVerdict = step >= maxStep;

  return (
    <section className="hero" id="top">
      <div className="hero-inner">
        <div className="hero-copy">
          <span className="badge">Policy engine for agentic CI/CD</span>
          <h1>
            Let AI fix your pipeline.
            <br />
            <span className="gradient-text">Never let it touch the rules.</span>
          </h1>
          <p className="hero-lede">
            NEXUS sits between any AI fix-generator and your repo. It reads the changeset,
            classifies every file as safe to automate or too sensitive to touch, and blocks the
            merge the moment one file crosses the line — no partial auto-merge, ever.
          </p>
          {pitch && <p className="pitch">{pitch}</p>}
          <div className="hero-actions">
            <Link to="/tool" className="btn btn-primary">
              Open the tool
              <ArrowRightIcon />
            </Link>
            <a href="#how-it-works" className="btn btn-secondary">
              See how it works
            </a>
          </div>
          <div className="hero-trust">
            <div>
              <strong>2026</strong>
              <span>survey names this exact gap</span>
            </div>
            <div>
              <strong>0</strong>
              <span>black-box models — plain policy.yaml</span>
            </div>
            <div>
              <strong>1</strong>
              <span>hard rule: highest risk wins</span>
            </div>
          </div>
        </div>

        <div className="hero-visual" aria-hidden="true">
          <div className="mock-card">
            <div className="mock-card-head">
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-dot" />
              <span className="mock-card-title">changeset.diff</span>
              <span className="mock-live-dot" />
            </div>
            {scenario.files.map((f, i) => (
              <div className={`mock-row ${i < step ? "visible" : "pending"}`} key={f.path}>
                <code>{f.path}</code>
                <span className={`tag ${f.plane === "data-plane" ? "tag-safe" : "tag-risky"}`}>
                  {f.plane === "data-plane" ? (
                    <CheckCircleIcon width="14" height="14" />
                  ) : (
                    <AlertIcon width="14" height="14" />
                  )}
                  {f.plane}
                </span>
              </div>
            ))}
            <div className={`mock-verdict ${scenario.verdict} ${showVerdict ? "visible" : "pending"}`}>
              {scenario.verdict === "safe" ? <CheckCircleIcon /> : <AlertIcon />}
              <div>
                <strong>{scenario.title}</strong>
                <span>{scenario.detail}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="integrations-strip">
        <span>Classifies CI/CD config from</span>
        <div className="integrations-list">
          {["GitHub Actions", "GitLab CI", "Jenkins", "CircleCI", "Travis CI", "Azure Pipelines"].map((name) => (
            <span className="integration-pill" key={name}>
              {name}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
