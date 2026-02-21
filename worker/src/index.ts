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
      // Lightweight geo endpoint used by the homepage greeting
      if (pathname === "/whoami" && request.method === "GET") {
        return whoami(request);
      }

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

      // Serve static assets + security headers
      const assetRes = await env.ASSETS.fetch(request);
      return withSecurityHeaders(assetRes);
    } catch (e) {
      console.error(e);
      return new Response("Internal Error", { status: 500 });
    }
  },
};

/* ---------------- Security headers applied to all assets ----------------- */
function withSecurityHeaders(res: Response) {
  const h = new Headers(res.headers);
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; script-src 'self' https://challenges.cloudflare.com 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-src https://challenges.cloudflare.com; base-uri 'self'; form-action 'self'"
  );
  h.set("Referrer-Policy", "strict-origin-when-cross-origin");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains; preload");
  return new Response(res.body, { status: res.status, headers: h });
}

/* -------------------------------- whoami --------------------------------- */
async function whoami(request: Request) {
  const cf: any = (request as any).cf || {};
  const payload = {
    city: typeof cf?.city === "string" ? cf.city : null,
    country: typeof cf?.country === "string" ? cf.country : null,
    timezone: typeof cf?.timezone === "string" ? cf.timezone : null,
  };
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/* -------------------------------- contact -------------------------------- */
async function handleContact(request: Request, env: Env) {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";

  const raw = await request.text();
  let body: any = {};
  try {
    body = JSON.parse(raw);
  } catch {
    /* ignore */
  }

  const { name, email, message, turnstileToken } = body || {};
  if (!name || !email || !message || !turnstileToken) {
    return json({ error: "Missing required fields" }, 400);
  }

  // Turnstile verify
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

  // D1 insert
  await env.DB.prepare(
    "INSERT INTO submissions (name, email, message, ip, user_agent) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(name, email, message, ip, ua)
    .run();

  // Gmail send (don't throw on failure)
  const delivered =
    (await sendGmail(env, {
      to: env.GMAIL_SENDER,
      subject: `New contact from ${name}`,
      text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
    }).catch((e) => {
      console.error("Gmail error:", e);
      return false;
    })) || false;

  // Timezone-aware acknowledgement
  const cf: any = (request as any).cf || {};
  const tz = typeof cf?.timezone === "string" ? cf.timezone : undefined;
  const city = typeof cf?.city === "string" ? cf.city : undefined;
  const country = typeof cf?.country === "string" ? cf.country : undefined;
  const where = city && country ? `${city}, ${country}` : country || undefined;

  const ack =
    tz && where
      ? `Thanks! Your message has been received. We’ll reply in your timezone (${tz}) — hello from ${where}!`
      : tz
      ? `Thanks! Your message has been received. We’ll reply in your timezone (${tz}).`
      : `Thanks! Your message has been received.`;

  return json({ ok: true, delivered, timezone: tz || null, where: where || null, message: ack });
}

/* ------------------------------- shortlinks ------------------------------ */
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

/* ------------------------------- resume.pdf ----------------------------- */
async function handleResume(request: Request, env: Env) {
  // Log but **never** block the download if logging fails
  try {
    await env.DB.prepare("INSERT INTO downloads (count, last_download_at) VALUES (1, datetime('now'))").run();
  } catch (e) {
    console.error("downloads insert error:", e);
  }

  const file = await env.ASSETS.fetch(request);
  return withSecurityHeaders(file);
}

/* --------------------------------- badge -------------------------------- */
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
  return new Response(svg.trim(), { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" } });
}

/* -------------------------------- helpers ------------------------------- */
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

async function sendGmail(
  env: Env,
  { to, subject, text }: { to: string; subject: string; text: string }
) {
  // exchange refresh_token → access_token
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