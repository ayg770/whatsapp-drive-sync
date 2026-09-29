import fs from 'fs';
import { Readable } from 'stream';
import { google } from 'googleapis';
import { getAuthorizedOAuthClient } from './googleAuth.js';

let driveClient = null;

function getDrive() {
  if (driveClient) return driveClient;

  const scopes = ['https://www.googleapis.com/auth/drive'];
  const oauthClient = getAuthorizedOAuthClient();
  const base64Json = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_BASE64;
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  let auth;
  if (oauthClient) {
    // Preferred: acts as the real Google account that owns the Drive folder,
    // so uploaded files use that account's own storage quota. A Service
    // Account (below) has none of its own on a regular (non-Workspace) Drive.
    auth = oauthClient;
  } else if (base64Json) {
    // Most robust for pasting into a hosting dashboard: a single unbroken
    // line, immune to a text editor accidentally inserting a real line break
    // in the middle of the long private_key field.
    let credentials;
    try {
      credentials = JSON.parse(Buffer.from(base64Json.trim(), 'base64').toString('utf8'));
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 could not be decoded into valid JSON.');
    }
    auth = new google.auth.GoogleAuth({ credentials, scopes });
  } else if (inlineJson) {
    // Paste the key file's contents directly — works, but a text editor can
    // corrupt the long private_key field by wrapping it onto multiple lines.
    let credentials;
    try {
      credentials = JSON.parse(inlineJson);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY_JSON is not valid JSON.');
    }
    auth = new google.auth.GoogleAuth({ credentials, scopes });
  } else if (keyFile && fs.existsSync(keyFile)) {
    // Convenient for local runs: point at the downloaded key file directly.
    auth = new google.auth.GoogleAuth({ keyFile, scopes });
  } else {
    throw new Error(
      'No Google Drive credentials found. Recommended: complete the one-time /admin/google-auth/start flow. Alternatively set GOOGLE_SERVICE_ACCOUNT_KEY_BASE64, GOOGLE_SERVICE_ACCOUNT_KEY_JSON, or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (only works with a Shared Drive).'
    );
  }

  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

// Returns the id of an existing folder with this exact name under parentId,
// or creates a new one if none exists yet (so re-syncing the same day reuses it).
export async function getOrCreateDateFolder(folderName, parentId) {
  const drive = getDrive();

  const escaped = folderName.replace(/'/g, "\\'");
  const query = `name = '${escaped}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;

  const existing = await drive.files.list({
    q: query,
    fields: 'files(id, name)',
    spaces: 'drive',
  });

  if (existing.data.files?.length) {
    return existing.data.files[0].id;
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  });

  return created.data.id;
}

export async function uploadBuffer(buffer, fileName, mimeType, parentId) {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: 'id, webViewLink',
  });

  return res.data;
}

export function folderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
