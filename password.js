import crypto from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(crypto.scrypt);

// scrypt parameters (OWASP-equivalent: N=2^15, r=8, p=3). They are stored inside
// the hash string, so they can be raised later without breaking old hashes.
const DEFAULT_PARAMS = { N: 32768, r: 8, p: 3 };
const KEY_LEN = 64;
const MAX_MEM = 128 * 1024 * 1024;

// Format: scrypt:N:r:p:saltHex:hashHex
// Only ":" separators and hex are used on purpose: no "$" characters, so the value
// is safe in .env files and hosting dashboards (no variable expansion).
export async function hashPassword(password, params = DEFAULT_PARAMS) {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = params;
  const key = await scrypt(password.normalize("NFKC"), salt, KEY_LEN, { N, r, p, maxmem: MAX_MEM });
  return ["scrypt", N, r, p, salt.toString("hex"), key.toString("hex")].join(":");
}

function parseHash(stored) {
  const parts = String(stored ?? "").trim().split(":");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const [, N, r, p, saltHex, hashHex] = parts;
  const params = { N: Number(N), r: Number(r), p: Number(p) };
  if (!Object.values(params).every((n) => Number.isInteger(n) && n > 0)) return null;
  if (!/^[0-9a-f]+$/i.test(saltHex) || !/^[0-9a-f]+$/i.test(hashHex)) return null;
  return { params, salt: Buffer.from(saltHex, "hex"), hash: Buffer.from(hashHex, "hex") };
}

export function isValidHashFormat(stored) {
  return parseHash(stored) !== null;
}

export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const { N, r, p } = parsed.params;
  const key = await scrypt(password.normalize("NFKC"), parsed.salt, parsed.hash.length, {
    N,
    r,
    p,
    maxmem: MAX_MEM,
  });
  return crypto.timingSafeEqual(key, parsed.hash);
}