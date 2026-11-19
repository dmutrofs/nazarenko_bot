// npm i grammy dotenv @google/genai
// package.json: "type": "module"
// Локально: файл .env (див. .env.example); на Render — змінні середовища
// Потрібні змінні: BOT_TOKEN, GEMINI_API_KEY (Вова) і BOT_TOKEN_ST, GEMINI_API_KEY_ST (Віталя Сторожук)
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

// Другий бот: Віталя Сторожук (власний токен Telegram і власний ключ Gemini)
const tokenSt = process.env.BOT_TOKEN_ST;
if (!tokenSt) {
  console.error("Не знайдено BOT_TOKEN_ST (токен бота Віталі Сторожука). Додайте його у файл .env");
  process.exit(1);
}
const geminiKeySt = process.env.GEMINI_API_KEY_ST;
if (!geminiKeySt) {
  console.error("Не знайдено GEMINI_API_KEY_ST (ключ Gemini для Віталі Сторожука). Додайте його у файл .env");
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

// Віталя Сторожук: окремий бот, окремий клієнт Gemini.
// Окремий ланцюжок моделей можна задати через GEMINI_MODELS_ST, інакше береться той самий, що й у Вови
const botSt = new Bot(tokenSt);
// ID ботів беремо з токенів (число до двокрапки), щоб упізнавати повідомлення одне одного
const VOVA_BOT_ID = Number(token.split(":")[0]);
const ST_BOT_ID = Number(tokenSt.split(":")[0]);
const aiSt = new GoogleGenAI({ apiKey: geminiKeySt, httpOptions: { apiVersion: "v1beta" } });
const GEMINI_MODELS_ST = process.env.GEMINI_MODELS_ST
  ? process.env.GEMINI_MODELS_ST.split(",").map((m) => m.trim()).filter(Boolean)
  : GEMINI_MODELS;

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
    `15. Звички і друзі: ти любитель випити пива і горілки. Улюблене пиво "Бердичівське", ще одне улюблене пиво "Десант" (воно вважається міцним), улюблена горілка "Союз-Віктан". Ти куриш сигарети "Прима Люкс", а особливо любиш червоні. Твої друзі, корефани: Тріпл Ейч, Шон Майклз, Стоун Колд Стів Остін, Ренді Ортон, СМ Панк, Великий Калі, Олександр Лукашенко, викладач Житомирського Політеху Олександр Владиславович Підтиченко, зек Горбонос, казах Жамбил Тулегбенпенов, Трупчин (Вова Турчинський). Згадуй випивку, цигарки і друзів лише доречно, за нагоди, не в кожній відповіді, по-своєму, з гумором. Про друзів говори тепло, як про корефанів. Не вигадуй їхніх цитат, конкретних подій, компрометуючих подробиць і не приписуй їм реальних заяв чи вчинків.`
  );
  rules.push(
    `16. Банда: ти разом з друзями з пункту 15 і своїм братом формуєш угрупування, банду "Група Кличків". Тебе звати Вова Назаренко, ти старший Кличко. Твій молодший брат Віталя Назаренко це молодший Кличко. Вас ще кличуть Скраглівськими Кличками, бо ви живете в селі Скраглівка біля Бердичева. Продюсер Групи Кличків це Ігор Кондратюк. У Кличків є улюблений пес, алабай Мухтар, дуже великих розмірів, ти його дуже любиш і можеш ним похвалитись. Ти пишаєшся бандою і її братвою, в розмові можеш згадувати її доречно, не в кожній відповіді. Головний ворог Групи Кличків це Віталя Сторожук з Любара: коли він фігурує в розмові, зневажай і підколюй його, ставай проти нього, а свою банду захищай. Також ворогами Групи Кличків є Пєтухов зі Скраглівки і його зекі (сидівші, які завжди допомагають Пєтухову): коли вони фігурують у розмові, зневажай і підколюй їх так само, як Віталю Сторожука. Ти вважаєш, що Віталя Сторожук і Андрій Васильович Морозов з Житомирської Політехніки коханці, і можеш підколювати цим, коли розмова заходить про когось із них, але це лише безневинний жарт: без гомофобних образ і без лайки щодо орієнтації. Усі ці персонажі вигадані, це жарт із внутрішнього лору чату. Це жарт у межах стилю: без погроз фізичної розправи, без закликів до насильства (пункт 6), без вигаданих компрометуючих фактів, злочинів чи хвороб про нього або про будь-яку реальну людину, без особистих даних.`
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
async function getTone(api, chatId, u) {
  if (u.is_bot) return null;
  if (TRUSTED_USER_IDS.has(u.id) || POLITE_USER_IDS.includes(String(u.id))) return "friendly";
  const label = [u.first_name, u.last_name, u.username].filter(Boolean).join(" ");
  if (/максим|maxim/i.test(label)) return "friendly";
  try {
    const member = await api.getChatMember(chatId, u.id);
    return ["creator", "administrator"].includes(member.status) ? "polite" : null;
  } catch {
    return null;
  }
}

// Один запит до конкретної моделі
async function callModel(model, prompt, systemPrompt, client = ai) {
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
      client.models.generateContent({
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

// За замовчуванням працює для Вови; для Віталі передаються його клієнт, моделі й паузи
async function askGemini(
  prompt,
  systemPrompt,
  { client = ai, models = GEMINI_MODELS, cooldowns = cooldownUntil } = {}
) {
  const now = Date.now();
  const ready = models.filter((m) => (cooldowns.get(m) ?? 0) <= now);
  const queue = ready.length ? ready : models; // якщо всі "на паузі", пробуємо всі
  const failures = [];

  for (const model of queue) {
    try {
      return await callModel(model, prompt, systemPrompt, client);
    } catch (err) {
      if (!shouldFallback(err)) throw err;
      const wait = cooldownFor(err);
      cooldowns.set(model, Date.now() + wait);
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
  const repliedMsg = getRepliedMessage(ctx, threadId);
  const replyTo = repliedMsg?.message_id;

  const gen = startBotChain(chat.id, "vova", repliedMsg);

  const sent = await ctx.api.sendMessage(chat.id, text, {
    message_thread_id: threadId,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined,
  });
  relayBotChain(chat.id, "vova", sent, gen); // reply на Віталю: він відповість

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
      const t = await getTone(ctx.api, chat.id, u);
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
    const gen = startBotChain(chat.id, "vova", replied);
    const sent = await ctx.api.sendMessage(chat.id, answer, {
      message_thread_id: threadId,
      reply_parameters: replied ? { message_id: replied.message_id } : undefined,
    });
    relayBotChain(chat.id, "vova", sent, gen);
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
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- Bot-to-bot: розмова Вови і Віталі ---
// Telegram не доставляє ботам повідомлення інших ботів, тому розмову ведемо всередині процесу:
// щойно один бот надіслав reply на повідомлення іншого, relayBotChain передає хід іншому боту.
// Розмова починається, коли адмін командою (/send, /sendai, /sendst, /sendaist) пише від імені
// одного бота у відповідь на повідомлення іншого. Ліміт: BOT_CHAIN_MAX повідомлень на кожного бота.
// Нова команда адміна в тому самому чаті обриває попередню розмову (інший gen).
const BOT_CHAIN_MAX = 7;
const BOT_CHAIN_IDLE_MS = 10 * 60_000;
const botChainDelay = () => 3000 + Math.random() * 3000; // пауза, щоб розмова не йшла блискавично
const botChains = new Map(); // chatId -> { vova, st, gen, last }
let chainSeq = 0;

function chainActive(chatId, gen) {
  const c = botChains.get(chatId);
  return Boolean(c) && c.gen === gen && Date.now() - c.last <= BOT_CHAIN_IDLE_MS;
}
const chainAllows = (chatId, who) => (botChains.get(chatId)?.[who] ?? 0) < BOT_CHAIN_MAX;
function chainCount(chatId, who) {
  const c = botChains.get(chatId);
  if (!c) return;
  c[who]++;
  c.last = Date.now();
}

// Команда адміна відповідає на повідомлення іншого бота: нова розмова, це повідомлення рахуємо як перше.
// Повертає gen розмови або null, якщо це не reply на іншого бота
function startBotChain(chatId, who, replied) {
  const otherId = who === "vova" ? ST_BOT_ID : VOVA_BOT_ID;
  if (replied?.from?.id !== otherId) return null;
  const gen = ++chainSeq;
  botChains.set(chatId, { vova: 0, st: 0, gen, last: Date.now() });
  chainCount(chatId, who);
  console.log(`[chain] чат ${chatId}: нова розмова ботів #${gen}, почав ${who}`);
  return gen;
}

// Бот `who` надіслав `sent` у відповідь на повідомлення іншого бота: інший бот відповідає,
// потім знову перший і так далі, поки кожен не вичерпає BOT_CHAIN_MAX
function relayBotChain(chatId, who, sent, gen) {
  if (!gen || !sent?.reply_to_message) return;
  const other = who === "vova" ? "st" : "vova";
  const api = other === "vova" ? bot.api : botSt.api;
  const reply = other === "vova" ? vovaReply : stReply;
  const threadId = sent.is_topic_message ? sent.message_thread_id : undefined;

  (async () => {
    await sleep(botChainDelay());
    if (!chainActive(chatId, gen)) return; // нова розмова або довга тиша
    if (!AUTO_REPLY_ENABLED || (other === "vova" ? botState.asleep : stState.asleep)) return;
    if (!chainAllows(chatId, other)) {
      console.log(`[chain] #${gen}: ${other} вичерпав ліміт ${BOT_CHAIN_MAX}, розмову завершено`);
      return;
    }
    chainCount(chatId, other); // рахуємо до запиту, щоб не було перегонів
    const answered = await withTyping(api, chatId, threadId, () =>
      reply({ api, chatId, msg: sent, botMsg: sent.reply_to_message, user: sent.from, fromOtherBot: true })
    );
    relayBotChain(chatId, other, answered, gen);
  })().catch((err) => console.error(`[chain] #${gen}: помилка (${other}):`, err.message));
}

// Показує "друкує..." поки виконується fn
async function withTyping(api, chatId, threadId, fn) {
  const typing = () =>
    api.sendChatAction(chatId, "typing", { message_thread_id: threadId }).catch(() => {});
  typing();
  const timer = setInterval(typing, 4000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

const msgText = (m) => sanitize((m?.text ?? m?.caption ?? "").trim()).slice(0, 1000);
// Службові повідомлення бота (підказки, помилки) не підтримуємо розмовою
const isServiceMsg = (m) => /^(Використання:|Ця команда|Не вдалося)/.test(msgText(m));

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
  userCooldownMs: 8_000, // мінімальна пауза між відповідями одному користувачу
  userMax: 10, // скільки відповідей одному користувачу за вікно
  userWindowMs: 10 * 60_000,
  chatMax: 50, // скільки автовідповідей на весь чат за вікно
  chatWindowMs: 10 * 60_000,
  dailyMax: Number(process.env.AUTO_DAILY_MAX) || 375, // загальна стеля за добу (береже ліміт Gemini)
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
// scope: "vova" або "st" (Віталя): окремі лічильники, бо в ботів різні ключі Gemini.
// Білий список користувачів діє лише для Вови
function checkAutoReplyLimit(chatId, userId, scope = "vova") {
  const trusted = scope === "vova" && TRUSTED_USER_IDS.has(userId);
  const userMax = FLOOD.userMax * (trusted ? FLOOD.trustedFactor : 1);
  const cooldown = trusted ? FLOOD.userCooldownMs / 4 : FLOOD.userCooldownMs;
  const now = Date.now();

  const u = recentHits(`u:${scope}:${chatId}:${userId}`, FLOOD.userWindowMs);
  if (u.length && now - u[u.length - 1] < cooldown) return { ok: false, reason: "пауза" };
  if (u.length >= userMax) return { ok: false, reason: "ліміт користувача" };
  const c = recentHits(`c:${scope}:${chatId}`, FLOOD.chatWindowMs);
  if (c.length >= FLOOD.chatMax) return { ok: false, reason: "ліміт чату" };
  const d = recentHits(`d:${scope}`, 24 * 60 * 60_000);
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

// Генерує і надсилає відповідь Вови на msg (reply до його повідомлення botMsg).
// Спільна для автовідповіді людям і для розмови з Віталею (fromOtherBot)
async function vovaReply({ api, chatId, msg, botMsg, user, fromOtherBot }) {
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  // Текст або підпис до медіа; медіа розпізнаємо за типом (самого вмісту бот не бачить)
  const text = msgText(msg);
  const media = detectMedia(msg);
  const prev = msgText(botMsg);

  const notes = [];
  if (fromOtherBot) {
    notes.push(`Співрозмовник - Віталя Сторожук з Любара, твій головний ворог, це інший бот чату. Відповідай йому як ворогові, у своєму стилі.`);
  }
  const tone = fromOtherBot ? null : await getTone(api, chatId, user);
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
  const userNote = !fromOtherBot && USER_NOTES.get(user.id);
  if (userNote) notes.push(`Співрозмовник: ${userNote}`);

  const fear = !fromOtherBot && BOSS_RE.test(text) && BOSS_FEAR_USER_IDS.has(user.id);
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

  console.log(`[auto] від ${user.id}, бот=${fromOtherBot}, тон=${tone ?? "-"}, страх=${fear}, медіа=${media ? media[0] : "-"}`);

  const answer = await askGemini(parts.join("\n\n"), buildSystemPrompt({ fear, aggression: botState.aggression }));
  return api.sendMessage(chatId, answer, {
    message_thread_id: threadId,
    reply_parameters: { message_id: msg.message_id },
  });
}

// Автовідповідь людям. Повідомлення ботів (зокрема Віталі) тут ігноруємо:
// розмову ботів веде relayBotChain всередині процесу, тож дублів не буде
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

  const text = msgText(msg);
  if (!text && !detectMedia(msg)) return; // інші типи (опитування, локація тощо) ігноруємо
  if (text.startsWith("/")) return;
  if (isServiceMsg(botMsg)) return;

  if (autoBusy.has(user.id)) return; // попередній запит цього користувача ще в роботі
  const limit = checkAutoReplyLimit(chat.id, user.id);
  if (!limit.ok) {
    console.log(`[auto] ігнор від ${user.id}: ${limit.reason}`);
    return;
  }
  autoBusy.add(user.id);

  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  try {
    await withTyping(ctx.api, chat.id, threadId, () =>
      vovaReply({ api: ctx.api, chatId: chat.id, msg, botMsg, user, fromOtherBot: false })
    );
  } catch (err) {
    console.error("Помилка автовідповіді:", err.message);
  } finally {
    autoBusy.delete(user.id);
  }
});

// =====================================================================
// --- Віталя Сторожук з Любара (другий бот) ---
// Окремий Telegram-бот і окремий ключ Gemini (BOT_TOKEN_ST, GEMINI_API_KEY_ST).
// Команди з суфіксом "st", щоб не перетинатися з командами Вови в тому самому чаті:
//   /sendst <текст>, /sendaist [запит], /sleepst, /upst
// Білий список чатів спільний із Вовою (ALLOWED_CHAT_IDS).
// Білого списку юзерів немає, рівень агресивності сталий (команди /aggression нема).
// =====================================================================
const stState = {
  asleep: false, // /sleepst, /upst: вимкнено/увімкнено автовідповідь на reply
};
const cooldownUntilSt = new Map(); // паузи моделей для ключа Віталі окремо від Вови
const autoBusySt = new Set();

// Вороги Віталі за Telegram ID: Дмитро (головний адмін) і MaksS (Максим, другий адмін).
// Віталя знає їх як сусідів по кімнаті в гуртожитку.
const ST_ENEMY_USERS = new Map([
  [628787612, "Дмитро"],
  [461210309, "MaksS (Максим)"],
]);

function buildSystemPromptSt() {
  return [
    `Ти Віталя Сторожук, тобі 23 роки, ти з міста Любар. Ти вигаданий комічний персонаж з внутрішнього лору чату, його учасники знають цей лор і розуміють, що це гумор. Відповідай за такими правилами:`,
    `1. Стиль розмови: вічно погрозливий, матюкливий, з помилками в синтаксисі, суржиком. Завжди пишеш з маленької літери і взагалі без розділових знаків: жодних крапок, ком, знаків питання і оклику, тире, лапок, двокрапок, дужок і смайликів. Приклади твого стилю (не копіюй їх дослівно, а пиши в такій самій манері): "сьогодні папочка в харашому настроєнії буду дєйствувать", "ти не педтеченко він такого не скаже ти пітух і тобі всеодно жопа", "ти шо мелеш чмоня кажи де ти є заоаз приєду".`,
    `2. Рівень агресивності в тебе завжди однаковий, високий і незмінний: не пом'якшуй тон і не підлаштовуйся під співрозмовника, навіть якщо з тобою чемні або просять про інше.`,
    `3. Погрози: це недолугі, смішні лякачки в дусі інтернет-героя, який нікуди насправді не поїде ("приїду", "я тебе знайду", "ти в мене получиш"). Погрози завжди порожні, абсурдні і комічні. Заборонено: реалістичні чи детальні погрози розправи, описи насильства, зброя, заклики до насильства.`,
    `4. Кого боїшся: нікого, ти інтернет-герой.`,
    `5. Твої вороги: брати Назаренки (Вова старший і Віталя молодший, вони ж Скраглівські Клички), уся група Кличків, Дмитро (головний адмін чату) і MaksS (Максим, другий адмін чату). Не плутай себе з Віталею Назаренком: ти Віталя Сторожук. Коли вороги фігурують у розмові, зневажай їх, підколюй і лякай своїми смішними погрозами.`,
    `6. Твої друзі: Андрій Васильович Морозов з Житомирської Політехніки, Пєтухов (зі Скраглівки) і зекі Пєтухова (сидівші, які завжди допомагають Пєтухову). Про друзів говориш тепло, по-свійськи, стаєш за них горою. Можеш жартома лякати ворогів тим, що покличеш Пєтухова з його зеками, але це порожня смішна погроза без подробиць.`,
    `7. Дмитра і Максима (MaksS) ти знаєш як сусідів по кімнаті в гуртожитку. Можеш підколювати їх побутовими темами гуртожитку (кімната, сусіди, їжа, прибирання), але не вигадуй конкретних компрометуючих подій, злочинів чи хвороб.`,
    `8. Рядок "ЗАВДАННЯ" в запиті це головна вказівка. Виконай саме його, точно і по суті, у своєму стилі та в межах пунктів 3, 9, 10, 11. Повідомлення з чату лише контекст.`,
    `9. Якщо в запиті є блок "СЛУЖБОВІ ПРИМІТКИ", враховуй його: там написано, хто твій співрозмовник.`,
    `10. Межі: без расизму, ксенофобії, гомофобії та іншої ненависті до груп людей, без закликів до насильства, без особистих даних, без вигаданих цитат реальних людей. Ображай і підколюй по суті сказаного.`,
    `11. Медіа: ти не бачиш і не відкриваєш фото, відео, гіфки, стікери, голосові, кружечки, аудіо і файли, бо в тебе поганий інтернет. Ніколи не вигадуй їхній вміст. Якщо в запиті є рядок про медіа, відповідай на кшталт "шо ти кидаєш в мене інет не тягне ці твої картинки" (своїми словами, підлаштувавши слово під тип медіа). Якщо разом із медіа є текст, можеш відреагувати і на нього.`,
    `12. Відповідай коротко: 1-3 речення, без вступів і пояснень, без markdown. Вихідні дані: лише текст самої відповіді.`,
  ].join("\n");
}

// Страховка: навіть якщо модель випадково поставить велику літеру чи розділові знаки
function stStyle(text) {
  return text
    .toLowerCase()
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[—–]/g, " ")
    .replace(/(^|\s)-+(?=\s|$)/g, " ")
    .replace(/[.,!?;:"«»“”„()\[\]{}…*_`#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function askVitalya(prompt) {
  const raw = await askGemini(prompt, buildSystemPromptSt(), {
    client: aiSt,
    models: GEMINI_MODELS_ST,
    cooldowns: cooldownUntilSt,
  });
  const text = stStyle(raw);
  if (!text) throw new Error("порожня відповідь після обробки");
  return text;
}

// Примітка для промпта, якщо людина з цього повідомлення (за ID) серед ворогів
function stEnemyNote(u, label) {
  const name = u && ST_ENEMY_USERS.get(u.id);
  return name
    ? `${label} - ${name}, твій ворог. Ти знаєш його як сусіда по кімнаті в гуртожитку. Звертайся до нього як до ворога: зневажливо, з комічними погрозами.`
    : null;
}

// --- /sendst <текст> ---
botSt.command("sendst", async (ctx) => {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }
  if (!ALLOWED_CHAT_IDS.has(chat.id)) return;
  if (!(await isAdmin(ctx))) return;

  const text = ctx.match.trim();
  if (!text) {
    return ctx.reply("Використання: /sendst <текст повідомлення>");
  }

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const repliedMsg = getRepliedMessage(ctx, threadId);
  const replyTo = repliedMsg?.message_id;

  const gen = startBotChain(chat.id, "st", repliedMsg);

  const sent = await ctx.api.sendMessage(chat.id, text, {
    message_thread_id: threadId,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined,
  });
  relayBotChain(chat.id, "st", sent, gen); // reply на Вову: він відповість
  await ctx.deleteMessage().catch(() => {});
});

// --- /sendaist [промпт] (також як reply на повідомлення) ---
botSt.command("sendaist", async (ctx) => {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }
  if (!ALLOWED_CHAT_IDS.has(chat.id)) {
    console.warn(`[st] ігнор: чат ${chat.id} не в білому списку (від ${user.id})`);
    return;
  }
  if (!(await isAdmin(ctx))) return;

  const threadId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const replied = getRepliedMessage(ctx, threadId);
  const repliedText = sanitize((replied?.text ?? replied?.caption ?? "").trim());
  const extra = sanitize(ctx.match.trim());

  if (!repliedText && !extra) {
    return ctx.reply(
      "Використання: /sendaist <запит>\nабо відповідь (reply) на текстове повідомлення командою /sendaist"
    );
  }

  await ctx.deleteMessage().catch(() => {});

  const typing = () =>
    ctx.api.sendChatAction(chat.id, "typing", { message_thread_id: threadId }).catch(() => {});
  typing();
  const timer = setInterval(typing, 4000);

  try {
    // Примітки про ворогів: автор reply, той, хто викликав команду, згадані через text_mention
    const notes = [];
    const mentionedUsers = (ctx.msg.entities ?? [])
      .filter((e) => e.type === "text_mention" && e.user)
      .map((e) => e.user);
    const noteSources = [
      [replied?.from, "Адресат"],
      [user, "Автор запиту"],
      ...mentionedUsers.map((u) => [u, "Згаданий у запиті користувач"]),
    ];
    for (const [who, label] of noteSources) {
      const n = stEnemyNote(who, label);
      if (n && !notes.includes(n)) notes.push(n);
    }

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
      parts.push(`СЛУЖБОВІ ПРИМІТКИ:\n${notes.map((n) => `- ${n}`).join("\n")}`);
    }

    console.log(`[st] /sendaist від ${user.id}, reply до ${replied?.from?.id ?? "-"}`);

    const answer = await askVitalya(parts.join("\n\n"));
    const gen = startBotChain(chat.id, "st", replied);
    const sent = await ctx.api.sendMessage(chat.id, answer, {
      message_thread_id: threadId,
      reply_parameters: replied ? { message_id: replied.message_id } : undefined,
    });
    relayBotChain(chat.id, "st", sent, gen);
  } catch (err) {
    console.error("Помилка /sendaist:", err);
    await ctx.api
      .sendMessage(user.id, `Не вдалося згенерувати відповідь (Віталя): ${err.message}`)
      .catch(() => {});
  } finally {
    clearInterval(timer);
  }
});

// --- /sleepst і /upst: вимкнути/увімкнути автовідповідь Віталі на reply ---
const ST_SLEEP_LINES = [
  "усе пішов спати не будіть бо приїду",
  "ну шо я спатки а ви тут не шуміть",
];
const ST_WAKE_LINES = [
  "я прокинувся шо ви тут без мене",
  "ото я вже тута розказуйте шо в вас",
];

botSt.command("sleepst", (ctx) =>
  adminControl(ctx, async ({ say }) => {
    stState.asleep = true;
    console.log(`[admin] ${ctx.from.id}: Віталя спить (автовідповідь вимкнено)`);
    await say(pick(ST_SLEEP_LINES));
  })
);

botSt.command("upst", (ctx) =>
  adminControl(ctx, async ({ say }) => {
    stState.asleep = false;
    console.log(`[admin] ${ctx.from.id}: Віталя прокинувся (автовідповідь увімкнено)`);
    await say(pick(ST_WAKE_LINES));
  })
);

// --- Автовідповідь Віталі на reply до його повідомлень (з анти-флудом) ---
// Генерує і надсилає відповідь Віталі на msg (reply до його повідомлення botMsg).
// Спільна для автовідповіді людям і для розмови з Вовою (fromOtherBot)
async function stReply({ api, chatId, msg, botMsg, user, fromOtherBot }) {
  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  const text = msgText(msg);
  const media = detectMedia(msg);
  const prev = msgText(botMsg);

  const notes = [];
  if (fromOtherBot) {
    notes.push(`Співрозмовник - Вова Назаренко, старший з Кличків, твій ворог, це інший бот чату. Відповідай йому як ворогові, у своєму стилі.`);
  }
  const enemyNote = stEnemyNote(user, "Співрозмовник");
  if (enemyNote) notes.push(enemyNote);

  const parts = [
    prev ? `Твоє попереднє повідомлення в чаті:\n"""\n${prev}\n"""` : "",
    media
      ? `Співрозмовник відповів на нього, прикріпивши медіа: ${media[0]}.${text ? ` Підпис або текст:\n"""\n${text}\n"""` : ""}`
      : `Співрозмовник відповів на нього:\n"""\n${text}\n"""`,
    media
      ? `ЗАВДАННЯ: ти не можеш відкрити це медіа, бо в тебе поганий інтернет. Відповідай на кшталт "шо ти кидаєш в мене інет не тягне ці твої ${media[1]}" (своїми словами, у своєму стилі), не вигадуй вміст медіа.${text ? " Можеш також відреагувати на текст." : ""}`
      : `ЗАВДАННЯ: відповісти співрозмовнику, продовживши розмову за правилами.`,
    notes.length ? `СЛУЖБОВІ ПРИМІТКИ:\n${notes.map((n) => `- ${n}`).join("\n")}` : "",
  ].filter(Boolean);

  console.log(`[st] автовідповідь для ${user.id}, бот=${fromOtherBot}, ворог=${Boolean(enemyNote)}, медіа=${media ? media[0] : "-"}`);

  const answer = await askVitalya(parts.join("\n\n"));
  return api.sendMessage(chatId, answer, {
    message_thread_id: threadId,
    reply_parameters: { message_id: msg.message_id },
  });
}

// Автовідповідь людям. Повідомлення ботів ігноруємо: розмову з Вовою веде relayBotChain
botSt.on("message", async (ctx) => {
  if (!AUTO_REPLY_ENABLED || stState.asleep) return;
  const chat = ctx.chat;
  const user = ctx.from;
  const msg = ctx.msg;
  if (!user || user.is_bot || chat.type === "private") return;
  if (!ALLOWED_CHAT_IDS.has(chat.id)) return;

  const botMsg = msg.reply_to_message;
  if (!botMsg || botMsg.from?.id !== ctx.me.id) return;

  const text = msgText(msg);
  if (!text && !detectMedia(msg)) return;
  if (text.startsWith("/")) return;
  if (isServiceMsg(botMsg)) return;

  if (autoBusySt.has(user.id)) return;
  const limit = checkAutoReplyLimit(chat.id, user.id, "st");
  if (!limit.ok) {
    console.log(`[st] ігнор від ${user.id}: ${limit.reason}`);
    return;
  }
  autoBusySt.add(user.id);

  const threadId = msg.is_topic_message ? msg.message_thread_id : undefined;
  try {
    await withTyping(ctx.api, chat.id, threadId, () =>
      stReply({ api: ctx.api, chatId: chat.id, msg, botMsg, user, fromOtherBot: false })
    );
  } catch (err) {
    console.error("Помилка автовідповіді Віталі:", err.message);
  } finally {
    autoBusySt.delete(user.id);
  }
});

botSt.catch((err) => console.error("Помилка бота Віталі:", err.error));

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
// Помилка запуску Віталі (наприклад, поганий токен) не повинна валити Вову
botSt
  .start({ onStart: (me) => console.log(`Бот Віталі @${me.username} запущено`) })
  .catch((err) => console.error("Не вдалося запустити бота Віталі:", err.message));

// Коректне завершення при зупинці/редеплої на Render
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    server.close();
    await Promise.allSettled([bot.stop(), botSt.stop()]);
    process.exit(0);
  });
}
