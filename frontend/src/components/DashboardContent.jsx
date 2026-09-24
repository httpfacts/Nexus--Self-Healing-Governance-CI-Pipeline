import { useEffect, useState } from "react";
import { CheckCircleIcon, AlertIcon, BookIcon, TerminalIcon } from "./Icons.jsx";
import FilePathBreadcrumb from "./FilePathBreadcrumb.jsx";

const PLACEHOLDER_EVENTS = [
  {
    id: "example-1",
    repo: "acme/payments-api",
    verdict: "AUTO_MERGE_ELIGIBLE",
    status: "auto_pr",
    risk: 0.15,
    summary: "Suggested fix for checkout.py",
    files: [{ file: "src/handlers/checkout.py", plane: "data-plane" }],
    prUrl: "#",
    createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  },
  {
    id: "example-2",
    repo: "acme/payments-api",
    verdict: "ESCALATE_TO_HUMAN",
    status: "pending_review",
    risk: 0.79,
    summary: "Suggested fix for deploy.yml",
    files: [{ file: ".github/workflows/deploy.yml", plane: "control-plane" }],
    createdAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
  },
  {
    id: "example-3",
    repo: "acme/internal-tools",
    verdict: "AUTO_MERGE_ELIGIBLE",
    status: "classified",
    risk: 0.15,
    summary: "Suggested fix for test_export.py",
    files: [{ file: "tests/test_export.py", plane: "data-plane" }],
    createdAt: new Date(Date.now() - 50 * 3600_000).toISOString(),
  },
];

const STATUS_LABEL = {
  classified: "Classified",
  fix_proposed: "Fix proposed",
  fix_skipped_no_llm_key: "Fix skipped (no LLM key)",
  fix_failed: "Fix failed",
  escalated: "Escalated",
  escalate_failed: "Escalation failed",
  pending_review: "Pending review",
  auto_pr: "Auto-PR",
  approved: "Approved",
  rejected: "Rejected",
};

// "safe"/"warn"/"risky" -- three tones instead of a binary one, so a fix
// that's still awaiting a human decision reads differently from one that
// already shipped or was turned down.
function statusTone(status) {
  if (status === "auto_pr" || status === "approved" || status === "fix_proposed" || status === "classified") return "safe";
  if (status === "rejected" || status === "fix_failed" || status === "escalate_failed") return "risky";
  return "warn"; // pending_review, escalated, fix_skipped_no_llm_key
}

// Maps the filter bar's buttons onto the actual status values above --
// several legacy/edge statuses fold into "Pending" so nothing silently
// disappears from the log just because it predates these filters.
function statusFilterGroup(status) {
  if (status === "auto_pr") return "auto-pr";
  if (status === "approved") return "approved";
  if (status === "rejected") return "rejected";
  return "pending";
}

function StatusBadge({ status }) {
  return <span className={`tag tag-${statusTone(status)}`}>{STATUS_LABEL[status] || status}</span>;
}

