// Usage: node hash-password.js
// Prompts for a password (hidden input) and prints a value for ADMIN_PASSWORD_HASH.
import { hashPassword } from "./password.js";

const MIN_LENGTH = 12;

function readHidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);

    // Piped input (e.g. `echo secret | node hash-password.js`): read everything.
    if (!process.stdin.isTTY) {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => (data += c));
      process.stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
      return;
    }

    let buf = "";
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(buf);
        }
        if (ch === "\u0003") process.exit(130); // Ctrl+C
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const password = await readHidden("Пароль: ");
if (password.length < MIN_LENGTH) {
  console.error(`Пароль закороткий: мінімум ${MIN_LENGTH} символів.`);
  process.exit(1);
}
if (process.stdin.isTTY) {
  const again = await readHidden("Повторіть пароль: ");
  if (again !== password) {
    console.error("Паролі не збігаються.");
    process.exit(1);
  }
}

console.log("\nДодайте у змінні оточення:\n");
console.log(`ADMIN_PASSWORD_HASH=${await hashPassword(password)}`);