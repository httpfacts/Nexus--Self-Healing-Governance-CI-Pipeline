// Real CI-run failure detection + LLM-proposed fix for the simple
// personal-token flow (mcpGithubClient.js's connection) -- no GitHub App
// installation required. Reuses automationClient's octokit-based helpers,
// just authenticated with the already-verified personal token instead of
// an installation token.
const { Octokit } = require("@octokit/rest");
const yaml = require("js-yaml");
const llm = require("./llmClient");
const automation = require("./automationClient");
const { classifyChangeset } = require("./classify");

function octokitForToken(token) {
  return new Octokit({ auth: token });
}

async function listRepos(token) {
  const octokit = octokitForToken(token);
  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: "updated",
    per_page: 60,
  });
  return data.map((r) => ({
    fullName: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
  }));
}

// Looks at the two most recent runs overall (not just failed ones) so a
// fix that actually worked shows up as "fixed" instead of the feed just
// silently repeating the same stale failure forever.
async function getRecentRuns(octokit, owner, repo) {
  const { data } = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, per_page: 2 });
  return data.workflow_runs;
}

async function getFailedJob(octokit, owner, repo, runId) {
  const { data } = await octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
  const job = data.jobs.find((j) => j.conclusion === "failure") || data.jobs[0] || null;
  if (!job) return null;
  const step = (job.steps || []).find((s) => s.conclusion === "failure");
  return { id: job.id, name: job.name, stepName: step ? step.name : null };
}

const LOG_LINE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z\s?/;

