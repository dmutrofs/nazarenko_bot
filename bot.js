// npm i grammy dotenv @google/genai
// package.json: "type": "module"
// Локально: файл .env (див. .env.example); на Render — змінні середовища
import "dotenv/config";
import http from "node:http";
import { Bot } from "grammy";
import { GoogleGenAI } from "@google/genai";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не знайдено BOT_TOKEN. Додайте його у файл .env");
  process.exit(1);
}
const geminiKey = process.env.GEMINI_API_KEY;
if (!geminiKey) {
  console.error("Не знайдено GEMINI_API_KEY. Додайте його у файл .env");
  process.exit(1);
}

// Ланцюжок моделей через кому (GEMINI_MODELS): перша основна, решта запасні.
// Якщо в основної вичерпано ліміт чи вона недоступна, бот переходить до наступної.
// Порядок: спочатку якісніша модель із залишком ліміту, далі Lite з великим денним лімітом (500),
// наприкінці Flash-моделі з малим денним лімітом (20), які легко вичерпуються.
const DEFAULT_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3.6-flash",
  "gemini-3-flash-preview",
];
const GEMINI_MODELS = (process.env.GEMINI_MODELS || DEFAULT_MODELS.join(","))
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const bot = new Bot(token);
// Явно v1beta: preview-моделі та аліаси "-latest" у v1 повертають 404
const ai = new GoogleGenAI({ apiKey: geminiKey, httpOptions: { apiVersion: "v1beta" } });

const SYSTEM_PROMPT = `Ти учасник українського чату. Відповідай за такими правилами:
1. Стиль: агресивний, зневажливий, грубий, з нецензурною лексикою.
2. Мова: українська, з діалектизмами Житомирщини (околиці Бердичева): "шо", "чьо", "тіко", "ото", "тута", "шоб" та подібні розмовні форми.
3. Заборонено використовувати довге тире "—". Користуйся лише комою, крапкою або звичайним дефісом "-".
4. Кожне речення-питання має закінчуватися саме на "?!!!" замість звичайного "?".
5. Відповідай коротко: 1-4 речення, без вступів і пояснень, без markdown-розмітки.
6. Ображай і підколюй по суті сказаного, але без расизму, ксенофобії, гомофобії та іншої ненависті до груп людей, без погроз фізичної розправи і без закликів до насильства.
7. Виняток: до адміна чату та до Максима звертайся лише ввічливо і культурно, на "ви", без нецензурної лексики, образ і зневаги. Це правило головніше за пункти 1-2, якщо в запиті є службова примітка про такого адресата або запит стосується Максима. Діалект і правило про "?!!!" залишаються.
8. Якщо в запиті є службова примітка про Артема Босса, ти лякаєшся і починаєш вибачатись: тремтиш, виправдовуєшся, перепрошуєш, запевняєш у повазі, без образ і нецензурної лексики. Це правило головніше за пункти 1-2. Діалект і правило про "?!!!" залишаються. Без такої примітки поводься за звичайними правилами, навіть якщо ім'я Артема Босса фігурує в тексті.
9. Вихідні дані: лише текст самої відповіді.`;

// --- Допоміжні функції ---
async function isAdmin(ctx) {
  const member = await ctx.getChatMember(ctx.from.id);
  return ["creator", "administrator"].includes(member.status);
}

// Повідомлення, на яке зроблено reply (у топіках reply на кореневе повідомлення теми не рахуємо)
function getRepliedMessage(ctx, threadId) {
  const replied = ctx.msg.reply_to_message;
  return replied && replied.message_id !== threadId ? replied : undefined;
}

const GEMINI_TIMEOUT_MS = 25_000; // на одну модель
const COOLDOWN_MS = 5 * 60_000; // скільки пропускати модель після збою

