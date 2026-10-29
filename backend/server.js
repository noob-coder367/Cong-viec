const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";
const ACCESS_PIN = process.env.ACCESS_PIN || "";
const attempts = new Map();
const WINDOW_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 10;

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "Pragma": "no-cache",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

function getClientKey(req) {
  // Render terminates TLS in front of the app. Use the first forwarded IP for
  // a lightweight per-IP throttle; never log the submitted PIN.
  return (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
    .toString().split(",")[0].trim().slice(0, 80);
}

async function readJson(req, maxBytes = 2048) {
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

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      "Access-Control-Max-Age": "600",
    });
    res.end();
    return;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;

  if (pathname === "/api/verify-pin" && req.method === "POST") {
    if (!ACCESS_PIN || !/^\d{6}$/.test(ACCESS_PIN)) {
      sendJson(res, 503, { error: "PIN verification is not configured" });
      return;
    }
    const key = getClientKey(req);
    const now = Date.now();
    const entry = attempts.get(key);
    if (entry && now - entry.startedAt < WINDOW_MS && entry.count >= MAX_ATTEMPTS) {
      sendJson(res, 429, { valid: false, error: "Too many attempts" });
      return;
    }
    if (!entry || now - entry.startedAt >= WINDOW_MS) attempts.set(key, { startedAt: now, count: 1 });
    else entry.count += 1;

    let payload;
    try {
      payload = await readJson(req);
    } catch {
      sendJson(res, 400, { valid: false, error: "Invalid request" });
      return;
    }
    const pin = typeof payload.pin === "string" ? payload.pin : "";
    if (pinMatches(pin)) {
      attempts.delete(key);
      sendJson(res, 200, { valid: true });
    } else {
      sendJson(res, 401, { valid: false });
    }
    // Bound memory usage if many unique clients hit the endpoint.
    if (attempts.size > 10000) {
      for (const [ip, value] of attempts) {
        if (now - value.startedAt >= WINDOW_MS) attempts.delete(ip);
      }
    }
    return;
  }

  if (pathname === "/health" && req.method === "GET") {
    const configured = Boolean(SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY);
    let supabaseReachable = false;
    if (configured) {
      try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/`, {
          method: "GET",
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
          },
          signal: AbortSignal.timeout(5000),
        });
        supabaseReachable = response.ok;
      } catch {
        supabaseReachable = false;
      }
    }
    sendJson(res, configured && supabaseReachable ? 200 : 503, {
      status: configured && supabaseReachable ? "ok" : "degraded",
      service: "cong-viec-backend",
      supabase: { configured, reachable: supabaseReachable },
      pinVerificationConfigured: Boolean(ACCESS_PIN && /^\d{6}$/.test(ACCESS_PIN)),
    });
    return;
  }

  if (pathname === "/" && req.method === "GET") {
    sendJson(res, 200, { name: "Cong-viec API", health: "/health" });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cong-viec backend listening on port ${PORT}`);
});
