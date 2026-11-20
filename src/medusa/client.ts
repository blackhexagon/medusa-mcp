import type { Config } from "../config.js";
import { log } from "../log.js";
import { toQueryString } from "./query.js";

export interface MedusaResponse {
  ok: boolean;
  status: number;
  statusText: string;
  data: unknown;
}

export interface RequestOptions {
  method: string;
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  /** Pre-built multipart body (used for file uploads). */
  formData?: FormData;
  signal?: AbortSignal;
}

export class MedusaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Thin HTTP client for the Medusa Admin API.
 *
 * Auth:
 *  - MEDUSA_API_KEY: secret API key sent as `Authorization: Basic base64(key:)` (recommended).
 *  - MEDUSA_ADMIN_EMAIL + MEDUSA_ADMIN_PASSWORD: logs in via /auth/user/emailpass and uses the JWT,
 *    re-authenticating automatically when the token expires.
 */
export class MedusaClient {
  private jwt?: string;
  private loginPromise?: Promise<string>;

  constructor(private readonly config: Config) {}

  private async login(): Promise<string> {
    this.loginPromise ??= (async () => {
      const res = await fetch(`${this.config.medusaBaseUrl}/auth/user/emailpass`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...this.config.medusaExtraHeaders },
        body: JSON.stringify({ email: this.config.medusaEmail, password: this.config.medusaPassword }),
        signal: AbortSignal.timeout(this.config.medusaTimeoutMs),
      });
      const data: any = await res.json().catch(() => ({}));
      if (!res.ok || typeof data?.token !== "string") {
        throw new MedusaError(`Medusa login failed (${res.status}): ${data?.message ?? res.statusText}`, res.status);
      }
      log.info("Authenticated against Medusa with email/password");
      this.jwt = data.token;
      return data.token as string;
    })().finally(() => {
      this.loginPromise = undefined;
    });
    return this.loginPromise;
  }

  private async authHeader(forceRefresh = false): Promise<string> {
    if (this.config.medusaApiKey) {
      return `Basic ${Buffer.from(`${this.config.medusaApiKey}:`).toString("base64")}`;
    }
    if (!this.jwt || forceRefresh) await this.login();
    return `Bearer ${this.jwt}`;
  }

  async request(opts: RequestOptions): Promise<MedusaResponse> {
    const qs = opts.query ? toQueryString(opts.query) : "";
    const url = `${this.config.medusaBaseUrl}${opts.path}${qs ? `?${qs}` : ""}`;
    const method = opts.method.toUpperCase();

    const send = async (forceRefresh: boolean) => {
      const headers: Record<string, string> = {
        accept: "application/json",
        ...this.config.medusaExtraHeaders,
        authorization: await this.authHeader(forceRefresh),
      };
      let body: string | FormData | undefined;
      if (opts.formData) {
        body = opts.formData;
      } else if (opts.body !== undefined && method !== "GET") {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
      const signals = [AbortSignal.timeout(this.config.medusaTimeoutMs)];
      if (opts.signal) signals.push(opts.signal);
      return fetch(url, { method, headers, body, signal: AbortSignal.any(signals) });
    };

    let res: Response;
    try {
      res = await send(false);
      if (res.status === 401 && !this.config.medusaApiKey) {
        log.info("Medusa returned 401, re-authenticating");
        res = await send(true);
      }
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${(err.cause as any).code ?? err.cause.message})` : "";
      const reason = err instanceof Error ? `${err.name}: ${err.message}${cause}` : String(err);
      throw new MedusaError(`Request to Medusa failed (${method} ${opts.path}): ${reason}`);
    }

    const text = await res.text();
    let data: unknown = text;
    if (text && (res.headers.get("content-type") ?? "").includes("json")) {
      try {
        data = JSON.parse(text);
      } catch {
        // keep raw text
      }
    }
    log.debug(`${method} ${opts.path} -> ${res.status}`);
    return { ok: res.ok, status: res.status, statusText: res.statusText, data: text ? data : null };
  }
}