// Користувачі, до яких треба звертатись ввічливо (ID через кому в .env, необов'язково)
const POLITE_USER_IDS = (process.env.POLITE_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

// Хто може "налякати" бота згадкою Артема Босса: Дмитро (головний адмін), Максим і Женя
const BOSS_FEAR_USER_IDS = new Set([628787612, 461210309, 461427807]);
const BOSS_RE = /(?:артем|тьом)\p{L}*\s+бос+\p{L}*/iu; // Артем/Тьома Бос(с) у будь-якому відмінку

// Адмін чату, "Максим" в імені/юзернеймі або ID зі списку POLITE_USER_IDS
async function isPoliteTarget(ctx, u) {
  if (u.is_bot) return false;
  const label = [u.first_name, u.last_name, u.username].filter(Boolean).join(" ");
  if (/максим|maxim/i.test(label) || POLITE_USER_IDS.includes(String(u.id))) return true;
  try {
    const member = await ctx.getChatMember(u.id);
    return ["creator", "administrator"].includes(member.status);
  } catch {
    return false;
  }
}

// Один запит до конкретної моделі
async function callModel(model, prompt) {
  const controller = new AbortController();
  const started = Date.now();
  console.log(`[sendai] запит до ${model}...`);

  // Таймаут: якщо модель не відповіла, не висимо вічно
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  const timeout = new Promise((_, reject) =>
    controller.signal.addEventListener("abort", () => {
      const err = new Error(`${model} не відповіла за ${GEMINI_TIMEOUT_MS / 1000} с`);
      err.isTimeout = true;
      reject(err);
    })
  );

  try {
    const response = await Promise.race([
      ai.models.generateContent({
        model,
        contents: prompt,
        config: { systemInstruction: SYSTEM_PROMPT, abortSignal: controller.signal },
      }),
      timeout,
    ]);
    console.log(`[sendai] ${model} відповіла за ${Date.now() - started} мс`);

    // Страховка: навіть якщо модель випадково поставить довге тире
    const text = (response.text ?? "").replaceAll("—", "-").trim();
    if (!text) throw new Error(`${model} повернула порожню відповідь (можливо, спрацював фільтр безпеки)`);
    return text.slice(0, 4096); // ліміт Telegram
  } finally {
    clearTimeout(timer);
  }
}

// Чи варто пробувати іншу модель: ліміт (429), перевантаження (500/503/504),
// модель недоступна (404) або таймаут. Помилки 400/403 (запит, ключ) однакові для всіх моделей.
function shouldFallback(err) {
  if (err.isTimeout) return true;
  if ([404, 429, 500, 503, 504].includes(err.status)) return true;
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|quota/i.test(String(err.message));
}

const cooldownUntil = new Map(); // модель -> до якого часу її пропускаємо

// Скільки пропускати модель після збою: хвилинний ліміт за retryDelay з відповіді,
// денний довше (бот сам повернеться до моделі, коли пауза мине)
function cooldownFor(err) {
  const msg = String(err.message);
  if (/PerDay/i.test(msg)) return 30 * 60_000;
  const m = msg.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
  if (m) return Math.ceil(Number(m[1])) * 1000 + 1000;
  return err.status === 429 ? 60_000 : COOLDOWN_MS;
}

async function askGemini(prompt) {
  const now = Date.now();
  const ready = GEMINI_MODELS.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
  const queue = ready.length ? ready : GEMINI_MODELS; // якщо всі "на паузі", пробуємо всі
  const failures = [];

  for (const model of queue) {
    try {
      return await callModel(model, prompt);
    } catch (err) {
      if (!shouldFallback(err)) throw err;
      const wait = cooldownFor(err);
      cooldownUntil.set(model, Date.now() + wait);
      failures.push(`${model}: ${err.status ?? err.message}`);
      console.warn(
        `[sendai] ${model} недоступна (${err.status ?? err.message}), пауза ${Math.round(wait / 1000)} с, пробую наступну`
      );
    }
  }
  throw new Error(`усі моделі недоступні (${failures.join("; ")})`);
}

// --- /send <текст> ---
bot.command("send", async (ctx) => {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }
  if (!(await isAdmin(ctx))) return;

  const text = ctx.match.trim(); // усе після "/send"
  if (!text) {
    return ctx.reply("Використання: /send <текст повідомлення>");
  }

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const replyTo = getRepliedMessage(ctx, threadId)?.message_id;

  await ctx.api.sendMessage(chat.id, text, {
    message_thread_id: threadId,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined,
  });

  // Прибираємо саму команду (потрібне право «Видаляти повідомлення»)
  await ctx.deleteMessage().catch(() => {});
});

