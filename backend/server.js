const http = require("node:http");
const crypto = require("node:crypto");
const { createClient } = require("@supabase/supabase-js");
const { uploadChatFile, downloadChatFile, MAX_UPLOAD_BYTES, handleDriveReauth } = require("./google-drive");

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const ACCESS_PIN = process.env.ACCESS_PIN || "";
const sessions = new Map();
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf", "application/zip", "application/x-zip-compressed", "application/x-rar-compressed",
  "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint", "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain"
]);
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, X-File-Name, X-Chat-Sender",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}
function getClientKey(req) {
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").toString().split(",")[0].trim().slice(0, 80);
}
async function readJson(req, maxBytes = 16 * 1024) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("BODY_TOO_LARGE");
  }
  return JSON.parse(body || "{}");
}
function pinMatches(candidate) {
  if (!ACCESS_PIN || !/^\d{6}$/.test(candidate)) return false;
  const expected = Buffer.from(ACCESS_PIN, "utf8");
  const supplied = Buffer.from(candidate, "utf8");
  return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
}
function getSession(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const expires = sessions.get(token);
  if (!token || !expires || expires <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  return token;
}
function requireChatReady(res) {
  if (!supabase) {
    sendJson(res, 503, { error: "Chat database is not configured. Add SUPABASE_SERVICE_ROLE_KEY to the Render service." });
    return false;
  }
  return true;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, X-File-Name, X-Chat-Sender",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }
  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/api/chat/drive/reconnect" && !getSession(req)) {
    sendJson(res, 401, { error: "Session expired. Enter the access PIN again." }); return;
  }
  if (await handleDriveReauth(req, res, pathname, supabase)) return;

  if (pathname === "/api/verify-pin" && req.method === "POST") {
    if (!ACCESS_PIN || !/^\d{6}$/.test(ACCESS_PIN)) {
      sendJson(res, 503, { error: "PIN verification is not configured" }); return;
    }
    const key = getClientKey(req), now = Date.now(), entry = attempts.get(key);
    if (entry && now - entry.startedAt < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
      sendJson(res, 429, { valid: false, error: "Too many attempts" }); return;
    }
    if (!entry || now - entry.startedAt >= WINDOW_MS) attempts.set(key, { startedAt: now, count: 1 });
    else entry.count += 1;
    let payload;
    try { payload = await readJson(req); }
    catch { sendJson(res, 400, { valid: false, error: "Invalid request" }); return; }
    const pin = typeof payload.pin === "string" ? payload.pin : "";
    if (!pinMatches(pin)) { sendJson(res, 401, { valid: false }); return; }
    attempts.delete(key);
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, now + SESSION_TTL_MS);
    if (sessions.size > 10000) for (const [session, expiry] of sessions) if (expiry <= now) sessions.delete(session);
    sendJson(res, 200, { valid: true, token, expiresIn: SESSION_TTL_MS }); return;
  }

  if (pathname.startsWith("/api/chat/")) {
    if (!getSession(req)) { sendJson(res, 401, { error: "Session expired. Enter the access PIN again." }); return; }
    if (!requireChatReady(res)) return;

    const contentMatch = pathname.match(/^\/api\/chat\/attachments\/([^/]+)\/content$/);
    if (contentMatch && req.method === "GET") {
      try {
        const attachmentId = decodeURIComponent(contentMatch[1]);
        const attachment = await supabase.from("chat_attachments")
          .select("drive_file_id, mime_type, file_name")
          .eq("id", attachmentId).maybeSingle();
        if (attachment.error || !attachment.data) { sendJson(res, 404, { error: "Không tìm thấy tệp đính kèm." }); return; }
        const driveResponse = await downloadChatFile(supabase, attachment.data.drive_file_id);
        const bytes = Buffer.from(await driveResponse.arrayBuffer());
        res.writeHead(200, {
          "Content-Type": attachment.data.mime_type || "application/octet-stream",
          "Content-Length": bytes.length,
          "Content-Disposition": "inline; filename*=UTF-8''" + encodeURIComponent(attachment.data.file_name),
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff"
        });
        res.end(bytes);
      } catch (error) {
        console.error("chat attachment read failed", error?.statusCode || "error", String(error?.message || "").slice(0, 100));
        sendJson(res, error?.statusCode === 401 ? 401 : error?.statusCode === 403 ? 403 : 502, { error: "Không thể tải tệp đính kèm." });
      }
      return;
    }

    if (pathname === "/api/chat/attachments" && req.method === "POST") {
      const rawName = String(req.headers["x-file-name"] || "attachment");
      let fileName = rawName;
      try { fileName = decodeURIComponent(rawName); } catch {}
      fileName = fileName.replace(/[\\0-\\x1f\\x7f]/g, "_").slice(0, 180) || "attachment";
      const sender = String(req.headers["x-chat-sender"] || "").trim().slice(0, 40);
      const mimeType = String(req.headers["content-type"] || "application/octet-stream").split(";")[0].slice(0, 150);
      if (!sender) { sendJson(res, 400, { error: "Nhập tên hiển thị trước khi gửi tệp." }); return; }
      if (!mimeType.startsWith("image/") && !mimeType.startsWith("video/") && !ALLOWED_MIME_TYPES.has(mimeType)) { sendJson(res, 415, { error: "Loại tệp này chưa được hỗ trợ." }); return; }
      const chunks = []; let total = 0;
      try {
        for await (const chunk of req) {
          total += chunk.length;
          if (total > MAX_UPLOAD_BYTES) { sendJson(res, 413, { error: "Mỗi tệp tối đa 25 MB." }); return; }
          chunks.push(chunk);
        }
        if (!total) { sendJson(res, 400, { error: "Tệp trống." }); return; }
        const uploaded = await uploadChatFile(supabase, fileName, mimeType, Buffer.concat(chunks));
        const messageResult = await supabase.from("chat_messages")
          .insert({ room_id: "general", sender_name: sender, content: "Đã gửi tệp: " + String(uploaded.name || fileName).slice(0, 180) })
          .select("id, room_id, sender_name, content, created_at").single();
        if (messageResult.error) {
          console.error("chat attachment message insert failed", messageResult.error.code || "unknown");
          sendJson(res, 503, { error: "Tệp đã tải lên nhưng không lưu được tin nhắn. Hãy thử lại sau." }); return;
        }
        const link = uploaded.webViewLink || ("https://drive.google.com/file/d/" + encodeURIComponent(uploaded.id) + "/view");
        const attachmentResult = await supabase.from("chat_attachments").insert({
          message_id: messageResult.data.id,
          drive_file_id: uploaded.id,
          file_name: uploaded.name || fileName,
          mime_type: uploaded.mimeType || mimeType,
          size_bytes: Number(uploaded.size || total),
          web_view_link: link,
          thumbnail_link: uploaded.thumbnailLink || null
        });
        if (attachmentResult.error) {
          console.error("chat attachment metadata insert failed", attachmentResult.error.code || "unknown");
          await supabase.from("chat_messages").delete().eq("id", messageResult.data.id);
          sendJson(res, 503, { error: "Không lưu được thông tin tệp; tin nhắn lỗi đã được hủy. Hãy thử lại." }); return;
        }
        sendJson(res, 201, { message: messageResult.data, attachment: { file_name: uploaded.name || fileName, web_view_link: link } }); return;
      } catch (error) {
        console.error("chat attachment upload failed", error?.statusCode || "error", String(error?.message || "").slice(0, 100));
        const status = error?.statusCode === 409 ? 409 : error?.statusCode === 403 ? 403 : error?.statusCode === 413 ? 413 : error?.statusCode === 415 ? 415 : error?.statusCode === 400 ? 400 : 502;
        const driveErrorText = String(error?.message || "").toLowerCase();
        const needsReauth = status === 403 && (driveErrorText.includes("insufficient authentication scopes") || driveErrorText.includes("insufficientpermissions"));
        const message = status === 409 ? "Google Drive chưa được kết nối cho chức năng gửi tệp." : needsReauth ? "Google Drive cần cấp lại quyền upload. Hãy bấm thử lại để cấp quyền." : status === 403 ? "Google Drive từ chối tải tệp. Kiểm tra quyền của tài khoản đã kết nối với thư mục đích." : status === 413 ? "Mỗi tệp tối đa 25 MB." : "Không thể tải tệp lên Google Drive.";
        sendJson(res, status, { error: message }); return;
      }
    }

    if (pathname === "/api/chat/messages" && req.method === "GET") {
      const limitRaw = Number(new URL(req.url, "http://localhost").searchParams.get("limit") || 100);
      const limit = Math.max(1, Math.min(100, Number.isFinite(limitRaw) ? limitRaw : 100));
      const result = await supabase.from("chat_messages")
        .select("id, room_id, sender_name, content, created_at, chat_attachments(id, drive_file_id, file_name, mime_type, size_bytes, web_view_link, thumbnail_link)")
        .eq("room_id", "general").order("created_at", { ascending: true }).limit(limit);
      if (result.error) { console.error("chat messages read failed", result.error.code || "unknown"); sendJson(res, 503, { error: "Could not load chat messages." }); return; }
      sendJson(res, 200, { messages: result.data || [] }); return;
    }

    if (pathname === "/api/chat/messages" && req.method === "POST") {
      let payload;
      try { payload = await readJson(req); }
      catch { sendJson(res, 400, { error: "Invalid request." }); return; }
      const sender = typeof payload.sender_name === "string" ? payload.sender_name.trim().slice(0, 40) : "";
      const content = typeof payload.content === "string" ? payload.content.trim() : "";
      if (!sender || !content || content.length > 4000) {
        sendJson(res, 400, { error: "Enter a name and a message of up to 4000 characters." }); return;
      }
      const result = await supabase.from("chat_messages")
        .insert({ room_id: "general", sender_name: sender, content })
        .select("id, room_id, sender_name, content, created_at").single();
      if (result.error) { console.error("chat message insert failed", result.error.code || "unknown"); sendJson(res, 503, { error: "Could not send message." }); return; }
      sendJson(res, 201, { message: result.data }); return;
    }
    sendJson(res, 404, { error: "Not found" }); return;
  }

  if (pathname === "/health" && req.method === "GET") {
    const configured = Boolean(SUPABASE_URL && (SUPABASE_PUBLISHABLE_KEY || SUPABASE_SERVICE_ROLE_KEY));
    let supabaseReachable = false;
    if (configured) {
      try {
        const key = SUPABASE_SERVICE_ROLE_KEY || SUPABASE_PUBLISHABLE_KEY;
        const response = await fetch(SUPABASE_URL + "/rest/v1/", { method: "GET", headers: { apikey: key, Authorization: "Bearer " + key }, signal: AbortSignal.timeout(5000) });
        supabaseReachable = response.ok;
      } catch { supabaseReachable = false; }
    }
    sendJson(res, configured && supabaseReachable ? 200 : 503, {
      status: configured && supabaseReachable ? "ok" : "degraded",
      service: "cong-viec-backend",
      supabase: { configured, reachable: supabaseReachable, chatPrivilegedKeyConfigured: Boolean(SUPABASE_SERVICE_ROLE_KEY) },
      pinVerificationConfigured: Boolean(ACCESS_PIN && /^\d{6}$/.test(ACCESS_PIN))
    }); return;
  }
  if (pathname === "/" && req.method === "GET") { sendJson(res, 200, { name: "Cong-viec API", health: "/health" }); return; }
  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log("Cong-viec backend listening on port " + PORT));
