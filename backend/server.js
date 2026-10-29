const http = require("node:http");

const PORT = Number(process.env.PORT) || 3000;
const SUPABASE_URL = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || "";

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
    });
    res.end();
    return;
  }

  const pathname = new URL(req.url, "http://localhost").pathname;

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
        // Any HTTP response confirms network/API reachability. Auth/config errors
        // are reported as unreachable for this smoke test; no credentials are returned.
        supabaseReachable = response.ok;
      } catch {
        supabaseReachable = false;
      }
    }

    sendJson(res, configured && supabaseReachable ? 200 : 503, {
      status: configured && supabaseReachable ? "ok" : "degraded",
      service: "cong-viec-backend",
      supabase: {
        configured,
        reachable: supabaseReachable,
      },
    });
    return;
  }

  if (pathname === "/" && req.method === "GET") {
    sendJson(res, 200, {
      name: "Cong-viec API",
      health: "/health",
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Cong-viec backend listening on port ${PORT}`);
});
