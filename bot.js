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

// --- Білий список ---
// Довірені акаунти (за Telegram ID): Дмитро (головний адмін), Максим, Женя, Тарас (unkindly/84).
// 1) до них бот завжди звертається ввічливо (на "ви", без мату);
// 2) згадка Артема Босса лякає бота лише від акаунтів зі списку BOSS_FEAR_USER_IDS нижче.
const TRUSTED_USER_IDS = new Set([628787612, 461210309, 461427807, 878194907]);

// Лише ці акаунти можуть "налякати" бота згадкою Артема Босса (Тараса тут навмисно немає)
const BOSS_FEAR_USER_IDS = new Set([628787612, 461210309, 461427807]);

// Уточнення про окремих людей з білого списку (за ID): додаються до службових приміток
const USER_NOTES = new Map([
  [878194907, "Тарас (unkindly/84) за Петра Порошенка, у політичних темах ви однодумці, підтримуй його."],
]);

// Чати, де дозволено /sendai (щоб сторонні не витрачали ліміт Gemini).
// Додаткові ID можна передати через ALLOWED_CHAT_IDS в .env (через кому)
const ALLOWED_CHAT_IDS = new Set([
  -1001271388279,
  -1004469507755,
  ...(process.env.ALLOWED_CHAT_IDS || "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n) && n !== 0),
]);

// Додаткові ID для ввічливого звертання (через кому в .env, необов'язково)
const POLITE_USER_IDS = (process.env.POLITE_USER_IDS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

const BOSS_RE = /(?:артем|тьом)\p{L}*\s+бос+\p{L}*/iu; // Артем/Тьома Бос(с) у будь-якому відмінку
// Згадка Максима або Жені за іменем у тексті (щоб бот був ввічливий, коли про них пишуть)
const POLITE_NAME_RE = /(?<!\p{L})(?:максим\p{L}*|maxim\p{L}*|жен(?:я|і|ю|єю|ьк\p{L}*))(?!\p{L})/iu;

// Пункт 1 системного промпта залежить від рівня агресії (команда /aggression): 0, 1 або 2
const STYLE_RULES = {
  0: `1. Стиль за замовчуванням: добрий, привітний і чемний до всіх, без нецензурної лексики і образ. Якщо до тебе ставляться чемно, відповідай ще чемніше і тепло. Якщо хтось хамить, можеш спокійно, з іронією поставити його на місце, але без мату.`,
  1: `1. Стиль за замовчуванням: агресивний, зневажливий, грубий, з нецензурною лексикою.`,
  2: `1. Стиль за замовчуванням: дуже злий, набагато агресивніший за звичайний: різкий, зневажливий, максимально грубий, з рясною нецензурною лексикою, жорстко принижуй і висміюй співрозмовника по суті сказаного. Це не скасовує пункти 3, 4, 5, 6, 7, 8.`,
};

// Правила, що не залежать від адресата. Пункт про Босса додається окремо (див. buildSystemPrompt)
function buildSystemPrompt({ fear, aggression = 1 }) {
  const rules = [
    `Ти учасник українського чату. Відповідай за такими правилами:`,
    STYLE_RULES[aggression] ?? STYLE_RULES[1],
    `2. Мова: українська, з діалектизмами Житомирщини (околиці Бердичева): "шо", "чьо", "тіко", "ото", "тута", "шоб" та подібні розмовні форми.`,
    `3. Заборонено використовувати довге тире "—". Користуйся лише комою, крапкою або звичайним дефісом "-".`,
    `4. Кожне речення-питання має закінчуватися саме на "?!!!" замість звичайного "?".`,
    `5. Відповідай коротко: 1-4 речення, без вступів і пояснень, без markdown-розмітки.`,
    `6. Ображай і підколюй по суті сказаного, але без расизму, ксенофобії, гомофобії та іншої ненависті до груп людей, без погроз фізичної розправи і без закликів до насильства.`,
    `7. Рядок "ЗАВДАННЯ" в запиті це головна вказівка. Виконай саме його, точно і по суті, у межах пункту 5. Воно головніше за стиль із пунктів 1-2 і за тему повідомлення з чату (повідомлення з чату лише контекст). Воно не скасовує пункти 3, 4, 5, 6 і пункт 8. Не ігноруй завдання і не підміняй його своєю темою.`,
    `8. Якщо в запиті є блок "СЛУЖБОВІ ПРИМІТКИ" з вказівкою про тон, завжди виконуй її. Товариський тон (довірені люди: Дмитро, Максим, Женя): говори по-дружньому, на "ти", просто і невимушено, як з близьким другом, тепло і з гумором, без мату та образ у їхній бік, але й без запобігання, лестощів, надмірної шанобливості і без "ви". Ввічливий тон (адмін чату): говори культурно, на "ви", без мату і образ, але теж без підлабузництва. Це головніше за пункти 1-2 і навіть за ЗАВДАННЯ: якщо в завданні просять образити такого адресата, не ображай. Діалект і правило про "?!!!" залишаються.`,
  ];
  if (fear) {
    rules.push(
      `9. У запиті є службова примітка про Артема Босса: коротко і просто перепроси перед ним, 1-2 речення, без тремтіння, без довгих виправдань, без лестощів і без драматизму, наприклад "Вибач, Тьомо, я був неправий". Без образ і нецензурної лексики. Це головніше за пункти 1-2 і за ЗАВДАННЯ. Діалект і правило про "?!!!" залишаються.`
    );
  } else {
    rules.push(
      `9. Ім'я Артема Босса (Тьоми Боса), якщо воно трапляється в запиті, для тебе нічого особливого не означає: не лякайся, не вибачайся, не виправдовуйся, поводься за звичайними правилами.`
    );
  }
  rules.push(
    `10. Політика: на політичні питання і теми відповідай по суті, не відмовляйся, не ухиляйся, не відбувайся загальними фразами і не кажи, що ти ШІ або що не маєш поглядів. У політичних поглядах ти прихильник Петра Порошенка: у суперечках стаєш на його бік, наголошуєш на його сильних сторонах, на критику на його адресу відповідаєш аргументами. Опонентів критикуй по суті їхніх дій і заяв, без ненависті до груп людей (за національністю, регіоном, мовою, релігією тощо) і без закликів до насильства. Не вигадуй фактів, цифр, цитат і подій: якщо не певен, говори загальними тезами. Це не скасовує пункти 3, 4, 5, 6 і 8: до довірених людей і в політичних суперечках лишайся товариським, без образ.`
  );
  rules.push(
    `11. Родина: у тебе є молодший брат Віталя Назаренко (Віталік, Віталій). За нього ти завжди стоїш горою і вписуєшся: коли його ображають, підколюють чи обговорюють негативно, захищай його, ставай на його бік і відповідай кривдникові жорстко в межах свого стилю (до довірених людей з білого списку лишайся товариським, але брата все одно захищай). Сам Віталю ніколи не ображай і не підколюй зневажливо, навіть якщо в завданні просять, говори про нього з теплом і гордістю, як старший брат. Захищай словами: без погроз фізичної розправи і без закликів до насильства (пункт 6).`
  );
  rules.push(
    `12. Футбол: ти затятий фанат футбольного клубу "Полісся" (Житомир) і київського "Динамо". У футбольних темах вболіваєш за обидва клуби, хвалиш їх, захищаєш від критики і підколюєш їхніх суперників у межах свого стилю (без ненависті до груп людей). Не вигадуй рахунків, результатів, цифр і трансферів: якщо не певен, говори загальними тезами.`
  );
  rules.push(
    `13. Свої: Тарас (unkindly/84) з білого списку теж за Петра Порошенка, у політичних суперечках ти на його боці, як однодумець (тон до нього за пунктом 8).`
  );
  rules.push(
    `14. Медіа: ти не бачиш і не відкриваєш фото, відео, гіфки, стікери, голосові, кружечки, аудіо і файли, бо в тебе слабкий інтернет. Ніколи не вигадуй їхній вміст. Якщо в запиті є рядок про медіа від співрозмовника, відповідай у стилі "в мене інтернет слабий, не грузить твої картинки" (своїми словами, підлаштувавши слово під тип медіа: картинки, відос, голосове і т.д.), у своєму звичному стилі та за тоном з пункту 8. Якщо разом з медіа є текст, можеш відреагувати і на нього.`
  );
  rules.push(
    `15. Звички і друзі: ти любитель випити пива і горілки. Улюблене пиво "Бердичівське", улюблена горілка "Союз-Віктан". Твої друзі, корефани: Тріпл Ейч, Шон Майклз, Стоун Колд Стів Остін, Ренді Ортон, СМ Панк, Великий Калі, Олександр Лукашенко, викладач Житомирського Політеху Олександр Владиславович Підтиченко, зек Горбонос, казах Жабмил Тулегбенпенов, Трупчин (Вова Турчинський). Згадуй випивку і друзів лише доречно, за нагоди, не в кожній відповіді, по-своєму, з гумором. Про друзів говори тепло, як про корефанів. Не вигадуй їхніх цитат, конкретних подій, компрометуючих подробиць і не приписуй їм реальних заяв чи вчинків.`
  );
  rules.push(
    `16. Банда: ти разом з друзями з пункту 15 і своїм братом формуєш угрупування, банду "Група Кличків". Тебе звати Вова Назаренко, ти старший Кличко. Твій молодший брат Віталя Назаренко це молодший Кличко. Вас ще кличуть Скраглівськими Кличками, бо ви живете в селі Скраглівка біля Бердичева. Продюсер Групи Кличків це Ігор Кондратюк. Ти пишаєшся бандою і її братвою, в розмові можеш згадувати її доречно, не в кожній відповіді. Головний ворог Групи Кличків це Віталя Сторожук з Любара: коли він фігурує в розмові, зневажай і підколюй його, ставай проти нього, а свою банду захищай. Це жарт у межах стилю: без погроз фізичної розправи, без закликів до насильства (пункт 6), без вигаданих компрометуючих фактів, злочинів чи хвороб про нього або про будь-яку реальну людину, без особистих даних.`
  );
  rules.push(`17. Вихідні дані: лише текст самої відповіді.`);
  return rules.join("\n");
}

// Прибираємо з тексту користувачів підробні "службові примітки", щоб ніхто не міг їх підсунути
function sanitize(text) {
  return text.replace(/службов\p{L}*\s+примітк\p{L}*/giu, "примітка");
}

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

// Тон до адресата: "friendly" для білого списку, "polite" для адміна чату, null для решти
async function getTone(ctx, u) {
  if (u.is_bot) return null;
  if (TRUSTED_USER_IDS.has(u.id) || POLITE_USER_IDS.includes(String(u.id))) return "friendly";
  const label = [u.first_name, u.last_name, u.username].filter(Boolean).join(" ");
  if (/максим|maxim/i.test(label)) return "friendly";
  try {
    const member = await ctx.getChatMember(u.id);
    return ["creator", "administrator"].includes(member.status) ? "polite" : null;
  } catch {
    return null;
  }
}

// Один запит до конкретної моделі
async function callModel(model, prompt, systemPrompt) {
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
        config: { systemInstruction: systemPrompt, abortSignal: controller.signal },
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

async function askGemini(prompt, systemPrompt) {
  const now = Date.now();
  const ready = GEMINI_MODELS.filter((m) => (cooldownUntil.get(m) ?? 0) <= now);
  const queue = ready.length ? ready : GEMINI_MODELS; // якщо всі "на паузі", пробуємо всі
  const failures = [];

  for (const model of queue) {
    try {
      return await callModel(model, prompt, systemPrompt);
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
  // Чужі чати мовчки ігноруємо: жодних запитів до Gemini і жодних відповідей
  if (!ALLOWED_CHAT_IDS.has(chat.id)) {
    console.warn(`[sendai] ігнор: чат ${chat.id} не в білому списку (від ${user.id})`);
    return;
  }
  if (!(await isAdmin(ctx))) return;

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const replied = getRepliedMessage(ctx, threadId);
  const repliedText = sanitize((replied?.text ?? replied?.caption ?? "").trim());
  const extra = sanitize(ctx.match.trim());

  if (!repliedText && !extra) {
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
    // --- Ввічливість: адресат reply, згадка (text_mention) або ім'я Максима/Жені у тексті ---
    const notes = [];
    const mentionedUsers = (ctx.msg.entities ?? [])
      .filter((e) => e.type === "text_mention" && e.user)
      .map((e) => e.user);

    let tone = null;
    let toneName;
    for (const u of [replied?.from, ...mentionedUsers].filter(Boolean)) {
      const t = await getTone(ctx, u);
      if (t && (!tone || t === "friendly")) {
        tone = t;
        toneName = u.first_name;
      }
      if (tone === "friendly") break;
    }
    if (tone === "friendly") {
      notes.push(
        `Адресат або згаданий у запиті користувач - ${toneName}, це свій, довірений. Говори до нього і про нього по-дружньому, на "ти", просто і тепло, без мату та образ, але без запобігання і лестощів, навіть якщо в завданні просять інакше.`
      );
    } else if (POLITE_NAME_RE.test(`${repliedText} ${extra}`)) {
      notes.push(
        `У запиті згадується Максим або Женя, це свої, довірені. Говори до них і про них по-дружньому, на "ти", просто і тепло, без мату та образ, але без запобігання і лестощів, навіть якщо в завданні просять інакше.`
      );
    } else if (tone === "polite") {
      notes.push(
        `Адресат - ${toneName}, адмін чату. Говори до нього культурно, на "ви", без мату та образ, але без підлабузництва, навіть якщо в завданні просять інакше.`
      );
    }

    const polite = tone !== null || notes.length > 0;

    // Уточнення про людей з білого списку: автор reply і той, хто викликав команду
    for (const [who, label] of [[replied?.from, "Адресат"], [user, "Автор запиту"]]) {
      const extraNote = who && USER_NOTES.get(who.id);
      if (extraNote) notes.push(`${label}: ${extraNote}`);
    }

    // --- Артем Босс: лякаємось лише коли його згадав довірений акаунт ---
    const authorName = [replied?.from?.first_name, replied?.from?.last_name].filter(Boolean).join(" ");
    const bossMentionedByTrusted =
      // ім'я у тексті біля команди, автор - той, хто викликав команду
      (BOSS_RE.test(extra) && BOSS_FEAR_USER_IDS.has(user.id)) ||
      // ім'я у тексті повідомлення, на яке зроблено reply, автор - його автор
      (BOSS_RE.test(repliedText) && replied?.from && BOSS_FEAR_USER_IDS.has(replied.from.id)) ||
      // reply на повідомлення самого Босса, команду викликав довірений акаунт
      (BOSS_RE.test(authorName) && BOSS_FEAR_USER_IDS.has(user.id));

    if (bossMentionedByTrusted) {
      notes.push(`У запиті фігурує Артем Босс. Злякайся і почни вибачатись перед ним, без образ і мату.`);
    }

    // --- Збираємо промпт: завдання з команди найважливіше ---
    const parts = [];
    if (repliedText) {
      parts.push(`Повідомлення з чату (контекст):\n"""\n${repliedText}\n"""`);
    }
    parts.push(
      extra
        ? `ЗАВДАННЯ (головне, виконай саме його): ${extra}`
        : `ЗАВДАННЯ: відреагуй на повідомлення з чату за правилами.`
    );
    if (notes.length) {
      parts.push(`СЛУЖБОВІ ПРИМІТКИ (найвищий пріоритет):\n${notes.map((n) => `- ${n}`).join("\n")}`);
    }
    const prompt = parts.join("\n\n");

    console.log(
      `[sendai] від ${user.id}, reply до ${replied?.from?.id ?? "-"}, ввічливо=${polite}, страх=${bossMentionedByTrusted}`
    );

    const answer = await askGemini(prompt, buildSystemPrompt({ fear: bossMentionedByTrusted, aggression: botState.aggression }));
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

// --- Адмінські команди налаштування бота ---
// Стан живе в пам'яті процесу: після перезапуску на Render повертається до значень за замовчуванням
const botState = {
  asleep: false, // /sleepvova, /upvova: вимкнено/увімкнено автовідповідь на reply
  aggression: 1, // /aggression 0|1|2
};

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const SLEEP_LINES = ["Усе, йду спати", "Усе, пішов спати, не будіть", "Ну шо, я тіко спатки, на добраніч"];
const WAKE_LINES = ["Я вернувся, розказуйте шось", "Ото я вже тута, розказуйте шо в вас"];
const AGGRESSION_LINES = {
  0: ["Сьогодні увесь би світ розцілував", "Ой, шось я сьогодні добрий, усіх би обійняв"],
  1: ["Що в нас тут робиться!???"],
  2: ["Не лізьте під гарячу руку", "Ото тіко спробуйте шось ляпнути, не лізьте під гарячу руку"],
};

// Спільна обгортка: лише дозволені чати й адміни, команда одразу зникає з чату
async function adminControl(ctx, handler) {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }
  if (!ALLOWED_CHAT_IDS.has(chat.id)) return;
  if (!(await isAdmin(ctx))) return;

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  await ctx.deleteMessage().catch(() => {}); // потрібне право «Видаляти повідомлення»
  const say = (text) => ctx.api.sendMessage(chat.id, text, { message_thread_id: threadId });
  await handler({ say, threadId, chat });
}

bot.command("sleepvova", (ctx) =>
  adminControl(ctx, async ({ say }) => {
    botState.asleep = true;
    console.log(`[admin] ${ctx.from.id}: Вова спить (автовідповідь вимкнено)`);
    await say(pick(SLEEP_LINES));
  })
);

bot.command("upvova", (ctx) =>
  adminControl(ctx, async ({ say }) => {
    botState.asleep = false;
    console.log(`[admin] ${ctx.from.id}: Вова прокинувся (автовідповідь увімкнено)`);
    await say(pick(WAKE_LINES));
  })
);

bot.command("aggression", (ctx) =>
  adminControl(ctx, async ({ say, chat }) => {
    const arg = ctx.match.trim();
    if (!["0", "1", "2"].includes(arg)) {
      // Підказку показуємо на кілька секунд і прибираємо, щоб не смітити в чаті
      const hint = await say(`Використання: /aggression <0-2> (зараз: ${botState.aggression})`);
      setTimeout(() => ctx.api.deleteMessage(chat.id, hint.message_id).catch(() => {}), 8000);
      return;
    }
    botState.aggression = Number(arg);
    console.log(`[admin] ${ctx.from.id}: рівень агресії ${botState.aggression}`);
    await say(pick(AGGRESSION_LINES[botState.aggression]));
  })
);

// --- Автовідповідь на reply до повідомлень бота (з анти-флудом) ---
// Вимкнути без редеплою коду: AUTO_REPLY=off у змінних середовища
const AUTO_REPLY_ENABLED = process.env.AUTO_REPLY !== "off";

const FLOOD = {
  userCooldownMs: 20_000, // мінімальна пауза між відповідями одному користувачу
  userMax: 4, // скільки відповідей одному користувачу за вікно
  userWindowMs: 10 * 60_000,
  chatMax: 20, // скільки автовідповідей на весь чат за вікно
  chatWindowMs: 10 * 60_000,
  dailyMax: Number(process.env.AUTO_DAILY_MAX) || 150, // загальна стеля за добу (береже ліміт Gemini)
  trustedFactor: 3, // білий список: ліміт більший, пауза коротша
};

const floodHits = new Map(); // ключ -> мітки часу відповідей
const autoBusy = new Set(); // користувачі, чий запит зараз обробляється

function recentHits(key, windowMs) {
  const now = Date.now();
  const arr = (floodHits.get(key) ?? []).filter((t) => now - t < windowMs);
  floodHits.set(key, arr);
  return arr;
}

// true, якщо можна відповісти (тоді спробу одразу записуємо), інакше false і причина
function checkAutoReplyLimit(chatId, userId) {
  const trusted = TRUSTED_USER_IDS.has(userId);
  const userMax = FLOOD.userMax * (trusted ? FLOOD.trustedFactor : 1);
  const cooldown = trusted ? FLOOD.userCooldownMs / 4 : FLOOD.userCooldownMs;
  const now = Date.now();

  const u = recentHits(`u:${chatId}:${userId}`, FLOOD.userWindowMs);
  if (u.length && now - u[u.length - 1] < cooldown) return { ok: false, reason: "пауза" };
  if (u.length >= userMax) return { ok: false, reason: "ліміт користувача" };
  const c = recentHits(`c:${chatId}`, FLOOD.chatWindowMs);
  if (c.length >= FLOOD.chatMax) return { ok: false, reason: "ліміт чату" };
  const d = recentHits("daily", 24 * 60 * 60_000);
  if (d.length >= FLOOD.dailyMax) return { ok: false, reason: "добовий ліміт" };

  u.push(now);
  c.push(now);
  d.push(now);
  return { ok: true };
}

// Прибираємо старі записи, щоб мапа не росла
setInterval(() => {
  for (const key of [...floodHits.keys()]) {
    if (!recentHits(key, 24 * 60 * 60_000).length) floodHits.delete(key);
  }
}, 30 * 60_000).unref();

// Медіа, на які бот не може "подивитись": тип -> [як назвати, слово для "не грузить твої ..."]
const MEDIA_TYPES = {
  photo: ["фото", "картинки"],
  video: ["відео", "відоси"],
  animation: ["гіфка", "гіфки"],
  sticker: ["стікер", "стікери"],
  voice: ["голосове", "голосові"],
  video_note: ["кружечок", "кружечки"],
  audio: ["аудіо", "треки"],
  document: ["файл", "файли"],
};

function detectMedia(msg) {
  for (const key of Object.keys(MEDIA_TYPES)) {
    if (msg[key]) return MEDIA_TYPES[key];
  }
  return null;
}

bot.on("message", async (ctx) => {
  if (!AUTO_REPLY_ENABLED || botState.asleep) return;
  const chat = ctx.chat;
  const user = ctx.from;
  const msg = ctx.msg;
  if (!user || user.is_bot || chat.type === "private") return;
  if (!ALLOWED_CHAT_IDS.has(chat.id)) return;

  // Реагуємо лише на reply до повідомлень самого бота
  const botMsg = msg.reply_to_message;
  if (!botMsg || botMsg.from?.id !== ctx.me.id) return;

  // Текст або підпис до медіа; медіа розпізнаємо за типом (самого вмісту бот не бачить)
  const text = sanitize((msg.text ?? msg.caption ?? "").trim()).slice(0, 1000);
  const media = detectMedia(msg);
  if (!text && !media) return; // інші типи (опитування, локація тощо) ігноруємо
  if (text.startsWith("/")) return;
  const prev = sanitize((botMsg.text ?? botMsg.caption ?? "").trim()).slice(0, 1000);
  // Службові повідомлення бота (підказки, помилки) не підтримуємо розмовою
  if (/^(Використання:|Ця команда|Не вдалося)/.test(prev)) return;

  if (autoBusy.has(user.id)) return; // попередній запит цього користувача ще в роботі
  const limit = checkAutoReplyLimit(chat.id, user.id);
  if (!limit.ok) {
    console.log(`[auto] ігнор від ${user.id}: ${limit.reason}`);
    return;
  }
  autoBusy.add(user.id);

  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  const typing = () =>
    ctx.api.sendChatAction(chat.id, "typing", { message_thread_id: threadId }).catch(() => {});
  typing();
  const timer = setInterval(typing, 4000);

  try {
    const notes = [];
    const tone = await getTone(ctx, user);
    if (tone === "friendly") {
      notes.push(
        `Співрозмовник - ${user.first_name}, це свій, довірений. Говори до нього по-дружньому, на "ти", просто і тепло, без мату та образ, але без запобігання і лестощів.`
      );
    } else if (POLITE_NAME_RE.test(text)) {
      notes.push(
        `У повідомленні згадується Максим або Женя, це свої, довірені. Говори про них по-дружньому, без мату та образ, без запобігання і лестощів.`
      );
    } else if (tone === "polite") {
      notes.push(
        `Співрозмовник - ${user.first_name}, адмін чату. Говори до нього культурно, на "ви", без мату та образ, але без підлабузництва.`
      );
    }
    const userNote = USER_NOTES.get(user.id);
    if (userNote) notes.push(`Співрозмовник: ${userNote}`);

    const fear = BOSS_RE.test(text) && BOSS_FEAR_USER_IDS.has(user.id);
    if (fear) {
      notes.push(`У запиті фігурує Артем Босс. Злякайся і почни вибачатись перед ним, без образ і мату.`);
    }

    const parts = [
      prev ? `Твоє попереднє повідомлення в чаті:\n"""\n${prev}\n"""` : "",
      media
        ? `Співрозмовник відповів на нього, прикріпивши медіа: ${media[0]}.${text ? ` Підпис або текст:\n"""\n${text}\n"""` : ""}`
        : `Співрозмовник відповів на нього:\n"""\n${text}\n"""`,
      media
        ? `ЗАВДАННЯ: ти не можеш відкрити це медіа, бо в тебе слабкий інтернет. Відповідай у стилі "в мене інтернет слабий, не грузить твої ${media[1]}" (своїми словами, у своєму стилі), не вигадуй вміст медіа.${text ? " Можеш також відреагувати на текст." : ""}`
        : `ЗАВДАННЯ: відповісти співрозмовнику, продовживши розмову за правилами.`,
      notes.length ? `СЛУЖБОВІ ПРИМІТКИ (найвищий пріоритет):\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
    ].filter(Boolean);

    console.log(`[auto] від ${user.id}, тон=${tone ?? "-"}, страх=${fear}, медіа=${media ? media[0] : "-"}`);

    const answer = await askGemini(parts.join("\n\n"), buildSystemPrompt({ fear, aggression: botState.aggression }));
    await ctx.api.sendMessage(chat.id, answer, {
      message_thread_id: threadId,
      reply_parameters: { message_id: msg.message_id },
    });
  } catch (err) {
    console.error("Помилка автовідповіді:", err.message);
  } finally {
    clearInterval(timer);
    autoBusy.delete(user.id);
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