// GitHub's log-download endpoint returns the WHOLE job's combined log --
// every step, in order, including the "Post" cleanup steps (unsetting the
// git credential header, submodule checks, "Cleaning up orphan processes")
// that run AFTER the step that actually failed. Blindly taking the tail of
// that combined log grabs this cleanup noise instead of the real failure
// whenever anything runs after the failing step -- which is nearly always.
//
// A first attempt at fixing this sliced by the failing step's
// started_at/completed_at window, but that falls apart on a job that fails
// in ~1s: step boundaries can land within the same second (or completed_at
// can be missing), leaving no reliable window to slice on. Anchoring on
// GitHub's own "##[error]..." annotation instead -- the line the runner
// itself writes at the exact point a step fails -- doesn't depend on
// timing at all, so it holds up regardless of how fast the job ran.
async function getLogExcerpt(octokit, owner, repo, jobId) {
  try {
    const { data } = await octokit.actions.downloadJobLogsForWorkflowRun({
      owner,
      repo,
      job_id: jobId,
    });
    const text = typeof data === "string" ? data : String(data);
    const rawLines = text.split("\n");
    const stripTimestamp = (line) => line.replace(LOG_LINE_TIMESTAMP, "");

    const errorLineIdx = rawLines.reduce((last, line, i) => (/##\[error\]/.test(line) ? i : last), -1);
    if (errorLineIdx >= 0) {
      const windowLines = rawLines
        .slice(Math.max(0, errorLineIdx - 7), errorLineIdx + 1)
        .map(stripTimestamp)
        .filter((l) => l.trim().length > 0);
      // Kept short on purpose -- this is meant to read like "why it failed"
      // at a glance, not a full log dump.
      if (windowLines.length > 0) return windowLines.slice(-8).join("\n");
    }

    // No "##[error]" marker found (older log format, or the step failed
    // without one) -- fall back to the whole job log's tail rather than
    // returning nothing.
    return rawLines
      .map(stripTimestamp)
      .filter((l) => l.trim().length > 0)
      .slice(-8)
      .join("\n");
  } catch {
    return null;
  }
}

// Checks the most recently updated repos for a failed run, instead of
// making the human pick one repo first -- surfaces whatever is actually
// broken across the account as a feed, sorted newest-first.
async function checkAllRepos(token, limit = 8) {
  const repos = await listRepos(token);
  const targets = repos.slice(0, limit);

  const results = await Promise.all(
    targets.map(async (r) => {
      const [owner, name] = r.fullName.split("/");
      try {
        const result = await checkPipeline(token, owner, name);
        if (result.hasFailure || result.recentlyFixed) return { repo: r.fullName, ...result };
        return null;
      } catch {
        return null; // one repo failing to check (no Actions access, etc.) shouldn't sink the feed
      }
    })
  );

  return results
    .filter(Boolean)
    .sort((a, b) => {
      const aDate = a.hasFailure ? a.run.createdAt : a.fixedRun.createdAt;
      const bDate = b.hasFailure ? b.run.createdAt : b.fixedRun.createdAt;
      return new Date(bDate) - new Date(aDate);
    });
}

async function checkPipeline(token, owner, repo) {
  const octokit = octokitForToken(token);

  const [runs, repoInfo] = await Promise.all([
    getRecentRuns(octokit, owner, repo),
    octokit.repos.get({ owner, repo }).then((r) => r.data),
  ]);

  const latest = runs[0] || null;
  const previous = runs[1] || null;

  if (!latest) {
    return { hasFailure: false, defaultBranch: repoInfo.default_branch };
  }

  if (latest.conclusion !== "failure") {
    // Latest run passed -- if the one before it had failed, this is a fix
    // landing, not just "nothing to report".
    if (previous && previous.conclusion === "failure") {
      return {
        hasFailure: false,
        recentlyFixed: true,
        defaultBranch: repoInfo.default_branch,
        fixedRun: { id: latest.id, url: latest.html_url, createdAt: latest.created_at, headBranch: latest.head_branch },
        previousFailureUrl: previous.html_url,
      };
    }
    return { hasFailure: false, defaultBranch: repoInfo.default_branch };
  }

  const run = latest;
  const failedJob = await getFailedJob(octokit, owner, repo, run.id);
  const logExcerpt = failedJob ? await getLogExcerpt(octokit, owner, repo, failedJob.id) : null;
  const files = await automation.getCommitFiles(octokit, owner, repo, run.head_sha);
  const classification = classifyChangeset(files);
  // Computed up front (not just after a fix is applied) so it's visible on
  // every feed card, including control-plane ones that never get an
  // auto-PR -- the human reviewing it still needs to know whether a push
  // will re-trigger this workflow or whether it needs a manual dispatch.
  const triggerInfo = await getTriggerInfo(octokit, owner, repo, run.path, repoInfo.default_branch);

  return {
    hasFailure: true,
    defaultBranch: repoInfo.default_branch,
    run: {
      id: run.id,
      url: run.html_url,
      headSha: run.head_sha,
      headBranch: run.head_branch,
      name: run.name,
      createdAt: run.created_at,
      path: run.path, // e.g. ".github/workflows/ci.yml"
    },
    failedJob,
    logExcerpt,
    triggerInfo,
    ...classification, // files, verdict, reasoning, risk
  };
}

function buildFixPrompt(filePath, currentContent, failedJob, logExcerpt) {
  return `A CI run failed. Failing job: "${failedJob?.name || "unknown"}"${
    failedJob?.stepName ? `, step "${failedJob.stepName}"` : ""
  }.

Relevant log output:
---
${logExcerpt || "(no log available)"}
---

Here is the current content of ${filePath}, a data-plane file NEXUS has
already cleared as safe to auto-fix (no workflow config, secrets, or approval
gates -- just application/test code):

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
markdown code fences, and no commentary -- just the raw file content a
patch tool could write straight to disk.`;
}

// After a fix is pushed, the workflow's own `on:` triggers decide whether
// CI re-runs on its own. `push`/`pull_request` (or `_target`) mean the run
// NEXUS just triggered by opening the PR is enough; a workflow that
// ONLY has `workflow_dispatch` needs a human to start it from the Actions
// tab -- best-effort, since a workflow file can be missing, unreadable, or
// use YAML anchors/expressions this simple parse won't fully resolve.
async function getTriggerInfo(octokit, owner, repo, workflowPath, ref) {
  if (!workflowPath) return null;
  try {
    const text = await automation.getFileContent(octokit, owner, repo, workflowPath, ref);
    if (!text) return null;

    const parsed = yaml.load(text);
    // YAML's bare `on:` key can come back as the boolean `true` under some
    // schemas/parsers -- js-yaml 4's default schema keeps it as the string
    // "on", but this covers both without guessing which ran.
    const rawOn = parsed?.on ?? parsed?.true ?? parsed?.[true];
    if (rawOn == null) return null;

    const triggers =
      typeof rawOn === "string"
        ? [rawOn]
        : Array.isArray(rawOn)
        ? rawOn
        : typeof rawOn === "object"
        ? Object.keys(rawOn)
        : [];

    const autoTriggers = ["push", "pull_request", "pull_request_target"];
    const willAutoRun = triggers.some((t) => autoTriggers.includes(t));
    const requiresManualDispatch = !willAutoRun && triggers.includes("workflow_dispatch");

    return {
      workflowPath,
      triggers,
      willAutoRun,
      requiresManualDispatch,
      actionsUrl: `https://github.com/${owner}/${repo}/actions`,
    };
  } catch {
    return null; // best-effort only -- never block the PR result on this
  }
}

// Pulls identifier-shaped tokens out of the failure log -- env var names
// (DOCKER_USERNAME), filenames (risk-tester.test.js), path segments -- used
// to judge whether a given file is even plausibly related to what failed,
// before spending an LLM call asking it to "fix" that file. Deliberately
// simple (no NLP): a log about a missing DOCKER_USERNAME variable should at
// least make files that literally don't mention it lower-priority.
function extractLogKeywords(logExcerpt) {
  if (!logExcerpt) return [];
  const matches = logExcerpt.match(/\b[A-Z][A-Z0-9_]{3,}\b|[\w.-]+\.\w{2,4}\b/g) || [];
  return [...new Set(matches)].slice(0, 20);
}

function fileLooksRelevant(content, filePath, keywords) {
  if (keywords.length === 0) return true; // no signal to filter on -- don't block anything
  const haystack = (filePath + "\n" + content).toLowerCase();
  return keywords.some((k) => haystack.includes(k.toLowerCase()));
}

// Every file in a failing changeset used to get the same treatment: ask the
// LLM to "fix" it against the same log excerpt, whether or not that file
// had anything to do with the failure (a workflow YAML sitting next to an
// unrelated test change, for instance). That wastes a call and can produce
// a confidently-wrong edit. Now: skip files the log doesn't mention at all
// (reported back as `skipped`, not silently dropped) and, if NONE of the
// changed files look relevant but a `workflowPath` was provided (the
// workflow that actually ran), try that too -- it's often the real answer
// for a "some CI variable/secret isn't set" style failure even when it
// wasn't part of this commit's diff.
async function generateFixes(token, owner, repo, { headSha, files, failedJob, logExcerpt, workflowPath }) {
  const octokit = octokitForToken(token);
  const keywords = extractLogKeywords(logExcerpt);

  const fixes = [];
  const skipped = [];
  let anyRelevant = false;

  for (const filePath of files) {
    const before = await automation.getFileContent(octokit, owner, repo, filePath, headSha);
    if (before === null) continue; // binary, deleted, or unreadable -- skip rather than guess

    if (!fileLooksRelevant(before, filePath, keywords)) {
      skipped.push({ file: filePath, reason: "Doesn't appear related to the failure above -- no fix generated for it." });
      continue;
    }
    anyRelevant = true;

    // \r\n vs \n is a transport artifact, never a real fix -- normalizing
    // it here keeps a model's line-ending quirks from making the diff look
    // like the whole file changed.
    const raw = await llm.complete(buildFixPrompt(filePath, before, failedJob, logExcerpt));
    const after = raw ? raw.replace(/\r\n/g, "\n") : raw;
    if (!after || after === before) continue;

    fixes.push({ file: filePath, before, after });
  }

  if (!anyRelevant && workflowPath && !files.includes(workflowPath)) {
    const before = await automation.getFileContent(octokit, owner, repo, workflowPath, headSha);
    if (before !== null && fileLooksRelevant(before, workflowPath, keywords)) {
      const raw = await llm.complete(buildFixPrompt(workflowPath, before, failedJob, logExcerpt));
      const after = raw ? raw.replace(/\r\n/g, "\n") : raw;
      if (after && after !== before) fixes.push({ file: workflowPath, before, after });
    }
  }

  return { fixes, skipped };
}

// humanApproved distinguishes the two paths that both end up here: the
// automatic data-plane path (no escalation needed) and the Review Queue's
// "Approve & open PR" action, where a human explicitly signed off on a
// control-plane change NEXUS would never auto-merge on its own. The
// PR body has to tell those two stories accurately -- claiming "data-plane
// only" on a human-approved control-plane fix would misrepresent exactly
// the distinction this whole product exists to enforce.
async function applyFixes(token, owner, repo, { baseBranch, headSha, runUrl, fixes, humanApproved = false }) {
  const octokit = octokitForToken(token);
  const branch = `nexus/auto-fix-${Date.now()}`;
  await automation.createBranch(octokit, owner, repo, branch, headSha);

  const changed = [];
  for (const { file, content } of fixes) {
    await automation.upsertFile(
      octokit,
      owner,
      repo,
      file,
      content,
      `NEXUS: auto-fix ${file} for failing CI run`,
      branch
    );
    changed.push(file);
  }

  if (changed.length === 0) {
    throw new Error("No files were written -- nothing to open a PR for.");
  }

  const body = [
    "Opened automatically by NEXUS.",
    "",
    humanApproved
      ? "This changeset touches a **control-plane** file. NEXUS does not auto-merge these -- it only opened this PR because a human explicitly approved it from the Review Queue."
      : "This changeset was classified **data-plane only** -- safe for the AI to auto-propose a fix without human escalation.",
    "",
    runUrl ? `Failing run: ${runUrl}` : null,
    "",
    "Files changed in this proposal:",
    ...changed.map((f) => `- \`${f}\``),
    "",
    "This is a draft PR. Review before merging.",
  ]
    .filter((l) => l !== null)
    .join("\n");

  const prUrl = await automation.openPullRequest(octokit, owner, repo, {
    title: humanApproved ? "NEXUS: human-approved fix for control-plane file" : "NEXUS: auto-fix for failing CI run",
    head: branch,
    base: baseBranch,
    body,
  });

  return { prUrl, filesChanged: changed };
}

module.exports = { listRepos, checkAllRepos, checkPipeline, generateFixes, applyFixes };
