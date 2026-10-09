const enc = new TextEncoder();

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return base64url(b);
}

export function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return base64url(new Uint8Array(d));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

// Signed, expiring payloads: used for the page session cookie and the OAuth "state".
export async function sign(secret: string, payload: object, ttlSeconds: number): Promise<string> {
  const body = base64url(enc.encode(JSON.stringify({ ...payload, exp: Date.now() + ttlSeconds * 1000 })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return `${body}.${base64url(new Uint8Array(sig))}`;
}

export async function verify<T>(secret: string, token: string | null | undefined): Promise<T | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), base64urlDecode(sig), enc.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const data = JSON.parse(new TextDecoder().decode(base64urlDecode(body))) as T & { exp: number };
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
