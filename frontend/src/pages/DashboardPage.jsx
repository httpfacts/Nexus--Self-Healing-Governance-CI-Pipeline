import { useEffect, useState } from "react";
import { useNavigate, Link } from "react-router-dom";
import { ShieldIcon } from "../components/Icons.jsx";
import DashboardContent from "../components/DashboardContent.jsx";

// Gated behind the GitHub App's OAuth login. Until that App is registered
// (see README), reach the same dashboard content via /tool instead, gated
// behind the simpler personal-token connection.
export default function DashboardPage() {
  const [user, setUser] = useState(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetch("/api/session")
      .then((r) => r.json())
      .then((data) => {
        if (!data.user) {
          navigate("/login", { replace: true });
          return;
        }
        setUser(data.user);
      })
      .catch(() => navigate("/login", { replace: true }));
  }, [navigate]);

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    navigate("/login", { replace: true });
  }

  if (!user) return null;

  return (
    <div className="dashboard-page">
      <header className="tool-topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">
            <ShieldIcon />
          </span>
          NEXUS
        </Link>
        <div className="dashboard-user">
          {user.avatarUrl && <img className="gh-avatar" src={user.avatarUrl} alt="" />}
          <span>@{user.username}</span>
          <button className="btn btn-secondary btn-sm" onClick={logout}>
            Log out
          </button>
        </div>
      </header>

      <main className="dashboard-main">
        <DashboardContent />
      </main>
    </div>
  );
}
