const crypto = require("node:crypto");

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const CHAT_UPLOAD_FOLDER_ID = process.env.CHAT_UPLOAD_FOLDER_ID || "1cxnAGUnZ1bnMISqY-7_OJgxIzTTKSflB";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_TOKEN_ENCRYPTION_KEY = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://cong-viec.onrender.com/auth/google/callback";
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://cong-viec-ptung1.vercel.app").replace(/\/+$/, "");
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const reauthStates = new Map();

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

function createReauthUrl() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_TOKEN_ENCRYPTION_KEY) {
    const error = new Error("Google Drive upload is not configured"); error.statusCode = 503; throw error;
  }
  const state = crypto.randomBytes(32).toString("base64url");
  reauthStates.set(state, Date.now() + 10 * 60 * 1000);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID, redirect_uri: GOOGLE_REDIRECT_URI, response_type: "code",
    scope: DRIVE_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "false", state
  }).toString();
  return url.toString();
}

async function handleDriveReauth(req, res, pathname, supabase) {
  const url = new URL(req.url, "http://localhost");
  if (pathname === "/api/chat/drive/reconnect" && req.method === "POST") {
    try { res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ url: createReauthUrl() })); }
    catch (error) { res.writeHead(error.statusCode || 503, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify({ error: "Không thể tạo liên kết cấp lại quyền Google Drive." })); }
    return true;
  }
  if (pathname !== "/auth/google/callback" || req.method !== "GET") return false;
  const state = url.searchParams.get("state") || "";
  const expiresAt = reauthStates.get(state); reauthStates.delete(state);
  if (!expiresAt || expiresAt < Date.now() || url.searchParams.get("error")) {
    res.writeHead(302, { Location: FRONTEND_URL + "?drive=reauth-error" }); res.end(); return true;
  }
  try {
    const tokens = await tokenExchange({ code: url.searchParams.get("code") || "", client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, redirect_uri: GOOGLE_REDIRECT_URI, grant_type: "authorization_code" });
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) throw new Error("Google did not return a refresh token");
    const saved = await supabase.from("google_drive_connections").upsert({ id: "primary", email: "", refresh_token_enc: encryptSecret(refreshToken), scopes: String(tokens.scope || DRIVE_SCOPE), connected_at: new Date().toISOString() }, { onConflict: "id" });
    if (saved.error) throw new Error("Could not save Google Drive connection");
    res.writeHead(302, { Location: FRONTEND_URL + "?drive=reauth-ok" }); res.end();
  } catch (error) { console.error("[drive] reauth failed", String(error?.message || "").slice(0, 160)); res.writeHead(302, { Location: FRONTEND_URL + "?drive=reauth-error" }); res.end(); }
  return true;
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

module.exports = { uploadChatFile, MAX_UPLOAD_BYTES, CHAT_UPLOAD_FOLDER_ID, handleDriveReauth };
