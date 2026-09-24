import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import DashboardContent from "../components/DashboardContent.jsx";
import DonutChart from "../components/DonutChart.jsx";
import FilePathBreadcrumb from "../components/FilePathBreadcrumb.jsx";
import { buildHunks } from "../lib/patchHunks.js";
import {
  ShieldIcon,
  LayersIcon,
  GithubIcon,
  GitlabIcon,
  TerminalIcon,
  BookIcon,
  UserIcon,
  KeyIcon,
  EyeIcon,
  EyeOffIcon,
  LogOutIcon,
  CheckCircleIcon,
  AlertIcon,
  FolderIcon,
  ArrowRightIcon,
  ChevronDownIcon,
  XCircleIcon,
} from "../components/Icons.jsx";

const NAV = [
  { key: "overview", label: "Overview", Icon: LayersIcon },
  { key: "connect", label: "Connect", Icon: GithubIcon },
  { key: "scan", label: "Check pipeline", Icon: TerminalIcon },
  { key: "review", label: "Review Queue", Icon: ShieldIcon },
  { key: "activity", label: "Audit Log", Icon: BookIcon },
];

function formatFeedDate(iso) {
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

// One place a trigger's "will this re-run on its own" note is rendered --
// used on every feed/review card, not just after a fix ships, since a human
// deciding what to do with a control-plane change needs this just as much
// as the auto-merge path does.
function TriggerNote({ triggerInfo }) {
  if (!triggerInfo) return null;
  if (triggerInfo.willAutoRun) {
    return (
      <p className="trigger-note">
        This workflow runs on <code>{triggerInfo.triggers.join(", ")}</code> — a new push (or PR) re-runs it
        automatically.
      </p>
    );
  }
  if (triggerInfo.requiresManualDispatch) {
    return (
      <p className="trigger-note warn">
        This workflow only runs via <code>workflow_dispatch</code> — it won't re-run on its own once the fix is
        pushed.{" "}
        <a href={triggerInfo.actionsUrl} target="_blank" rel="noreferrer">
          Run it manually from the Actions tab <ArrowRightIcon width="12" height="12" />
        </a>
      </p>
    );
  }
  return null;
}

function RiskBadge({ risk }) {
  if (typeof risk !== "number") return null;
  return <span className="risk-score">risk {risk.toFixed(2)}</span>;
}

// A failed generation shouldn't be a dead end -- when it's the free local
// model that came up empty, this is the actionable next step, not just an
// error to read and abandon.
function SkippedFilesNote({ skipped }) {
  if (!skipped || skipped.length === 0) return null;
  return (
    <div className="skipped-files-note">
      {skipped.map((s, i) => (
        <p key={i}>
          <FilePathBreadcrumb path={s.file} /> — {s.reason}
        </p>
      ))}
    </div>
  );
}

function FixErrorNote({ error, suggestOwnKey, onNavigate }) {
  if (!error) return null;
  if (!suggestOwnKey) return <p className="error">{error}</p>;
  return (
    <div className="fix-error-cta">
      <p className="error">{error}</p>
      <button
        type="button"
        className="btn btn-secondary btn-sm"
        onClick={() => onNavigate?.("connect")}
      >
        Connect your own AI key <ArrowRightIcon width="12" height="12" />
      </button>
    </div>
  );
}

function PatchView({ before, after }) {
  const hunks = buildHunks(before, after);
  if (hunks.length === 0) return null;
  return (
    <div className="patch-view">
      {hunks.map((hunk, hi) => (
        <pre className="patch-hunk" key={hi}>
          {hunk.map((line, li) => (
            <div className={`patch-line ${line.type}`} key={li}>
              <span className="patch-marker">{line.type === "add" ? "+" : line.type === "remove" ? "-" : " "}</span>
              {line.text}
            </div>
          ))}
        </pre>
      ))}
    </div>
  );
}

// Shared by FeedEntry (Check pipeline) and ReviewQueueCard (Review Queue) --
// both need "generate a fix, maybe edit it, then either open a PR or (for
// escalated ones) get a human decision", so the request/response plumbing
// lives here once instead of twice.
function useFixWorkflow(entry, { onAuthStale } = {}) {
  // Which files currently have a generation request in flight -- per-file
  // rather than one flag, so generating a suggestion for file #2 doesn't
  // disable the button on file #5.
  const [generatingFiles, setGeneratingFiles] = useState(() => new Set());
  const [fixError, setFixError] = useState(null);
  const [suggestOwnKey, setSuggestOwnKey] = useState(false);
  const [skipped, setSkipped] = useState(null);
  // Each entry also carries a `status`: "accepted" (default, included when
  // opening the PR) or "rejected" (kept visible, excluded from the PR) --
  // lets a human pick exactly which of several suggested files actually ship.
  const [fixes, setFixes] = useState([]);
  const [eventId, setEventId] = useState(null);
  const [editingFile, setEditingFile] = useState(null);
  const [draft, setDraft] = useState("");
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [prResult, setPrResult] = useState(null);
  const [rejecting, setRejecting] = useState(false);
  const [rejected, setRejected] = useState(false);
  const [copiedFile, setCopiedFile] = useState(null);

  // Generates a suggestion for exactly the files passed in -- a single file
  // when triggered from that file's own row, or the whole changeset when
  // called via generateFix() below. Re-generating a file that already has a
  // suggestion replaces just that entry, leaving the others untouched.
  async function generateFixFor(files) {
    if (!files || files.length === 0) return;
    setGeneratingFiles((prev) => new Set([...prev, ...files]));
    setFixError(null);
    setSuggestOwnKey(false);
    try {
      const res = await fetch("/api/pipeline/generate-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: entry.provider,
          repo: entry.repo,
          headSha: entry.run.headSha,
          files,
          failedJob: entry.failedJob,
          logExcerpt: entry.logExcerpt,
          verdict: entry.verdict,
          risk: entry.risk,
          workflowPath: entry.run.path,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Tokens live in memory only and don't survive a backend restart --
        // if this is why the request just failed, re-check connection
        // status now instead of leaving the sidebar showing "Connected"
        // while every action 401s.
        if (res.status === 401) {
          onAuthStale?.();
          throw new Error(`${data.error || "Not connected."} Your connection may have reset -- check the Connect tab.`);
        }
        if (data.suggestOwnKey) setSuggestOwnKey(true);
        if (data.skipped?.length) setSkipped((prev) => [...(prev || []), ...data.skipped]);
        throw new Error(data.error || "Couldn't generate a fix.");
      }
      setFixes((prev) => {
        const kept = prev.filter((f) => !files.includes(f.file));
        return [...kept, ...data.fixes.map((f) => ({ ...f, status: "accepted" }))];
      });
      if (data.skipped?.length) setSkipped((prev) => [...(prev || []), ...data.skipped]);
      if (!eventId && data.eventId) setEventId(data.eventId);
    } catch (e) {
      setFixError(e.message);
    } finally {
      setGeneratingFiles((prev) => {
        const next = new Set(prev);
        files.forEach((f) => next.delete(f));
        return next;
      });
    }
  }

  // Back-compat convenience for callers that still want "generate for
  // everything in this changeset" in one click (Review Queue).
  function generateFix() {
    return generateFixFor(entry.files.map((f) => f.file));
  }

  function setFixStatus(file, status) {
    setFixes((prev) => prev.map((f) => (f.file === file ? { ...f, status } : f)));
  }

  function startEdit(f) {
    setEditingFile(f.file);
    setDraft(f.after);
  }

  function saveEdit(f) {
    setFixes((prev) => prev.map((x) => (x.file === f.file ? { ...x, after: draft } : x)));
    setEditingFile(null);
  }

  async function copyFix(f) {
    await navigator.clipboard.writeText(f.after);
    setCopiedFile(f.file);
    setTimeout(() => setCopiedFile(null), 2000);
  }

  async function applyFix({ humanApproved = false } = {}) {
    const included = fixes.filter((f) => f.status !== "rejected");
    if (included.length === 0) {
      setApplyError("Accept at least one suggested fix first.");
      return;
    }
    setApplying(true);
    setApplyError(null);
    try {
      const res = await fetch("/api/pipeline/apply-fix", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: entry.provider,
          repo: entry.repo,
          baseBranch: entry.defaultBranch,
          headSha: entry.run.headSha,
          runUrl: entry.run.url,
          fixes: included.map((f) => ({ file: f.file, content: f.after })),
          humanApproved,
          eventId,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 401) {
          onAuthStale?.();
          throw new Error(`${data.error || "Not connected."} Your connection may have reset -- check the Connect tab.`);
        }
        throw new Error(data.error || `Couldn't open the ${entry.provider === "gitlab" ? "merge" : "pull"} request.`);
      }
      setPrResult(data);
    } catch (e) {
      setApplyError(e.message);
    } finally {
      setApplying(false);
    }
  }

  // Rejects the whole entry (Review Queue's "Reject" action) -- distinct
  // from setFixStatus(file, "rejected"), which only excludes one file's
  // suggestion while leaving the others eligible to ship.
  async function rejectEntry() {
    setRejecting(true);
    try {
      if (eventId) {
        await fetch("/api/pipeline/reject-fix", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventId }),
        });
      }
      setRejected(true);
    } finally {
      setRejecting(false);
    }
  }

  return {
    generating: generatingFiles.size > 0,
    generatingFiles,
    fixError,
    suggestOwnKey,
    skipped,
    fixes,
    editingFile,
    draft,
    setDraft,
    applying,
    applyError,
    prResult,
    rejecting,
    rejected,
    copiedFile,
    generateFix,
    generateFixFor,
    setFixStatus,
    startEdit,
    saveEdit,
    copyFix,
    applyFix,
    rejectEntry,
  };
}

