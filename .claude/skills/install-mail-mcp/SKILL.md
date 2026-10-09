---
name: install-mail-mcp
description: Install or repair the Mail MCP connector (Gmail for Claude) end to end, driving the browser for the user. Use when the user says "Install Mail MCP", "set up my mail connector", "add a mailbox", or when a routine reports a Mail MCP problem.
---

# Install Mail MCP

You install the connector **for** the user. They should only have to sign in, click **Allow**, and confirm things that commit their accounts. Everything else is yours.

## Ground rules

- Talk to the user in their language; the product (page, buttons, messages) is in English.
- Show progress at every step: `Step 2 of 6 · about 8 min left`.
- Before each human-only click, say exactly what they'll see and what to click.
- Human-only actions (never do these yourself): signing in to any account, typing account passwords, Google's **Allow** / consent screens, accepting terms of service, billing.
- Never put secrets (client secret, setup password, Claude key) anywhere except the exact field they belong in. Never write them in chat (except the setup password, shown once so the user can save it), files or commits.
- If something fails, read the message on the page: it says what happened and what to do. Do that, then retry. Explain it to the user in one plain sentence, no jargon.
- Use the browser available in Claude Desktop (built-in browser, or computer use). If none is available, tell the user how to turn it on and stop.

## Steps

### 1. Deploy (Cloudflare) — ~2 min
1. Generate a setup password (24 random bytes, hex). Show it to the user **once** and ask them to save it in their password manager.
2. Open `https://deploy.workers.cloudflare.com/?url=https://github.com/CodingPoesy/EmailRoutine`.
3. The user signs in to Cloudflare (and GitHub if asked).
4. Fill in: project name `mail-mcp`; `OWNER_EMAIL` = the user's main Google address; `SETUP_PASSWORD` = the generated password. Click Deploy.
5. Wait for the deployment to finish; note the Worker URL (`https://mail-mcp.<account>.workers.dev`).

Check: `<url>/healthz` shows `ok`.

### 2. Open the setup page — ~1 min
Open `<url>/setup`, expand "First time…", enter the setup password. The page shows "Step 1 of 4".

### 3. Google app — ~5 min (once)
Follow the numbered list in step 1 of the page, signed in to Google as `OWNER_EMAIL`:
1. Create project `mail-mcp`. Wait until it's selected in the console.
2. Enable the Gmail API (link on the page). Wait for "API enabled".
3. Google Auth Platform → Get started: app name `Mail MCP`, support and contact email = owner, audience **External**. The user accepts Google's policy.
4. Audience → **Publish app** → confirm. (Left in "Testing", access stops after 7 days.)
5. Clients → Create client → **Web application**, name `Mail MCP`, add the redirect URI shown on the setup page, exactly. Create.
6. Immediately paste the Client ID and Client secret into the setup page form and click **Save and test**. Google never shows the secret again; if it's lost, add a new secret on the client page.

Check: step 1 shows a green tick.

If a mailbox belongs to a Google Workspace domain the user administers: admin.google.com → Security → Access and data control → API controls → Manage third-party app access → configure new app by Client ID → **Trusted**. If the user isn't the admin, say who must do it and continue with the other mailboxes.

### 4. Mailboxes — ~1 min each
For each mailbox: click **+ Add mailbox** → the user picks the account → on "Google hasn't verified this app": **Advanced → Go to Mail MCP** (it's their own app) → the Gmail box must be ticked → **Continue**. Back on the page: "Mailbox connected".

Check: a green dot next to each address.

### 5. Connect Claude — ~3 min
1. Step 3 of the page: **Create access key**. Keep it only long enough to paste it in the next point.
2. claude.ai → Code → the routine's environment settings: add the variable `MAIL_MCP_KEY` = the key; in network access, allow the Worker's domain.
3. In the routine's repository, add `.mcp.json` (template on the setup page, under "What to put in Claude"). Commit it once the user confirms.

### 6. Check — ~1 min
1. Setup page step 4: **Run diagnostics** → all green. Fix any red line with its "Fix it" button.
2. Real test from the routine's environment: call `health`, then `search_threads` with `newer_than:1d` on each mailbox. Show the user the 3 latest subjects per mailbox.

Finish by telling the user what's connected, where the setup page is, and that any problem will appear at the top of their routine reports.

## Repair mode

When a routine reports a Mail MCP problem, or the user says something broke: open `<url>/setup`, run diagnostics, apply each "Fix it" action (most often **Reconnect** on a mailbox), and run diagnostics again.
