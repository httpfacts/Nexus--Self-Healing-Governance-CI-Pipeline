#!/usr/bin/env node
// Stage 1 — the classifier, standalone. No server, no GitHub, no UI.
// Takes a list of changed file paths (from args, stdin, or a git diff) and
// prints a data-plane / control-plane / mixed verdict. This is the one
// piece the project's novelty rests on, so it has to work in isolation,
// testable against any git diff before anything else touches it.
//
// Usage:
//   node cli.js file1.py file2.yml               classify explicit paths
//   git diff --name-only | node cli.js            classify unstaged changes (piped)
//   node cli.js --diff                             classify unstaged changes (working tree vs HEAD)
//   node cli.js --staged                           classify staged changes
//   node cli.js --range main..HEAD                 classify changes between two refs
//
// Exit code: 0 if AUTO_MERGE_ELIGIBLE, 1 if ESCALATE_TO_HUMAN -- usable
// directly as a CI gate step.
const { execFileSync } = require("child_process");
const { classifyChangeset } = require("./classify");

function filesFromGit(args) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", ...args], { encoding: "utf8" });
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.error(`git diff failed: ${err.message}`);
    process.exit(2);
  }
}

function readStdin() {
  try {
    const fs = require("fs");
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function resolveFiles() {
  const args = process.argv.slice(2);

  if (args[0] === "--diff") return filesFromGit([]);
  if (args[0] === "--staged") return filesFromGit(["--staged"]);
  if (args[0] === "--range" && args[1]) return filesFromGit([args[1]]);

  if (args.length > 0) return args;

  if (!process.stdin.isTTY) {
    const piped = readStdin();
    return piped.split("\n").map((l) => l.trim()).filter(Boolean);
  }

  return [];
}

function main() {
  const files = resolveFiles();

  if (files.length === 0) {
    console.error("No files to classify.");
    console.error("Usage: node cli.js <file1> <file2> ...");
    console.error("       git diff --name-only | node cli.js");
    console.error("       node cli.js --diff | --staged | --range <base>..<head>");
    process.exit(2);
  }

  const result = classifyChangeset(files);

  console.log(`NEXUS classifier -- ${files.length} file(s)\n`);
  for (const f of result.files) {
    const tag = f.plane === "data-plane" ? "data-plane " : "control-plane";
    const rule = f.matchedRule ? `matched: ${f.matchedRule}` : "no rule matched -- defaulted to control-plane";
    console.log(`  [${tag}]  ${f.file}`);
    console.log(`              ${rule}`);
  }

  console.log(`\nVerdict: ${result.verdict}`);
  console.log(result.reasoning);

  process.exit(result.verdict === "AUTO_MERGE_ELIGIBLE" ? 0 : 1);
}

main();
