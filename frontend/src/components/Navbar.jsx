import { Link } from "react-router-dom";
import { ShieldIcon } from "./Icons.jsx";

const LINKS = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#research", label: "Research" },
  { href: "#faq", label: "FAQ" },
];

export default function Navbar() {
  return (
    <header className="navbar">
      <div className="navbar-inner">
        <a href="#top" className="brand">
          <span className="brand-mark">
            <ShieldIcon />
          </span>
          NEXUS
        </a>
        <nav className="navbar-links">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href}>
              {l.label}
            </a>
          ))}
          <Link to="/login">Dashboard</Link>
        </nav>
        <Link to="/tool" className="btn btn-primary btn-sm">
          Open the tool
        </Link>
      </div>
    </header>
  );
}
