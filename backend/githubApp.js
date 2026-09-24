// Stage 2 — the GitHub App itself: App-JWT auth, installation tokens, the
// OAuth login flow, and webhook signature verification. Everything here
// needs real credentials from a GitHub App you register at
// https://github.com/settings/apps/new -- see README "Setting up the
// GitHub App" for the exact steps. Nothing in this file works until
// GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY / GITHUB_APP_CLIENT_ID /
// GITHUB_APP_CLIENT_SECRET / GITHUB_WEBHOOK_SECRET are set in backend/.env.
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Octokit } = require("@octokit/rest");

function required(name) {
  const value = process.env[name];
  if (!value) {
    const err = new Error(`${name} is not set -- see README "Setting up the GitHub App".`);
    err.code = "GITHUB_APP_NOT_CONFIGURED";
    throw err;
  }
  return value;
}

function isConfigured() {
  return Boolean(
    process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_CLIENT_ID &&
      process.env.GITHUB_APP_CLIENT_SECRET
  );
}

// The private key is pasted into .env as a single line with literal "\n"
// sequences (PEM files are multi-line) -- restore real newlines.
function privateKeyPem() {
  return required("GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
}

function signAppJwt() {
  const appId = required("GITHUB_APP_ID");
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: appId },
    privateKeyPem(),
    { algorithm: "RS256" }
  );
}

let cachedInstallationToken = null; // { installationId, token, expiresAt }

async function getInstallationToken(installationId) {
  if (
    cachedInstallationToken &&
    cachedInstallationToken.installationId === installationId &&
    cachedInstallationToken.expiresAt > Date.now() + 30_000
  ) {
    return cachedInstallationToken.token;
  }

  const appOctokit = new Octokit({ auth: signAppJwt() });
  const { data } = await appOctokit.request("POST /app/installations/{installation_id}/access_tokens", {
    installation_id: installationId,
  });

  cachedInstallationToken = {
    installationId,
    token: data.token,
    expiresAt: new Date(data.expires_at).getTime(),
  };
  return data.token;
}

async function octokitForInstallation(installationId) {
  const token = await getInstallationToken(installationId);
  return new Octokit({ auth: token });
}

// ---------- OAuth login (Stage 2's "OAuth so a repo can be connected", ---
// reused as the dashboard's login mechanism per the chosen auth approach) --

function getLoginUrl(state) {
  const clientId = required("GITHUB_APP_CLIENT_ID");
  const redirectUri = process.env.GITHUB_APP_CALLBACK_URL || "http://localhost:4000/auth/github/callback";
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

async function exchangeCodeForUser(code) {
  const clientId = required("GITHUB_APP_CLIENT_ID");
  const clientSecret = required("GITHUB_APP_CLIENT_SECRET");

  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    throw new Error(tokenData.error_description || "GitHub did not return an access token.");
  }

  const userRes = await fetch("https://api.github.com/user", {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, "User-Agent": "nexus-app" },
  });
  if (!userRes.ok) throw new Error(`GitHub rejected the OAuth token (status ${userRes.status}).`);
  const user = await userRes.json();
  return { username: user.login, name: user.name || null, avatarUrl: user.avatar_url || null };
}

// ---------- Webhook signature verification ----------

function verifyWebhookSignature(rawBody, signature256) {
  const secret = required("GITHUB_WEBHOOK_SECRET");
  if (!signature256) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature256);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  isConfigured,
  signAppJwt,
  getInstallationToken,
  octokitForInstallation,
  getLoginUrl,
  exchangeCodeForUser,
  verifyWebhookSignature,
};
