// The setup page: one screen to install, check and fix the connector.
// Plain HTML + vanilla JS, no build step. All dynamic text goes through esc().

import { ERRORS } from "./errors.ts";

const CSS = `
:root{--bg:#f7f7f5;--card:#fff;--ink:#1d1d1b;--muted:#6b6b66;--line:#e4e4df;--accent:#2f5bd3;--ok:#1f8a4c;--bad:#c2372b;--warn:#b7791f;--soft:#eef2fd}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--ink:#ecece8;--muted:#a3a39c;--line:#33332f;--accent:#7b9cff;--ok:#4cc27e;--bad:#ff7a6e;--warn:#e0a84a;--soft:#232a3d}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:0}p{margin:8px 0}
.muted{color:var(--muted)}.small{font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px;margin:14px 0}
.step-head{display:flex;align-items:center;gap:10px}
.badge{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:var(--soft);color:var(--accent);font-weight:600;font-size:13px;flex:none}
.badge.done{background:var(--ok);color:#fff}
.progress{height:8px;background:var(--line);border-radius:4px;overflow:hidden;margin:10px 0 4px}.progress>div{height:100%;background:var(--accent);transition:width .3s}
button,.btn{font:inherit;border:1px solid var(--accent);background:var(--accent);color:#fff;border-radius:8px;padding:8px 14px;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}button.danger{background:transparent;border-color:var(--bad);color:var(--bad)}
button:disabled{opacity:.5;cursor:default}
input,select{font:inherit;width:100%;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);margin:4px 0 10px}
label{font-weight:600;font-size:13px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.copy{display:flex;gap:8px;align-items:center;margin:6px 0}.copy code{flex:1;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px;overflow-x:auto;white-space:nowrap}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:12.5px}
ol{padding-left:20px}li{margin:4px 0}
.alert{border-radius:10px;padding:12px 14px;margin:12px 0;border:1px solid}
.alert.bad{border-color:var(--bad);background:color-mix(in srgb,var(--bad) 8%,transparent)}
.alert.ok{border-color:var(--ok);background:color-mix(in srgb,var(--ok) 8%,transparent)}
.alert b{display:block;margin-bottom:2px}
.row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--line);flex-wrap:wrap}
.row:first-child{border-top:0}
.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:6px}.dot.ok{background:var(--ok)}.dot.bad{background:var(--bad)}
.tip{background:var(--soft);border-radius:10px;padding:10px 12px;margin:10px 0;font-size:14px}
table{width:100%;border-collapse:collapse;font-size:13px}td{padding:5px 4px;border-top:1px solid var(--line);vertical-align:top}
.hidden{display:none}
`;

