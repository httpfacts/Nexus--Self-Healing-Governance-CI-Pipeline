// Stage 5 — the gap no competitor tool closes. Called only for changesets
// with at least one control-plane file. No code is touched, no LLM is
// called -- this path exists specifically so nothing autonomous happens to
// workflow config, secrets, or approval gates. It opens an Issue and stops.
const automation = require("./automationClient");

async function escalate({ octokit, owner, repo, controlPlaneFiles, runUrl, reasoning }) {
  const body = [
    "Opened automatically by NEXUS.",
    "",
    "This changeset was **blocked from auto-fix** because it touches at least one control-plane file " +
      "-- something that affects who's allowed to do what, not just how the app runs. NEXUS never " +
      "auto-merges these; a human has to look at it.",
    "",
    `Failing run: ${runUrl}`,
    "",
    "Control-plane files in this changeset:",
    ...controlPlaneFiles.map((f) => `- \`${f.file}\`${f.matchedRule ? ` (matched \`${f.matchedRule}\`)` : " (no rule matched -- defaulted to control-plane)"}`),
    "",
    reasoning,
  ].join("\n");

  const issueUrl = await automation.openIssue(octokit, owner, repo, {
    title: "NEXUS: control-plane change blocked from auto-fix",
    body,
    labels: ["nexus", "needs-human-review"],
  });

  return { issueUrl };
}

module.exports = { escalate };
