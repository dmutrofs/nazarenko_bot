import crypto from "node:crypto";
import { verifyPassword } from "./password.js";
import { LIST_DEFS, ValidationError } from "./whitelist-store.js";

const SESSION_ABSOLUTE_MS = 8 * 60 * 60_000; // hard limit for a session
const SESSION_IDLE_MS = 60 * 60_000; // inactivity limit
const MAX_SESSIONS = 10;
const MAX_BODY_BYTES = 8 * 1024;

const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_MAX_PER_IP = 5; // attempts per IP per window
const LOGIN_MAX_GLOBAL = 30; // attempts overall per window (guards against distributed guessing)

const sha256 = (s) => crypto.createHash("sha256").update(s).digest();
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Constant-time string comparison (hashing first makes the lengths equal).
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(String(a)), sha256(String(b)));

class HttpError extends Error {
  constructor(status, message, headers) {
    super(message);
    this.status = status;
    this.headers = headers;
  }
}

function isSecure(req) {
  return Boolean(req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https";
}

// Client IP for rate limiting. TRUST_PROXY_HOPS = number of reverse proxies in front of the app
// (0 = none, use the socket address). We take the entry that many positions from the RIGHT of
// X-Forwarded-For, because the left part can be forged by the client.
function clientIp(req) {
  const hops = Number(process.env.TRUST_PROXY_HOPS ?? 1);
  const xff = req.headers["x-forwarded-for"];
  if (hops > 0 && typeof xff === "string" && xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[Math.max(0, parts.length - hops)];
  }
  return req.socket.remoteAddress ?? "unknown";
}

function securityHeaders(secure, extra = {}) {
  return {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Robots-Tag": "noindex, nofollow",
    ...(secure ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
    ...extra,
  };
}

function sendJson(res, secure, status, data, extraHeaders = {}) {
  res.writeHead(status, securityHeaders(secure, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }));
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, "Запит завеликий"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        resolve(parsed);
      } catch {
        reject(new HttpError(400, "Некоректний JSON"));
      }
    });
    req.on("error", reject);
  });
}

function assertSameOrigin(req) {
  const origin = req.headers.origin;
  let ok = false;
  try {
    ok = Boolean(origin) && new URL(origin).host === req.headers.host;
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(403, "Заборонено (origin)");
}

function assertJsonBody(req) {
  if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "Очікується application/json");
  }
}

function parseValue(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^-?\d{1,19}$/.test(raw.trim())) return Number(raw.trim());
  throw new ValidationError("ID має бути цілим числом");
}

/**
 * Returns a request handler `(req, res) => boolean` (true = the request was handled),
 * or null when the admin panel is not configured.
 */
