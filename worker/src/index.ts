// worker/src/index.ts

export interface Env {
  // ...existing bindings...
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      // NEW: lightweight whoami endpoint for client-side greeting
      if (pathname === '/whoami' && request.method === 'GET') {
        return whoami(request);
      }

      if (request.method === 'POST' && pathname === '/contact') {
        return handleContact(request, env);
      }
      if (pathname.startsWith('/go/')) {
        return handleShortlink(request, env, pathname.replace('/go/', ''));
      }
      if (pathname === '/resume.pdf') {
        return handleResume(request, env);
      }
      if (pathname === '/badge') {
        return handleBadge(request, env);
      }

      // Serve static assets
      return await env.ASSETS.fetch(request);
    } catch (e) {
      console.error(e);
      return new Response('Internal Error', { status: 500 });
    }
  },
};

// NEW: whoami endpoint – returns coarse location/timezone for greeting
async function whoami(request: Request) {
  const cf: any = (request as any).cf || {};
  const payload = {
    city: typeof cf?.city === 'string' ? cf.city : null,
    country: typeof cf?.country === 'string' ? cf.country : null,
    timezone: typeof cf?.timezone === 'string' ? cf.timezone : null,
  };
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// --- /contact ---
async function handleContact(request: Request, env: Env) {
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const ua = request.headers.get('User-Agent') || '';

  // robust body parse
  const raw = await request.text();
  let body: any = {};
  try { body = JSON.parse(raw); } catch { /* fall through to validation */ }

  const { name, email, message, turnstileToken } = body || {};
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

  // Send email via Gmail (non-blocking for UX)
  const delivered = await sendGmail(env, {
    to: env.GMAIL_SENDER,
    subject: `New contact from ${name}`,
    text: `Name: ${name}\nEmail: ${email}\n\n${message}`,
  }).catch((e) => { console.error('Gmail error:', e); return false; });

  // include timezone and friendly place in the acknowledgement
  const cf: any = (request as any).cf || {};
  const tz = typeof cf?.timezone === 'string' ? cf.timezone : undefined;
  const city = typeof cf?.city === 'string' ? cf.city : undefined;
  const country = typeof cf?.country === 'string' ? cf.country : undefined;
  const where = city && country ? `${city}, ${country}` : country || undefined;

  const ack =
    tz && where
      ? `Thanks! Your message has been received. We’ll reply in your timezone (${tz}) — hello from ${where}!`
      : tz
        ? `Thanks! Your message has been received. We’ll reply in your timezone (${tz}).`
        : `Thanks! Your message has been received.`;

  return json({
    ok: true,
    delivered: !!delivered,
    timezone: tz || null,
    where: where || null,
    message: ack,
  });
}

// ...existing handleShortlink / handleResume / handleBadge / helpers / sendGmail...
function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}