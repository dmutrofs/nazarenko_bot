import "dotenv/config";
import http from "node:http";
import { Bot } from "grammy";

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error("Не знайдено BOT_TOKEN. Додайте його у файл .env");
  process.exit(1);
}

const bot = new Bot(token);

bot.command("send", async (ctx) => {
  const chat = ctx.chat;
  const user = ctx.from;
  if (!user || chat.type === "private") {
    return ctx.reply("Ця команда працює лише в груповому чаті.");
  }

  const member = await ctx.getChatMember(user.id);
  if (!["creator", "administrator"].includes(member.status)) return;

  const text = ctx.match.trim();
  if (!text) {
    return ctx.reply("Використання: /send <текст повідомлення>");
  }

  const replyTo = ctx.msg.reply_to_message?.message_id;

  await ctx.api.sendMessage(chat.id, text, {
    message_thread_id: ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined,
    reply_parameters: replyTo ? { message_id: replyTo } : undefined,
  });

  await ctx.deleteMessage().catch(() => {});
});

bot.catch((err) => console.error("Помилка бота:", err.error));

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

bot.start({ onStart: (me) => console.log(`Бот @${me.username} запущено`) });

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, async () => {
    server.close();
    await bot.stop();
    process.exit(0);
  });
}