export function createAdminHandler({ store, login, passwordHash }) {
  if (!login || !passwordHash) return null;

  // sessions: sha256(token) -> { csrf, created, last }. Only the hash of the token is kept in memory.
  const sessions = new Map();
  const ipAttempts = new Map(); // ip -> timestamps
  const globalAttempts = []; // timestamps

  setInterval(() => {
    const now = Date.now();
    for (const [key, s] of sessions) {
      if (now - s.created > SESSION_ABSOLUTE_MS || now - s.last > SESSION_IDLE_MS) sessions.delete(key);
    }
    for (const [ip, arr] of ipAttempts) {
      const fresh = arr.filter((t) => now - t < LOGIN_WINDOW_MS);
      if (fresh.length) ipAttempts.set(ip, fresh);
      else ipAttempts.delete(ip);
    }
  }, 10 * 60_000).unref();

  // The attempt is counted BEFORE the password is checked, so a burst of parallel
  // requests cannot slip past the limit while earlier ones are still being verified.
  function consumeLoginAttempt(ip) {
    const now = Date.now();
    const mine = (ipAttempts.get(ip) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    while (globalAttempts.length && now - globalAttempts[0] >= LOGIN_WINDOW_MS) globalAttempts.shift();

    if (mine.length >= LOGIN_MAX_PER_IP || globalAttempts.length >= LOGIN_MAX_GLOBAL) {
      const oldest = mine.length >= LOGIN_MAX_PER_IP ? mine[0] : globalAttempts[0];
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest + LOGIN_WINDOW_MS - now) / 1000)) };
    }
    mine.push(now);
    globalAttempts.push(now);
    ipAttempts.set(ip, mine);
    return { ok: true };
  }

  function createSession() {
    if (sessions.size >= MAX_SESSIONS) {
      const oldest = [...sessions.entries()].sort((a, b) => a[1].last - b[1].last)[0];
      if (oldest) sessions.delete(oldest[0]);
    }
    const token = crypto.randomBytes(32).toString("base64url");
    const csrf = crypto.randomBytes(24).toString("base64url");
    const now = Date.now();
    sessions.set(sha256Hex(token), { csrf, created: now, last: now });
    return { token, csrf };
  }

  const cookieName = (secure) => (secure ? "__Host-sid" : "sid");

  function readCookie(req, name) {
    const raw = req.headers.cookie;
    if (!raw) return null;
    for (const part of raw.split(";")) {
      const idx = part.indexOf("=");
      if (idx > 0 && part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
    }
    return null;
  }

  function getSession(req, secure) {
    const token = readCookie(req, cookieName(secure));
    if (!token || token.length > 128) return null;
    const key = sha256Hex(token);
    const s = sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (now - s.created > SESSION_ABSOLUTE_MS || now - s.last > SESSION_IDLE_MS) {
      sessions.delete(key);
      return null;
    }
    s.last = now;
    return { key, ...s };
  }

  function sessionCookie(secure, token, maxAgeSec) {
    // __Host- prefix (HTTPS only) pins the cookie to this exact host, Path=/, no Domain.
    return `${cookieName(secure)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure ? "; Secure" : ""}`;
  }

  function assertCsrf(req, session) {
    const sent = String(req.headers["x-csrf-token"] ?? "");
    if (!sent || !safeEqual(sent, session.csrf)) throw new HttpError(403, "Недійсний CSRF-токен");
  }

  function sendPage(res, secure) {
    const nonce = crypto.randomBytes(16).toString("base64");
    const csp = [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join("; ");
    res.writeHead(200, securityHeaders(secure, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": csp }));
    res.end(PAGE_HTML.replaceAll("__NONCE__", nonce));
  }

  async function route(req, res, pathname) {
    const secure = isSecure(req);
    const method = req.method;

    if (pathname === "/admin" || pathname === "/admin/") {
      if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Метод не дозволено");
      return sendPage(res, secure);
    }

    const api = pathname.startsWith("/admin/api/") ? pathname.slice("/admin/api/".length) : null;
    if (api === null) throw new HttpError(404, "Не знайдено");

    // --- Session state ---
    if (api === "session" && method === "GET") {
      const s = getSession(req, secure);
      return sendJson(res, secure, 200, s ? { authenticated: true, csrf: s.csrf } : { authenticated: false });
    }

    // --- Login ---
    if (api === "login" && method === "POST") {
      assertSameOrigin(req);
      assertJsonBody(req);
      if (process.env.NODE_ENV === "production" && !secure) {
        throw new HttpError(400, "Вхід можливий лише через HTTPS");
      }

      const ip = clientIp(req);
      const gate = consumeLoginAttempt(ip);
      if (!gate.ok) {
        console.warn(`[admin] забагато спроб входу, ip=${ip}`);
        throw new HttpError(429, "Забагато спроб входу. Спробуйте пізніше.", { "Retry-After": String(gate.retryAfterSec) });
      }

      const body = await readJson(req);
      const l = typeof body.login === "string" ? body.login : "";
      const p = typeof body.password === "string" ? body.password : "";

      // Both checks always run, so the response time does not reveal whether the login exists.
      const loginOk = safeEqual(l, login);
      const passOk = p.length > 0 && p.length <= 256 ? await verifyPassword(p, passwordHash) : false;

      if (!(loginOk && passOk)) {
        console.warn(`[admin] невдала спроба входу, ip=${ip}`);
        await sleep(300 + Math.random() * 300);
        throw new HttpError(401, "Невірний логін або пароль");
      }

      ipAttempts.delete(ip);
      const { token, csrf } = createSession();
      console.log(`[admin] успішний вхід, ip=${ip}`);
      return sendJson(res, secure, 200, { authenticated: true, csrf }, {
        "Set-Cookie": sessionCookie(secure, token, Math.floor(SESSION_ABSOLUTE_MS / 1000)),
      });
    }

    // --- Everything below requires a valid session ---
    const session = getSession(req, secure);
    if (!session) throw new HttpError(401, "Потрібен вхід");

    const mutating = method !== "GET" && method !== "HEAD";
    if (mutating) {
      assertSameOrigin(req);
      assertCsrf(req, session);
    }

    if (api === "logout" && method === "POST") {
      sessions.delete(session.key);
      console.log("[admin] вихід");
      return sendJson(res, secure, 200, { ok: true }, { "Set-Cookie": sessionCookie(secure, "", 0) });
    }

    if (api === "lists" && method === "GET") {
      const snap = store.snapshot();
      const lists = Object.entries(LIST_DEFS).map(([name, def]) => ({
        name,
        title: def.title,
        description: def.description,
        kind: def.kind,
        labelTitle: def.labelTitle,
        labelRequired: def.labelRequired,
        maxLabel: def.maxLabel,
        entries: snap[name] ?? [],
      }));
      return sendJson(res, secure, 200, { lists });
    }

    const m = api.match(/^lists\/([a-z_]+)(?:\/(-?\d{1,19}))?$/);
    if (m) {
      const [, name, valuePart] = m;
      if (!LIST_DEFS[name]) throw new HttpError(404, "Невідомий список");

      if (method === "POST" && valuePart === undefined) {
        assertJsonBody(req);
        const body = await readJson(req);
        const value = parseValue(body.value);
        await store.upsert(name, value, typeof body.label === "string" ? body.label : "");
        console.log(`[admin] ${name}: збережено ${value}`);
        return sendJson(res, secure, 200, { ok: true });
      }
      if (method === "DELETE" && valuePart !== undefined) {
        const value = Number(valuePart);
        await store.remove(name, value);
        console.log(`[admin] ${name}: видалено ${value}`);
        return sendJson(res, secure, 200, { ok: true });
      }
    }

    throw new HttpError(404, "Не знайдено");
  }

  return function handle(req, res) {
    const pathname = (req.url ?? "").split("?")[0];
    if (pathname !== "/admin" && !pathname.startsWith("/admin/")) return false;

    route(req, res, pathname).catch((err) => {
      if (res.headersSent) return res.end();
      const secure = isSecure(req);
      if (err instanceof HttpError) {
        return sendJson(res, secure, err.status, { error: err.message }, err.headers);
      }
      if (err instanceof ValidationError) {
        return sendJson(res, secure, 400, { error: err.message });
      }
      console.error("[admin] помилка:", err);
      sendJson(res, secure, 500, { error: "Внутрішня помилка сервера" });
    });
    return true;
  };
}

// ---------------------------------------------------------------------------
// UI (single page, no external resources; strict CSP with a per-request nonce)
// ---------------------------------------------------------------------------
const PAGE_HTML = `<!doctype html>
<html lang="uk">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Адмінка ботів</title>
<style nonce="__NONCE__">
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#fff; --text:#1c1e21; --muted:#6b7280; --line:#e3e5e8; --accent:#2563eb; --danger:#dc2626; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#14161a; --card:#1d2025; --text:#e8eaed; --muted:#9aa0a6; --line:#2d3139; --accent:#5b8def; --danger:#f0615d; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font:15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
  main { max-width: 880px; margin: 0 auto; padding: 20px 14px 60px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:16px; }
  h1 { font-size:20px; margin:0; }
  h2 { font-size:17px; margin:0 0 2px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-bottom:16px; }
  .muted { color:var(--muted); font-size:13px; margin:0 0 12px; }
  label { display:block; font-size:13px; color:var(--muted); margin:10px 0 4px; }
  input { width:100%; padding:9px 10px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; }
  input:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:1px; }
  button { padding:9px 14px; border:1px solid var(--line); border-radius:8px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { color:var(--danger); }
  button:disabled { opacity:.5; cursor:default; }
  .login { max-width:360px; margin:12vh auto 0; }
  .row { display:grid; grid-template-columns: 170px 1fr auto; gap:8px; align-items:center; padding:6px 0; border-top:1px solid var(--line); }
  .row.head { border-top:0; color:var(--muted); font-size:13px; }
  .actions { display:flex; gap:6px; }
  .add { display:grid; grid-template-columns: 170px 1fr auto; gap:8px; margin-top:12px; align-items:end; }
  .add label { margin-top:0; }
  .empty { color:var(--muted); padding:8px 0; }
  .msg { position:fixed; left:50%; bottom:18px; transform:translateX(-50%); max-width:90vw; padding:10px 16px; border-radius:10px; background:var(--text); color:var(--bg); font-size:14px; }
  .msg.err { background:var(--danger); color:#fff; }
  .hidden { display:none; }
  @media (max-width:640px) {
    .row, .add { grid-template-columns: 1fr; }
    .row.head { display:none; }
  }
</style>
</head>
<body>
<main>
  <section id="login-view" class="card login hidden">
    <h1>Вхід в адмінку</h1>
    <form id="login-form" autocomplete="on">
      <label for="login">Логін</label>
      <input id="login" name="username" autocomplete="username" required maxlength="128">
      <label for="password">Пароль</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required maxlength="256">
      <p></p>
      <button class="primary" type="submit" id="login-btn">Увійти</button>
    </form>
  </section>

  <section id="app-view" class="hidden">
    <header>
      <h1>Білі списки ботів</h1>
      <button id="logout-btn" type="button">Вийти</button>
    </header>
    <div id="lists"></div>
  </section>
</main>
<div id="msg" class="msg hidden" role="status"></div>

<script nonce="__NONCE__">
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let csrf = null;
  let msgTimer = null;

  // Build DOM with textContent only (never innerHTML), so list data can't inject markup.
  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    node.append(...children);
    return node;
  }

  function toast(text, isError = false) {
    const box = $("msg");
    box.textContent = text;
    box.className = "msg" + (isError ? " err" : "");
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => box.classList.add("hidden"), 4000);
  }

  async function api(method, path, body) {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (csrf && method !== "GET") headers["X-CSRF-Token"] = csrf;
    const res = await fetch("/admin/api/" + path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && path !== "login") {
      showLogin();
      throw new Error("Сесію завершено, увійдіть знову");
    }
    if (!res.ok) throw new Error(data.error || "Помилка " + res.status);
    return data;
  }

  function showLogin() {
    csrf = null;
    $("app-view").classList.add("hidden");
    $("login-view").classList.remove("hidden");
    $("password").value = "";
    $("login").focus();
  }

  async function showApp() {
    $("login-view").classList.add("hidden");
    $("app-view").classList.remove("hidden");
    await loadLists();
  }

  async function loadLists() {
    const { lists } = await api("GET", "lists");
    const root = $("lists");
    root.replaceChildren(...lists.map(renderList));
  }

  function renderList(list) {
    const card = el("section", { class: "card" });
    card.append(el("h2", {}, list.title), el("p", { class: "muted" }, list.description));

    const head = el("div", { class: "row head" }, el("span", {}, "ID"), el("span", {}, list.labelTitle), el("span", {}));
    card.append(head);

    if (!list.entries.length) card.append(el("div", { class: "empty" }, "Список порожній"));

    for (const entry of list.entries) {
      const labelInput = el("input", { value: entry.label, maxlength: String(list.maxLabel), "aria-label": list.labelTitle });
      const save = el("button", { type: "button" }, "Зберегти");
      const del = el("button", { type: "button", class: "danger" }, "Видалити");

      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          await api("POST", "lists/" + list.name, { value: entry.value, label: labelInput.value });
          toast("Збережено");
          await loadLists();
        } catch (e) { toast(e.message, true); } finally { save.disabled = false; }
      });
      del.addEventListener("click", async () => {
        if (!confirm("Видалити " + entry.value + " зі списку «" + list.title + "»?")) return;
        del.disabled = true;
        try {
          await api("DELETE", "lists/" + list.name + "/" + entry.value);
          toast("Видалено");
          await loadLists();
        } catch (e) { toast(e.message, true); del.disabled = false; }
      });

      card.append(el("div", { class: "row" }, el("code", {}, String(entry.value)), labelInput, el("div", { class: "actions" }, save, del)));
    }

    const idInput = el("input", { inputmode: "numeric", placeholder: list.kind === "chat" ? "-1001234567890" : "123456789", "aria-label": "ID" });
    const newLabel = el("input", { maxlength: String(list.maxLabel), "aria-label": list.labelTitle });
    const addBtn = el("button", { type: "button", class: "primary" }, "Додати");
    addBtn.addEventListener("click", async () => {
      addBtn.disabled = true;
      try {
        await api("POST", "lists/" + list.name, { value: idInput.value, label: newLabel.value });
        toast("Додано");
        await loadLists();
      } catch (e) { toast(e.message, true); } finally { addBtn.disabled = false; }
    });
    card.append(el("div", { class: "add" },
      el("div", {}, el("label", {}, "ID"), idInput),
      el("div", {}, el("label", {}, list.labelTitle + (list.labelRequired ? "" : " (необов'язково)")), newLabel),
      addBtn));
    return card;
  }

  $("login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = $("login-btn");
    btn.disabled = true;
    try {
      const data = await api("POST", "login", { login: $("login").value, password: $("password").value });
      csrf = data.csrf;
      $("password").value = "";
      await showApp();
    } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  });

  $("logout-btn").addEventListener("click", async () => {
    try { await api("POST", "logout", {}); } catch { /* ignore */ }
    showLogin();
  });

  (async () => {
    try {
      const s = await api("GET", "session");
      if (s.authenticated) { csrf = s.csrf; await showApp(); } else showLogin();
    } catch { showLogin(); }
  })();
})();
</script>
</body>
</html>`;