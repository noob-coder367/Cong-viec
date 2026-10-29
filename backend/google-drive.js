const crypto = require("node:crypto");

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const FRONTEND_URL = (process.env.FRONTEND_URL || "https://cong-viec-ptung1.vercel.app").replace(/\/+$/, "");
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "https://cong-viec.onrender.com/auth/google/callback";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const DRIVE_ADMIN_PIN = process.env.DRIVE_ADMIN_PIN || "";
const GOOGLE_TOKEN_ENCRYPTION_KEY = process.env.GOOGLE_TOKEN_ENCRYPTION_KEY || "";
const driveSessions = new Map();
const oauthStates = new Map();
const pinAttempts = new Map();
const DRIVE_SESSION_TTL = 4 * 60 * 60 * 1000;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(body));
}
function redirect(res, url) {
  res.writeHead(302, { Location: url, "Cache-Control": "no-store" });
  res.end();
}
function getBearer(req) {
  const auth = String(req.headers.authorization || "");
  if (!auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const expires = driveSessions.get(token);
  if (!expires || expires <= Date.now()) { driveSessions.delete(token); return null; }
  return token;
}
async function readJson(req, maxBytes = 64 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("BODY_TOO_LARGE");
  }
  return JSON.parse(body || "{}");
}
function encryptSecret(value) {
  if (!GOOGLE_TOKEN_ENCRYPTION_KEY) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
  const key = crypto.createHash("sha256").update(GOOGLE_TOKEN_ENCRYPTION_KEY, "utf8").digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}
function decryptSecret(value) {
  if (!GOOGLE_TOKEN_ENCRYPTION_KEY) throw new Error("GOOGLE_TOKEN_ENCRYPTION_KEY is not configured");
  const [ivText, tagText, dataText] = String(value || "").split(".");
  if (!ivText || !tagText || !dataText) throw new Error("Stored Google token has an invalid format");
  const key = crypto.createHash("sha256").update(GOOGLE_TOKEN_ENCRYPTION_KEY, "utf8").digest();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(dataText, "base64url")), decipher.final()]).toString("utf8");
}
function configured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && REDIRECT_URI && GOOGLE_TOKEN_ENCRYPTION_KEY);
}
async function tokenExchange(params) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error_description || data.error || "Google token exchange failed");
  return data;
}
async function loadConnection(supabase) {
  if (!supabase) throw new Error("Supabase server key is not configured");
  const result = await supabase.from("google_drive_connections")
    .select("id, email, refresh_token_enc, connected_at, scopes")
    .eq("id", "primary").maybeSingle();
  if (result.error) throw new Error("Could not read Google Drive connection");
  return result.data || null;
}
async function driveAccessToken(supabase) {
  const connection = await loadConnection(supabase);
  if (!connection?.refresh_token_enc) {
    const error = new Error("Google Drive is not connected yet");
    error.statusCode = 409;
    throw error;
  }
  const refreshToken = decryptSecret(connection.refresh_token_enc);
  const tokens = await tokenExchange({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  return { accessToken: tokens.access_token, connection };
}
async function googleRequest(accessToken, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: "Bearer " + accessToken, ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30000)
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data?.error?.message || data?.error_description || "Google Drive API request failed");
    error.statusCode = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
    throw error;
  }
  return data;
}
async function withDrive(supabase, work) {
  const { accessToken } = await driveAccessToken(supabase);
  return work(accessToken);
}
function safeDriveError(res, error) {
  console.error("[drive] request failed", error?.statusCode || "error", String(error?.message || "").slice(0, 160));
  const status = error?.statusCode || 502;
  json(res, status, { error: status === 401 ? "Google access expired or was revoked. Reconnect Google Drive." : status === 403 ? "Google denied this action. Check Drive permissions and API configuration." : status === 409 ? "Connect Google Drive first." : status === 413 ? "File is too large (maximum 25 MB per upload)." : "Google Drive request failed." });
}
function driveQueryEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}
function getClientKey(req) {
  return String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim().slice(0, 80);
}

