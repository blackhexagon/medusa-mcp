import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString("base64url");

export type Purpose = "access" | "refresh" | "code" | "client" | "client-secret" | "authreq" | "mfa";

export interface Claims {
  iat: number;
  exp?: number;
  jti: string;
  [key: string]: unknown;
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Stateless HS256 JWT signer. Every purpose uses its own derived key, so e.g.
 * an authorization code can never be replayed as an access token.
 */
export class Signer {
  private readonly keys = new Map<Purpose, Buffer>();

  constructor(private readonly secret: string) {}

  private key(purpose: Purpose): Buffer {
    let key = this.keys.get(purpose);
    if (!key) {
      key = createHmac("sha256", this.secret).update(`medusa-mcp:oauth:${purpose}`).digest();
      this.keys.set(purpose, key);
    }
    return key;
  }

  mac(purpose: Purpose, data: string): string {
    return createHmac("sha256", this.key(purpose)).update(data).digest("base64url");
  }

  sign(purpose: Purpose, payload: Record<string, unknown>, ttlSeconds?: number): string {
    const now = Math.floor(Date.now() / 1000);
    const claims: Claims = { ...payload, iat: now, jti: randomBytes(12).toString("base64url") };
    if (ttlSeconds) claims.exp = now + ttlSeconds;
    const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = b64url(JSON.stringify(claims));
    return `${head}.${body}.${this.mac(purpose, `${head}.${body}`)}`;
  }

  verify<T extends Record<string, unknown>>(purpose: Purpose, token: string | undefined | null): (T & Claims) | null {
    if (!token || typeof token !== "string" || token.length > 8192) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [head, body, sig] = parts;
    if (!safeEqual(sig, this.mac(purpose, `${head}.${body}`))) return null;
    try {
      const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (typeof claims.exp === "number" && claims.exp < Math.floor(Date.now() / 1000)) return null;
      return claims;
    } catch {
      return null;
    }
  }
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
