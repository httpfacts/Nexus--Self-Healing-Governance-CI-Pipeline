// Talks to a real GitHub MCP server (@modelcontextprotocol/server-github),
// spawned as a child process over stdio, using the official MCP SDK client.
// This is the same protocol an AI agent would use to call GitHub tools --
// NEXUS uses it to check a repo's CI/CD config files, not to
// generate fixes.
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");

const SERVER_ENTRY = require.resolve("@modelcontextprotocol/server-github/dist/index.js");

class GithubMcpError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status || 502;
  }
}

// currentToken/connection live only in process memory -- never written to
// disk, never logged. Falls back to GITHUB_PERSONAL_ACCESS_TOKEN from
// backend/.env (if set) until someone connects one via the UI.
let currentToken = process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null;
let connection = { username: null, name: null, avatarUrl: null };

let clientPromise = null;
let activeClient = null;

function spawnClient(token) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: {
      PATH: process.env.PATH || "",
      ...(token ? { GITHUB_PERSONAL_ACCESS_TOKEN: token } : {}),
    },
  });

  const client = new Client({ name: "nexus-backend", version: "1.0.0" });
  const forgetIfCurrent = () => {
    if (activeClient === client) {
      activeClient = null;
      clientPromise = null;
    }
  };
  client.onclose = forgetIfCurrent;
  client.onerror = forgetIfCurrent;

  return client.connect(transport).then(() => {
    activeClient = client;
    return client;
  });
}

function getClient() {
  if (!clientPromise) {
    clientPromise = spawnClient(currentToken).catch((err) => {
      clientPromise = null;
      throw err;
    });
  }
  return clientPromise;
}

// Swaps the token and respawns the MCP server child process with it in its
// env (child process env can't be changed after spawn). Closes the old
// client first so its onclose handler can't race the new one.
async function resetClient(newToken) {
  const old = activeClient;
  currentToken = newToken;
  clientPromise = null;
  activeClient = null;
  if (old) {
    try {
      await old.close();
    } catch {
      /* already gone */
    }
  }
}

async function verifyToken(token) {
  let res;
  try {
    res = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token}`, "User-Agent": "nexus-demo" },
    });
  } catch {
    throw new GithubMcpError("Couldn't reach GitHub to verify that token.", 502);
  }
  if (res.status === 401) {
    throw new GithubMcpError("GitHub rejected that token (invalid or expired).", 401);
  }
  if (!res.ok) {
    throw new GithubMcpError(`GitHub rejected that token (status ${res.status}).`, res.status);
  }
  const data = await res.json();
  return { username: data.login, name: data.name || null, avatarUrl: data.avatar_url || null };
}

async function connectWithToken(token) {
  const identity = await verifyToken(token);
  await resetClient(token);
  connection = identity;
  await getClient(); // eagerly spawn so a bad env surfaces now, not on first scan
  return { connected: true, ...identity };
}

async function disconnectToken() {
  await resetClient(process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null);
  connection = { username: null, name: null, avatarUrl: null };
}

function getStatus() {
  return {
    connected: Boolean(connection.username),
    username: connection.username,
    name: connection.name,
    avatarUrl: connection.avatarUrl,
    envTokenPresent: Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
  };
}

// Used by pipelineCheck.js, which needs the raw token to authenticate its
// own Octokit REST client (separate from the MCP stdio client above).
function getConnectedToken() {
  return connection.username ? currentToken : null;
}

// Looks up one path in the repo. Returns null if it doesn't exist,
// { type: "file" } if it's a single file, or { type: "dir", entries } if
// it's a directory listing -- same shape the GitHub contents API returns.
async function getPathEntry(owner, repo, targetPath) {
  const client = await getClient();
  let result;
  try {
    result = await client.callTool({
      name: "get_file_contents",
      arguments: { owner, repo, path: targetPath },
    });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    if (/not found/i.test(message)) return null;
    if (/rate limit/i.test(message)) {
      throw new GithubMcpError(
        connection.username
          ? "GitHub API rate limit reached for this token."
          : "GitHub API rate limit reached. Connect a GitHub token above for a higher limit.",
        429
      );
    }
    throw new GithubMcpError(message, 502);
  }

  const raw = result && result.content && result.content[0] && result.content[0].text;
  if (!raw) return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  return Array.isArray(parsed) ? { type: "dir", entries: parsed } : { type: "file" };
}

// The known locations a CI/CD pipeline config can live in. NEXUS only
// ever needs to look here -- these ARE the control-plane files by
// definition, so there's no reason to walk the rest of the repo.
const CI_ROOT_FILES = [
  { path: "Jenkinsfile", label: "Jenkins" },
  { path: ".gitlab-ci.yml", label: "GitLab CI" },
  { path: ".travis.yml", label: "Travis CI" },
  { path: "azure-pipelines.yml", label: "Azure Pipelines" },
];

const CI_DIRS = [
  { path: ".github/workflows", label: "GitHub Actions" },
  { path: ".circleci", label: "CircleCI" },
];

async function scanCiCdFiles(owner, repo) {
  const root = await getPathEntry(owner, repo, "");
  if (!root) {
    throw new GithubMcpError(`Repository not found on GitHub: ${owner}/${repo}`, 404);
  }

  const files = [];
  const systems = new Set();

  for (const { path: p, label } of CI_ROOT_FILES) {
    const entry = await getPathEntry(owner, repo, p);
    if (entry && entry.type === "file") {
      files.push(p);
      systems.add(label);
    }
  }

  for (const { path: dirPath, label } of CI_DIRS) {
    const entry = await getPathEntry(owner, repo, dirPath);
    if (entry && entry.type === "dir") {
      for (const item of entry.entries) {
        if (item.type === "file") {
          files.push(item.path);
          systems.add(label);
        }
      }
    }
  }

  return {
    files,
    ciDetected: { present: files.length > 0, systems: Array.from(systems) },
  };
}

module.exports = {
  scanCiCdFiles,
  GithubMcpError,
  connectWithToken,
  disconnectToken,
  getStatus,
  getConnectedToken,
};
