import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Navbar from "../components/Navbar.jsx";
import Hero from "../components/Hero.jsx";
import GapSection from "../components/GapSection.jsx";
import PapersSection from "../components/PapersSection.jsx";
import ArchitectureDiagram from "../components/ArchitectureDiagram.jsx";
import FaqSection from "../components/FaqSection.jsx";
import Reveal from "../components/Reveal.jsx";
import { ShieldIcon, ArrowRightIcon } from "../components/Icons.jsx";

export default function LandingPage() {
  const [overview, setOverview] = useState(null);
  const [papers, setPapers] = useState(null);
  const [faq, setFaq] = useState(null);
  const [backendError, setBackendError] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/overview").then((r) => r.json()),
      fetch("/api/papers").then((r) => r.json()),
      fetch("/api/faq").then((r) => r.json()),
    ])
      .then(([o, p, f]) => {
        setOverview(o);
        setPapers(p);
        setFaq(f);
      })
      .catch(() => setBackendError(true));
  }, []);

  return (
    <>
      <Navbar />
      <main>
        {backendError && (
          <div className="banner-error">
            Couldn't reach the backend at <code>/api</code>. Make sure the Express server is
            running on port 4000 (<code>cd backend && npm install && npm start</code>).
          </div>
        )}
        <Hero pitch={overview?.pitch} />
        <Reveal>
          <GapSection gap={overview?.gap} />
        </Reveal>
        <Reveal>
          <ArchitectureDiagram />
        </Reveal>
        <Reveal>
          <PapersSection papers={papers} />
        </Reveal>
        <Reveal>
          <FaqSection faq={faq} />
        </Reveal>

        <Reveal as="section" className="cta-band">
          <div className="cta-band-inner">
            <h2>See where your AI agent draws the line.</h2>
            <p>Connect a repo and get a real verdict on its CI/CD config — not a guess.</p>
            <Link to="/tool" className="btn btn-primary">
              Open the NEXUS tool
              <ArrowRightIcon />
            </Link>
          </div>
        </Reveal>
      </main>
      <footer className="footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <span className="brand-mark">
              <ShieldIcon />
            </span>
            NEXUS
          </div>
          <p>
            A policy boundary for agentic CI/CD — deciding what an AI is allowed to auto-merge, not
            just how well it can propose a fix.
          </p>
          <p className="footer-stack">Frontend: React + Vite · Backend: Express · Policy: YAML</p>
        </div>
      </footer>
    </>
  );
}
