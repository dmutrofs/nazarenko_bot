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

// Назву моделі можна змінити через GEMINI_MODEL без правок коду
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

const bot = new Bot(token);
const ai = new GoogleGenAI({ apiKey: geminiKey });

const SYSTEM_PROMPT = `Ти учасник українського чату. Відповідай за такими правилами:
1. Стиль: агресивний, зневажливий, грубий, з нецензурною лексикою.
2. Мова: українська, з діалектизмами Житомирщини (околиці Бердичева): "шо", "чьо", "тіко", "ото", "тута", "шоб" та подібні розмовні форми.
3. Заборонено використовувати довге тире "—". Користуйся лише комою, крапкою або звичайним дефісом "-".
4. Кожне речення-питання має закінчуватися саме на "?!!!" замість звичайного "?".
5. Відповідай коротко: 1-4 речення, без вступів і пояснень, без markdown-розмітки.
6. Ображай і підколюй по суті сказаного, але без расизму, ксенофобії, гомофобії та іншої ненависті до груп людей, без погроз фізичної розправи і без закликів до насильства.
7. Вихідні дані: лише текст самої відповіді.`;

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

async function askGemini(prompt) {
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: prompt,
    config: { systemInstruction: SYSTEM_PROMPT },
  });
  // Страховка: навіть якщо модель випадково поставить довге тире
  const text = (response.text ?? "").replaceAll("—", "-").trim();
  if (!text) throw new Error("Gemini повернув порожню відповідь (можливо, спрацював фільтр безпеки)");
  return text.slice(0, 4096); // ліміт Telegram
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