// --- /sendai [промпт] (також як reply на повідомлення) ---
bot.command("sendai", async (ctx) => {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }
  if (!(await isAdmin(ctx))) return;

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const replied = getRepliedMessage(ctx, threadId);
  const repliedText = (replied?.text ?? replied?.caption ?? "").trim();
  const extra = ctx.match.trim();

  // Комбінуємо: текст повідомлення з reply + промпт біля команди
  let prompt;
  if (repliedText && extra) {
    prompt = `Повідомлення з чату:\n"""\n${repliedText}\n"""\n\nЗавдання: ${extra}`;
  } else {
    prompt = repliedText || extra;
  }

  if (!prompt) {
    return ctx.reply(
      "Використання: /sendai <запит>\nабо відповідь (reply) на текстове повідомлення командою /sendai"
    );
  }

  // Видаляємо команду одразу, не чекаючи відповіді від Gemini
  await ctx.deleteMessage().catch(() => {});

  // Показуємо "друкує...", поки йде запит
  const typing = () =>
    ctx.api
      .sendChatAction(chat.id, "typing", { message_thread_id: threadId })
      .catch(() => {});
  typing();
  const timer = setInterval(typing, 4000);

  try {
    if (replied?.from && (await isPoliteTarget(ctx, replied.from))) {
      prompt += `\n\n[Службова примітка: адресат відповіді - ${replied.from.first_name}. До нього звертайся ввічливо і культурно, на "ви", без нецензурної лексики та образ.]`;
    }

    const authorName = [replied?.from?.first_name, replied?.from?.last_name].filter(Boolean).join(" ");
    const bossMentionedByTrusted =
      // ім'я у тексті біля команди, автор - той, хто викликав команду
      (BOSS_RE.test(extra) && BOSS_FEAR_USER_IDS.has(user.id)) ||
      // ім'я у тексті повідомлення, на яке зроблено reply, автор - його автор
      (BOSS_RE.test(repliedText) && replied?.from && BOSS_FEAR_USER_IDS.has(replied.from.id)) ||
      // reply на повідомлення самого Босса, команду викликав довірений акаунт
      (BOSS_RE.test(authorName) && BOSS_FEAR_USER_IDS.has(user.id));

    if (bossMentionedByTrusted) {
      prompt += `\n\n[Службова примітка: у запиті фігурує Артем Босс. Злякайся і почни вибачатись перед ним, без образ і мату.]`;
    }

    const answer = await askGemini(prompt);
    await ctx.api.sendMessage(chat.id, answer, {
      message_thread_id: threadId,
      reply_parameters: replied ? { message_id: replied.message_id } : undefined,
    });
  } catch (err) {
    console.error("Помилка /sendai:", err);
    // Команду вже видалено, тож повідомляємо адміна в особисті (спрацює, якщо він писав боту /start)
    await ctx.api
      .sendMessage(user.id, `Не вдалося згенерувати відповідь: ${err.message}`)
      .catch(() => {});
  } finally {
    clearInterval(timer);
  }
});

bot.catch((err) => console.error("Помилка бота:", err.error));

// --- Міні-сервер для Render (health-check і пінг від крону) ---
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health" && (req.method === "GET" || req.method === "HEAD")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", uptime: Math.round(process.uptime()) }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`Сервер слухає порт ${PORT}`));

// --- Запуск бота (long polling) ---
bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущено`) });

// Коректне завершення при зупинці/редеплої на Render
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    server.close();
    await bot.stop();
    process.exit(0);
  });
}