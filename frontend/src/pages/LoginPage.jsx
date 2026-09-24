import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ShieldIcon, GithubIcon } from "../components/Icons.jsx";

export default function LoginPage() {
  const [checking, setChecking] = useState(true);
  const [appConfigured, setAppConfigured] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((data) => {
        setAppConfigured(data.githubAppConfigured);
        if (data.user) navigate("/dashboard", { replace: true });
        else setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [navigate]);

  if (checking) return null;

  return (
    <div className="auth-page">
      <div className="auth-card">
        <span className="brand-mark auth-mark">
          <ShieldIcon />
        </span>
        <h1>Sign in to NEXUS</h1>
        <p>
          The dashboard shows every CI failure NEXUS has classified on a connected repo, and
          whether it was auto-fixed or escalated. Sign in with the GitHub account that installed the
          App.
        </p>

        {!appConfigured && (
          <p className="auth-warning">
            The GitHub App isn't configured on this backend yet — see <code>README.md</code>,
            "Setting up the GitHub App", then set the <code>GITHUB_APP_*</code> variables in{" "}
            <code>backend/.env</code> and restart the server.
          </p>
        )}

        <a
          href="/auth/github/login"
          className={`btn btn-primary auth-github-btn ${!appConfigured ? "disabled" : ""}`}
          aria-disabled={!appConfigured}
          onClick={(e) => !appConfigured && e.preventDefault()}
        >
          <GithubIcon width="18" height="18" />
          Sign in with GitHub
        </a>
      </div>
    </div>
  );
}
