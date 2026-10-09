// End-to-end test of the Worker with an in-memory KV and a fake Google.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { setupPage } from "../src/ui.ts";

const ORIGIN = "https://mail-mcp.example.workers.dev";
const CLIENT_ID = "123456-abc.apps.googleusercontent.com";

function memoryKV() {
  const m = new Map<string, string>();
  return {
    async get(k: string, type?: string) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k: string, v: string) { m.set(k, v); },
    async delete(k: string) { m.delete(k); },
  };
}

function idToken(email: string) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b({ alg: "none" })}.${b({ email, email_verified: true })}.sig`;
}

const b64 = (s: string) => Buffer.from(s).toString("base64url");
let gmailDisabled = false;

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const body = init?.body ? new URLSearchParams(String(init.body)) : null;
  const j = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });
  if (url.href === "https://oauth2.googleapis.com/token") {
    if (body!.get("client_secret") !== "good-secret") return j({ error: "invalid_client" }, 401);
    if (body!.get("code") === "connection-test") return j({ error: "invalid_grant" }, 400);
    if (body!.get("grant_type") === "refresh_token") return j({ access_token: "at2", expires_in: 3600 });
    if (body!.get("code") === "owner-code") return j({ access_token: "x", expires_in: 3600, scope: "openid email", id_token: idToken("owner@gmail.com") });
    if (body!.get("code") === "box-code") return j({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/userinfo.email", id_token: idToken("box@gmail.com") });
    if (body!.get("code") === "box-unticked") return j({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "openid email", id_token: idToken("box@gmail.com") });
  }
  if (url.hostname === "gmail.googleapis.com") {
    if (gmailDisabled) return new Response('{"error":{"status":"PERMISSION_DENIED","details":[{"reason":"SERVICE_DISABLED"}]}}', { status: 403 });
    if (url.pathname.endsWith("/profile")) return j({ emailAddress: "box@gmail.com", messagesTotal: 42 });
    if (url.pathname.endsWith("/threads")) return j({ threads: [{ id: "t1" }] });
    if (url.pathname.endsWith("/threads/t1")) {
      const msg = (id: string, from: string, labels: string[], text: string) => ({
        id, threadId: "t1", labelIds: labels, snippet: text.slice(0, 20), internalDate: "1791545863000",
        payload: { headers: [{ name: "From", value: from }, { name: "Subject", value: "Hello" }], mimeType: "multipart/alternative",
          parts: [{ mimeType: "text/plain", body: { data: b64(text) } }, { mimeType: "application/pdf", filename: "a.pdf", body: { attachmentId: "x" } }] },
      });
      return j({ id: "t1", messages: [msg("m1", "Box <box@gmail.com>", ["SENT"], "Question?"), msg("m2", "Fred <fred@x.com>", ["INBOX", "UNREAD"], "Réponse ✓")] });
    }
  }
  throw new Error(`unexpected fetch ${url.href}`);
}) as typeof fetch;

const env = { MAIL_KV: memoryKV(), OWNER_EMAIL: "owner@gmail.com", SETUP_PASSWORD: "pw-123456" } as any;
let cookie = "";
async function req(path: string, init: RequestInit & { json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (cookie) headers.set("cookie", cookie);
  if (init.json !== undefined) { headers.set("content-type", "application/json"); headers.set("origin", ORIGIN); }
  const res = await worker.fetch(new Request(ORIGIN + path, { method: init.method ?? (init.json !== undefined ? "POST" : "GET"), headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body }), env);
  const sc = res.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  return res;
}
const stateFrom = (res: Response) => new URL(res.headers.get("location")!).searchParams.get("state")!;

test("setup page script is valid JavaScript", () => {
  const html = setupPage();
  const js = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(js));
});

test("API refuses without session, wrong password gives a clear error", async () => {
  assert.equal((await req("/api/status")).status, 401);
  const r = await (await req("/api/login", { json: { password: "nope" } })).json() as any;
  assert.equal(r.error.code, "SETUP_PASSWORD_WRONG");
  assert.match(r.error.message, /password/);
});

test("full setup flow", async () => {
  assert.equal((await req("/api/login", { json: { password: "pw-123456" } })).status, 200);

  let r = await (await req("/api/google-app", { json: { clientId: "bad", clientSecret: "x" } })).json() as any;
  assert.equal(r.error.code, "GOOGLE_APP_FORMAT");
  r = await (await req("/api/google-app", { json: { clientId: CLIENT_ID, clientSecret: "wrong" } })).json() as any;
  assert.equal(r.error.code, "GOOGLE_APP_INVALID");
  r = await (await req("/api/google-app", { json: { clientId: CLIENT_ID, clientSecret: "good-secret" } })).json() as any;
  assert.equal(r.ok, true);

  // Owner signs in with Google.
  const saved = cookie; cookie = "";
  let res = await req("/auth/owner");
  assert.match(res.headers.get("location")!, /accounts\.google\.com/);
  res = await req(`/auth/callback?code=owner-code&state=${encodeURIComponent(stateFrom(res))}`);
  assert.equal(res.headers.get("location"), "/setup");
  assert.ok(cookie, "owner gets a session");
  cookie = saved;

  // Unticked Gmail permission is detected.
  res = await req("/auth/mailbox");
  res = await req(`/auth/callback?code=box-unticked&state=${encodeURIComponent(stateFrom(res))}`);
  assert.equal(res.headers.get("location"), "/setup?error=GMAIL_PERMISSION_UNCHECKED");

  res = await req("/auth/mailbox");
  assert.match(res.headers.get("location")!, /access_type=offline/);
  res = await req(`/auth/callback?code=box-code&state=${encodeURIComponent(stateFrom(res))}`);
  assert.match(res.headers.get("location")!, /added=box%40gmail\.com/);

  // Tampered state is refused.
  res = await req(`/auth/callback?code=box-code&state=abc.def`);
  assert.equal(res.headers.get("location"), "/setup?error=LINK_EXPIRED");

  const status = await (await req("/api/status")).json() as any;
  assert.deepEqual(status.steps, { google: true, mailboxes: true, claude: false });
  assert.equal(status.mailboxes[0].email, "box@gmail.com");
  assert.equal(JSON.stringify(status).includes("rt"), false, "refresh token never leaves the server");
});

test("MCP: key required, then tools work and are read-only", async () => {
  const rpc = (key: string | null, body: object) =>
    worker.fetch(new Request(ORIGIN + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) }), env);

  let res = await rpc(null, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(res.status, 401);
  assert.equal(((await res.json()) as any).error, "CLAUDE_KEY_MISSING");

  const { key } = await (await req("/api/claude-key", { json: {} })).json() as any;
  assert.equal((await rpc("wrong", { jsonrpc: "2.0", id: 1, method: "ping" })).status, 401);

  const init = await (await rpc(key, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json() as any;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal((await rpc(key, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);

  const list = await (await rpc(key, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json() as any;
  const names = list.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["list_mailboxes", "health", "search_threads", "get_thread"]);
  assert.ok(list.result.tools.every((t: any) => t.annotations.readOnlyHint));

  const call = async (name: string, args: object = {}) =>
    ((await (await rpc(key, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } })).json()) as any).result;

  let r = await call("health");
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /OK box@gmail.com \(42 messages\)/);

  r = await call("search_threads", { query: "in:inbox" });
  const found = JSON.parse(r.content[0].text.split("\n").slice(1).join("\n"));
  assert.equal(found.threads[0].last_from, "Fred <fred@x.com>");
  assert.equal(found.threads[0].last_is_from_owner, false);
  assert.equal(found.threads[0].unread, true);

  r = await call("get_thread", { thread_id: "t1" });
  const th = JSON.parse(r.content[0].text.split("\n").slice(1).join("\n"));
  assert.equal(th.messages[1].body, "Réponse ✓");
  assert.equal(th.messages[0].from_owner, true);
  assert.deepEqual(th.messages[0].attachments, ["a.pdf"]);

  r = await call("search_threads", { mailbox: "other@gmail.com", query: "x" });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /ERROR MAILBOX_NOT_FOUND/);

  gmailDisabled = true;
  r = await call("health");
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Gmail access isn't turned on/);
  const diag = await (await req("/api/diagnostics", { json: {} })).json() as any;
  const box = diag.checks.find((c: any) => c.id === "mailbox:box@gmail.com");
  assert.equal(box.code, "GMAIL_API_DISABLED");
  gmailDisabled = false;
});

test("cross-site POST is refused", async () => {
  const res = await worker.fetch(new Request(ORIGIN + "/api/claude-key", { method: "POST", headers: { cookie, origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), env);
  assert.equal(res.status, 403);
});
