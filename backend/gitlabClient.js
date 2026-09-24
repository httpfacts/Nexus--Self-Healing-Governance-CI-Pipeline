// GitLab CI -- second provider in the unified pipeline-failure feed,
// alongside GitHub Actions (mcpGithubClient.js / pipelineCheck.js). Same
// memory-only personal-access-token pattern: connectWithToken() verifies
// the token against GitLab's own API, nothing is ever written to disk.
// No SDK needed -- GitLab's REST API is plain fetch + a PRIVATE-TOKEN header.
const llm = require("./llmClient");
const { classifyChangeset } = require("./classify");

const GITLAB_API = process.env.GITLAB_API_URL || "https://gitlab.com/api/v4";

class GitlabError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

let currentToken = null;
let connection = { username: null, name: null, avatarUrl: null };

async function gitlabFetch(path, token, options = {}) {
  let res;
  try {
    res = await fetch(`${GITLAB_API}${path}`, {
      ...options,
      headers: {
        ...(token ? { "PRIVATE-TOKEN": token } : {}),
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch {
    throw new GitlabError("Couldn't reach GitLab.", 502);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GitlabError(`GitLab API error ${res.status}: ${text.slice(0, 200)}`, res.status);
  }
  const contentType = res.headers.get("content-type") || "";
  return contentType.includes("application/json") ? res.json() : res.text();
}

async function verifyToken(token) {
  try {
    const user = await gitlabFetch("/user", token);
    return { username: user.username, name: user.name || null, avatarUrl: user.avatar_url || null };
  } catch (err) {
    if (err.status === 401) throw new GitlabError("GitLab rejected that token (invalid or expired).", 401);
    throw new GitlabError("Couldn't reach GitLab to verify that token.", 502);
  }
}

async function connectWithToken(token) {
  const identity = await verifyToken(token);
  currentToken = token;
  connection = identity;
  return { connected: true, ...identity };
}

function disconnectToken() {
  currentToken = null;
  connection = { username: null, name: null, avatarUrl: null };
}

function getStatus() {
  return {
    connected: Boolean(connection.username),
    username: connection.username,
    name: connection.name,
    avatarUrl: connection.avatarUrl,
  };
}

function getConnectedToken() {
  return connection.username ? currentToken : null;
}

async function listProjects(token) {
  const projects = await gitlabFetch("/projects?membership=true&order_by=last_activity_at&per_page=60", token);
  return projects.map((p) => ({
    id: p.id,
    fullName: p.path_with_namespace,
    private: p.visibility !== "public",
    defaultBranch: p.default_branch,
  }));
}

// Looks at the two most recent pipelines overall (not just failed ones) so
// a fix that actually worked shows up as "fixed" instead of the feed just
// silently repeating the same stale failure forever.
async function getRecentPipelines(token, projectId) {
  return gitlabFetch(`/projects/${projectId}/pipelines?per_page=2&order_by=id&sort=desc`, token);
}

async function getFailedJob(token, projectId, pipelineId) {
  const jobs = await gitlabFetch(`/projects/${projectId}/pipelines/${pipelineId}/jobs?scope[]=failed`, token);
  const job = jobs[0];
  if (!job) return null;
  return { id: job.id, name: job.name, stepName: job.stage || null };
}

// GitLab embeds ANSI color codes in trace output -- stripped so the log
// excerpt reads cleanly in a plain <pre> block.
async function getLogExcerpt(token, projectId, jobId) {
  try {
    const text = await gitlabFetch(`/projects/${projectId}/jobs/${jobId}/trace`, token);
    const clean = String(text)
      .split("\n")
      .map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""))
      .filter((l) => l.trim().length > 0);
    return clean.slice(-8).join("\n");
  } catch {
    return null;
  }
}

async function getCommitFiles(token, projectId, sha) {
  const diffs = await gitlabFetch(`/projects/${projectId}/repository/commits/${sha}/diff`, token);
  return diffs.map((d) => d.new_path || d.old_path);
}

async function getFileContent(token, projectId, filePath, ref) {
  try {
    const text = await gitlabFetch(
      `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}/raw?ref=${encodeURIComponent(ref)}`,
      token
    );
    return typeof text === "string" ? text : null;
  } catch {
    return null; // binary, deleted, or unreadable -- skip rather than guess
  }
}

async function checkPipeline(token, projectId) {
  const project = await gitlabFetch(`/projects/${projectId}`, token);
  const pipelines = await getRecentPipelines(token, projectId);
  const latest = pipelines[0] || null;
  const previous = pipelines[1] || null;

  if (!latest) return { hasFailure: false, defaultBranch: project.default_branch };

  if (latest.status !== "failed") {
    if (previous && previous.status === "failed") {
      return {
        hasFailure: false,
        recentlyFixed: true,
        defaultBranch: project.default_branch,
        fixedRun: { id: latest.id, url: latest.web_url, createdAt: latest.created_at, headBranch: latest.ref },
        previousFailureUrl: previous.web_url,
      };
    }
    return { hasFailure: false, defaultBranch: project.default_branch };
  }

  const pipeline = latest;
  const failedJob = await getFailedJob(token, projectId, pipeline.id);
  const logExcerpt = failedJob ? await getLogExcerpt(token, projectId, failedJob.id) : null;
  const files = await getCommitFiles(token, projectId, pipeline.sha);
  const classification = classifyChangeset(files);

  return {
    hasFailure: true,
    defaultBranch: project.default_branch,
    run: {
      id: pipeline.id,
      url: pipeline.web_url,
      headSha: pipeline.sha,
      headBranch: pipeline.ref,
      name: "GitLab CI",
      createdAt: pipeline.created_at,
    },
    failedJob,
    logExcerpt,
    ...classification, // files, verdict, reasoning
  };
}

// Project-scoped GitLab endpoints accept a URL-encoded "namespace/project"
// path anywhere they accept a numeric ID -- used consistently instead of
// the numeric ID so the frontend only ever has to pass around `fullName`,
// the same shape GitHub's `owner/repo` already uses.
async function checkAllProjects(token, limit = 8) {
  const projects = await listProjects(token);
  const targets = projects.slice(0, limit);

  const results = await Promise.all(
    targets.map(async (p) => {
      try {
        const result = await checkPipeline(token, encodeURIComponent(p.fullName));
        if (result.hasFailure || result.recentlyFixed) return { repo: p.fullName, provider: "gitlab", ...result };
        return null;
      } catch {
        return null;
      }
    })
  );

  return results.filter(Boolean);
}

function buildFixPrompt(filePath, currentContent, failedJob, logExcerpt) {
  return `A GitLab CI pipeline failed. Failing job: "${failedJob?.name || "unknown"}"${
    failedJob?.stepName ? `, stage "${failedJob.stepName}"` : ""
  }.

Relevant log output:
---
${logExcerpt || "(no log available)"}
---

Here is the current content of ${filePath}, a data-plane file NEXUS has
already cleared as safe to auto-fix (no CI config, secrets, or approval gates
-- just application/test code):

---
${currentContent}
---

Change only what's necessary to fix the failure above. Keep every other line
byte-for-byte identical -- same indentation, same spacing, same line breaks,
same quoting style. Do not reformat, re-indent, reorder keys, or rewrap lines
you aren't fixing, even if you think it looks nicer: this file is about to be
shown as a diff, and reformatting unrelated lines makes the whole file look
changed instead of the one real fix.

Return ONLY the full corrected content of this file, with no explanation, no
markdown code fences, and no commentary -- just the raw file content a patch
tool could write straight to disk.`;
}

// Same reasoning as pipelineCheck.js's GitHub version: don't spend an LLM
// call asking it to "fix" a file the failure log never even mentions --
// GitLab CI configs are usually one file already in `files` when relevant,
// so there's no separate workflow-fallback step here.
function extractLogKeywords(logExcerpt) {
  if (!logExcerpt) return [];
  const matches = logExcerpt.match(/\b[A-Z][A-Z0-9_]{3,}\b|[\w.-]+\.\w{2,4}\b/g) || [];
  return [...new Set(matches)].slice(0, 20);
}

function fileLooksRelevant(content, filePath, keywords) {
  if (keywords.length === 0) return true;
  const haystack = (filePath + "\n" + content).toLowerCase();
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

async function generateFixes(token, projectId, { headSha, files, failedJob, logExcerpt }) {
  const keywords = extractLogKeywords(logExcerpt);
  const fixes = [];
  const skipped = [];
  for (const filePath of files) {
    const before = await getFileContent(token, projectId, filePath, headSha);
    if (before === null) continue;

    if (!fileLooksRelevant(before, filePath, keywords)) {
      skipped.push({ file: filePath, reason: "Doesn't appear related to the failure above -- no fix generated for it." });
      continue;
    }

    const raw = await llm.complete(buildFixPrompt(filePath, before, failedJob, logExcerpt));
    const after = raw ? raw.replace(/\r\n/g, "\n") : raw;
    if (!after || after === before) continue;

    fixes.push({ file: filePath, before, after });
  }
  return { fixes, skipped };
}

async function applyFixes(token, projectId, { baseBranch, headSha, runUrl, fixes }) {
  const branch = `nexus/auto-fix-${Date.now()}`;
  await gitlabFetch(
    `/projects/${projectId}/repository/branches?branch=${encodeURIComponent(branch)}&ref=${encodeURIComponent(headSha)}`,
    token,
    { method: "POST" }
  );

  const changed = [];
  for (const { file, content } of fixes) {
    await gitlabFetch(`/projects/${projectId}/repository/files/${encodeURIComponent(file)}`, token, {
      method: "PUT",
      body: JSON.stringify({ branch, content, commit_message: `NEXUS: auto-fix ${file} for failing pipeline` }),
    });
    changed.push(file);
  }

  if (changed.length === 0) {
    throw new Error("No files were written -- nothing to open a merge request for.");
  }

  const description = [
    "Opened automatically by NEXUS.",
    "",
    "This changeset was classified **data-plane only** -- safe for the AI to auto-propose a fix without human escalation.",
    "",
    runUrl ? `Failing pipeline: ${runUrl}` : null,
    "",
    "Files changed in this proposal:",
    ...changed.map((f) => `- \`${f}\``),
    "",
    "Review before merging.",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const mr = await gitlabFetch(`/projects/${projectId}/merge_requests`, token, {
    method: "POST",
    body: JSON.stringify({
      source_branch: branch,
      target_branch: baseBranch,
      title: "NEXUS: auto-fix for failing pipeline",
      description,
    }),
  });

  return { prUrl: mr.web_url, filesChanged: changed };
}

module.exports = {
  GitlabError,
  connectWithToken,
  disconnectToken,
  getStatus,
  getConnectedToken,
  listProjects,
  checkPipeline,
  checkAllProjects,
  generateFixes,
  applyFixes,
};