async function handleDriveRequest(req, res, pathname, supabase) {
  const url = new URL(req.url, "http://localhost");

  if (pathname === "/auth/google/callback" && req.method === "GET") {
    const state = url.searchParams.get("state") || "";
    const pending = oauthStates.get(state);
    oauthStates.delete(state);
    if (!pending || pending.expiresAt < Date.now() || !driveSessions.has(pending.session) || driveSessions.get(pending.session) <= Date.now()) {
      redirect(res, FRONTEND_URL + "/?drive=error&reason=state"); return true;
    }
    if (url.searchParams.get("error")) {
      redirect(res, FRONTEND_URL + "/?drive=error&reason=denied"); return true;
    }
    const code = url.searchParams.get("code") || "";
    try {
      if (!configured() || !supabase) throw new Error("Drive OAuth or database configuration missing");
      const tokens = await tokenExchange({
        code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI, grant_type: "authorization_code"
      });
      let refreshToken = tokens.refresh_token;
      const existing = await loadConnection(supabase);
      if (!refreshToken && existing?.refresh_token_enc) refreshToken = decryptSecret(existing.refresh_token_enc);
      if (!refreshToken) throw new Error("Google did not return a refresh token; reconnect with consent");
      const userInfo = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: "Bearer " + tokens.access_token }, signal: AbortSignal.timeout(10000)
      });
      const profile = await userInfo.json().catch(() => ({}));
      const saved = await supabase.from("google_drive_connections").upsert({
        id: "primary", email: String(profile.email || "").slice(0, 320),
        refresh_token_enc: encryptSecret(refreshToken),
        scopes: DRIVE_SCOPE, connected_at: new Date().toISOString()
      }, { onConflict: "id" });
      if (saved.error) throw new Error("Could not persist encrypted Google Drive credentials");
      redirect(res, FRONTEND_URL + "/?drive=connected"); return true;
    } catch (error) {
      console.error("[drive] OAuth callback failed", String(error?.message || "").slice(0, 160));
      redirect(res, FRONTEND_URL + "/?drive=error&reason=oauth"); return true;
    }
  }

  if (!pathname.startsWith("/api/drive/")) return false;

  if (pathname === "/api/drive/admin/verify" && req.method === "POST") {
    if (!/^\d{6}$/.test(DRIVE_ADMIN_PIN)) {
      json(res, 503, { error: "Drive admin PIN is not configured in Render." }); return true;
    }
    const clientKey = getClientKey(req), now = Date.now(), old = pinAttempts.get(clientKey);
    if (old && now - old.startedAt < 5 * 60 * 1000 && old.count >= 8) {
      json(res, 429, { error: "Too many attempts. Try again later." }); return true;
    }
    if (!old || now - old.startedAt >= 5 * 60 * 1000) pinAttempts.set(clientKey, { startedAt: now, count: 1 });
    else old.count += 1;
    let body;
    try { body = await readJson(req, 2048); } catch { json(res, 400, { error: "Invalid request." }); return true; }
    const supplied = Buffer.from(typeof body.pin === "string" ? body.pin : "", "utf8");
    const expected = Buffer.from(DRIVE_ADMIN_PIN, "utf8");
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
      json(res, 401, { error: "Drive PIN is incorrect." }); return true;
    }
    pinAttempts.delete(clientKey);
    const token = crypto.randomBytes(32).toString("base64url");
    driveSessions.set(token, now + DRIVE_SESSION_TTL);
    json(res, 200, { token, expiresIn: DRIVE_SESSION_TTL }); return true;
  }

  const driveSession = getBearer(req);
  if (!driveSession) { json(res, 401, { error: "Drive admin session expired. Enter the Drive PIN again." }); return true; }

  if (pathname === "/api/drive/status" && req.method === "GET") {
    try {
      const connection = await loadConnection(supabase);
      json(res, 200, { configured: configured(), connected: Boolean(connection?.refresh_token_enc), email: connection?.email || null, connectedAt: connection?.connected_at || null });
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  if (pathname === "/api/drive/oauth/start" && req.method === "POST") {
    if (!configured() || !supabase) { json(res, 503, { error: "Configure Google OAuth, encryption key and Supabase server key in Render first." }); return true; }
    const state = crypto.randomBytes(32).toString("base64url");
    oauthStates.set(state, { session: driveSession, expiresAt: Date.now() + 10 * 60 * 1000 });
    for (const [key, item] of oauthStates) if (item.expiresAt <= Date.now()) oauthStates.delete(key);
    const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authUrl.search = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID, redirect_uri: REDIRECT_URI, response_type: "code",
      scope: DRIVE_SCOPE + " https://www.googleapis.com/auth/userinfo.email",
      access_type: "offline", prompt: "consent", include_granted_scopes: "true", state
    }).toString();
    json(res, 200, { url: authUrl.toString() }); return true;
  }

  if (pathname === "/api/drive/files" && req.method === "GET") {
    try {
      const query = url.searchParams.get("q") || "";
      const folderId = url.searchParams.get("folderId") || "root";
      const pageToken = url.searchParams.get("pageToken") || "";
      const mode = url.searchParams.get("mode") || "files";
      const qParts = [mode === "trash" ? "trashed = true" : "trashed = false"];
      if (mode !== "trash" && folderId) qParts.push("'" + driveQueryEscape(folderId) + "' in parents");
      if (query.trim()) qParts.push("name contains '" + driveQueryEscape(query.trim().slice(0, 150)) + "'");
      const params = new URLSearchParams({
        q: qParts.join(" and "), pageSize: "100",
        orderBy: "folder,name", fields: "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,webViewLink,thumbnailLink,parents,description,trashed,iconLink)"
      });
      if (pageToken) params.set("pageToken", pageToken);
      const result = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/drive/v3/files?" + params));
      json(res, 200, { files: result.files || [], nextPageToken: result.nextPageToken || null }); 
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  if (pathname === "/api/drive/folders" && req.method === "POST") {
    try {
      const body = await readJson(req, 8192);
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
      const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : "root";
      if (!name) { json(res, 400, { error: "Folder name is required." }); return true; }
      const result = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/drive/v3/files?fields=id,name,mimeType,webViewLink,parents", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] })
      }));
      json(res, 201, { file: result });
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  if (pathname === "/api/drive/upload" && req.method === "POST") {
    try {
      const name = String(url.searchParams.get("name") || "upload").trim().slice(0, 200);
      const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].slice(0, 150);
      const parentId = String(url.searchParams.get("parentId") || "root").slice(0, 200);
      const chunks = []; let total = 0;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > MAX_UPLOAD_BYTES) { json(res, 413, { error: "File too large (maximum 25 MB)." }); return true; }
        chunks.push(chunk);
      }
      if (!total) { json(res, 400, { error: "Empty file." }); return true; }
      const boundary = "----congviec" + crypto.randomBytes(12).toString("hex");
      const metadata = JSON.stringify({ name, mimeType, parents: [parentId] });
      const body = Buffer.concat([
        Buffer.from("--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + metadata + "\r\n--" + boundary + "\r\nContent-Type: " + mimeType + "\r\n\r\n"),
        Buffer.concat(chunks), Buffer.from("\r\n--" + boundary + "--")
      ]);
      const result = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,mimeType,size,modifiedTime,webViewLink,thumbnailLink,parents", {
        method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body
      }));
      json(res, 201, { file: result });
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  if (pathname.startsWith("/api/drive/files/") && req.method === "PATCH") {
    try {
      const id = decodeURIComponent(pathname.slice("/api/drive/files/".length));
      if (!id || id.includes("/")) { json(res, 400, { error: "Invalid file ID." }); return true; }
      const body = await readJson(req, 8192);
      const fields = [];
      const patch = {};
      if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 200);
      if (typeof body.trashed === "boolean") patch.trashed = body.trashed;
      if (typeof body.parentId === "string" && body.parentId) {
        const old = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?fields=parents"));
        if (Array.isArray(old.parents)) fields.push(...old.parents);
        const result = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?addParents=" + encodeURIComponent(body.parentId) + "&removeParents=" + encodeURIComponent(fields.join(",")) + "&fields=id,name,mimeType,parents,webViewLink,trashed", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch)
        }));
        json(res, 200, { file: result }); return true;
      }
      if (!Object.keys(patch).length) { json(res, 400, { error: "No valid changes provided." }); return true; }
      const result = await withDrive(supabase, accessToken => googleRequest(accessToken, "https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(id) + "?fields=id,name,mimeType,parents,webViewLink,trashed", {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch)
      }));
      json(res, 200, { file: result });
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  if (pathname === "/api/drive/disconnect" && req.method === "POST") {
    try {
      const existing = await loadConnection(supabase);
      if (existing) {
        const result = await supabase.from("google_drive_connections").delete().eq("id", "primary");
        if (result.error) throw new Error("Could not remove Google Drive connection");
      }
      json(res, 200, { disconnected: true });
    } catch (error) { safeDriveError(res, error); }
    return true;
  }

  json(res, 404, { error: "Drive endpoint not found." });
  return true;
}

module.exports = { handleDriveRequest };
