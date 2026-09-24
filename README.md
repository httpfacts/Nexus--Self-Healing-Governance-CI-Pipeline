# NEXUS

A policy boundary for agentic CI/CD: when a pipeline fails, NEXUS
classifies every changed file as **data-plane** (application/test code —
safe to auto-fix) or **control-plane** (workflow YAML, secrets, approval
gates — always needs a human), using a plain, readable `policy.yaml` — not
a learned model. If the whole changeset is data-plane, it can generate a
fix and open the PR/MR itself. If anything is control-plane, the fix still
gets generated, but it sits in a **Review Queue** until a human approves
or rejects it — NEXUS never ships a control-plane change on its own.

This repo has two parts:

1. **`backend/`** — Express API: the classifier, risk scorer, a real
   GitHub MCP client, a GitLab REST client, a pluggable LLM fix-suggestion
   client (Google Gemini by default, or your own
   Gemini/Anthropic/OpenAI/Grok key), and (a
   separate, optional path) a full GitHub App/webhook/auto-PR pipeline.
2. **`frontend/`** — React/Vite site: a marketing landing page plus `/tool`,
   an interactive dashboard that actually connects to your GitHub/GitLab
   account and does the work described above.

## What's actually live right now

Everything under **`/tool`** works today with nothing but a personal
access token — no GitHub App registration, no webhook tunnel, no OAuth.

- **Overview** — a small dashboard over the same data: connection count,
  repos currently failing, auto-fixable vs escalated counts, a donut
  chart of the split, a bar list of failing repos, and a recent-failures
  table.
- **Connect** — paste a GitHub and/or GitLab personal access token.
  Verified against the provider's API on connect; kept in memory only for
  the life of the backend process, never written to disk. An optional
  **AI provider** card lives here too — see below.
- **Check pipeline** — automatically checks your most recently updated
  repos/projects on every connected provider for a failing run (polls
  every 30s in the background, plus a manual **Refresh**). For each
  failure it shows:
  - which job/step failed and a **log excerpt anchored on GitHub's own
    `##[error]` annotation** — the exact point a step failed, not just
    the tail of the whole job log (which is usually dominated by
    unrelated Post-job cleanup output that runs afterward regardless of
    outcome)
  - a **risk score** (0–1) alongside the data-plane/control-plane verdict
    — a deterministic keyword rubric (secrets/IAM ≈ 1.0, Dockerfile ≈
    0.91, workflow files ≈ 0.79, data-plane ≈ 0.15), not a learned model,
    same philosophy as the classifier itself
  - the changed files, classified data-plane vs control-plane, shown as
    a folder breadcrumb rather than a flat path
  - whether the responsible workflow **auto-re-runs on push/PR**, or
    needs a **manual `workflow_dispatch`** — parsed from the workflow's
    own `on:` config and shown up front, before you even generate a fix
  - **low risk (data-plane)** → "Generate fix" → a small red/green diff
    (with an **Edit** button) → **"Open PR/MR with this fix"**
  - **high risk (control-plane)** → "Suggest a fix" runs the same flow,
    but the actual approve/ship decision happens in the Review Queue
  - if a repo that was failing now has a passing run, it shows up as a
    green **"Fixed"** card instead of just silently disappearing
- **Review Queue** — every control-plane-flagged fix in one place: risk
  score, the policy rule it matched, the diff, and **Approve & open PR**
  / **Reject**. This is the only path a control-plane change can ship
  through — a human has to click Approve, every time.
- **Audit Log** — every classification decision `classifyChangeset()`
  made, as a real filterable table (search by repo/path/summary, filter
  by Auto-PR/Pending/Approved/Rejected), backed by an event log that both
  the `/tool` flow and the webhook path write to. Also has the
  in-browser `policy.yaml` editor (validates YAML before saving; restart
  the backend to pick up the change, since policy is loaded once at
  startup).

### Fix generation only targets files that are actually relevant