const SCRIPT = `
const ERRORS = ${JSON.stringify(ERRORS)};
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let state = null;

function alertBox(kind, title, text, href, actionLabel) {
  const btn = href ? ' <a class="btn ghost" style="margin-top:8px" href="' + esc(href) + '"' + (href.startsWith("http") ? ' target="_blank" rel="noopener"' : "") + '>' + esc(actionLabel || "Fix it") + '</a>' : "";
  return '<div class="alert ' + kind + '"><b>' + esc(title) + '</b>' + esc(text) + btn + '</div>';
}
function errorBox(err) {
  const e = err && err.code ? err : (ERRORS[err] ? { ...ERRORS[err], code: err } : ERRORS.UNKNOWN);
  return alertBox("bad", e.message, e.action, e.href, "Show me");
}
async function call(path, body) {
  let res;
  try {
    res = await fetch(path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch { return { ok: false, error: { ...ERRORS.GOOGLE_UNREACHABLE, message: "This page can't reach the connector.", action: "Check your internet connection and retry." } }; }
  const data = await res.json().catch(() => ({ ok: false, error: ERRORS.UNKNOWN }));
  if (res.status === 401 && path !== "/api/login") { showLogin(); }
  return data;
}
function copyBtn(text) { return '<button class="ghost" data-copy="' + esc(text) + '">Copy</button>'; }
document.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-copy]");
  if (t) { await navigator.clipboard.writeText(t.dataset.copy); const old = t.textContent; t.textContent = "Copied ✓"; setTimeout(() => (t.textContent = old), 1500); }
});

function showLogin(msg) {
  $("#app").innerHTML =
    '<div class="card"><h2>Sign in</h2><p class="muted">This page belongs to the owner of this connector.</p>' +
    (msg || "") +
    '<p><a class="btn" href="/auth/owner">Sign in with Google</a></p>' +
    '<details><summary class="small muted">First time, or Google sign-in not set up yet?</summary>' +
    '<form id="pw"><label for="password">Setup password</label><input id="password" type="password" autocomplete="current-password" placeholder="Chosen when the connector was deployed"><button>Open setup</button></form></details></div>';
  $("#pw").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const r = await call("/api/login", { password: $("#password").value });
    if (r.ok) load(); else showLogin(errorBox(r.error));
  });
}

function stepCard(n, id, title, done, inner) {
  return '<section class="card" id="' + id + '"><div class="step-head"><span class="badge ' + (done ? "done" : "") + '">' + (done ? "✓" : n) + '</span><h2>' + esc(title) + '</h2></div>' + inner + '</section>';
}

function render() {
  const s = state;
  const done = [s.steps.google, s.steps.mailboxes, s.steps.claude, s.lastDiagOk === true];
  const count = done.filter(Boolean).length;
  const next = done.indexOf(false);
  const params = new URLSearchParams(location.search);
  let top = "";
  if (params.get("error")) top += errorBox(params.get("error"));
  if (params.get("added")) top += alertBox("ok", "Mailbox connected", params.get("added") + " can now be read by Claude.");
  const broken = s.mailboxes.filter((m) => m.status === "error");
  for (const m of broken) top += alertBox("bad", m.email + ": " + (m.problem ? m.problem.message : "problem"), m.problem ? m.problem.action : "", "#step-mailboxes", "Fix it");

  const head =
    '<div class="card"><div class="row" style="border:0;padding:0"><div><b>' + (count === 4 ? "All set" : "Step " + (next + 1) + " of 4") + '</b> <span class="muted small">· ' + (count === 4 ? "Claude can read your mailboxes" : "about " + (4 - count) * 3 + " min left") + '</span></div>' +
    '<button class="ghost" id="logout">Sign out</button></div><div class="progress"><div style="width:' + count * 25 + '%"></div></div>' +
    '<p class="small muted">Owner: ' + esc(s.owner) + '</p>' +
    '<div class="tip">Prefer to let Claude do it? In <b>Claude Desktop</b>, say <b>“Install Mail MCP”</b>: Claude opens this page and completes the steps with you.</div></div>';

  const google = s.googleApp.configured
    ? '<p>Connected to Google app <code>' + esc(s.googleApp.clientId) + '</code>.</p><details><summary class="small muted">Replace it</summary>' + googleForm() + '</details>'
    : '<p class="muted">Google needs an “app” before anyone can connect a mailbox. You do this once, in about 5 minutes.</p>' +
      '<ol>' +
      '<li><a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">Create a Google Cloud project</a> named <code>mail-mcp</code>.</li>' +
      '<li><a href="https://console.cloud.google.com/apis/library/gmail.googleapis.com" target="_blank" rel="noopener">Turn on the Gmail API</a> for that project.</li>' +
      '<li>In <a href="https://console.cloud.google.com/auth/branding" target="_blank" rel="noopener">Google Auth Platform</a>, click Get started: app name <code>Mail MCP</code>, your email as support and contact, audience <b>External</b>.</li>' +
      '<li>In <a href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noopener">Audience</a>, click <b>Publish app</b> (otherwise access stops after 7 days).</li>' +
      '<li>In <a href="https://console.cloud.google.com/auth/clients/create" target="_blank" rel="noopener">Clients → Create client</a>: type <b>Web application</b>, and add this address under <b>Authorized redirect URIs</b>:' +
      '<div class="copy"><code>' + esc(s.redirectUri) + '</code>' + copyBtn(s.redirectUri) + '</div></li>' +
      '<li>Paste the Client ID and Client secret below. <b>Copy the secret right away:</b> Google shows it only once.</li>' +
      '</ol>' + googleForm();

  const boxes = s.mailboxes.length
    ? s.mailboxes.map((m) =>
        '<div class="row"><div><span class="dot ' + (m.status === "ok" ? "ok" : "bad") + '"></span><b>' + esc(m.email) + '</b> <span class="muted small">· read only</span>' +
        (m.problem ? '<div class="small" style="color:var(--bad)">' + esc(m.problem.message) + '</div>' : "") + '</div>' +
        '<div>' + (m.status === "error" ? '<a class="btn" href="/auth/mailbox?hint=' + encodeURIComponent(m.email) + '">Reconnect</a> ' : "") +
        '<button class="danger" data-remove="' + esc(m.email) + '">Remove</button></div></div>').join("")
    : '<p class="muted">No mailbox yet.</p>';
  const mailboxes =
    boxes +
    '<div class="row"><div><label for="mode">Access for the next mailbox</label><select id="mode"><option value="read">Read only</option><option disabled>Read + drafts (coming soon)</option></select></div></div>' +
    (s.googleApp.configured ? '<a class="btn" href="/auth/mailbox">+ Add mailbox</a>' : '<button disabled>+ Add mailbox</button> <span class="small muted">Finish step 1 first.</span>') +
    '<p class="small muted">Google will ask you to pick the account and click <b>Allow</b>. If Google warns that the app “isn’t verified”, click <b>Advanced → Go to Mail MCP</b>: it’s your own app.</p>';

  const mcpJson = JSON.stringify({ mcpServers: { mail: { type: "http", url: s.mcpUrl, headers: { Authorization: "Bearer \${MAIL_MCP_KEY}" } } } }, null, 2);
  const claude =
    '<p>Claude reaches your mailboxes through this address:</p><div class="copy"><code>' + esc(s.mcpUrl) + '</code>' + copyBtn(s.mcpUrl) + '</div>' +
    '<p>' + (s.claudeKey.exists ? 'An access key exists (created ' + esc(new Date(s.claudeKey.createdAt).toLocaleString()) + '). Creating a new one disconnects the old one.' : 'Create an access key so only your Claude can use this connector.') + '</p>' +
    '<button id="newkey" class="' + (s.claudeKey.exists ? "ghost" : "") + '">' + (s.claudeKey.exists ? "Create a new key" : "Create access key") + '</button>' +
    '<div id="keyout"></div>' +
    '<details><summary class="small muted">What to put in Claude</summary><ol class="small">' +
    '<li>In your routine’s repository, add a file <code>.mcp.json</code>:<pre>' + esc(mcpJson) + '</pre>' + copyBtn(mcpJson) + '</li>' +
    '<li>In claude.ai → Code → your environment settings: add the variable <code>MAIL_MCP_KEY</code> with the key, and allow the domain <code>' + esc(new URL(s.mcpUrl).host) + '</code> in network access.</li></ol></details>';

  const check =
    '<p class="muted">Checks Google, every mailbox and the Claude key in one go.</p><button id="diag">Run diagnostics</button><div id="diagout">' + (s.lastDiag || "") + '</div>';

  const journal = s.journal.length
    ? '<table>' + s.journal.map((j) => '<tr><td class="muted">' + esc(new Date(j.at).toLocaleString()) + '</td><td>' + (j.ok ? "" : "⚠️ ") + esc(j.action) + '</td><td>' + esc(j.mailbox) + '</td><td class="muted">' + esc(j.detail) + '</td></tr>').join("") + '</table>'
    : '<p class="muted">Nothing yet.</p>';

  $("#app").innerHTML = top + head +
    stepCard(1, "step-google", "Google app", s.steps.google, google) +
    stepCard(2, "step-mailboxes", "Mailboxes", s.steps.mailboxes, mailboxes) +
    stepCard(3, "step-claude", "Connect Claude", s.steps.claude, claude) +
    stepCard(4, "step-check", "Check everything", s.lastDiagOk === true, check) +
    '<section class="card"><h2>Activity</h2>' + journal + '</section>';

  $("#logout").onclick = async () => { await call("/api/logout", {}); showLogin(); };
  const gf = $("#gform");
  if (gf) gf.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const b = gf.querySelector("button"); b.disabled = true; b.textContent = "Testing with Google…";
    const r = await call("/api/google-app", { clientId: $("#cid").value, clientSecret: $("#csecret").value });
    if (r.ok) { history.replaceState(null, "", "/setup#step-mailboxes"); load(); }
    else { $("#gerr").innerHTML = errorBox(r.error); b.disabled = false; b.textContent = "Save and test"; }
  });
  document.querySelectorAll("[data-remove]").forEach((b) => b.onclick = async () => {
    if (!confirm("Remove " + b.dataset.remove + "? Claude will no longer be able to read it.")) return;
    await call("/api/mailboxes/remove", { email: b.dataset.remove }); load();
  });
  $("#newkey").onclick = async () => {
    if (state.claudeKey.exists && !confirm("The current key will stop working. Continue?")) return;
    const r = await call("/api/claude-key", {});
    if (!r.ok) { $("#keyout").innerHTML = errorBox(r.error); return; }
    $("#keyout").innerHTML = alertBox("ok", "Your access key (shown only once)", "Copy it now and store it as MAIL_MCP_KEY in Claude's environment settings.") +
      '<div class="copy"><code>' + esc(r.key) + '</code>' + copyBtn(r.key) + '</div>';
    state.claudeKey.exists = true; state.steps.claude = true;
  };
  $("#diag").onclick = async () => {
    const b = $("#diag"); b.disabled = true; b.textContent = "Checking…";
    const r = await call("/api/diagnostics", {});
    b.disabled = false; b.textContent = "Run diagnostics";
    if (!r.ok) { $("#diagout").innerHTML = errorBox(r.error); return; }
    const allOk = r.checks.every((c) => c.ok);
    state.lastDiagOk = allOk;
    state.lastDiag = (allOk ? alertBox("ok", "Everything works", "Claude can read your mailboxes.") : "") +
      r.checks.map((c) => c.ok
        ? '<div class="row"><div><span class="dot ok"></span>' + esc(c.label) + '</div></div>'
        : '<div class="row"><div><span class="dot bad"></span><b>' + esc(c.label) + '</b><div>' + esc(c.message) + '</div><div class="small muted">' + esc(c.action) + '</div></div>' +
          (c.href ? '<a class="btn ghost" href="' + esc(c.href) + '"' + (c.href.startsWith("http") ? ' target="_blank" rel="noopener"' : "") + '>Fix it</a>' : "") + '</div>').join("");
    render();
    location.hash = "step-check";
  };
}
function googleForm() {
  return '<form id="gform"><label for="cid">Client ID</label><input id="cid" placeholder="1234…apps.googleusercontent.com" autocomplete="off" required>' +
    '<label for="csecret">Client secret</label><input id="csecret" type="password" autocomplete="off" required>' +
    '<div id="gerr"></div><button>Save and test</button></form>';
}
async function load() {
  const r = await call("/api/status");
  if (!r.ok) { if (r.error && r.error.code !== "SESSION_EXPIRED") $("#app").innerHTML = errorBox(r.error); else showLogin(new URLSearchParams(location.search).get("error") ? errorBox(new URLSearchParams(location.search).get("error")) : ""); return; }
  state = { ...r, lastDiag: state && state.lastDiag, lastDiagOk: state && state.lastDiagOk };
  render();
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}
load();
`;

export function setupPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Mail MCP setup</title>
<style>${CSS}</style>
</head>
<body>
<main>
<h1>Mail MCP</h1>
<p class="muted">Your own Gmail connector for Claude. Read-only: it cannot send, delete or change anything.</p>
<div id="app"><div class="card muted">Loading…</div></div>
</main>
<script>${SCRIPT}</script>
</body>
</html>`;
}
