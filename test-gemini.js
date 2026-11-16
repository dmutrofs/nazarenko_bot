// Запуск: node test-gemini.js   (з тієї ж папки, де лежить .env)
import "dotenv/config";

const key = process.env.GEMINI_API_KEY;
const BASE = "https://generativelanguage.googleapis.com/v1beta";
const PROMPT = "Скажи одне слово: привіт";

const post = (path, payload, ms) =>
  fetch(`${BASE}/${path}${path.includes("?") ? "&" : "?"}key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ms),
  });

async function step(name, fn) {
  const t = Date.now();
  try {
    const result = await fn();
    console.log(`OK      ${name} (${Date.now() - t} мс): ${result}`);
  } catch (e) {
    console.log(`ПОМИЛКА ${name} (${Date.now() - t} мс): ${e.cause?.code ?? e.name} - ${e.message}`);
  }
}

const short = (s) => String(s).replace(/\s+/g, " ").slice(0, 110);
const textOf = (j) => j.candidates?.[0]?.content?.parts?.[0]?.text ?? JSON.stringify(j.error ?? j);

console.log("Node:", process.version);

// 1) Які моделі доступні для генерації
const list = await (await fetch(`${BASE}/models?key=${key}&pageSize=200`)).json();
const models = (list.models ?? [])
  .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
  .map((m) => m.name.replace("models/", ""))
  .filter((n) => /flash|lite/i.test(n) && !/image|tts|live|audio|embed/i.test(n));
console.log("Моделі flash/lite, доступні для generateContent:\n  " + models.join("\n  "));

// 2) Звичайний запит на кожну модель (по 25 с)
for (const m of models.slice(0, 8)) {
  await step(`generateContent ${m}`, async () => {
    const r = await post(`models/${m}:generateContent`, { contents: [{ parts: [{ text: PROMPT }] }] }, 25000);
    return `HTTP ${r.status}: ${short(textOf(await r.json()))}`;
  });
}

// 3) Для першої моделі: стрімінг і мінімальне "міркування"
const m0 = process.env.GEMINI_MODEL || models[0];
await step(`stream ${m0} (до 60 с)`, async () => {
  const r = await post(`models/${m0}:streamGenerateContent?alt=sse`, { contents: [{ parts: [{ text: PROMPT }] }] }, 60000);
  const { value } = await r.body.getReader().read();
  return `HTTP ${r.status}: ${short(new TextDecoder().decode(value))}`;
});
await step(`low thinking ${m0}`, async () => {
  const r = await post(
    `models/${m0}:generateContent`,
    { contents: [{ parts: [{ text: PROMPT }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } },
    25000
  );
  return `HTTP ${r.status}: ${short(textOf(await r.json()))}`;
});

process.exit(0);