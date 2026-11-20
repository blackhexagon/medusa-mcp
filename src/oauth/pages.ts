const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f4f5; --card:#fff; --fg:#18181b; --muted:#71717a; --border:#e4e4e7; --accent:#18181b; --accent-fg:#fff; --err:#dc2626; }
  @media (prefers-color-scheme: dark) { :root { --bg:#09090b; --card:#18181b; --fg:#fafafa; --muted:#a1a1aa; --border:#27272a; --accent:#fafafa; --accent-fg:#18181b; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 16px; }
  .card { width:100%; max-width:380px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p { margin:0 0 16px; color:var(--muted); }
  .client { color:var(--fg); font-weight:600; }
  label { display:block; font-size:13px; font-weight:500; margin:12px 0 4px; }
  input, select { width:100%; padding:9px 11px; border:1px solid var(--border); border-radius:8px; background:transparent; color:var(--fg); font:inherit; }
  .row { display:flex; gap:8px; margin-top:20px; }
  button { flex:1; padding:10px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:var(--accent-fg); font:inherit; font-weight:600; cursor:pointer; }
  button.secondary { background:transparent; color:var(--fg); border-color:var(--border); }
  .error { color:var(--err); background:color-mix(in srgb, var(--err) 10%, transparent); border-radius:8px; padding:8px 12px; margin-bottom:12px; font-size:14px; }
  .note { font-size:12px; margin-top:16px; }
</style>
</head>
<body><main class="card">${body}</main></body>
</html>`;
}

export interface ConsentInfo {
  requestToken: string;
  clientName: string;
  redirectHost: string;
  storeHost: string;
  error?: string;
  email?: string;
}

export function loginPage(info: ConsentInfo): string {
  return layout(
    "Sign in - Medusa MCP",
    `<h1>Sign in to Medusa</h1>
<p><span class="client">${esc(info.clientName)}</span> wants to access the Medusa Admin of <b>${esc(info.storeHost)}</b>.</p>
${info.error ? `<div class="error">${esc(info.error)}</div>` : ""}
<form method="post" action="authorize" autocomplete="on">
  <input type="hidden" name="request" value="${esc(info.requestToken)}">
  <label for="email">Admin email</label>
  <input id="email" name="email" type="email" required autocomplete="username" value="${esc(info.email)}" autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required autocomplete="current-password">
  <div class="row">
    <button class="secondary" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
    <button type="submit" name="action" value="login">Sign in &amp; allow</button>
  </div>
</form>
<p class="note">After signing in you will be redirected to <b>${esc(info.redirectHost)}</b>. Only continue if you started this connection yourself.</p>`,
  );
}

export function mfaPage(info: ConsentInfo & { mfaToken: string }): string {
  return layout(
    "Verification - Medusa MCP",
    `<h1>Two-factor verification</h1>
<p>Enter the code from your authenticator app for <b>${esc(info.email)}</b>.</p>
${info.error ? `<div class="error">${esc(info.error)}</div>` : ""}
<form method="post" action="authorize">
  <input type="hidden" name="request" value="${esc(info.requestToken)}">
  <input type="hidden" name="mfa" value="${esc(info.mfaToken)}">
  <label for="method">Method</label>
  <select id="method" name="method">
    <option value="totp">Authenticator app (TOTP)</option>
    <option value="recovery-code">Recovery code</option>
  </select>
  <label for="code">Code</label>
  <input id="code" name="code" required autocomplete="one-time-code" inputmode="numeric" autofocus>
  <div class="row">
    <button class="secondary" type="submit" name="action" value="deny" formnovalidate>Cancel</button>
    <button type="submit" name="action" value="mfa">Verify</button>
  </div>
</form>`,
  );
}

export function errorPage(message: string): string {
  return layout("Error - Medusa MCP", `<h1>Authorization error</h1><p>${esc(message)}</p>`);
}