function OverviewSection({ githubStatus, gitlabStatus, feed, onNavigate }) {
  const failingEntries = feed ? feed.filter((f) => f.hasFailure) : null;
  const failing = failingEntries ? failingEntries.length : null;
  const escalated = failingEntries ? failingEntries.filter((f) => f.verdict === "ESCALATE_TO_HUMAN").length : null;
  const autoFixable = failingEntries ? failingEntries.length - escalated : null;
  const anyConnected = githubStatus?.connected || gitlabStatus?.connected;
  const connectionCount = (githubStatus?.connected ? 1 : 0) + (gitlabStatus?.connected ? 1 : 0);
  const maxFiles = failingEntries ? Math.max(1, ...failingEntries.map((f) => f.files.length)) : 1;

  return (
    <section>
      <div className="tool-section-head">
        <h1>Overview</h1>
        <p className="section-sub">
          NEXUS talks to GitHub and GitLab over their real APIs using a personal access token
          you connect below — not a demo. Every failing pipeline lands in one feed, whichever
          provider it came from.
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <span className="stat-avatar blue">
            <GithubIcon width="18" height="18" />
          </span>
          <div>
            <strong>{connectionCount}</strong>
            <span>Connections</span>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-avatar amber">
            <FolderIcon width="18" height="18" />
          </span>
          <div>
            <strong>{failing === null ? "—" : failing}</strong>
            <span>Repos with failing runs</span>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-avatar green">
            <CheckCircleIcon width="18" height="18" />
          </span>
          <div>
            <strong>{autoFixable === null ? "—" : autoFixable}</strong>
            <span>Auto-fixable (data-plane)</span>
          </div>
        </div>
        <div className="stat-tile">
          <span className="stat-avatar rose">
            <AlertIcon width="18" height="18" />
          </span>
          <div>
            <strong>{escalated === null ? "—" : escalated}</strong>
            <span>Escalated to human</span>
          </div>
        </div>
      </div>

      <div className="overview-grid">
        <div className="overview-card">
          <div className="overview-card-head">
            <h3>Verdict breakdown</h3>
          </div>
          {failingEntries && failingEntries.length > 0 ? (
            <div className="donut-row">
              <DonutChart
                segments={[
                  { value: autoFixable, color: "var(--safe)" },
                  { value: escalated, color: "var(--risky)" },
                ]}
              />
              <div className="donut-legend">
                <span>
                  <i className="legend-dot" style={{ background: "var(--safe)" }} /> Auto-fixable ({autoFixable})
                </span>
                <span>
                  <i className="legend-dot" style={{ background: "var(--risky)" }} /> Escalated ({escalated})
                </span>
              </div>
            </div>
          ) : (
            <p className="tool-empty-note">
              {failingEntries ? "Nothing failing right now." : "Connect a provider to see a breakdown."}
            </p>
          )}
        </div>

        <div className="overview-card">
          <div className="overview-card-head">
            <h3>Failing repos</h3>
          </div>
          {failingEntries && failingEntries.length > 0 ? (
            <div className="bar-list">
              {failingEntries.map((f) => (
                <div className="bar-row" key={`${f.provider}-${f.repo}`}>
                  <span className="bar-label">{f.repo}</span>
                  <div className="bar-track">
                    <div
                      className={`bar-fill ${f.verdict === "ESCALATE_TO_HUMAN" ? "risky" : "safe"}`}
                      style={{ width: `${Math.round((f.files.length / maxFiles) * 100)}%` }}
                    />
                  </div>
                  <span className="bar-value">{f.files.length}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="tool-empty-note">
              {failingEntries ? "Nothing failing right now." : "Connect a provider to see this."}
            </p>
          )}
        </div>
      </div>

      <div className="overview-card">
        <div className="overview-card-head">
          <h3>Recent failures</h3>
        </div>
        {failingEntries && failingEntries.length > 0 ? (
          <div className="overview-table-wrap">
            <table className="overview-table">
              <thead>
                <tr>
                  <th>Repo</th>
                  <th>Provider</th>
                  <th>Failed at</th>
                  <th>Verdict</th>
                  <th>Date</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {failingEntries.map((f) => (
                  <tr key={`${f.provider}-${f.repo}-${f.run.id}`}>
                    <td>{f.repo}</td>
                    <td className="capitalize">{f.provider}</td>
                    <td>{f.failedJob?.stepName || f.failedJob?.name || "—"}</td>
                    <td>
                      <span className={`tag ${f.verdict === "AUTO_MERGE_ELIGIBLE" ? "tag-safe" : "tag-risky"}`}>
                        {f.verdict === "AUTO_MERGE_ELIGIBLE" ? "auto-fixable" : "escalated"}
                      </span>
                    </td>
                    <td>{formatFeedDate(f.run.createdAt)}</td>
                    <td>
                      <a className="run-link" href={f.run.url} target="_blank" rel="noreferrer">
                        View <ArrowRightIcon width="12" height="12" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="tool-empty-note">
            {failingEntries ? "Nothing failing right now." : "Connect a provider to populate this."}
          </p>
        )}
      </div>

      <div className="overview-actions">
        {!anyConnected ? (
          <button className="btn btn-primary" onClick={() => onNavigate("connect")}>
            Connect a provider <ArrowRightIcon />
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => onNavigate("scan")}>
            Check pipelines <ArrowRightIcon />
          </button>
        )}
        {escalated > 0 && (
          <button className="btn btn-secondary" onClick={() => onNavigate("review")}>
            {escalated} waiting in Review Queue
          </button>
        )}
        <button className="btn btn-secondary" onClick={() => onNavigate("activity")}>
          View Audit Log
        </button>
      </div>
    </section>
  );
}

function ProviderConnectCard({ label, Icon, endpoint, placeholder, status, onStatusChange, variant }) {
  const [token, setToken] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function connect() {
    if (!token.trim()) {
      setError("Paste a personal access token first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't connect with that token.");
      setToken("");
      onStatusChange(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function disconnect() {
    setLoading(true);
    try {
      await fetch(`${endpoint}/disconnect`, { method: "POST" });
      onStatusChange({ connected: false });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="provider-connect">
      <div className="provider-connect-head">
        <Icon width="18" height="18" />
        <h3>{label}</h3>
      </div>

      {status?.connected ? (
        <div className={`connect-card connected ${variant}`}>
          <span className="stat-icon connect">
            <UserIcon width="16" height="16" />
          </span>
          <div>
            <strong>Connected as @{status.username}</strong>
            <span>Authenticated with your token</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={disconnect} disabled={loading}>
            <LogOutIcon width="14" height="14" /> Disconnect
          </button>
        </div>
      ) : (
        <div className="connect-card">
          <label className="tool-field">
            <KeyIcon width="14" height="14" />
            <input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={placeholder}
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && connect()}
            />
            <button
              type="button"
              className="tool-field-toggle"
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? "Hide token" : "Show token"}
            >
              {showToken ? <EyeOffIcon width="14" height="14" /> : <EyeIcon width="14" height="14" />}
            </button>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" onClick={connect} disabled={loading}>
            {loading ? "Verifying…" : "Connect"}
          </button>
        </div>
      )}
    </div>
  );
}

const AI_PROVIDERS = [
  { value: "gemini", label: "Google (Gemini)" },
  { value: "anthropic", label: "Anthropic (Claude)" },
  { value: "openai", label: "OpenAI (GPT)" },
  { value: "grok", label: "xAI (Grok)" },
];

function AiKeyConnectCard({ status, onStatusChange }) {
  const [provider, setProvider] = useState("gemini");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function connect() {
    if (!apiKey.trim()) {
      setError("Paste an API key first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Couldn't connect with that key.");
      setApiKey("");
      onStatusChange(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  async function disconnect() {
    setLoading(true);
    try {
      await fetch("/api/ai/disconnect", { method: "POST" });
      onStatusChange({ connected: false, provider: null });
    } finally {
      setLoading(false);
    }
  }

  const providerLabel = AI_PROVIDERS.find((p) => p.value === status?.provider)?.label || status?.provider;

  return (
    <div className="provider-connect">
      <div className="provider-connect-head">
        <TerminalIcon width="18" height="18" />
        <h3>AI provider</h3>
      </div>

      {status?.connected && status.isUserKey ? (
        <div className="connect-card connected blue">
          <span className="stat-icon connect">
            <TerminalIcon width="16" height="16" />
          </span>
          <div>
            <strong>Using {providerLabel}</strong>
            <span>Overrides the server default for fix generation</span>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={disconnect} disabled={loading}>
            <LogOutIcon width="14" height="14" /> Disconnect
          </button>
        </div>
      ) : (
        <div className="connect-card">
          {status?.connected ? (
            <div className="connect-card connected blue" style={{ marginBottom: 12 }}>
              <span className="stat-icon connect">
                <TerminalIcon width="16" height="16" />
              </span>
              <div>
                <strong>Using {providerLabel} (server default)</strong>
                <span>Paste your own key below to override it for this session</span>
              </div>
            </div>
          ) : (
            <p className="tool-empty-note" style={{ marginBottom: 10 }}>
              No AI provider is configured on the server (set GEMINI_API_KEY in backend/.env).
              Paste your own Gemini key here — free at aistudio.google.com/apikey — or a key for
              another provider to enable "Generate fix" / "Suggest a fix"; it's used until you
              disconnect.
            </p>
          )}
          <select className="ai-key-select" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {AI_PROVIDERS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <label className="tool-field">
            <KeyIcon width="14" height="14" />
            <input
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="API key"
              spellCheck={false}
              onKeyDown={(e) => e.key === "Enter" && connect()}
            />
            <button
              type="button"
              className="tool-field-toggle"
              onClick={() => setShowKey((v) => !v)}
              aria-label={showKey ? "Hide key" : "Show key"}
            >
              {showKey ? <EyeOffIcon width="14" height="14" /> : <EyeIcon width="14" height="14" />}
            </button>
          </label>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" onClick={connect} disabled={loading}>
            {loading ? "Verifying…" : "Connect"}
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectSection({ githubStatus, gitlabStatus, onGithubStatusChange, onGitlabStatusChange, aiStatus, onAiStatusChange }) {
  return (
    <section>
      <div className="tool-section-head">
        <h1>Connect</h1>
        <p className="section-sub">
          Bring your own token for whichever CI/CD platform you use — kept in memory only for this
          server session, never written to disk. Connect one or both; the pipeline feed merges
          whatever's connected.
        </p>
      </div>

      <div className="provider-connect-grid">
        <ProviderConnectCard
          label="GitHub"
          Icon={GithubIcon}
          endpoint="/api/github"
          placeholder="Personal access token"
          status={githubStatus}
          onStatusChange={onGithubStatusChange}
          variant="blue"
        />
        <ProviderConnectCard
          label="GitLab"
          Icon={GitlabIcon}
          endpoint="/api/gitlab"
          placeholder="Personal access token"
          status={gitlabStatus}
          onStatusChange={onGitlabStatusChange}
          variant="orange"
        />
        <AiKeyConnectCard status={aiStatus} onStatusChange={onAiStatusChange} />
      </div>
    </section>
  );
}

function FixedEntry({ entry }) {
  const providerLabel = entry.provider === "gitlab" ? "GitLab" : "GitHub";
  return (
    <div className="feed-entry fixed">
      <div className="feed-entry-head">
        <span className="feed-date">{formatFeedDate(entry.fixedRun.createdAt)}</span>
        <span className={`feed-provider ${entry.provider}`}>{providerLabel}</span>
        <span className="feed-repo">{entry.repo}</span>
        <a className="run-link" href={entry.fixedRun.url} target="_blank" rel="noreferrer">
          View run <ArrowRightIcon width="12" height="12" />
        </a>
      </div>
      <div className="verdict-card safe">
        <h3>
          <CheckCircleIcon /> Fixed
        </h3>
        <p>
          The previously failing run is passing again.{" "}
          <a href={entry.previousFailureUrl} target="_blank" rel="noreferrer">
            See the earlier failure <ArrowRightIcon width="13" height="13" />
          </a>
        </p>
      </div>
    </div>
  );
}

function FeedEntry({ entry, onNavigate, onAuthStale }) {
  const wf = useFixWorkflow(entry, { onAuthStale });
  const isSafe = entry.verdict === "AUTO_MERGE_ELIGIBLE";
  const requestNoun = entry.provider === "gitlab" ? "MR" : "PR";
  const providerLabel = entry.provider === "gitlab" ? "GitLab" : "GitHub";

  return (
    <div className="feed-entry">
      <div className="feed-entry-head">
        <span className="feed-date">{formatFeedDate(entry.run.createdAt)}</span>
        <span className={`feed-provider ${entry.provider}`}>{providerLabel}</span>
        <span className="feed-repo">{entry.repo}</span>
        <RiskBadge risk={entry.risk} />
        <a className="run-link" href={entry.run.url} target="_blank" rel="noreferrer">
          View run <ArrowRightIcon width="12" height="12" />
        </a>
      </div>

      <div className="feed-fail">
        <AlertIcon width="15" height="15" />
        <div>
          <strong>
            {entry.failedJob?.name || "Job"} failed
            {entry.failedJob?.stepName ? ` at "${entry.failedJob.stepName}"` : ""}
          </strong>
          {entry.logExcerpt && <pre className="feed-log">{entry.logExcerpt}</pre>}
        </div>
      </div>

      <div className="file-verdicts">
        {entry.files.map((f, i) => {
          const fix = wf.fixes.find((x) => x.file === f.file);
          const isGenerating = wf.generatingFiles.has(f.file);
          return (
            <div className="file-verdict-row" key={f.file + i}>
              <FilePathBreadcrumb path={f.file} />
              <span className={`tag ${f.plane === "data-plane" ? "tag-safe" : "tag-risky"}`}>{f.plane}</span>
              {fix ? (
                <span className={`tag ${fix.status === "rejected" ? "tag-risky" : "tag-safe"}`}>
                  {fix.status === "rejected" ? "rejected" : "suggested"}
                </span>
              ) : (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => wf.generateFixFor([f.file])}
                  disabled={isGenerating}
                >
                  {isGenerating ? "Generating…" : "Generate suggestion"}
                </button>
              )}
            </div>
          );
        })}
      </div>

      <div className={`risk-note ${isSafe ? "low" : "high"}`}>
        {isSafe
          ? "Low risk — data-plane only. NEXUS can self-heal this: pick a file above to generate a fix, then open the PR yourself."
          : "High risk — control-plane file involved. Pick a file above to get a suggestion, but a human must review and apply it — no auto-PR."}
      </div>
      <TriggerNote triggerInfo={entry.triggerInfo} />

      <SkippedFilesNote skipped={wf.skipped} />
      <FixErrorNote error={wf.fixError} suggestOwnKey={wf.suggestOwnKey} onNavigate={onNavigate} />

      {wf.fixes.length > 0 && !wf.prResult && (
        <div className="fix-review">
          {wf.fixes.map((f) => (
            <div className={`fix-card ${f.status === "rejected" ? "fix-card-rejected" : ""}`} key={f.file}>
              <div className="fix-card-head">
                <FilePathBreadcrumb path={f.file} />
                <div className="fix-card-head-actions">
                  {wf.editingFile !== f.file && f.status !== "rejected" && (
                    <button type="button" className="fix-edit-btn" onClick={() => wf.startEdit(f)}>
                      Edit
                    </button>
                  )}
                  {f.status === "rejected" ? (
                    <button type="button" className="fix-accept-btn" onClick={() => wf.setFixStatus(f.file, "accepted")}>
                      Undo reject
                    </button>
                  ) : (
                    <button type="button" className="fix-reject-btn" onClick={() => wf.setFixStatus(f.file, "rejected")}>
                      Reject
                    </button>
                  )}
                </div>
              </div>

              {f.status === "rejected" ? (
                <p className="tool-empty-note">Rejected — won't be included.</p>
              ) : wf.editingFile === f.file ? (
                <div className="fix-edit-box">
                  <textarea value={wf.draft} onChange={(e) => wf.setDraft(e.target.value)} spellCheck={false} />
                  <div className="fix-edit-actions">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => wf.startEdit({ file: null })}>
                      Cancel
                    </button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => wf.saveEdit(f)}>
                      Save edit
                    </button>
                  </div>
                </div>
              ) : (
                <PatchView before={f.before} after={f.after} />
              )}

              {!isSafe && wf.editingFile !== f.file && f.status !== "rejected" && (
                <button type="button" className="btn btn-secondary btn-sm fix-copy-btn" onClick={() => wf.copyFix(f)}>
                  {wf.copiedFile === f.file ? "Copied" : "Copy suggested code"}
                </button>
              )}
            </div>
          ))}

          {isSafe ? (
            <button
              className="btn btn-primary"
              onClick={() => wf.applyFix({ humanApproved: false })}
              disabled={wf.applying || wf.fixes.every((f) => f.status === "rejected")}
            >
              {wf.applying ? `Opening ${requestNoun}…` : `Open ${requestNoun} with this fix`}
            </button>
          ) : (
            <p className="tool-empty-note">
              This touches a control-plane file — apply it yourself after review, or{" "}
              <a href="#" onClick={(e) => { e.preventDefault(); onNavigate("review"); }}>
                approve or reject it in the Review Queue
              </a>
              . NEXUS won't open a {requestNoun} automatically here.
            </p>
          )}
          {wf.applyError && <p className="error">{wf.applyError}</p>}
        </div>
      )}

      {wf.prResult && (
        <div className="verdict-card safe">
          <h3>
            <CheckCircleIcon /> {entry.provider === "gitlab" ? "Merge request" : "Draft PR"} opened
          </h3>
          <p>
            {wf.prResult.filesChanged.length} file{wf.prResult.filesChanged.length === 1 ? "" : "s"} changed.{" "}
            <a href={wf.prResult.prUrl} target="_blank" rel="noreferrer">
              Review it on {providerLabel} <ArrowRightIcon width="13" height="13" />
            </a>
          </p>
        </div>
      )}
    </div>
  );
}

function ReviewQueueCard({ entry, onAuthStale, onNavigate }) {
  const wf = useFixWorkflow(entry, { onAuthStale });
  const [expanded, setExpanded] = useState(false);
  const providerLabel = entry.provider === "gitlab" ? "GitLab" : "GitHub";
  const requestNoun = entry.provider === "gitlab" ? "MR" : "MR";
  const controlFiles = entry.files.filter((f) => f.plane === "control-plane");
  const title = controlFiles.length === 1 ? `Review ${controlFiles[0].file.split("/").pop()}` : `Review ${controlFiles.length} control-plane files`;

  return (
    <div className="review-card">
      <button type="button" className="review-card-head" onClick={() => setExpanded((v) => !v)}>
        <ChevronDownIcon width="16" height="16" style={{ transform: expanded ? "rotate(180deg)" : "none" }} />
        <div className="review-card-title">
          <strong>{title}</strong>
          <span>
            {entry.repo} · {providerLabel}
          </span>
        </div>
        <RiskBadge risk={entry.risk} />
        {wf.prResult && <span className="tag tag-safe">approved</span>}
        {wf.rejected && <span className="tag tag-risky">rejected</span>}
      </button>

      {expanded && (
        <div className="review-card-body">
          <div className="review-card-reason">
            <span className="lbl-mono">Risk reason</span>
            <p>
              {controlFiles.map((f) => f.matchedRule || "no explicit rule matched -- defaulted to control-plane").join(", ")}
            </p>
          </div>

          <div className="file-verdicts">
            {entry.files.map((f, i) => (
              <div className="file-verdict-row" key={f.file + i}>
                <FilePathBreadcrumb path={f.file} />
                <span className={`tag ${f.plane === "data-plane" ? "tag-safe" : "tag-risky"}`}>{f.plane}</span>
              </div>
            ))}
          </div>

          <TriggerNote triggerInfo={entry.triggerInfo} />

          {wf.fixes.length === 0 && !wf.rejected && (
            <button className="btn btn-secondary btn-sm" onClick={wf.generateFix} disabled={wf.generating}>
              {wf.generating ? "Generating…" : "Generate suggested fix"}
            </button>
          )}
          <SkippedFilesNote skipped={wf.skipped} />
          <FixErrorNote error={wf.fixError} suggestOwnKey={wf.suggestOwnKey} onNavigate={onNavigate} />

          {wf.fixes.length > 0 && !wf.prResult && !wf.rejected && (
            <div className="fix-review">
              {wf.fixes.map((f) => (
                <div className="fix-card" key={f.file}>
                  <div className="fix-card-head">
                    <FilePathBreadcrumb path={f.file} />
                    {wf.editingFile !== f.file && (
                      <button type="button" className="fix-edit-btn" onClick={() => wf.startEdit(f)}>
                        Edit
                      </button>
                    )}
                  </div>
                  {wf.editingFile === f.file ? (
                    <div className="fix-edit-box">
                      <textarea value={wf.draft} onChange={(e) => wf.setDraft(e.target.value)} spellCheck={false} />
                      <div className="fix-edit-actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => wf.startEdit({ file: null })}>
                          Cancel
                        </button>
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => wf.saveEdit(f)}>
                          Save edit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <PatchView before={f.before} after={f.after} />
                  )}
                </div>
              ))}

              <div className="review-actions">
                <button className="btn btn-primary" onClick={() => wf.applyFix({ humanApproved: true })} disabled={wf.applying}>
                  <CheckCircleIcon width="14" height="14" />
                  {wf.applying ? `Opening ${requestNoun}…` : `Approve & open ${requestNoun}`}
                </button>
                <button className="btn btn-secondary" onClick={wf.rejectEntry} disabled={wf.rejecting}>
                  <XCircleIcon width="14" height="14" />
                  {wf.rejecting ? "Rejecting…" : "Reject"}
                </button>
              </div>
              {wf.applyError && <p className="error">{wf.applyError}</p>}
            </div>
          )}

          {wf.prResult && (
            <div className="verdict-card safe">
              <h3>
                <CheckCircleIcon /> Approved — {entry.provider === "gitlab" ? "merge request" : "pull request"} opened
              </h3>
              <p>
                <a href={wf.prResult.prUrl} target="_blank" rel="noreferrer">
                  Review it on {providerLabel} <ArrowRightIcon width="13" height="13" />
                </a>
              </p>
            </div>
          )}

          {wf.rejected && (
            <div className="verdict-card risky">
              <h3>
                <XCircleIcon /> Rejected
              </h3>
              <p>This suggestion won't be applied. It's recorded in the Audit Log.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ReviewQueueSection({ connected, feed, onAuthStale, onNavigate }) {
  if (!connected) {
    return (
      <section>
        <div className="tool-section-head">
          <h1>Review Queue</h1>
        </div>
        <p className="section-sub">Connect GitHub or GitLab first to see what's waiting for review.</p>
      </section>
    );
  }

  const escalated = feed ? feed.filter((e) => e.hasFailure && e.verdict === "ESCALATE_TO_HUMAN") : null;

  return (
    <section>
      <div className="tool-section-head">
        <h1>Review Queue</h1>
        <p className="section-sub">
          These fixes were flagged control-plane by policy.yaml. They will not ship until you
          approve them here — NEXUS never auto-merges a control-plane change.
        </p>
      </div>

      {escalated && escalated.length === 0 && (
        <div className="verdict-card safe">
          <h3>
            <CheckCircleIcon /> Nothing waiting
          </h3>
          <p>No control-plane changes are currently flagged for review.</p>
        </div>
      )}

      {escalated && escalated.length > 0 && (
        <div className="review-queue-list">
          {escalated.map((entry) => (
            <ReviewQueueCard entry={entry} onAuthStale={onAuthStale} onNavigate={onNavigate} key={`${entry.provider}-${entry.repo}-${entry.run.id}`} />
          ))}
        </div>
      )}

      {!escalated && <p className="tool-empty-note">Checking…</p>}
    </section>
  );
}

function ScanSection({
  connected,
  feed,
  loading,
  error,
  onRefresh,
  onNavigate,
  onAuthStale,
  githubRepos,
  reposLoading,
  selectedRepo,
  onSelectRepo,
}) {
  if (!connected) {
    return (
      <section>
        <div className="tool-section-head">
          <h1>Pipeline failures</h1>
        </div>
        <p className="section-sub">Connect GitHub or GitLab first to check your repositories.</p>
      </section>
    );
  }

  return (
    <section>
      <div className="tool-section-head">
        <h1>Pipeline failures</h1>
        <p className="section-sub">
          {selectedRepo
            ? "Checks the repo you picked below for a failing run."
            : "Automatically checks your most recently updated repositories for failing runs — pick one below to narrow it down."}{" "}
          Data-plane failures get a reviewable, editable fix; control-plane ones are always escalated.
        </p>
      </div>

      <div className="repo-picker-row">
        <select
          className="ai-key-select repo-picker-select"
          value={selectedRepo}
          onChange={(e) => onSelectRepo(e.target.value)}
          disabled={reposLoading}
        >
          <option value="">
            {reposLoading ? "Loading your repos…" : "All repos (auto — most recently updated)"}
          </option>
          {githubRepos?.map((r) => (
            <option key={r.fullName} value={r.fullName}>
              {r.fullName}
              {r.private ? " (private)" : ""}
            </option>
          ))}
        </select>
        <button className="btn btn-secondary btn-sm" onClick={onRefresh} disabled={loading}>
          {loading ? "Checking…" : "Refresh"}
        </button>
      </div>

      {error && <p className="error">{error}</p>}

      {feed && feed.length === 0 && (
        <div className="tool-result">
          <div className="verdict-card safe">
            <h3>
              <CheckCircleIcon /> Nothing failing
            </h3>
            <p>Recent runs across your repositories are all passing.</p>
          </div>
        </div>
      )}

      {feed && feed.length > 0 && (
        <div className="pipeline-feed">
          {feed.map((entry) =>
            entry.hasFailure ? (
              <FeedEntry entry={entry} onNavigate={onNavigate} onAuthStale={onAuthStale} key={`${entry.provider}-${entry.repo}-${entry.run.id}`} />
            ) : (
              <FixedEntry entry={entry} key={`${entry.provider}-${entry.repo}-${entry.fixedRun.id}`} />
            )
          )}
        </div>
      )}
    </section>
  );
}

export default function ToolPage() {
  const [section, setSection] = useState("overview");
  const [githubStatus, setGithubStatus] = useState(null);
  const [gitlabStatus, setGitlabStatus] = useState(null);
  const [aiStatus, setAiStatus] = useState(null);
  const [feed, setFeed] = useState(null);
  const [feedLoading, setFeedLoading] = useState(false);
  const [feedError, setFeedError] = useState(null);
  const [githubRepos, setGithubRepos] = useState(null);
  const [reposLoading, setReposLoading] = useState(false);
  // "" = auto feed across the most recently updated repos (old behaviour).
  // Any other value = only check that one repo.
  const [selectedRepo, setSelectedRepo] = useState("");

  // Tokens live in memory only (never written to disk) -- a backend
  // restart silently drops them. Without this, the sidebar keeps showing
  // "Connected" from whatever it fetched on page load even after that
  // happens, and every action fails with a confusing "Connect first"
  // despite the UI insisting you're already connected.
  function refreshConnections() {
    fetch("/api/github/status")
      .then((r) => r.json())
      .then(setGithubStatus)
      .catch(() => setGithubStatus({ connected: false }));
    fetch("/api/gitlab/status")
      .then((r) => r.json())
      .then(setGitlabStatus)
      .catch(() => setGitlabStatus({ connected: false }));
  }

  useEffect(() => {
    refreshConnections();
    fetch("/api/ai/status")
      .then((r) => r.json())
      .then(setAiStatus)
      .catch(() => setAiStatus({ connected: false, provider: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Populates the repo picker once GitHub is connected. Doesn't block the
  // (still-working) auto feed if it fails -- the picker just stays empty
  // and "All repos (auto)" keeps working.
  useEffect(() => {
    if (!githubStatus?.connected) {
      setGithubRepos(null);
      return;
    }
    setReposLoading(true);
    fetch("/api/github/repos")
      .then((r) => r.json())
      .then((data) => setGithubRepos(data.repos || []))
      .catch(() => setGithubRepos([]))
      .finally(() => setReposLoading(false));
  }, [githubStatus?.connected]);

  const anyConnected = githubStatus?.connected || gitlabStatus?.connected;
  const connectedProviders = [
    githubStatus?.connected ? `@${githubStatus.username} (GitHub)` : null,
    gitlabStatus?.connected ? `@${gitlabStatus.username} (GitLab)` : null,
  ].filter(Boolean);

  async function loadFeed(silent) {
    if (!silent) setFeedLoading(true);
    setFeedError(null);
    try {
      // A repo is picked -> check only that one, wrapped into the same
      // shape /api/pipeline/feed returns so FeedEntry/FixedEntry render
      // it identically either way. Nothing picked -> old auto-feed
      // behaviour across the most recently updated repos.
      if (selectedRepo) {
        const res = await fetch("/api/github/pipeline-check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ repo: selectedRepo }),
        });
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) refreshConnections();
          throw new Error(data.error || "Couldn't check that repository.");
        }
        const entry = { provider: "github", repo: selectedRepo, ...data };
        setFeed(entry.hasFailure || entry.recentlyFixed ? [entry] : []);
      } else {
        const res = await fetch("/api/pipeline/feed");
        const data = await res.json();
        if (!res.ok) {
          if (res.status === 401) refreshConnections();
          throw new Error(data.error || "Couldn't check your repositories.");
        }
        setFeed(data.feed);
      }
    } catch (e) {
      if (!silent) setFeedError(e.message);
    } finally {
      if (!silent) setFeedLoading(false);
    }
  }

  // Polls in the background so a pipeline that fails (or gets fixed) shows
  // up on its own -- no manual "Refresh" needed to notice it. Also keeps
  // the connection status honest: if the backend restarted and forgot the
  // token, this notices within 30s instead of leaving the sidebar stale
  // indefinitely.
  useEffect(() => {
    if (!anyConnected) return;
    loadFeed();
    const id = setInterval(() => {
      loadFeed(true);
      refreshConnections();
    }, 30000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anyConnected, selectedRepo]);

  return (
    <div className="tool-page">
      <aside className="tool-sidebar">
        <Link to="/" className="tool-brand">
          <span className="brand-mark">
            <ShieldIcon />
          </span>
          NEXUS
        </Link>

        <nav className="tool-nav">
          {NAV.map(({ key, label, Icon }) => (
            <button
              key={key}
              className={`tool-nav-item ${section === key ? "active" : ""}`}
              onClick={() => setSection(key)}
            >
              <Icon width="16" height="16" />
              {label}
            </button>
          ))}
        </nav>

        <div className="tool-sidebar-footer">
          {connectedProviders.length > 0 ? (
            <div className="sidebar-user">
              <span className="stat-icon connect">
                <UserIcon width="14" height="14" />
              </span>
              <div>
                <strong>{connectedProviders.join(" · ")}</strong>
                <span>Connected</span>
              </div>
            </div>
          ) : (
            <div className="sidebar-user muted">
              <span className="stat-icon">
                <UserIcon width="14" height="14" />
              </span>
              <div>
                <strong>Not connected</strong>
                <span>No token yet</span>
              </div>
            </div>
          )}
          <Link to="/" className="tool-exit">
            ← Exit tool
          </Link>
        </div>
      </aside>

      {/*
        Every section stays mounted all the time and is only hidden with
        CSS -- switching tabs used to unmount whichever section you left,
        which threw away any fix a FeedEntry/ReviewQueueCard had already
        generated (or applied) the moment you looked at another tab.
      */}
      <main className="tool-main">
        <div style={{ display: section === "overview" ? "block" : "none" }}>
          <OverviewSection githubStatus={githubStatus} gitlabStatus={gitlabStatus} feed={feed} onNavigate={setSection} />
        </div>
        <div style={{ display: section === "connect" ? "block" : "none" }}>
          <ConnectSection
            githubStatus={githubStatus}
            gitlabStatus={gitlabStatus}
            onGithubStatusChange={setGithubStatus}
            onGitlabStatusChange={setGitlabStatus}
            aiStatus={aiStatus}
            onAiStatusChange={setAiStatus}
          />
        </div>
        <div style={{ display: section === "scan" ? "block" : "none" }}>
          <ScanSection
            connected={anyConnected}
            feed={feed}
            loading={feedLoading}
            error={feedError}
            onRefresh={loadFeed}
            onNavigate={setSection}
            onAuthStale={refreshConnections}
            githubRepos={githubRepos}
            reposLoading={reposLoading}
            selectedRepo={selectedRepo}
            onSelectRepo={setSelectedRepo}
          />
        </div>
        <div style={{ display: section === "review" ? "block" : "none" }}>
          <ReviewQueueSection connected={anyConnected} feed={feed} onAuthStale={refreshConnections} onNavigate={setSection} />
        </div>
        <div style={{ display: section === "activity" ? "block" : "none" }}>
          <DashboardContent connected={anyConnected} />
        </div>
      </main>
    </div>
  );
}
