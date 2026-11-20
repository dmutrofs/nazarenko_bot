import { createClient } from "@libsql/client";

// Definitions of every editable list. "set" lists hold only IDs, "map" lists also
// keep the label (a note for the prompt / a display name) as the Map value.
export const LIST_DEFS = {
  allowed_chats: {
    title: "Дозволені чати",
    description: "Групові чати, де працюють боти (ALLOWED_CHAT_IDS).",
    kind: "chat",
    type: "set",
    labelTitle: "Назва чату (для себе)",
    labelRequired: false,
    maxLabel: 120,
  },
  trusted_users: {
    title: "Довірені користувачі",
    description: "Дружній тон, збільшені ліміти автовідповідей (TRUSTED_USER_IDS).",
    kind: "user",
    type: "set",
    labelTitle: "Ім'я (для себе)",
    labelRequired: false,
    maxLabel: 120,
  },
  boss_fear_users: {
    title: "Ті, чия згадка Босса лякає Вову",
    description: "Якщо ці користувачі згадують Артема Босса, бот перепрошує (BOSS_FEAR_USER_IDS).",
    kind: "user",
    type: "set",
    labelTitle: "Ім'я (для себе)",
    labelRequired: false,
    maxLabel: 120,
  },
  polite_users: {
    title: "Ввічливі користувачі",
    description: "Додатковий список для дружнього тону (POLITE_USER_IDS).",
    kind: "user",
    type: "set",
    labelTitle: "Ім'я (для себе)",
    labelRequired: false,
    maxLabel: 120,
  },
  user_notes: {
    title: "Нотатки про користувачів",
    description: "Нотатка потрапляє в промпт Вови, коли пише цей користувач (USER_NOTES).",
    kind: "user",
    type: "map",
    labelTitle: "Нотатка для промпту",
    labelRequired: true,
    maxLabel: 500,
  },
  st_enemy_users: {
    title: "Вороги Віталі Сторожука",
    description: "Бот Віталі ставиться до них як до ворогів (ST_ENEMY_USERS).",
    kind: "user",
    type: "map",
    labelTitle: "Ім'я",
    labelRequired: true,
    maxLabel: 120,
  },
};

export class ValidationError extends Error {}

