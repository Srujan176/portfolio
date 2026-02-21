export interface Env {
  // Static assets binding (from wrangler.toml)
  ASSETS: Fetcher;

  // Data bindings
  DB: D1Database;           // D1 (we'll create/bind shortly)
  KV: KVNamespace;          // KV (we'll create/bind shortly)

  // Secrets
  GMAIL_CLIENT_ID: string;
  GMAIL_CLIENT_SECRET: string;
  GMAIL_REFRESH_TOKEN: string;
  GMAIL_SENDER: string;
  TURNSTILE_SECRET_KEY: string;

  // Vars
  OPEN_TO_WORK_DEFAULT?: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // Backend routes: handled before assets due to run_worker_first
      if (request.method === 'POST' && pathname === '/contact') {
        return handleContact(request, env);
      }
      if (pathname.startsWith('/go/')) {
        return handleShortlink(request, env, pathname.replace('/go/', ''));
      }
      if (pathname === '/resume.pdf') {
        return handleResume(request, env); // increments counter, then serves file
      }
      if (pathname === '/badge') {
        return handleBadge(request, env);
      }

      // Otherwise, serve static assets from /src
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

// --- /contact ---
async function handleContact(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';
  const body = await request.json().catch(() => ({} as any));

  const { name, email, message, turnstileToken } = body as any;
  if (!name || !email || !message || !turnstileToken) {
    return json({ error: 'Missing required fields' }, 400);
  }

  // Verify Turnstile
  const turnstileRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: new URLSearchParams({
      secret: env.TURNSTILE_SECRET_KEY,
      response: turnstileToken,
      remoteip: ip,
    }),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const tsData = await turnstileRes.json<any>();
  if (!tsData.success) {
    return json({ error: 'Turnstile verification failed' }, 400);
  }

  // Insert into D1
  await env.DB.prepare(
    `INSERT INTO submissions (name, email, message, ip, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).bind(name, email, message, ip, ua).run();

  // Send email via Gmail
  const delivered = await sendGmail(env, {
    to: env.GMAIL_SENDER,
    subject: `New contact from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
  }).catch((e) => { console.error('Gmail error:', e); return false; });

  return json({
    ok: true,
    delivered: !!delivered,
    message: delivered ? 'Thanks! Your message has been sent.' : 'We received your message. Email delivery pending.',
  });
}

// --- /go/:key ---
async function handleShortlink(request: Request, env: Env, key: string) {
  const target = await env.KV.get(`shortlinks:${key}`);
  if (!target) return new Response('Shortlink not found', { status: 404 });

  const ref = new URL(request.url).searchParams.get('ref') || '';
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';

  await env.DB.prepare(
    `INSERT INTO clicks (short_key, target_url, referrer, ip, user_agent) VALUES (?, ?, ?, ?, ?)`
  ).bind(key, target, ref, ip, ua).run();

  return Response.redirect(target, 302);
}

// --- /resume.pdf ---
async function handleResume(request: Request, env: Env) {
  // increment counter
  await env.DB.prepare(
    `INSERT INTO downloads (count, last_download_at) VALUES (1, datetime('now'))`
  ).run();

  // then serve the actual file from static assets
  return env.ASSETS.fetch(request);
}

// --- /badge ---
async function handleBadge(request: Request, env: Env) {
  const flag = (await env.KV.get('open_to_work')) ?? env.OPEN_TO_WORK_DEFAULT ?? 'true';
  const open = flag === 'true';
  const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="190" height="28">
  <rect rx="4" width="190" height="28" fill="${open ? '#2da44e' : '#d73a49'}"/>
  <text x="12" y="19" font-size="14" fill="#fff" font-family="system-ui, -apple-system, Segoe UI, Roboto">
    ${open ? 'Open to Opportunities ✅' : 'Not Open ❌'}
  </text>
</svg>`;
  return new Response(svg.trim(), {
    headers: { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' },
  });
}

// --- helpers ---
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function sendGmail(
  env: Env,
  { to, subject, text }: { to: string; subject: string; text: string }
) {
  // 1) get access token
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GMAIL_CLIENT_ID,
      client_secret: env.GMAIL_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokenRes.ok) return false;
  const data: any = await tokenRes.json();
  const access_token = data.access_token;

  // 2) build RFC 822 message and base64url encode
  const raw = [
    `From: ${env.GMAIL_SENDER}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    '',
    text,
  ].join('\r\n');

  const base64Url = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  // 3) send
  const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: base64Url }),
  });

  return sendRes.ok;
}