// Stage 4 — the "self-healing" half. Only ever called for changesets the
// Stage 1 classifier already marked data-plane-only. Reads each failing
// file's current content, asks the LLM for a corrected version, pushes it
// to a new branch, and opens a draft PR. Zero human input on the happy
// path -- that's the point of this stage.
//
// Uses the shared LLM client (llmClient.js) -- Gemini via GEMINI_API_KEY by
// default. Without a configured provider this throws LLM_NOT_CONFIGURED,
// which callers mark as "fix skipped" rather than a failure.
const llm = require("./llmClient");
const automation = require("./automationClient");

function buildPrompt(filePath, currentContent, jobSummary) {
  const failureText = jobSummary
    .map((j) => `Job "${j.name}" (${j.conclusion}):\n${j.steps.map((s) => "  - " + s).join("\n") || "  (no failed steps reported)"}`)
    .join("\n\n");

  return `A CI run failed. Here is what failed:

${failureText}

Here is the current content of ${filePath}, a data-plane file NEXUS has
already cleared as safe to auto-fix (no workflow config, secrets, or approval
gates -- just application/test code):

---
${currentContent}
---

Return ONLY the full corrected content of this file, with no explanation, no
markdown code fences, and no commentary -- just the raw file content a
patch tool could write straight to disk.`;
}

async function proposeFix({ octokit, owner, repo, baseBranch, headSha, files, jobSummary, runUrl }) {
  // Checked before createBranch so an unconfigured server doesn't leave an
  // empty branch behind on the repo.
  if (!llm.isConfigured()) {
    const err = new Error("GEMINI_API_KEY is not set -- Stage 4 (fix proposal) is unavailable.");
    err.code = "LLM_NOT_CONFIGURED";
    throw err;
  }

  const branch = `nexus/auto-fix-${Date.now()}`;
  await automation.createBranch(octokit, owner, repo, branch, headSha);

  const changed = [];
  for (const filePath of files) {
    const currentContent = await automation.getFileContent(octokit, owner, repo, filePath, headSha);
    if (currentContent === null) continue; // binary, deleted, or unreadable -- skip rather than guess

    let proposed = await llm.complete(buildPrompt(filePath, currentContent, jobSummary));
    // llm.complete() trims its output; keep the file's original trailing
    // newline so the commit doesn't show a spurious end-of-file change.
    if (proposed && currentContent.endsWith("\n") && !proposed.endsWith("\n")) proposed += "\n";
    if (!proposed || proposed === currentContent) continue;

    await automation.upsertFile(
      octokit,
      owner,
      repo,
      filePath,
      proposed,
      `NEXUS: auto-fix ${filePath} for failing CI run`,
      branch
    );
    changed.push(filePath);
  }

  if (changed.length === 0) {
    throw new Error("LLM did not produce a usable fix for any data-plane file in this changeset.");
  }

  const body = [
    "Opened automatically by NEXUS.",
    "",
    `This changeset was classified **data-plane only** -- safe for the AI to auto-propose a fix without human escalation.`,
    "",
    `Failing run: ${runUrl}`,
    "",
    "Files changed in this proposal:",
    ...changed.map((f) => `- \`${f}\``),
    "",
    "This is a draft PR. Review before merging.",
  ].join("\n");

  const prUrl = await automation.openPullRequest(octokit, owner, repo, {
    title: "NEXUS: auto-fix for failing CI run",
    head: branch,
    base: baseBranch,
    body,
  });

  return { prUrl, filesChanged: changed };
}

module.exports = { proposeFix };
