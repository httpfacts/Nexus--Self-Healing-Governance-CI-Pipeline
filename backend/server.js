require("dotenv").config();
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const session = require("express-session");
const yaml = require("js-yaml");
const papers = require("./data/papers.json");
const { classifyChangeset, policy } = require("./classify");
const {
  scanCiCdFiles,
  GithubMcpError,
  connectWithToken,
  disconnectToken,
  getStatus,
  getConnectedToken,
} = require("./mcpGithubClient");
const githubApp = require("./githubApp");
const eventStore = require("./eventStore");
const { handleWebhookEvent } = require("./webhookHandler");
const pipelineCheck = require("./pipelineCheck");
const gitlab = require("./gitlabClient");
const llm = require("./llmClient");

const app = express();
const PORT = process.env.PORT || 4000;

// `origin: true` (reflect whatever Origin the request sends) is a real
// exposure here specifically: the personal-token connection below is a
// single, in-memory, process-wide value (not per-session), so combined
// with `credentials: true`, any page open in the same browser could
// otherwise call this API cross-origin and use it -- read pipeline data,
// or worse, open real PRs -- on the strength of the CORS reflection alone.
// Locking origin down to the actual frontend closes that off.
app.use(cors({ origin: process.env.FRONTEND_URL || "http://localhost:3000", credentials: true }));
// Captures the raw request bytes alongside the parsed body -- the webhook
// route needs the raw bytes to verify GitHub's HMAC signature.
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "nexus-dev-secret-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: "lax" },
  })
);

app.get("/api/overview", (req, res) => {
  res.json({
    pitch:
      "Self-healing CI/CD already works — LogSage, RepairAgent, Repairnator all read a failure log and propose a fix. Nobody argues about whether AI can fix a broken pipeline anymore. The open question, per a 2026 survey by Barnes et al., is how much control you hand the AI — because right now, every one of these tools can touch anything: a Dockerfile, a test file, but also a workflow YAML, a secret, an IAM policy. NEXUS adds the one thing that's missing: a hard boundary that decides, before any fix happens, whether the AI is allowed to auto-merge it or has to stop and ask a human.",
    gap: {
      title: "Data-plane vs. control-plane",
      dataPlane:
        "Application code, test files, Dockerfiles, config values — things that affect how the app runs. Safe to auto-propose.",
      controlPlane:
        "Pipeline workflow YAML, deployment policy, secrets, branch protection, approval gates — things that affect who's allowed to do what. Always blocked and escalated to a human.",
    },
  });
});

app.get("/api/papers", (req, res) => {
  res.json(papers);
});

app.get("/api/policy", (req, res) => {
  res.json(policy);
});

app.get("/api/faq", (req, res) => {
  res.json([
    {
      q: "Isn't this just LogSage with extra steps?",
      a: "LogSage and RepairAgent both stop at 'here's a proposed fix' — they treat every file the same. NEXUS adds a step before that fix can become a pull request: classify it as data-plane or control-plane, and if it's control-plane, block it and route it to a human issue instead. The fix-generation isn't the contribution — the boundary is.",
    },
    {
      q: "How do you know this gap is real and not something you assumed?",
      a: "Barnes et al. (2026) name it directly as 'authority transfer' and state no benchmark exists for it. It's also independently visible in the tools themselves — none of LogSage, RepairAgent, Repairnator, or AutoGuard have this classification step.",
    },
    {
      q: "Why does this gap matter in practice?",
      a: "A deployment job blocked by a required-reviewer rule could get 'fixed' by an AI editing the workflow YAML to remove that rule — making the pipeline pass by deleting a human approval gate. NEXUS blocks control-plane edits like this and escalates them instead.",
    },
    {
      q: "What's your evaluation metric?",
      a: "Classification accuracy against a hand-labeled set of historical CI fixes, split into false negatives (control-plane changes wrongly auto-merged — the dangerous error) and false positives (safe changes needlessly escalated — the overhead cost), compared against a no-boundary baseline.",
    },
  ]);
});

