// Every problem the user can hit, written for a non-technical person:
// one clear sentence, plus the one thing to do about it.
// Technical details are never shown on the page; they are kept for Claude
// (diagnostics endpoint and MCP tool results) so it can fix things itself.

export type ErrorCode =
  | "SETUP_PASSWORD_WRONG"
  | "SESSION_EXPIRED"
  | "WRONG_ACCOUNT"
  | "GOOGLE_APP_MISSING"
  | "GOOGLE_APP_INVALID"
  | "GOOGLE_APP_FORMAT"
  | "GMAIL_API_DISABLED"
  | "ACCESS_DENIED"
  | "GMAIL_PERMISSION_UNCHECKED"
  | "NO_LONG_TERM_ACCESS"
  | "MAILBOX_DISCONNECTED"
  | "MAILBOX_NOT_FOUND"
  | "MAILBOX_AMBIGUOUS"
  | "LINK_EXPIRED"
  | "CLAUDE_KEY_MISSING"
  | "CLAUDE_KEY_WRONG"
  | "GOOGLE_UNREACHABLE"
  | "GOOGLE_RATE_LIMIT"
  | "STORAGE_ERROR"
  | "UNKNOWN";

export interface ErrorInfo {
  message: string;
  action: string;
  // Where the action button goes on the setup page (an anchor or a URL).
  href?: string;
}

export const ERRORS: Record<ErrorCode, ErrorInfo> = {
  SETUP_PASSWORD_WRONG: {
    message: "That setup password isn't right.",
    action: "Check for a typo and try again. It's the password chosen when the connector was deployed.",
  },
  SESSION_EXPIRED: {
    message: "You've been signed out of this page.",
    action: "Sign in again.",
    href: "/setup",
  },
  WRONG_ACCOUNT: {
    message: "You signed in with a Google account that doesn't own this page.",
    action: "Sign in again with the owner's Google account.",
    href: "/auth/owner",
  },
  GOOGLE_APP_MISSING: {
    message: "Your Google app isn't set up yet.",
    action: "Complete step 1 first.",
    href: "#step-google",
  },
  GOOGLE_APP_INVALID: {
    message: "Google doesn't recognise this Client ID and Client secret together.",
    action: "Copy both values again from your Google app. If the secret is lost, create a new one: Google only shows it once.",
    href: "#step-google",
  },
  GOOGLE_APP_FORMAT: {
    message: "This doesn't look like a Google Client ID.",
    action: "A Client ID ends with “.apps.googleusercontent.com”. Copy it again from your Google app.",
    href: "#step-google",
  },
  GMAIL_API_DISABLED: {
    message: "Gmail access isn't turned on in your Google project yet.",
    action: "Turn on the Gmail API, wait one minute, then click Retry.",
    href: "https://console.cloud.google.com/apis/library/gmail.googleapis.com",
  },
  ACCESS_DENIED: {
    message: "Google didn't give access to this mailbox.",
    action: "Click “Add mailbox” again and choose Allow. If you see “Access blocked”, your company's Google admin must mark this app as trusted.",
    href: "#step-mailboxes",
  },
  GMAIL_PERMISSION_UNCHECKED: {
    message: "The Gmail permission was unticked on Google's consent screen.",
    action: "Click “Add mailbox” again and make sure the Gmail box is ticked before you click Continue.",
    href: "#step-mailboxes",
  },
  NO_LONG_TERM_ACCESS: {
    message: "Google gave only temporary access to this mailbox.",
    action: "Remove this app from your Google account permissions, then click “Add mailbox” again.",
    href: "https://myaccount.google.com/connections",
  },
  MAILBOX_DISCONNECTED: {
    message: "We lost access to this mailbox. Google asked for a new sign-in.",
    action: "Click Reconnect. It takes 10 seconds.",
    href: "#step-mailboxes",
  },
  MAILBOX_NOT_FOUND: {
    message: "This mailbox isn't connected to the connector.",
    action: "Use one of the connected mailboxes, or add this one on the setup page.",
    href: "#step-mailboxes",
  },
  MAILBOX_AMBIGUOUS: {
    message: "Several mailboxes are connected, so the mailbox must be named.",
    action: "Call the tool again with the “mailbox” field set to one of the connected addresses.",
  },
  LINK_EXPIRED: {
    message: "This sign-in link has expired or was already used.",
    action: "Start again from the setup page.",
    href: "/setup",
  },
  CLAUDE_KEY_MISSING: {
    message: "Claude isn't connected yet: no access key has been created.",
    action: "Create a key in step 3.",
    href: "#step-claude",
  },
  CLAUDE_KEY_WRONG: {
    message: "Claude used an access key this connector doesn't accept.",
    action: "Create a new key in step 3 and update it in Claude's environment settings.",
    href: "#step-claude",
  },
  GOOGLE_UNREACHABLE: {
    message: "Google didn't answer in time.",
    action: "This is usually temporary. Wait a minute and retry.",
  },
  GOOGLE_RATE_LIMIT: {
    message: "Google is limiting how fast this mailbox can be read.",
    action: "Wait a few minutes and retry.",
  },
  STORAGE_ERROR: {
    message: "The connector couldn't save its settings.",
    action: "Retry in a minute. If it keeps happening, redeploy the connector from Cloudflare.",
  },
  UNKNOWN: {
    message: "Something unexpected went wrong.",
    action: "Click Retry. If it happens again, ask Claude to run the diagnostics.",
  },
};

export class AppError extends Error {
  code: ErrorCode;
  technical?: string;
  status: number;
  constructor(code: ErrorCode, technical?: string, status = 400) {
    super(code);
    this.code = code;
    this.technical = technical;
    this.status = status;
  }
}

export function describe(err: unknown): { code: ErrorCode; technical: string } {
  if (err instanceof AppError) return { code: err.code, technical: err.technical ?? "" };
  return { code: "UNKNOWN", technical: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
}
