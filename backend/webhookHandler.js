// Stage 3 -- wires Stage 1's classifier to Stage 2's incoming events, and
// (once verdicts come back) into Stage 4/5's automated response. This is
// the first place a REAL CI failure on a connected repo turns into a
// stored, classified event -- not a test diff typed into a form.
const { classifyChangeset } = require("./classify");
const { octokitForInstallation } = require("./githubApp");
const automation = require("./automationClient");
const eventStore = require("./eventStore");
const { proposeFix } = require("./fixProposal");
const { escalate } = require("./escalate");

async function handleWorkflowRunEvent(payload) {
  const { workflow_run: run, repository, installation } = payload;
  if (!installation) return { skipped: "no installation on payload" };
  if (run.status !== "completed" || run.conclusion !== "failure") {
    return { skipped: `not a completed failure (status=${run.status}, conclusion=${run.conclusion})` };
  }

  const owner = repository.owner.login;
  const repo = repository.name;
  const octokit = await octokitForInstallation(installation.id);

  const pr = (run.pull_requests || [])[0];
  const files = pr
    ? await automation.getPullRequestFiles(octokit, owner, repo, pr.number)
    : await automation.getCommitFiles(octokit, owner, repo, run.head_sha);

  if (files.length === 0) {
    return { skipped: "no changed files found for this run" };
  }

  const classification = classifyChangeset(files);
  const event = eventStore.addEvent({
    repo: `${owner}/${repo}`,
    runId: run.id,
    runUrl: run.html_url,
    headSha: run.head_sha,
    baseBranch: pr ? pr.base.ref : run.head_branch,
    files: classification.files,
    verdict: classification.verdict,
    reasoning: classification.reasoning,
    status: "classified",
  });

  if (classification.verdict === "AUTO_MERGE_ELIGIBLE") {
    // Stage 4: data-plane only -- safe to attempt an automated fix.
    try {
      const jobSummary = await automation.getJobSummary(octokit, owner, repo, run.id);
      const dataPlaneFiles = classification.files.filter((f) => f.plane === "data-plane").map((f) => f.file);
      const { prUrl } = await proposeFix({
        octokit,
        owner,
        repo,
        baseBranch: event.baseBranch,
        headSha: run.head_sha,
        files: dataPlaneFiles,
        jobSummary,
        runUrl: run.html_url,
      });
      eventStore.updateEvent(event.id, { status: "fix_proposed", prUrl });
    } catch (err) {
      eventStore.updateEvent(event.id, {
        status: err.code === "LLM_NOT_CONFIGURED" ? "fix_skipped_no_llm_key" : "fix_failed",
        error: err.message,
      });
    }
  } else {
    // Stage 5: at least one control-plane file -- never auto-fix, always escalate.
    try {
      const controlPlaneFiles = classification.files.filter((f) => f.plane === "control-plane");
      const { issueUrl } = await escalate({
        octokit,
        owner,
        repo,
        controlPlaneFiles,
        runUrl: run.html_url,
        reasoning: classification.reasoning,
      });
      eventStore.updateEvent(event.id, { status: "escalated", issueUrl });
    } catch (err) {
      eventStore.updateEvent(event.id, { status: "escalate_failed", error: err.message });
    }
  }

  return { eventId: event.id };
}

async function handleWebhookEvent(eventName, payload) {
  if (eventName === "workflow_run") return handleWorkflowRunEvent(payload);
  return { skipped: `unhandled event type: ${eventName}` };
}

module.exports = { handleWebhookEvent };