const AUDIT_FILTERS = [
  { key: "all", label: "All" },
  { key: "auto-pr", label: "Auto-PR" },
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

// Stage 6's dashboard content, factored out so it can render both behind
// the full GitHub App OAuth login (DashboardPage, for later) and behind
// the simpler personal-token connection already used on /tool (now).
export default function DashboardContent({ connected }) {
  const [events, setEvents] = useState(null);
  const [policyText, setPolicyText] = useState("");
  const [policyStatus, setPolicyStatus] = useState(null);
  const [policyError, setPolicyError] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [auditFilter, setAuditFilter] = useState("all");
  const [auditSearch, setAuditSearch] = useState("");

  // `connected` in the dependency array matters: this page stays mounted
  // the whole time you're on /tool (so switching tabs doesn't lose other
  // sections' state -- see ToolPage), which means this effect used to fire
  // once at initial page load, before you'd necessarily connected yet --
  // and never retried, so the sidebar could say "Connected" while this
  // tab was stuck showing a stale error from that one failed attempt.
  // Re-running whenever `connected` flips to true fixes that.
  useEffect(() => {
    if (!connected) return;
    setLoadError(null);
    Promise.all([
      fetch("/api/events").then((r) => (r.ok ? r.json() : Promise.reject(new Error("events")))),
      fetch("/api/policy/raw").then((r) => (r.ok ? r.text() : Promise.reject(new Error("policy")))),
    ])
      .then(([evts, policy]) => {
        setEvents(evts);
        setPolicyText(policy);
      })
      .catch(() => setLoadError("Couldn't load dashboard data. Make sure you're connected to GitHub above."));
  }, [connected]);

  async function savePolicy() {
    setPolicyStatus("saving");
    setPolicyError(null);
    try {
      const res = await fetch("/api/policy/raw", {
        method: "PUT",
        headers: { "Content-Type": "text/plain" },
        body: policyText,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't save policy.yaml.");
      setPolicyStatus("saved");
    } catch (e) {
      setPolicyError(e.message);
      setPolicyStatus(null);
    }
  }

  if (!connected) {
    return (
      <section>
        <div className="tool-section-head">
          <h1>Audit Log</h1>
        </div>
        <p className="section-sub">Connect GitHub or GitLab first to see classification history and edit the policy.</p>
      </section>
    );
  }
  if (loadError) return <p className="error">{loadError}</p>;
  if (events === null) return null;

  const usingPlaceholders = events.length === 0;
  const search = auditSearch.trim().toLowerCase();
  const rows = (usingPlaceholders ? PLACEHOLDER_EVENTS : events).filter((e) => {
    if (auditFilter !== "all" && statusFilterGroup(e.status) !== auditFilter) return false;
    if (!search) return true;
    const haystack = [e.repo, e.summary, ...(e.files || []).map((f) => f.file)].join(" ").toLowerCase();
    return haystack.includes(search);
  });

  return (
    <>
      <section className="dashboard-section">
        <div className="tool-scanner-head">
          <TerminalIcon width="16" height="16" />
          <span>immutable ledger</span>
        </div>
        <h1>Audit Log</h1>
        <p className="section-sub">
          Every classification decision <code>classifyChangeset()</code> ever made, with the exact
          policy.yaml rule it matched on and what happened next.
        </p>

        {usingPlaceholders && (
          <div className="callout dashboard-placeholder-note">
            <p>
              No live events yet — connect a provider and generate a fix on Check pipeline or the
              Review Queue to populate this. The rows below are illustrative example data so you can
              see the shape of the log in the meantime.
            </p>
          </div>
        )}

        <div className="audit-toolbar">
          <input
            type="text"
            className="audit-search"
            placeholder="Filter by repo, path, summary…"
            value={auditSearch}
            onChange={(e) => setAuditSearch(e.target.value)}
          />
          <div className="audit-filter-bar">
            {AUDIT_FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                className={`audit-filter-btn ${auditFilter === f.key ? "active" : ""}`}
                onClick={() => setAuditFilter(f.key)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <span className="audit-record-count">{rows.length} record{rows.length === 1 ? "" : "s"}</span>
        </div>

        {rows.length === 0 && <p className="tool-empty-note">Nothing matches this filter yet.</p>}

        {rows.length > 0 && (
          <div className="overview-table-wrap">
            <table className="overview-table audit-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>File</th>
                  <th>Fix</th>
                  <th>Class</th>
                  <th>Risk</th>
                  <th>Decision</th>
                  <th>PR</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e) => (
                  <tr key={e.id}>
                    <td>{e.repo}</td>
                    <td className="audit-file-cell">
                      {(e.files || []).map((f, i) => (
                        <FilePathBreadcrumb path={f.file} key={i} />
                      ))}
                    </td>
                    <td className="audit-summary-cell">{e.summary || "—"}</td>
                    <td>
                      <span className={`tag ${e.verdict === "AUTO_MERGE_ELIGIBLE" ? "tag-safe" : "tag-risky"}`}>
                        {e.verdict === "AUTO_MERGE_ELIGIBLE" ? <CheckCircleIcon width="13" height="13" /> : <AlertIcon width="13" height="13" />}
                        {e.verdict === "AUTO_MERGE_ELIGIBLE" ? "data-plane" : "control-plane"}
                      </span>
                    </td>
                    <td>{typeof e.risk === "number" ? <span className="risk-score">{e.risk.toFixed(2)}</span> : "—"}</td>
                    <td>
                      <StatusBadge status={e.status} />
                    </td>
                    <td>
                      {e.prUrl && (
                        <a href={e.prUrl} target="_blank" rel="noreferrer">
                          #{e.prUrl.split("/").pop()}
                        </a>
                      )}
                      {e.issueUrl && (
                        <a href={e.issueUrl} target="_blank" rel="noreferrer">
                          View Issue
                        </a>
                      )}
                      {!e.prUrl && !e.issueUrl && "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="dashboard-section">
        <div className="tool-scanner-head">
          <BookIcon width="16" height="16" />
          <span>policy.yaml</span>
        </div>
        <h1>Edit the policy</h1>
        <p className="section-sub">
          Every classification above (and every scan on this page) reads this file. Edit it here —
          the backend validates the YAML before saving, but needs a restart to pick up the change.
        </p>

        <textarea
          className="file-input policy-editor"
          value={policyText}
          onChange={(e) => setPolicyText(e.target.value)}
          spellCheck={false}
          rows={18}
        />
        <div className="policy-actions">
          <button className="btn btn-primary" onClick={savePolicy} disabled={policyStatus === "saving"}>
            {policyStatus === "saving" ? "Saving…" : "Save policy.yaml"}
          </button>
          {policyStatus === "saved" && <span className="policy-saved-note">Saved — restart the backend to apply it.</span>}
          {policyError && <p className="error">{policyError}</p>}
        </div>
      </section>
    </>
  );
}
