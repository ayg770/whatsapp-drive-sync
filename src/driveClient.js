import fs from 'fs';
import { Readable } from 'stream';
import { google } from 'googleapis';

let driveClient = null;

function getDrive() {
  if (driveClient) return driveClient;

  const scopes = ['https://www.googleapis.com/auth/drive'];
  const inlineJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_JSON;
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;

  let auth;
  if (inlineJson) {
    // Preferred on a hosting platform: paste the key file's contents into an
    // env var, since there's usually no easy way to upload a file there.
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
      'No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_KEY_JSON (the key file\'s contents) or GOOGLE_SERVICE_ACCOUNT_KEY_FILE (a local path) in .env.'
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
