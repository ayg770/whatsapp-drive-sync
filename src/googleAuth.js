import fs from 'node:fs';
import path from 'node:path';
import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function trimmedEnv(name) {
  const value = process.env[name];
  // Copy-pasting from Google Cloud Console (or a dashboard's own "copy"
  // button) can silently include a trailing newline/space, which then makes
  // the client_id/secret not match what Google has on file.
  return value ? value.trim() : value;
}

function oauthClient() {
  const clientId = trimmedEnv('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = trimmedEnv('GOOGLE_OAUTH_CLIENT_SECRET');
  const redirectUri = trimmedEnv('GOOGLE_OAUTH_REDIRECT_URI');
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isOAuthConfigured() {
  return Boolean(oauthClient());
}

// One-time setup: send the school's Google account owner here once, so files
// this app creates belong to their real Drive (with real storage quota)
// instead of a Service Account's (which has none).
export function getAuthUrl(state) {
  const client = oauthClient();
  if (!client) throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are not set.');
  return client.generateAuthUrl({
    state,
    access_type: 'offline',
    prompt: 'consent', // forces Google to issue a refresh_token even on repeat authorizations
    scope: SCOPES
  });
}

export async function exchangeCodeForTokens(code) {
  const client = oauthClient();
  if (!client) throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are not set.');
  const { tokens } = await client.getToken(code);
  return tokens;
}

// Used at request time once GOOGLE_OAUTH_REFRESH_TOKEN is saved as an env var.
export function getAuthorizedOAuthClient() {
  let refreshToken = trimmedEnv('GOOGLE_OAUTH_REFRESH_TOKEN');
  if (!refreshToken) {
    try {
      refreshToken = JSON.parse(fs.readFileSync(tokenFile(), 'utf8')).refresh_token;
    } catch {}
  }
  const client = oauthClient();
  if (!client || !refreshToken) return null;
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

function tokenFile() {
  return path.resolve(process.env.DATA_DIR || 'data', 'google-oauth.json');
}
export function saveOAuthRefreshToken(token) {
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ refresh_token: token }), {
    mode: 0o600
  });
  fs.renameSync(file + '.tmp', file);
}
