import { AppError } from "./errors.ts";
import { store, type Env, type GoogleApp, type Mailbox } from "./store.ts";

export const SCOPES = {
  signIn: ["openid", "email"],
  read: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
};

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export function redirectUri(origin: string): string {
  return `${origin}/auth/callback`;
}

export function authUrl(app: GoogleApp, origin: string, scopes: string[], state: string, opts: { offline: boolean; loginHint?: string }): string {
  const p = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri(origin),
    response_type: "code",
    scope: scopes.join(" "),
    state,
    include_granted_scopes: "false",
  });
  if (opts.offline) {
    p.set("access_type", "offline");
    // Always ask again so Google always returns a long-term (refresh) token.
    p.set("prompt", "consent select_account");
  } else {
    p.set("prompt", "select_account");
  }
  if (opts.loginHint) p.set("login_hint", opts.loginHint);
  return `${AUTH_URL}?${p}`;
}

async function postToken(params: Record<string, string>): Promise<Response> {
  try {
    return await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
  } catch (e) {
    throw new AppError("GOOGLE_UNREACHABLE", String(e), 502);
  }
}

export interface TokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn: number;
  scope: string;
  email: string;
}

function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return "";
  try {
    const part = idToken.split(".")[1];
    const json = JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));
    return json.email_verified === false ? "" : String(json.email ?? "").toLowerCase();
  } catch {
    return "";
  }
}

export async function exchangeCode(app: GoogleApp, origin: string, code: string): Promise<TokenResult> {
  const res = await postToken({
    code,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  if (!res.ok) {
    const err = String(data.error ?? res.status);
    if (err === "invalid_client" || err === "unauthorized_client") throw new AppError("GOOGLE_APP_INVALID", `token: ${err}`);
    if (err === "invalid_grant") throw new AppError("LINK_EXPIRED", `token: ${err} ${data.error_description ?? ""}`);
    throw new AppError("UNKNOWN", `token exchange ${res.status}: ${JSON.stringify(data)}`);
  }
  return {
    accessToken: String(data.access_token),
    refreshToken: data.refresh_token ? String(data.refresh_token) : undefined,
    expiresIn: Number(data.expires_in ?? 3600),
    scope: String(data.scope ?? ""),
    email: emailFromIdToken(data.id_token as string | undefined),
  };
}

// Checks a Client ID / secret pair without any user involved: Google answers
// "invalid_client" for a bad pair and "invalid_grant" for a good pair with a fake code.
export async function testGoogleApp(app: GoogleApp, origin: string): Promise<void> {
  if (!/^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(app.clientId)) {
    throw new AppError("GOOGLE_APP_FORMAT", `client id: ${app.clientId}`);
  }
  const res = await postToken({
    code: "connection-test",
    client_id: app.clientId,
    client_secret: app.clientSecret,
    redirect_uri: redirectUri(origin),
    grant_type: "authorization_code",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string>;
  if (data.error === "invalid_grant") return;
  if (data.error === "invalid_client" || data.error === "unauthorized_client") {
    throw new AppError("GOOGLE_APP_INVALID", `test: ${data.error} ${data.error_description ?? ""}`);
  }
  throw new AppError("UNKNOWN", `test ${res.status}: ${JSON.stringify(data)}`);
}

export async function accessTokenFor(env: Env, mailbox: Mailbox): Promise<string> {
  const cached = await store.getCachedAccessToken(env, mailbox.email);
  if (cached && cached.expiresAt - Date.now() > 60_000) return cached.token;

  const app = await store.getGoogleApp(env);
  if (!app) throw new AppError("GOOGLE_APP_MISSING");
  const res = await postToken({
    refresh_token: mailbox.refreshToken,
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: "refresh_token",
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, string | number>;
  if (!res.ok) {
    const err = String(data.error ?? res.status);
    if (err === "invalid_grant") throw new AppError("MAILBOX_DISCONNECTED", `refresh: ${err} ${data.error_description ?? ""}`);
    if (err === "invalid_client" || err === "unauthorized_client") throw new AppError("GOOGLE_APP_INVALID", `refresh: ${err}`);
    throw new AppError("UNKNOWN", `refresh ${res.status}: ${JSON.stringify(data)}`);
  }
  const token = String(data.access_token);
  await store.cacheAccessToken(env, mailbox.email, token, Number(data.expires_in ?? 3600));
  return token;
}

export async function gmailGet<T>(env: Env, mailbox: Mailbox, path: string, params?: URLSearchParams): Promise<T> {
  const token = await accessTokenFor(env, mailbox);
  let res: Response;
  try {
    res = await fetch(`${GMAIL}${path}${params ? `?${params}` : ""}`, { headers: { authorization: `Bearer ${token}` } });
  } catch (e) {
    throw new AppError("GOOGLE_UNREACHABLE", String(e), 502);
  }
  if (res.ok) return (await res.json()) as T;
  const text = await res.text();
  if (res.status === 403 && /SERVICE_DISABLED|accessNotConfigured|has not been used in project/.test(text)) {
    throw new AppError("GMAIL_API_DISABLED", text.slice(0, 500));
  }
  if (res.status === 403 && /insufficient|PERMISSION_DENIED/i.test(text)) {
    throw new AppError("GMAIL_PERMISSION_UNCHECKED", text.slice(0, 500));
  }
  if (res.status === 401) throw new AppError("MAILBOX_DISCONNECTED", text.slice(0, 500));
  if (res.status === 429) throw new AppError("GOOGLE_RATE_LIMIT", text.slice(0, 500));
  if (res.status === 404) throw new AppError("UNKNOWN", `Not found: ${path}`);
  throw new AppError("UNKNOWN", `gmail ${res.status} ${path}: ${text.slice(0, 500)}`);
}

// ---------- Gmail message parsing ----------

interface GmailHeader { name: string; value: string }
interface GmailPart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPart[];
}
export interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailPart;
}

export function header(m: GmailMessage, name: string): string {
  const h = m.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? "";
}

function decodeBody(data: string): string {
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `${text} [${href}]`)
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function bodyText(part: GmailPart | undefined): { text: string; attachments: string[] } {
  const attachments: string[] = [];
  let plain = "";
  let html = "";
  const walk = (p: GmailPart) => {
    if (p.filename) attachments.push(p.filename);
    else if (p.mimeType === "text/plain" && p.body?.data && !plain) plain = decodeBody(p.body.data);
    else if (p.mimeType === "text/html" && p.body?.data && !html) html = decodeBody(p.body.data);
    p.parts?.forEach(walk);
  };
  if (part) walk(part);
  return { text: plain || (html ? htmlToText(html) : ""), attachments };
}
