import type { Config } from "../config.js";
import { log } from "../log.js";
import type { MedusaClient } from "../medusa/client.js";

export interface AdminIdentity {
  id: string;
  email: string;
}

export type LoginResult =
  | { kind: "ok"; user: AdminIdentity }
  | { kind: "mfa"; challengeId: string }
  | { kind: "invalid"; message: string };

/** Verifies Medusa admin credentials (incl. MFA) against the Medusa backend. */
export class MedusaAuth {
  constructor(
    private readonly config: Config,
    private readonly client: MedusaClient,
  ) {}

  private async post(path: string, body: unknown): Promise<{ status: number; data: any }> {
    const res = await fetch(`${this.config.medusaBaseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...this.config.medusaExtraHeaders },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.medusaTimeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  }

  async login(email: string, password: string): Promise<LoginResult> {
    const { status, data } = await this.post("/auth/user/emailpass", { email, password });
    if (status === 401 || status === 400 || status === 404) return { kind: "invalid", message: "Invalid email or password." };
    if (status === 429) return { kind: "invalid", message: "Too many attempts. Try again later." };
    if (status >= 300) {
      log.warn(`Medusa login returned ${status}`, data);
      return { kind: "invalid", message: `Medusa login failed (HTTP ${status}).` };
    }
    if (data?.mfa_challenge?.id) return { kind: "mfa", challengeId: String(data.mfa_challenge.id) };
    if (typeof data?.token !== "string") return { kind: "invalid", message: "Medusa did not return a token for this account." };
    return this.identify(data.token, email);
  }

  async verifyMfa(challengeId: string, method: string, code: string, email: string): Promise<LoginResult> {
    const { status, data } = await this.post(`/auth/mfa/challenges/${encodeURIComponent(challengeId)}/verify`, { method, code });
    if (status >= 300) return { kind: "invalid", message: status === 429 ? "Too many attempts." : "Invalid verification code." };
    if (typeof data?.token === "string") return this.identify(data.token, email);
    // Some setups complete the challenge without returning a token: fall back to a lookup by email.
    const user = await this.findByEmail(email);
    return user ? { kind: "ok", user } : { kind: "invalid", message: "This account is not a Medusa admin user." };
  }

  /** Resolves the admin user behind a Medusa JWT. */
  private async identify(token: string, email: string): Promise<LoginResult> {
    const res = await fetch(`${this.config.medusaBaseUrl}/admin/users/me?fields=id,email`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...this.config.medusaExtraHeaders },
      signal: AbortSignal.timeout(this.config.medusaTimeoutMs),
    });
    const data: any = await res.json().catch(() => ({}));
    if (res.ok && data?.user?.id) return { kind: "ok", user: { id: data.user.id, email: data.user.email ?? email } };
    log.warn(`/admin/users/me returned ${res.status} after a successful login`);
    return { kind: "invalid", message: "This account is not a Medusa admin user." };
  }

  private async findByEmail(email: string): Promise<AdminIdentity | undefined> {
    const res = await this.client.request({ method: "GET", path: "/admin/users", query: { email, fields: "id,email", limit: 1 } });
    const user = (res.data as any)?.users?.[0];
    return res.ok && user?.id ? { id: user.id, email: user.email } : undefined;
  }

  /** Used on token refresh: false only if the user definitely no longer exists. */
  async userExists(id: string): Promise<boolean> {
    try {
      const res = await this.client.request({ method: "GET", path: `/admin/users/${encodeURIComponent(id)}`, query: { fields: "id" } });
      return res.status !== 404;
    } catch {
      return true; // Medusa unreachable: don't log everyone out
    }
  }
}
