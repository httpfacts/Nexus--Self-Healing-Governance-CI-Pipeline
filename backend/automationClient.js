// Stage 4/5's GitHub access layer. Deliberately separate from
// mcpGithubClient.js: that client is a shared singleton driven by whichever
// human is signed into the interactive tool page. This one is called from
// the webhook handler on the GitHub App's own installation token, per
// event, and must never share state with a logged-in user's session.
async function getPullRequestFiles(octokit, owner, repo, pullNumber) {
  const { data } = await octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 });
  return data.map((f) => f.filename);
}

async function getCommitFiles(octokit, owner, repo, sha) {
  const { data } = await octokit.repos.getCommit({ owner, repo, ref: sha });
  return (data.files || []).map((f) => f.filename);
}

async function getFileContent(octokit, owner, repo, filePath, ref) {
  const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref });
  if (Array.isArray(data) || !data.content) return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function getJobSummary(octokit, owner, repo, runId) {
  const { data } = await octokit.actions.listJobsForWorkflowRun({ owner, repo, run_id: runId });
  return data.jobs.map((job) => ({
    name: job.name,
    conclusion: job.conclusion,
    steps: (job.steps || [])
      .filter((s) => s.conclusion && s.conclusion !== "success")
      .map((s) => `${s.name}: ${s.conclusion}`),
  }));
}

async function createBranch(octokit, owner, repo, newBranch, fromSha) {
  await octokit.git.createRef({ owner, repo, ref: `refs/heads/${newBranch}`, sha: fromSha });
}

async function upsertFile(octokit, owner, repo, filePath, content, message, branch) {
  let sha;
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath, ref: branch });
    if (!Array.isArray(data)) sha = data.sha;
  } catch {
    // File doesn't exist on this branch yet -- fine, this is a create.
  }
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
    sha,
  });
}

async function openPullRequest(octokit, owner, repo, { title, head, base, body }) {
  const { data } = await octokit.pulls.create({ owner, repo, title, head, base, body, draft: true });
  return data.html_url;
}

async function openIssue(octokit, owner, repo, { title, body, labels }) {
  const { data } = await octokit.issues.create({ owner, repo, title, body, labels });
  return data.html_url;
}

module.exports = {
  getPullRequestFiles,
  getCommitFiles,
  getFileContent,
  getJobSummary,
  createBranch,
  upsertFile,
  openPullRequest,
  openIssue,
};