// The live two-tier demo: the frontend sends file paths, the backend
// applies policy.yaml and returns a real classification decision.
app.post("/api/classify", (req, res) => {
  const { files } = req.body;
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "Provide a non-empty array of file paths under `files`." });
  }
  const result = classifyChangeset(files);
  res.json(result);
});

// Token lives in memory only (see mcpGithubClient.js) -- never written to
// disk, never echoed back. Verified against GitHub before it's accepted.
app.get("/api/github/status", (req, res) => {
  res.json(getStatus());
});

app.post("/api/github/connect", async (req, res) => {
  const { token } = req.body;
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "Provide a GitHub personal access token." });
  }
  try {
    const result = await connectWithToken(token.trim());
    res.json(result);
  } catch (err) {
    const status = err instanceof GithubMcpError ? err.status : 502;
    res.status(status).json({ error: err.message || "Couldn't connect with that token." });
  }
});

app.post("/api/github/disconnect", async (req, res) => {
  await disconnectToken();
  res.json({ connected: false });
});

// Connects to a real GitHub MCP server (see mcpGithubClient.js), checks the
// known CI/CD config locations (.github/workflows, .gitlab-ci.yml,
// Jenkinsfile, .circleci, etc.) -- nothing else in the repo -- then runs
// the same classifyChangeset() used by /api/classify against what it found.
app.post("/api/github/scan", async (req, res) => {
  const { repo } = req.body;
  const match = typeof repo === "string" && repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!match) {
    return res.status(400).json({ error: "Provide a repo as `owner/name`, e.g. `expressjs/express`." });
  }
  const [, owner, name] = match;

  try {
    const { files, ciDetected } = await scanCiCdFiles(owner, name);
    const classification = classifyChangeset(files);
    res.json({
      repo: `${owner}/${name}`,
      fileCount: files.length,
      ciDetected,
      ...classification,
    });
  } catch (err) {
    const status = err instanceof GithubMcpError ? err.status : 502;
    res.status(status).json({ error: err.message || "Failed to scan the repository." });
  }
});

function parseRepo(repo) {
  const match = typeof repo === "string" && repo.trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return match ? { owner: match[1], name: match[2] } : null;
}

function requireGithubToken(req, res, next) {
  const token = getConnectedToken();
  if (!token) return res.status(401).json({ error: "Connect GitHub first." });
  req.githubToken = token;
  next();
}

// Lets the tool page offer a repo picker instead of a free-text owner/repo
// field -- lists repos the connected token can see.
app.get("/api/github/repos", requireGithubToken, async (req, res) => {
  try {
    const repos = await pipelineCheck.listRepos(req.githubToken);
    res.json({ repos });
  } catch (err) {
    res.status(502).json({ error: err.message || "Couldn't list repositories." });
  }
});

// Finds the most recent failed Actions run in the repo, the job/step that
// failed, a tail of its log, and classifies the files that changed in the
// failing commit -- data-plane vs control-plane, same policy.yaml rule as
// everywhere else.
app.post("/api/github/pipeline-check", requireGithubToken, async (req, res) => {
  const parsed = parseRepo(req.body.repo);
  if (!parsed) {
    return res.status(400).json({ error: "Provide a repo as `owner/name`." });
  }
  try {
    const result = await pipelineCheck.checkPipeline(req.githubToken, parsed.owner, parsed.name);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to check the pipeline." });
  }
});

// ---------- GitLab (second provider, same memory-only token pattern) ----------

app.get("/api/gitlab/status", (req, res) => {
  res.json(gitlab.getStatus());
});

