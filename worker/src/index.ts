export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  KV: KVNamespace;

  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_SENDER: string;

  TURNSTILE_SECRET_KEY: string;
  OPEN_TO_WORK_DEFAULT?: string;
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // ── Routes (no /whoami; all timezone logic removed) ────────────────────────
      if (request.method === "POST" && pathname === "/contact") {
        return handleContact(request, env);
      }

      if (pathname.startsWith("/go/")) {
        const key = pathname.replace("/go/", "");
        return handleShortlink(request, env, key);
      }

      if (pathname === "/resume.pdf") {
        return handleResume(request, env);
      }

      if (pathname === "/badge") {
        return handleBadge(request, env);
      }

      // Default: serve static assets (add security + cache headers)
      const assetRes = await env.ASSETS.fetch(request);
      return withSecurityAndCacheHeaders(assetRes);
    } catch (e) {
      console.error(e);
      return new Response("Internal Error", { status: 500 });
    }
  },
};

/* ─────────────────────────── Security & Caching ─────────────────────────── */

function withSecurityAndCacheHeaders(res: Response) {
  const h = new Headers(res.headers);

  // Strict CSP for scripts (no inline JS needed by this site)
  h.set(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data:",
      "script-src 'self' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'", // keep until all styles are external
      "connect-src 'self'",
      "frame-src https://challenges.cloudflare.com",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ")
  );

  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  h.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  // Cache policy: HTML no-store, assets cache a week (immutable)
  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  if (ct.includes("text/html")) {
    h.set("Cache-Control", "no-store"); // HTML should revalidate on each visit
  } else if (
    ct.includes("javascript") ||
    ct.includes("text/css") ||
    ct.startsWith("image/") ||
    ct.includes("application/pdf")
  ) {
    h.set("Cache-Control", "public, max-age=604800, immutable"); // 7 days
  }

  return new Response(res.body, { status: res.status, headers: h });
}

/* ───────────────────────────── /contact (POST) ───────────────────────────── */

async function handleContact(request: Request, env: Env) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";

  // Size cap to protect the Worker
  const contentLength = Number(request.headers.get("Content-Length") || "0");
  if (contentLength > 65_536) {
    return json({ error: "Payload too large" }, 413);
  }

  // Basic rate limit: 5 requests / 10 minutes / IP
  if (!(await rateLimit(env, ip))) {
    return json({ error: "Too many requests, please try again later." }, 429);
  }

  // Parse body
  const raw = await request.text();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { name, email, message, turnstileToken } = body || {};

  // Field presence
  if (!name || !email || !message || !turnstileToken) {
    return json({ error: "Missing required fields" }, 400);
  }

  // Length caps
  if ((name + "").length > 200 || (email + "").length > 320 || (message + "").length > 5000) {
    return json({ error: "Input too long" }, 400);
  }

  // Simple email sanity check
  const emailOk = /^[^@\s]{1,64}@[^\s@]{1,255}$/.test(email);
  if (!emailOk) return json({ error: "Invalid email" }, 400);

  // Turnstile verification
  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: turnstileToken,
      remoteip: ip,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const ts = await verify.json<any>();
  if (!ts.success) return json({ error: "Turnstile verification failed" }, 400);

  // Insert into D1
  await env.DB.prepare(
    "INSERT INTO submissions (name, email, message, ip, user_agent) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(name, email, message, ip, ua)
    .run();

  // Try email (non-blocking UX)
  const delivered =
    (await sendGmail(env, {
      to: env.GMAIL_SENDER,
      subject: `New contact from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    }).catch((e) => {
      console.error("Gmail error:", e);
      return false;
    })) || false;

  // Generic acknowledgement (no timezone text)
  return json({
    ok: true,
    delivered,
    message: "Thanks! Your message has been received.",
  });
}

/* ─────────────────────────────── /go/:key ──────────────────────────────── */

async function handleShortlink(request: Request, env: Env, key: string) {
  const target = await env.KV.get(`shortlinks:${key}`);
  if (!target) return new Response("Shortlink not found", { status: 404 });

  const ref = new URL(request.url).searchParams.get("ref") || "";
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";

  await env.DB.prepare(
    "INSERT INTO clicks (short_key, target_url, referrer, ip, user_agent) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(key, target, ref, ip, ua)
    .run();

  return Response.redirect(target, 302);
}

/* ────────────────────────────── /resume.pdf ────────────────────────────── */

async function handleResume(request: Request, env: Env) {
  // Log download but NEVER block the file
  try {
    await env.DB.prepare(
      "INSERT INTO downloads (count, last_download_at) VALUES (1, datetime('now'))"
    ).run();
  } catch (e) {
    console.error("downloads insert error:", e);
  }

  const file = await env.ASSETS.fetch(request);
  return withSecurityAndCacheHeaders(file);
}

/* ───────────────────────────────── /badge ──────────────────────────────── */

async function handleBadge(_request: Request, env: Env) {
  const flag = (await env.KV.get("open_to_work")) ?? env.OPEN_TO_WORK_DEFAULT ?? "true";
  const open = flag === "true";
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="190" height="28">
  <rect rx="4" width="190" height="28" fill="${open ? "#2da44e" : "#d73a49"}"/>
  <text x="12" y="19" font-size="14" fill="#fff" font-family="system-ui, -apple-system, Segoe UI, Roboto">
    ${open ? "Open to Opportunities ✅" : "Not Open ❌"}
  </text>
</svg>`;
  return new Response(svg.trim(), {
    headers: {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "no-store",
    },
  });
}

/* ──────────────────────────────── Helpers ──────────────────────────────── */

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Very small token bucket per-IP using KV
async function rateLimit(env: Env, ip: string, now = Date.now()) {
  const key = `rl:contact:${ip}`;
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const limit = 5;

  const recRaw = await env.KV.get(key);
  let rec: { count: number; reset: number } = recRaw ? JSON.parse(recRaw) : { count: 0, reset: now + windowMs };

  if (now > rec.reset) rec = { count: 0, reset: now + windowMs };
  rec.count += 1;

  await env.KV.put(key, JSON.stringify(rec), {
    expirationTtl: Math.ceil((rec.reset - now) / 1000),
  });

  return rec.count <= limit;
}

async function sendGmail(
  env: Env,
  { to, subject, text }: { to: string; subject: string; text: string }
) {
  // Exchange refresh_token → access_token
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) return false;
  const data: any = await tokenRes.json();
  const access_token = data.access_token;

  const raw = [
    `From: ${env.GMAIL_SENDER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    "",
    text,
  ].join("\r\n");

  // URL-safe base64
  const base64Url = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  const sendRes = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ raw: base64Url }),
  });

  return sendRes.ok;
}