function cleanLabel(raw) {
  // Strip control characters, collapse whitespace.
  return String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function validate(name, value, label) {
  const def = LIST_DEFS[name];
  if (!def) throw new ValidationError("Невідомий список");
  if (!Number.isSafeInteger(value) || value === 0) {
    throw new ValidationError("ID має бути цілим числом");
  }
  if (def.kind === "chat" && value > 0) {
    throw new ValidationError("ID групового чату має бути від'ємним (наприклад -1001234567890)");
  }
  if (def.kind === "user" && value < 0) {
    throw new ValidationError("ID користувача має бути додатним числом");
  }
  const clean = cleanLabel(label);
  if (def.labelRequired && !clean) throw new ValidationError(`Поле «${def.labelTitle}» обов'язкове`);
  if (clean.length > def.maxLabel) {
    throw new ValidationError(`Поле «${def.labelTitle}» не довше ${def.maxLabel} символів`);
  }
  return clean;
}

/**
 * @param {object} opts
 * @param {string} opts.url        Turso database URL (libsql://...) or file:... for local dev
 * @param {string} [opts.authToken]
 * @param {Record<string, Array<[number, string]>>} [opts.defaults]  seed data + offline fallback
 */
export function createWhitelistStore({ url, authToken, defaults = {} }) {
  const client = createClient({ url, authToken });

  // Live, in-memory views. They are mutated IN PLACE, so references taken once at
  // startup (const TRUSTED = store.get("trusted_users")) always stay up to date.
  const live = {};
  for (const [name, def] of Object.entries(LIST_DEFS)) {
    live[name] = def.type === "map" ? new Map() : new Set();
  }
  let snapshot = {};
  for (const name of Object.keys(LIST_DEFS)) snapshot[name] = [];

  function applyEntries(grouped) {
    // Fully synchronous: no awaits between clear() and refill, so readers never see a half-empty list.
    for (const [name, def] of Object.entries(LIST_DEFS)) {
      const target = live[name];
      const entries = grouped[name] ?? [];
      target.clear();
      for (const e of entries) {
        if (def.type === "map") target.set(e.value, e.label);
        else target.add(e.value);
      }
    }
    snapshot = grouped;
  }

  // Offline fallback: until the DB answers, the bot works with the built-in defaults.
  const fallback = {};
  for (const name of Object.keys(LIST_DEFS)) {
    fallback[name] = (defaults[name] ?? []).map(([value, label]) => ({ value, label: label ?? "" }));
  }
  applyEntries(fallback);

  let ready = false;

  async function init() {
    if (ready) return;
    await client.batch(
      [
        `CREATE TABLE IF NOT EXISTS whitelist (
           list_name  TEXT NOT NULL,
           value      INTEGER NOT NULL,
           label      TEXT NOT NULL DEFAULT '',
           created_at INTEGER NOT NULL,
           PRIMARY KEY (list_name, value)
         )`,
        `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
      ],
      "write"
    );

    // Seed each list once from the built-in defaults. The "seeded" flag keeps a list
    // that the admin emptied on purpose from being refilled on the next start.
    const seededRows = await client.execute(`SELECT key FROM meta WHERE key LIKE 'seeded:%'`);
    const seeded = new Set(seededRows.rows.map((r) => String(r.key)));
    const now = Date.now();
    for (const name of Object.keys(LIST_DEFS)) {
      if (seeded.has(`seeded:${name}`)) continue;
      const stmts = fallback[name].map((e) => ({
        sql: `INSERT OR IGNORE INTO whitelist (list_name, value, label, created_at) VALUES (?, ?, ?, ?)`,
        args: [name, e.value, e.label, now],
      }));
      stmts.push({ sql: `INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`, args: [`seeded:${name}`, "1"] });
      await client.batch(stmts, "write");
      console.log(`[db] список ${name} заповнено початковими значеннями (${fallback[name].length})`);
    }
    ready = true;
  }

  async function refresh() {
    if (!ready) await init();
    const res = await client.execute(`SELECT list_name, value, label FROM whitelist ORDER BY list_name, created_at, value`);
    const grouped = {};
    for (const name of Object.keys(LIST_DEFS)) grouped[name] = [];
    for (const row of res.rows) {
      const name = String(row.list_name);
      if (!grouped[name]) continue; // ignore rows of lists that no longer exist in code
      grouped[name].push({ value: Number(row.value), label: String(row.label ?? "") });
    }
    applyEntries(grouped);
  }

  async function upsert(name, value, label) {
    const clean = validate(name, value, label);
    if (!ready) await init();
    await client.execute({
      sql: `INSERT INTO whitelist (list_name, value, label, created_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(list_name, value) DO UPDATE SET label = excluded.label`,
      args: [name, value, clean, Date.now()],
    });
    await refresh();
  }

  async function remove(name, value) {
    if (!LIST_DEFS[name]) throw new ValidationError("Невідомий список");
    if (!Number.isSafeInteger(value)) throw new ValidationError("ID має бути цілим числом");
    if (!ready) await init();
    await client.execute({ sql: `DELETE FROM whitelist WHERE list_name = ? AND value = ?`, args: [name, value] });
    await refresh();
  }

  let timer = null;
  function startAutoRefresh(intervalMs = 5 * 60_000) {
    timer = setInterval(() => {
      refresh().catch((err) => console.warn("[db] не вдалося оновити білі списки:", err.message));
    }, intervalMs);
    timer.unref();
  }

  return {
    get: (name) => live[name],
    snapshot: () => snapshot,
    init,
    refresh,
    upsert,
    remove,
    startAutoRefresh,
    close: () => {
      if (timer) clearInterval(timer);
      client.close();
    },
  };
}