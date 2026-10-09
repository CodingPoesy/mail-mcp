import { randomToken, safeEqual, sha256, sign, verify } from "./crypto.ts";
import { AppError, ERRORS, describe, type ErrorCode } from "./errors.ts";
import { SCOPES, authUrl, exchangeCode, gmailGet, redirectUri, testGoogleApp } from "./google.ts";
import { handleMcp } from "./mcp.ts";
import { store, type Env } from "./store.ts";
import { setupPage } from "./ui.ts";

const SESSION_COOKIE = "mm_session";
const SESSION_TTL = 12 * 3600;

interface Session { who: string }
interface OAuthState { kind: "owner" | "mailbox"; mode?: "read" }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    try {
      return await route(request, env, url);
    } catch (e) {
      const { code, technical } = describe(e);
      console.error("unhandled", code, technical);
      if (url.pathname.startsWith("/api/")) return apiError(code, technical, e instanceof AppError ? e.status : 500);
      return redirect(`/setup?error=${code}`);
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env, url: URL): Promise<Response> {
  const { pathname } = url;
  const origin = url.origin;

  if (!env.OWNER_EMAIL || !env.SETUP_PASSWORD) {
    return new Response(
      "This connector is missing OWNER_EMAIL or SETUP_PASSWORD. Add them in Cloudflare → Workers → mail-mcp → Settings → Variables and Secrets, then reload.",
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }

  if (pathname === "/mcp") return mcp(request, env, origin);
  if (pathname === "/" || pathname === "") return redirect("/setup");
  if (pathname === "/healthz") return new Response("ok");
  if (pathname === "/setup" && request.method === "GET") {
    return new Response(setupPage(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  }

  if (pathname === "/auth/owner") {
    const app = await store.getGoogleApp(env);
    if (!app) return redirect("/setup?error=GOOGLE_APP_MISSING");
    const state = await sign(env.SETUP_PASSWORD, { kind: "owner" } satisfies OAuthState, 600);
    return redirect(authUrl(app, origin, SCOPES.signIn, state, { offline: false, loginHint: env.OWNER_EMAIL }));
  }
  if (pathname === "/auth/mailbox") {
    if (!(await session(request, env))) return redirect("/setup?error=SESSION_EXPIRED");
    const app = await store.getGoogleApp(env);
    if (!app) return redirect("/setup?error=GOOGLE_APP_MISSING");
    const state = await sign(env.SETUP_PASSWORD, { kind: "mailbox", mode: "read" } satisfies OAuthState, 600);
    const hint = url.searchParams.get("hint") ?? undefined;
    return redirect(authUrl(app, origin, SCOPES.read, state, { offline: true, loginHint: hint }));
  }
  if (pathname === "/auth/callback") return callback(request, env, url);

  if (pathname.startsWith("/api/")) {
    if (request.method === "POST") {
      // Same-origin only: blocks other websites from driving this page.
      const from = request.headers.get("origin");
      if (from && from !== origin) return apiError("SESSION_EXPIRED", `origin ${from}`, 403);
    }
    if (pathname === "/api/login" && request.method === "POST") return login(request, env);
    const s = await session(request, env);
    if (!s) return apiError("SESSION_EXPIRED", "", 401);
    return api(request, env, url, s);
  }

  return new Response("Not found", { status: 404 });
}

// ---------- helpers ----------

function redirect(to: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 302, headers: { location: to, ...headers } });
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}

function apiError(code: ErrorCode, technical: string, status = 400): Response {
  return json({ ok: false, error: { code, ...ERRORS[code], technical } }, status);
}

function cookie(value: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function session(request: Request, env: Env): Promise<Session | null> {
  const raw = request.headers.get("cookie") ?? "";
  const m = raw.match(new RegExp(`(?:^|; )${SESSION_COOKIE}=([^;]+)`));
  return verify<Session>(env.SETUP_PASSWORD, m?.[1]);
}

async function newSessionCookie(env: Env, who: string): Promise<string> {
  return cookie(await sign(env.SETUP_PASSWORD, { who } satisfies Session, SESSION_TTL), SESSION_TTL);
}

// ---------- MCP ----------

async function mcp(request: Request, env: Env, origin: string): Promise<Response> {
  const { hash } = await store.getClaudeKey(env);
  const unauthorized = (code: ErrorCode) =>
    new Response(JSON.stringify({ error: code, message: ERRORS[code].message, action: ERRORS[code].action, setup: `${origin}/setup#step-claude` }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  if (!hash) return unauthorized("CLAUDE_KEY_MISSING");
  const auth = request.headers.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!key || !safeEqual(await sha256(key), hash)) return unauthorized("CLAUDE_KEY_WRONG");
  return handleMcp(request, env, `${origin}/setup`);
}

// ---------- OAuth callback ----------

async function callback(request: Request, env: Env, url: URL): Promise<Response> {
  const state = await verify<OAuthState>(env.SETUP_PASSWORD, url.searchParams.get("state"));
  if (!state) return redirect("/setup?error=LINK_EXPIRED");
  const gErr = url.searchParams.get("error");
  if (gErr) return redirect(`/setup?error=${gErr === "access_denied" ? "ACCESS_DENIED" : "UNKNOWN"}`);
  const code = url.searchParams.get("code");
  const app = await store.getGoogleApp(env);
  if (!code || !app) return redirect("/setup?error=LINK_EXPIRED");

  const tokens = await exchangeCode(app, url.origin, code);

  if (state.kind === "owner") {
    if (!tokens.email || tokens.email !== env.OWNER_EMAIL.trim().toLowerCase()) {
      return redirect("/setup?error=WRONG_ACCOUNT");
    }
    return redirect("/setup", { "set-cookie": await newSessionCookie(env, tokens.email) });
  }

  // Adding a mailbox: only the signed-in owner may do it.
  if (!(await session(request, env))) return redirect("/setup?error=SESSION_EXPIRED");
  if (!tokens.scope.split(" ").includes("https://www.googleapis.com/auth/gmail.readonly")) {
    return redirect("/setup?error=GMAIL_PERMISSION_UNCHECKED");
  }
  if (!tokens.refreshToken) return redirect("/setup?error=NO_LONG_TERM_ACCESS");
  if (!tokens.email) return redirect("/setup?error=UNKNOWN");

  await store.saveMailbox(env, {
    email: tokens.email,
    mode: state.mode ?? "read",
    refreshToken: tokens.refreshToken,
    connectedAt: new Date().toISOString(),
    status: "ok",
  });
  await store.cacheAccessToken(env, tokens.email, tokens.accessToken, tokens.expiresIn);
  await store.log(env, { mailbox: tokens.email, action: "connected", detail: "read only", ok: true });
  return redirect(`/setup?added=${encodeURIComponent(tokens.email)}#step-mailboxes`);
}

// ---------- setup API ----------

async function login(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const given = await sha256(String(body.password ?? ""));
  if (!safeEqual(given, await sha256(env.SETUP_PASSWORD))) return apiError("SETUP_PASSWORD_WRONG", "", 401);
  return json({ ok: true }, 200, { "set-cookie": await newSessionCookie(env, "setup-password") });
}

async function api(request: Request, env: Env, url: URL, s: Session): Promise<Response> {
  const origin = url.origin;
  const body = request.method === "POST" ? ((await request.json().catch(() => ({}))) as Record<string, string>) : {};

  switch (`${request.method} ${url.pathname}`) {
    case "POST /api/logout":
      return json({ ok: true }, 200, { "set-cookie": cookie("", 0) });

    case "GET /api/status": {
      const [app, mailboxes, key, journal] = await Promise.all([
        store.getGoogleApp(env),
        store.listMailboxes(env),
        store.getClaudeKey(env),
        store.journal(env),
      ]);
      const steps = { google: !!app, mailboxes: mailboxes.length > 0, claude: !!key.hash };
      return json({
        ok: true,
        signedInAs: s.who,
        owner: env.OWNER_EMAIL,
        redirectUri: redirectUri(origin),
        mcpUrl: `${origin}/mcp`,
        googleApp: app ? { configured: true, clientId: app.clientId } : { configured: false },
        mailboxes: mailboxes.map((m) => ({
          email: m.email,
          mode: m.mode,
          status: m.status,
          problem: m.status === "error" && m.lastError ? ERRORS[m.lastError as ErrorCode] ?? ERRORS.UNKNOWN : null,
          connectedAt: m.connectedAt,
          lastCheckedAt: m.lastCheckedAt,
        })),
        claudeKey: { exists: !!key.hash, createdAt: key.createdAt },
        steps,
        journal: journal.slice(0, 20),
      });
    }

    case "POST /api/google-app": {
      const app = { clientId: String(body.clientId ?? "").trim(), clientSecret: String(body.clientSecret ?? "").trim() };
      if (!app.clientSecret) throw new AppError("GOOGLE_APP_INVALID", "empty secret");
      await testGoogleApp(app, origin);
      await store.setGoogleApp(env, app);
      await store.log(env, { mailbox: "-", action: "google-app", detail: "saved and tested", ok: true });
      return json({ ok: true });
    }

    case "POST /api/mailboxes/remove": {
      await store.removeMailbox(env, String(body.email ?? "").toLowerCase());
      await store.log(env, { mailbox: String(body.email), action: "removed", detail: "", ok: true });
      return json({ ok: true });
    }

    case "POST /api/claude-key": {
      const key = `mmk_${randomToken(32)}`;
      await store.setClaudeKeyHash(env, await sha256(key));
      await store.log(env, { mailbox: "-", action: "claude-key", detail: "new key created", ok: true });
      return json({ ok: true, key });
    }

    case "POST /api/diagnostics":
      return json({ ok: true, checks: await diagnostics(env, origin) });
  }
  return apiError("UNKNOWN", `no route ${request.method} ${url.pathname}`, 404);
}

interface Check {
  id: string;
  label: string;
  ok: boolean;
  code?: ErrorCode;
  message?: string;
  action?: string;
  href?: string;
  technical?: string;
}

async function diagnostics(env: Env, origin: string): Promise<Check[]> {
  const checks: Check[] = [];
  const fail = (id: string, label: string, e: unknown): Check => {
    const { code, technical } = describe(e);
    return { id, label, ok: false, code, ...ERRORS[code], technical };
  };

  try {
    await env.MAIL_KV.put("diagnostics:probe", new Date().toISOString(), { expirationTtl: 60 });
    checks.push({ id: "storage", label: "Connector storage", ok: true });
  } catch (e) {
    checks.push(fail("storage", "Connector storage", new AppError("STORAGE_ERROR", String(e))));
  }

  const app = await store.getGoogleApp(env).catch(() => null);
  if (!app) {
    checks.push(fail("google-app", "Google app", new AppError("GOOGLE_APP_MISSING")));
  } else {
    try {
      await testGoogleApp(app, origin);
      checks.push({ id: "google-app", label: "Google app", ok: true });
    } catch (e) {
      checks.push(fail("google-app", "Google app", e));
    }
  }

  const mailboxes = await store.listMailboxes(env).catch(() => []);
  if (mailboxes.length === 0) {
    checks.push(fail("mailboxes", "Mailboxes", new AppError("MAILBOX_NOT_FOUND", "no mailbox connected")));
  }
  for (const m of mailboxes) {
    const label = `Mailbox ${m.email}`;
    try {
      await gmailGet(env, m, "/profile");
      await store.markMailbox(env, m.email, true);
      checks.push({ id: `mailbox:${m.email}`, label, ok: true });
    } catch (e) {
      await store.markMailbox(env, m.email, false, describe(e).code);
      checks.push(fail(`mailbox:${m.email}`, label, e));
    }
  }

  const key = await store.getClaudeKey(env);
  checks.push(
    key.hash
      ? { id: "claude", label: "Claude access key", ok: true }
      : fail("claude", "Claude access key", new AppError("CLAUDE_KEY_MISSING")),
  );
  return checks;
}
