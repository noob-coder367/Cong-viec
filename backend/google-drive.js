const crypto = require("node:crypto");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CHAT_UPLOAD_FOLDER_ID = process.env.CHAT_UPLOAD_FOLDER_ID || "1cxnAGUnZ1bnMISqY-7_OJgxIzTTKSflB";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_TOKEN_ENCRYPTION_KEY = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "";

function decryptSecret(value) {
  if (!GOOGLE_TOKEN_ENCRYPTION_KEY) throw new Error("Google Drive token encryption is not configured");
  const [ivText, tagText, dataText] = String(value || "").split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Stored Google token has an invalid format");
  const key = crypto.createHash("sha256").update(GOOGLE_TOKEN_ENCRYPTION_KEY, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}

async function tokenExchange(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error_description || data.error || "Google token exchange failed");
    error.statusCode = response.status === 401 ? 401 : 502;
    throw error;
  }
  return data;
}

async function driveAccessToken(supabase) {
  if (!supabase) {
    const error = new Error("Supabase server key is not configured");
    error.statusCode = 503;
    throw error;
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_TOKEN_ENCRYPTION_KEY) {
    const error = new Error("Google Drive upload is not configured");
    error.statusCode = 503;
    throw error;
  }
  const result = await supabase.from("google_drive_connections")
    .select("refresh_token_enc")
    .eq("id", "primary")
    .maybeSingle();
  if (result.error) {
    const error = new Error("Could not read Google Drive connection");
    error.statusCode = 503;
    throw error;
  }
  if (!result.data?.refresh_token_enc) {
    const error = new Error("Google Drive is not connected");
    error.statusCode = 409;
    throw error;
  }
  const tokens = await tokenExchange({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: decryptSecret(result.data.refresh_token_enc),
    grant_type: "refresh_token"
  });
  return tokens.access_token;
}

async function uploadToDrive(accessToken, fileName, mimeType, fileBuffer) {
  const boundary = "----congviec-chat-" + crypto.randomBytes(12).toString("hex");
  const metadata = JSON.stringify({ name: fileName, mimeType, parents: [CHAT_UPLOAD_FOLDER_ID] });
  const body = Buffer.concat([
    Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: " + mimeType + "\r\n\r\n"),
    fileBuffer,
    Buffer.from("\r\n--" + boundary + "--")
  ]);
  const response = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,webViewLink,thumbnailLink,parents", {
    method: "POST",
    headers: { Authorization: "Bearer " + accessToken, "Content-Type": "multipart/related; boundary=" + boundary },
    body,
    signal: AbortSignal.timeout(60000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || "Google Drive upload failed");
    error.statusCode = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
    throw error;
  }
  return data;
}

async function uploadChatFile(supabase, fileName, mimeType, fileBuffer) {
  if (!Buffer.isBuffer(fileBuffer) || !fileBuffer.length) {
    const error = new Error("Empty file"); error.statusCode = 400; throw error;
  }
  if (fileBuffer.length > MAX_UPLOAD_BYTES) {
    const error = new Error("File too large"); error.statusCode = 413; throw error;
  }
  const name = String(fileName || "attachment").replace(/[\\/\0-\x1f\x7f]/g, "_").trim().slice(0, 180) || "attachment";
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(mimeType) ? mimeType : "application/octet-stream";
  const accessToken = await driveAccessToken(supabase);
  return uploadToDrive(accessToken, name, type, fileBuffer);
}

module.exports = { uploadChatFile, MAX_UPLOAD_BYTES, CHAT_UPLOAD_FOLDER_ID };
