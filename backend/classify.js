const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const policyPath = path.join(__dirname, "policy", "policy.yaml");
const policy = yaml.load(fs.readFileSync(policyPath, "utf8"));

// Minimal glob -> RegExp converter, just enough for the patterns in policy.yaml
// ("**" = any depth, "*" = any chars within a segment).
function globToRegExp(glob) {
  let pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§DOUBLESTAR§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§DOUBLESTAR§§/g, ".*");

  return new RegExp("^" + pattern + "$");
}

function compileRules(section) {
  return (policy[section]?.patterns || []).map((p) => ({
    raw: p,
    regex: globToRegExp(p),
  }));
}

const controlPlaneRules = compileRules("control_plane");
const dataPlaneRules = compileRules("data_plane");

// A deterministic 0-1 severity score layered ON TOP of the binary
// data-plane/control-plane verdict -- it never changes what auto-merges
// (the verdict above is still the only thing that decides that), it just
// helps a human prioritize which escalated items to look at first. Kept
// as a plain keyword rubric, not a learned model, for the same reason the
// classifier itself is: an auditable "why" beats an opaque number.
function computeRiskScore(filePath, plane) {
  if (plane === "data-plane") return 0.15;

  const p = filePath.toLowerCase();
  if (/secret|credential|\.pem$|\.key$|token/.test(p)) return 1.0;
  if (/iam|\brole\b|permission|policy.*\.json$/.test(p)) return 1.0;
  if (/branch-protection|codeowners|deploy-approval|environments\/.*protection/.test(p)) return 0.95;
  if (/dockerfile/.test(p)) return 0.91;
  if (/\.github\/workflows\/|\.gitlab-ci\.yml$|\.workflow\.ya?ml$/.test(p)) return 0.79;
  return 0.7; // matched a control-plane pattern but none of the sharper signals above
}

function classifyFile(filePath) {
  const normalized = filePath.trim().replace(/^\.?\//, "");

  const controlMatch = controlPlaneRules.find((r) => r.regex.test(normalized) || r.regex.test("/" + normalized));
  if (controlMatch) {
    return {
      file: filePath,
      plane: "control-plane",
      matchedRule: controlMatch.raw,
      risk: computeRiskScore(normalized, "control-plane"),
    };
  }

  const dataMatch = dataPlaneRules.find((r) => r.regex.test(normalized) || r.regex.test("/" + normalized));
  if (dataMatch) {
    return {
      file: filePath,
      plane: "data-plane",
      matchedRule: dataMatch.raw,
      risk: computeRiskScore(normalized, "data-plane"),
    };
  }

  return {
    file: filePath,
    plane: "control-plane",
    matchedRule: null,
    defaulted: true,
    risk: computeRiskScore(normalized, "control-plane"),
  };
}

// Classify a whole changeset. Rule: "highest risk wins" — if ANY file is
// control-plane, the entire changeset escalates to a human. No partial
// auto-merge (see Curveball 1 reasoning in the review notes).
function classifyChangeset(filePaths) {
  const results = filePaths.map(classifyFile);
  const anyControlPlane = results.some((r) => r.plane === "control-plane");
  const risk = results.reduce((max, r) => Math.max(max, r.risk), 0);

  return {
    files: results,
    verdict: anyControlPlane ? "ESCALATE_TO_HUMAN" : "AUTO_MERGE_ELIGIBLE",
    risk,
    reasoning: anyControlPlane
      ? "At least one file in this changeset matches a control-plane pattern. The entire changeset is blocked and routed to a human reviewer, even if other files in the same diff are safe data-plane changes."
      : "All files in this changeset match data-plane patterns. NEXUS allows this fix to be auto-proposed (and, depending on team policy, auto-merged) without human escalation.",
  };
}

module.exports = { classifyFile, classifyChangeset, policy };
