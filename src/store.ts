import { AppError } from "./errors.ts";

export interface Env {
  MAIL_KV: KVNamespace;
  OWNER_EMAIL: string;
  SETUP_PASSWORD: string;
}

export type MailboxMode = "read";

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

export interface Mailbox {
  email: string;
  mode: MailboxMode;
  refreshToken: string;
  connectedAt: string;
  // Last known state, refreshed by every Gmail call and by diagnostics.
  status: "ok" | "error";
  lastError?: string;
  lastCheckedAt?: string;
}

export interface JournalEntry {
  at: string;
  mailbox: string;
  action: string;
  detail: string;
  ok: boolean;
}

const K = {
  googleApp: "config:google-app",
  claudeKeyHash: "config:claude-key-sha256",
  claudeKeyCreatedAt: "config:claude-key-created-at",
  mailboxes: "mailboxes",
  journal: "journal",
  accessToken: (email: string) => `access-token:${email}`,
};

async function getJson<T>(env: Env, key: string): Promise<T | null> {
  try {
    return await env.MAIL_KV.get<T>(key, "json");
  } catch (e) {
    throw new AppError("STORAGE_ERROR", `KV get ${key}: ${String(e)}`, 500);
  }
}

async function putJson(env: Env, key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  try {
    await env.MAIL_KV.put(key, JSON.stringify(value), ttlSeconds ? { expirationTtl: ttlSeconds } : undefined);
  } catch (e) {
    throw new AppError("STORAGE_ERROR", `KV put ${key}: ${String(e)}`, 500);
  }
}

export const store = {
  getGoogleApp: (env: Env) => getJson<GoogleApp>(env, K.googleApp),
  setGoogleApp: (env: Env, app: GoogleApp) => putJson(env, K.googleApp, app),

  async listMailboxes(env: Env): Promise<Mailbox[]> {
    return (await getJson<Mailbox[]>(env, K.mailboxes)) ?? [];
  },
  async saveMailbox(env: Env, mailbox: Mailbox): Promise<void> {
    const all = (await store.listMailboxes(env)).filter((m) => m.email !== mailbox.email);
    all.push(mailbox);
    all.sort((a, b) => a.email.localeCompare(b.email));
    await putJson(env, K.mailboxes, all);
  },
  async removeMailbox(env: Env, email: string): Promise<void> {
    const all = (await store.listMailboxes(env)).filter((m) => m.email !== email);
    await putJson(env, K.mailboxes, all);
    await env.MAIL_KV.delete(K.accessToken(email));
  },
  async markMailbox(env: Env, email: string, ok: boolean, error?: string): Promise<void> {
    const all = await store.listMailboxes(env);
    const m = all.find((x) => x.email === email);
    if (!m) return;
    const changed = m.status !== (ok ? "ok" : "error") || m.lastError !== error;
    m.status = ok ? "ok" : "error";
    m.lastError = ok ? undefined : error;
    m.lastCheckedAt = new Date().toISOString();
    // Avoid a KV write on every successful call: only persist changes.
    if (changed) await putJson(env, K.mailboxes, all);
  },

  getCachedAccessToken: (env: Env, email: string) =>
    getJson<{ token: string; expiresAt: number }>(env, K.accessToken(email)),
  cacheAccessToken: (env: Env, email: string, token: string, expiresIn: number) =>
    putJson(env, K.accessToken(email), { token, expiresAt: Date.now() + expiresIn * 1000 }, Math.max(60, expiresIn)),

  async getClaudeKey(env: Env): Promise<{ hash: string | null; createdAt: string | null }> {
    const [hash, createdAt] = await Promise.all([
      env.MAIL_KV.get(K.claudeKeyHash),
      env.MAIL_KV.get(K.claudeKeyCreatedAt),
    ]);
    return { hash, createdAt };
  },
  async setClaudeKeyHash(env: Env, hash: string): Promise<void> {
    await env.MAIL_KV.put(K.claudeKeyHash, hash);
    await env.MAIL_KV.put(K.claudeKeyCreatedAt, new Date().toISOString());
  },

  async journal(env: Env): Promise<JournalEntry[]> {
    return (await getJson<JournalEntry[]>(env, K.journal)) ?? [];
  },
  async log(env: Env, entry: Omit<JournalEntry, "at">): Promise<void> {
    try {
      const all = await store.journal(env);
      all.unshift({ at: new Date().toISOString(), ...entry });
      await putJson(env, K.journal, all.slice(0, 50));
    } catch {
      // The journal must never break a real action.
    }
  },
};
