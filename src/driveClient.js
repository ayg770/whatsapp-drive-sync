import fs from 'fs';
import { google } from 'googleapis';

let driveClient = null;

function getDrive() {
  if (driveClient) return driveClient;

  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE;
  if (!keyFile || !fs.existsSync(keyFile)) {
    throw new Error(
      `Google service account key file not found at "${keyFile}". Set GOOGLE_SERVICE_ACCOUNT_KEY_FILE in .env.`
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });

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

export async function uploadFile(filePath, fileName, mimeType, parentId) {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [parentId],
    },
    media: {
      mimeType,
      body: fs.createReadStream(filePath),
    },
    fields: 'id, webViewLink',
  });

  return res.data;
}

export function folderUrl(folderId) {
  return `https://drive.google.com/drive/folders/${folderId}`;
}