Early on, "Generate fix" / "Suggest a fix" asked the LLM to fix *every*
changed file against the *same* failure log — including files that had
nothing to do with the failure (a workflow YAML sitting next to an
unrelated test change, say). That wastes a call and risks a
confidently-wrong edit. Now:

- Files the log excerpt doesn't even mention are skipped, with the reason
  shown ("Doesn't appear related to the failure above").
- If *none* of the changed files look relevant but the workflow that
  actually ran does mention something from the log (a missing secret or
  env var, say) — even if that workflow file wasn't part of the commit —
  it's tried too. This is the "go find the actual right file" behavior:
  a failure like a missing `DOCKER_USERNAME` is usually a workflow-file
  problem, not a problem in whatever test file happened to be in the same
  commit.

### The LLM behind "Generate fix" / "Suggest a fix"

Production default is **Google Gemini** via the Gemini Developer API (see
`backend/llmClient.js`):

```bash
# create a key: https://aistudio.google.com/apikey
# then set in backend/.env:
GEMINI_API_KEY=AIza...
GEMINI_MODEL=gemini-3.8-flash       # see note below
# GEMINI_THINKING_LEVEL=low         # optional: low | medium | high
```

Google retires models on a published schedule (`gemini-2.0-flash`, for
example, is already shut down). If fix generation starts failing with a
404 "model not found" error, check
[ai.google.dev/gemini-api/docs/models](https://ai.google.dev/gemini-api/docs/models)
and update `GEMINI_MODEL` in `backend/.env`. Temperature is intentionally
not set: Google recommends leaving it at the default for Gemini 3.x.
Transient 429/503 responses are retried twice with a short backoff, and a
response that was cut off mid-file is treated as a failure rather than
written out truncated.

With no `GEMINI_API_KEY` and no connected key, "Generate fix"/"Suggest a
fix" fails with a clear "no AI provider configured" error instead of
silently doing nothing.

**Bring your own key.** On Connect → **AI provider**, paste a key for
**Gemini, Anthropic, OpenAI, or Grok** — verified live against that
provider on connect, kept in memory only, same pattern as the
GitHub/GitLab tokens. Once connected it overrides the server default for
every fix generation; disconnecting falls straight back to
`GEMINI_API_KEY`.

Every provider's raw output also goes through the same cleanup pass
(`cleanResponse()` in `llmClient.js`): strips markdown code fences and
chatty preambles/sign-offs a model tacks on despite being told not to,
and the fix prompt itself explicitly tells the model to preserve
unrelated lines byte-for-byte — otherwise a model that reformats
whitespace while making its one real edit makes the whole file look
changed in the diff, not just the fix.

## The separate, optional path: GitHub App + webhooks + auto-PR

This is older code (`githubApp.js`, `webhookHandler.js`, `fixProposal.js`,
`escalate.js`) for a fully automatic, event-driven pipeline: install a
GitHub App on a repo, and a real CI failure triggers a webhook →
classify → draft PR (data-plane, via `fixProposal.js`, which uses the
same Gemini client as `/tool`) or an escalation
Issue (control-plane) — with no one needing to open `/tool` at all. It
also gates the login-only `/dashboard` route. None of this is required
for the `/tool` flow described above; it needs its own setup (see
"Setting up the GitHub App" below) and hasn't been exercised against a
real webhook in this environment.

## Structure

```
nexus-site/
├── README.md
├── backend/
│   ├── server.js              All routes — see below
│   ├── classify.js            Classifier: policy.yaml matcher + changeset verdict + risk score
│   ├── policy/policy.yaml     The declarative rule set every stage reads
│   ├── cli.js                 Standalone classifier CLI (works on any git diff, no server needed)
│   ├── mcpGithubClient.js     Real GitHub MCP client — connect/status/CI-file scan for /tool
│   ├── pipelineCheck.js       GitHub: list repos, find failing runs, generate/apply fixes, trigger detection
│   ├── gitlabClient.js        GitLab: same shape as pipelineCheck.js, plain REST + PRIVATE-TOKEN
│   ├── llmClient.js           Pluggable LLM client: Gemini by default, or a connected user key
│   ├── automationClient.js    Octokit wrapper used by the GitHub App webhook path
│   ├── githubApp.js           GitHub App JWT auth, installation tokens, OAuth, webhook signatures
│   ├── webhookHandler.js      Turns a workflow_run webhook into a classified, stored event
│   ├── fixProposal.js         Webhook path's LLM patch generation + draft PR (uses llmClient.js)
│   ├── escalate.js            Webhook path's Issue creation, no code touched
│   ├── eventStore.js          JSON-file event log (see note below) -- backs the Audit Log
│   └── data/                  papers.json (site content) + events.json (created on first event)
└── frontend/
    └── src/
        ├── App.jsx             Routes: "/", "/tool", "/login", "/dashboard"
        ├── styles.css          The whole site's styling — burgundy/wine theme, single stylesheet
        ├── components/         Icons, Navbar, Hero, FAQ accordion, papers/architecture sections,
        │                       DonutChart, DashboardContent (Audit Log + policy editor),
        │                       FilePathBreadcrumb, etc.
        ├── lib/patchHunks.js   Turns a before/after file pair into small git-diff-style hunks
        └── pages/
            ├── LandingPage.jsx  Marketing site
            ├── ToolPage.jsx     Overview / Connect / Check pipeline / Review Queue / Audit Log
            ├── LoginPage.jsx    "Sign in with GitHub" (App OAuth, webhook path only)
            └── DashboardPage.jsx Same event history + policy editor, gated behind login
```

**Why a JSON file instead of a real database:** `better-sqlite3` needs a
native build step (`node-gyp` + a C++ toolchain), not available in every
environment. `eventStore.js` exposes `addEvent`/`updateEvent`/`listEvents`
— swap the file I/O inside it for Postgres/SQLite/whatever if this ever
needs to run concurrently or at real scale; nothing else needs to change.

## Running it locally

Needs Node.js 18+ (built-in `fetch` is used directly in a few places).
Open two terminals.

**Terminal 1 — backend:**
```bash
cd backend
npm install
npm start
```
Starts the API on `http://localhost:4000` (override with `PORT=`).

**Terminal 2 — frontend:**
```bash
cd frontend
npm install
npm run dev
```
Starts the site on `http://localhost:3000`. Vite proxies `/api/*` and
`/auth/*` to `http://localhost:4000` (`frontend/vite.config.js`) — the
`/auth` proxy keeps the login session cookie on the same origin the
frontend calls. Running the backend on a different port? Update the
proxy target in `vite.config.js` to match.

Open `http://localhost:3000`, click **Open the tool**.

## Environment variables (`backend/.env`)

Copy `backend/.env.example` to `backend/.env` and fill in what you need.
Nothing is required just to browse the site; the `/tool` dashboard only
needs a token pasted into its own Connect page (not an env var) — the env
vars below are for the optional pieces:

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_THINKING_LEVEL` | Every LLM call: "Generate fix" / "Suggest a fix" on `/tool` when no user AI key is connected, and the webhook path's auto-fix (`fixProposal.js`). `GEMINI_MODEL` defaults to `gemini-3.8-flash`; `GEMINI_THINKING_LEVEL` is optional |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | Optional fallback token so `/tool` isn't rate-limited before you connect one yourself |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_CALLBACK_URL`, `GITHUB_WEBHOOK_SECRET` | The optional GitHub App/webhook path only |
| `SESSION_SECRET` | Login session cookie signing (webhook path's `/login`) |
| `FRONTEND_URL` | Where OAuth redirects back to after login, and the **only origin the backend's CORS policy allows** (see Security below) |

## Security notes

- **No secret is ever written to disk.** GitHub/GitLab tokens and any
  connected AI provider key live in server memory only, for the life of
  the process — a restart clears them and the UI notices (see below),
  not silently pretend they still work.
- **CORS is locked to `FRONTEND_URL`** (default `http://localhost:3000`),
  not "any origin." The personal-token connection is a single
  process-wide value, not per-session — with a wide-open CORS policy,
  any page open in the same browser could otherwise call this API
  cross-origin and use it. Locking the allowed origin down closes that
  off without affecting the Vite dev proxy (a server-side proxy isn't
  subject to CORS at all).
- **Stale-connection self-healing.** Because tokens are memory-only, a
  backend restart silently drops them. The frontend re-checks connection
  status automatically (every 30s, and instantly on any 401) instead of
  leaving the sidebar claiming "Connected" while every real action fails.
- **Why not bcrypt/encryption for the tokens or keys:** bcrypt (and
  encryption generally) is for secrets you verify or decrypt later —
  every credential this app handles (GitHub/GitLab tokens, AI provider
  keys) has to be used in its original, plaintext form on the next API
  call, so hashing it would just make it unusable. The actual guarantee
  here is stronger for a single-user local tool: never persisted at all,
  so there's nothing on disk to steal in the first place.
- `policy.yaml` edits from the in-browser editor are YAML-parsed and
  rejected on invalid syntax before ever being written to disk.

## Setting up the GitHub App (optional — only for the webhook auto-PR path)

1. Go to **github.com/settings/apps/new**:
   - **GitHub App name**: anything unique
   - **Homepage URL**: `http://localhost:3000`
   - **Callback URL**: `http://localhost:4000/auth/github/callback` — check
     **"Request user authorization (OAuth) during installation"**
   - **Webhook URL**: a public tunnel, e.g. `npx smee-client --url https://smee.io/<channel> --target http://localhost:4000/webhooks/github`
   - **Webhook secret**: make one up, note it for `.env`
   - **Repository permissions**: Actions (read), Contents (read & write),
     Issues (read & write), Pull requests (read & write), Metadata (read)
   - **Subscribe to events**: Workflow run
2. Note the App ID, generate a private key (`.pem`), note the Client ID/secret
3. Install the App on the repo(s) you want it watching
4. Fill in `backend/.env` under the GitHub App section (paste the `.pem`
   contents as one line with `\n` for newlines), restart the backend
5. `/login` → sign in → push a commit that breaks CI on that repo → the
   webhook classifies it and either opens a draft PR (data-plane, needs
   `GEMINI_API_KEY`) or an Issue (control-plane, no LLM call)

## Customizing the policy

Edit `backend/policy/policy.yaml` directly, or use the in-browser editor
under `/tool` → Audit Log (validates YAML before saving). Restart
the backend afterward — policy is loaded once at startup.

## Production build

```bash
cd frontend
npm run build
```
Outputs a static bundle to `frontend/dist/`. Since the app uses
client-side routing, the static host needs an SPA fallback (serve
`index.html` for unknown paths like `/tool`). The backend needs a real
session store (not `express-session`'s in-memory default), `FRONTEND_URL`
set to the real deployed frontend origin (see Security above), and a
public webhook URL if you deploy the GitHub App path for real.

## Not built yet

- **Jenkins / CircleCI / Azure DevOps / Buildkite** as additional feed
  providers (same shape as the GitHub/GitLab clients — Jenkins is the
  most-requested next one, but needs a real instance to verify against)
- **AWS Bedrock** as an AI provider option — unlike the other four
  (Gemini/Anthropic/OpenAI/Grok, all single-key APIs), Bedrock
  authenticates with an AWS access key + secret + region and requires
  SigV4 request signing, which really needs the AWS SDK to do correctly
  rather than hand-rolled — a real feature to add properly, not a
  same-shape extension of the current key-based providers
- **Slack notifications** on escalation (smallest next step for the
  webhook path — post to a channel instead of only showing up in `/tool`)
- Hand-labeled benchmark + precision/recall/F1 evaluation, and a results
  writeup — genuinely separate work, not started
