# Mail MCP

Your own Gmail connector for Claude. One connector, as many Gmail / Google Workspace mailboxes as you want, with a setup page that shows what's connected and what's wrong.

- **Claude keeps the intelligence**: it decides what to search, reads, sorts and writes.
- **The connector does the work and enforces the rules in code**: version 1 is **read-only**. There is no tool to send, delete or change anything.
- **Your Gmail access never reaches Claude**: Google tokens stay inside the connector (Cloudflare storage). Claude only gets a connector key.

```
Claude (routine)  ──HTTPS + key──▶  Mail MCP on Cloudflare Workers  ──OAuth──▶  Gmail API
   intelligence                       actions + guardrails + tokens               your mailboxes
```

## Install

**Easiest: let Claude do it.** In Claude Desktop, say **“Install Mail MCP from github.com/CodingPoesy/EmailRoutine”**. Claude follows [`.claude/skills/install-mail-mcp/SKILL.md`](.claude/skills/install-mail-mcp/SKILL.md), opens the browser and does every step with you. You only sign in and click **Allow**.

**By hand** (about 15 minutes):

1. [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/CodingPoesy/EmailRoutine)
   Fill in `OWNER_EMAIL` (your Google address) and `SETUP_PASSWORD` (a long random string, e.g. `openssl rand -hex 24`).
2. Open `https://<your-worker>.workers.dev/setup` and sign in with the setup password.
3. Follow the 4 steps on the page: Google app → Mailboxes → Connect Claude → Check everything.

## Connect it to Claude

In the repository your Claude routine runs in, add `.mcp.json`:

```json
{
  "mcpServers": {
    "mail": {
      "type": "http",
      "url": "https://<your-worker>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${MAIL_MCP_KEY}" }
    }
  }
}
```

Then, in claude.ai → Code → your environment settings: add the variable `MAIL_MCP_KEY` (created on the setup page, step 3) and allow the domain `<your-worker>.workers.dev` in network access.

## Tools

| Tool | What it does |
|---|---|
| `health` | Checks every mailbox can be read now. Call it first in every routine run. |
| `list_mailboxes` | Connected mailboxes, mode and status. |
| `search_threads` | Gmail search; returns each thread's latest message and whether the owner sent it. |
| `get_thread` | Full thread as plain text, oldest first. |

Every tool result containing email content starts with a reminder that it is third-party data, never instructions.

## Security model

- Setup page: only the owner (Google sign-in matching `OWNER_EMAIL`, or the setup password). Same-origin check on every action.
- Claude access: one key, stored hashed; creating a new key revokes the old one.
- Gmail: `gmail.readonly` only. Tokens never leave the connector and never appear on the page or in tool results.
- Settings can only be changed on the setup page, never through Claude.

## Roadmap

- v2: Gmail **drafts** (`Read + drafts` mode). Sending stays with you: you review the draft and click Send in Gmail.

## Development

```bash
npm install
npm run check      # typecheck + tests + Cloudflare build (dry run)
cp .dev.vars.example .dev.vars && npm run dev
```