app.post("/api/gitlab/connect", async (req, res) => {
  const { token } = req.body;
  if (typeof token !== "string" || !token.trim()) {
    return res.status(400).json({ error: "Provide a GitLab personal access token." });
  }
  try {
    const result = await gitlab.connectWithToken(token.trim());
    res.json(result);
  } catch (err) {
    const status = err instanceof gitlab.GitlabError ? err.status : 502;
    res.status(status).json({ error: err.message || "Couldn't connect with that token." });
  }
});

app.post("/api/gitlab/disconnect", (req, res) => {
  gitlab.disconnectToken();
  res.json({ connected: false });
});

// ---------- Optional bring-your-own AI key ----------
// Production default is the server-configured Gemini key (GEMINI_API_KEY) --
// no per-user setup needed. Connecting a personal key here (Gemini,
// Anthropic, OpenAI, or Grok) overrides it for every "Generate fix" /
// "Suggest a fix" call for the rest of this server session. Same
// memory-only pattern as the GitHub/GitLab tokens above: verified on
// connect, never written to disk, cleared on disconnect (falls straight
// back to GEMINI_API_KEY).

app.get("/api/ai/status", (req, res) => {
  res.json(llm.getUserKeyStatus());
});

app.post("/api/ai/connect", async (req, res) => {
  const { provider, apiKey } = req.body;
  try {
    const result = await llm.setUserKey(provider, apiKey);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: err.message || "Couldn't connect with that key." });
  }
});

app.post("/api/ai/disconnect", (req, res) => {
  llm.clearUserKey();
  res.json({ connected: false });
});

// ---------- Unified pipeline feed (GitHub + GitLab, whichever is connected) ----------

// Checks the most recently updated repos/projects on every connected
// provider for a failed run so the human never has to pick one first -- a
// feed of whatever's actually broken across the account(s).
app.get("/api/pipeline/feed", async (req, res) => {
  const githubToken = getConnectedToken();
  const gitlabToken = gitlab.getConnectedToken();
  if (!githubToken && !gitlabToken) {
    return res.status(401).json({ error: "Connect GitHub or GitLab first." });
  }

  const [githubFeed, gitlabFeed] = await Promise.all([
    githubToken
      ? pipelineCheck.checkAllRepos(githubToken).then((f) => f.map((e) => ({ provider: "github", ...e })))
      : Promise.resolve([]),
    gitlabToken ? gitlab.checkAllProjects(gitlabToken) : Promise.resolve([]),
  ]);

  const entryDate = (e) => new Date(e.hasFailure ? e.run.createdAt : e.fixedRun.createdAt);
  const feed = [...githubFeed, ...gitlabFeed].sort((a, b) => entryDate(b) - entryDate(a));
  res.json({ feed });
});

function providerClient(provider) {
  if (provider === "gitlab") return { client: gitlab, token: gitlab.getConnectedToken() };
  return { client: pipelineCheck, token: getConnectedToken() };
}

