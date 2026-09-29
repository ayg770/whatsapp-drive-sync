import { google } from 'googleapis';

const SCOPES = ['https://www.googleapis.com/auth/drive'];

function oauthClient() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function isOAuthConfigured() {
  return Boolean(oauthClient());
}

// One-time setup: send the school's Google account owner here once, so files
// this app creates belong to their real Drive (with real storage quota)
// instead of a Service Account's (which has none).
export function getAuthUrl() {
  const client = oauthClient();
  if (!client) throw new Error('GOOGLE_OAUTH_CLIENT_ID/SECRET/REDIRECT_URI are not set.');
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces Google to issue a refresh_token even on repeat authorizations
    scope: SCOPES,
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
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
  const client = oauthClient();
  if (!client || !refreshToken) return null;
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}