// Called for both auto-mergeable (data-plane) AND escalated (control-plane)
// changesets -- data-plane fixes go straight to "Open PR", control-plane
// ones land in the Review Queue for a human to approve or reject. Proposes
// fixes with the LLM and returns them for review -- does not write to the
// repo. Dispatches to whichever provider the feed entry came from (GitHub
// owner/repo pair, or GitLab's URL-encoded project path). Logs a
// classified/pending-review event so the Audit Log has real history even
// outside the webhook path.
app.post("/api/pipeline/generate-fix", async (req, res) => {
  const { provider, repo, headSha, files, failedJob, logExcerpt, verdict, risk, workflowPath } = req.body;
  const { client, token } = providerClient(provider);
  if (!token) return res.status(401).json({ error: `Connect ${provider === "gitlab" ? "GitLab" : "GitHub"} first.` });
  if (!headSha || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: "Provide `headSha` and a non-empty `files` array." });
  }

  try {
    const { fixes, skipped } =
      provider === "gitlab"
        ? await client.generateFixes(token, encodeURIComponent(repo), { headSha, files, failedJob, logExcerpt })
        : await (() => {
            const parsed = parseRepo(repo);
            if (!parsed) throw new Error("Provide a repo as `owner/name`.");
            return client.generateFixes(token, parsed.owner, parsed.name, { headSha, files, failedJob, logExcerpt, workflowPath });
          })();

    if (fixes.length === 0) {
      // Two different reasons land here, and they need different messages:
      // every file got skipped as unrelated to the failure (a targeting
      // problem, not a model quality one -- suggesting a better key won't
      // help), vs. the model ran against relevant files and still came up
      // empty (where it might).
      if (skipped.length === files.length) {
        return res.status(502).json({
          error:
            "None of the changed files in this changeset appear related to the failure in the log above -- the actual cause looks like it's somewhere else in the repo. No fix could be generated.",
          skipped,
        });
      }
      return res.status(502).json({
        error:
          "The AI model didn't produce a usable fix for any of these files -- the failure may not actually be in these files (see the log excerpt), or the change needed is more than a same-file edit.",
        skipped,
      });
    }

    const isEscalated = verdict === "ESCALATE_TO_HUMAN";
    // A real one-line description of what changed, not a fabricated AI
    // summary -- the LLM only returns raw file content, it was never asked
    // for a title, so this is built from the actual fixed files instead.
    const summary =
      fixes.length === 1
        ? `Suggested fix for ${fixes[0].file.split("/").pop()}`
        : `Suggested fixes for ${fixes.length} files (${fixes.map((f) => f.file.split("/").pop()).join(", ")})`;
    const event = eventStore.addEvent({
      repo,
      provider,
      verdict: verdict || null,
      risk: typeof risk === "number" ? risk : null,
      status: isEscalated ? "pending_review" : "fix_proposed",
      summary,
      files: files.map((f) => ({ file: f })),
    });

    res.json({ fixes, skipped, eventId: event.id });
  } catch (err) {
    const status = err.code === "LLM_NOT_CONFIGURED" ? 503 : 502;
    res.status(status).json({ error: err.message || "Failed to generate a fix." });
  }
});

// The one write path here: pushes the reviewed fixes to a new branch and
// opens a draft PR (GitHub) or merge request (GitLab). Reached either
// automatically (data-plane, humanApproved=false) or from the Review
// Queue's "Approve & open PR" action on a control-plane fix
// (humanApproved=true) -- either way, only after a human has seen the
// before/after diff.
app.post("/api/pipeline/apply-fix", async (req, res) => {
  const { provider, repo, baseBranch, headSha, runUrl, fixes, humanApproved, eventId } = req.body;
  const { client, token } = providerClient(provider);
  if (!token) return res.status(401).json({ error: `Connect ${provider === "gitlab" ? "GitLab" : "GitHub"} first.` });
  if (!baseBranch || !headSha || !Array.isArray(fixes) || fixes.length === 0) {
    return res.status(400).json({ error: "Provide `baseBranch`, `headSha`, and a non-empty `fixes` array." });
  }

  try {
    const result =
      provider === "gitlab"
        ? await client.applyFixes(token, encodeURIComponent(repo), { baseBranch, headSha, runUrl, fixes, humanApproved })
        : await (() => {
            const parsed = parseRepo(repo);
            if (!parsed) throw new Error("Provide a repo as `owner/name`.");
            return client.applyFixes(token, parsed.owner, parsed.name, { baseBranch, headSha, runUrl, fixes, humanApproved });
          })();

    if (eventId) {
      eventStore.updateEvent(eventId, { status: humanApproved ? "approved" : "auto_pr", prUrl: result.prUrl });
    }

    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message || "Failed to open the pull/merge request." });
  }
});

// Review Queue's "Reject" action -- no repo write, just records that a
// human looked at this control-plane suggestion and declined it, so it
// shows up in the Audit Log instead of silently vanishing.
app.post("/api/pipeline/reject-fix", (req, res) => {
  const { eventId } = req.body;
  if (!eventId) return res.status(400).json({ error: "Provide `eventId`." });
  const updated = eventStore.updateEvent(eventId, { status: "rejected" });
  if (!updated) return res.status(404).json({ error: "No matching event to reject." });
  res.json(updated);
});

// ---------- Login (GitHub OAuth gates the dashboard) ----------

app.get("/auth/github/login", (req, res) => {
  if (!githubApp.isConfigured()) {
    return res.status(503).send("GitHub App is not configured yet -- see README \"Setting up the GitHub App\".");
  }
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  res.redirect(githubApp.getLoginUrl(state));
});

app.get("/auth/github/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid or expired login attempt. Go back and try again.");
  }
  try {
    const user = await githubApp.exchangeCodeForUser(code);
    req.session.user = user;
    res.redirect((process.env.FRONTEND_URL || "http://localhost:3000") + "/dashboard");
  } catch (err) {
    res.status(502).send(`Login failed: ${err.message}`);
  }
});

app.get("/api/session", (req, res) => {
  res.json({ user: req.session.user || null, githubAppConfigured: githubApp.isConfigured() });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// Accepts either real GitHub App OAuth login (Stage 2, not set up yet) or
// the simpler personal-token connection already used by /tool -- whichever
// is available. Lets the dashboard content render from the tool page today
// without waiting on the GitHub App registration.
function requireConnection(req, res, next) {
  if (req.session.user || getStatus().connected) return next();
  return res.status(401).json({ error: "Connect GitHub first (either sign in, or connect a token on /tool)." });
}

// ---------- Dashboard data (Stage 6) ----------
// Real events flow in here the moment Stage 2/3's webhook is live; the
// dashboard itself renders placeholder rows until then (see frontend).

app.get("/api/events", requireConnection, (req, res) => {
  res.json(eventStore.listEvents());
});

app.get("/api/policy/raw", requireConnection, (req, res) => {
  res.type("text/yaml").send(fs.readFileSync(path.join(__dirname, "policy", "policy.yaml"), "utf8"));
});

app.put("/api/policy/raw", requireConnection, express.text({ type: "*/*" }), (req, res) => {
  try {
    yaml.load(req.body); // throws on invalid YAML -- validate before writing
  } catch (err) {
    return res.status(400).json({ error: `Invalid YAML: ${err.message}` });
  }
  fs.writeFileSync(path.join(__dirname, "policy", "policy.yaml"), req.body);
  res.json({ ok: true, note: "Restart the backend to pick up the change (policy is loaded once at startup)." });
});

// ---------- Webhook receiver (Stage 2/3) ----------
// GitHub POSTs here on every event the App is subscribed to. Needs
// GITHUB_WEBHOOK_SECRET set and a publicly reachable URL registered on the
// App (ngrok/smee in local dev) -- see README.
app.post("/webhooks/github", async (req, res) => {
  const signature = req.get("x-hub-signature-256");
  let verified;
  try {
    verified = githubApp.verifyWebhookSignature(req.rawBody, signature);
  } catch (err) {
    return res.status(503).json({ error: err.message });
  }
  if (!verified) {
    return res.status(401).json({ error: "Invalid webhook signature." });
  }

  // Acknowledge immediately -- GitHub expects a fast response and will
  // retry/disable the webhook on repeated timeouts. Process afterward.
  res.status(202).json({ received: true });

  const eventName = req.get("x-github-event");
  try {
    const result = await handleWebhookEvent(eventName, req.body);
    if (result?.skipped) console.log(`[webhook] ${eventName}: skipped (${result.skipped})`);
    else console.log(`[webhook] ${eventName}: event ${result?.eventId}`);
  } catch (err) {
    console.error(`[webhook] ${eventName}: failed --`, err.message);
  }
});

app.listen(PORT, () => {
  console.log(`NEXUS backend listening on http://localhost:${PORT}`);
});
