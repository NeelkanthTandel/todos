// Shared by the hook and the connect/disconnect commands. Node 18+, no dependencies.
import { webcrypto } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const require = createRequire(import.meta.url);
// The website's own secret filter (public/clipboard.js), copied byte for byte; a test keeps the copy in sync.
require("./clipboard.cjs");
const secretCheck = globalThis.TodoClipboard.check;

const subtle = webcrypto.subtle;
export const toB64u = bytes => Buffer.from(bytes).toString("base64url");
export const fromB64u = s => new Uint8Array(Buffer.from(s, "base64url"));

// ---------- encryption (same format as public/relay.js) ----------
// data = base64url(iv ‖ AES-256-GCM(deflate-raw(JSON)))
export async function encrypt(keyB64, obj, iv = webcrypto.getRandomValues(new Uint8Array(12))) {
  const key = await subtle.importKey("raw", fromB64u(keyB64), "AES-GCM", false, ["encrypt"]);
  const plain = zlib.deflateRawSync(Buffer.from(JSON.stringify(obj), "utf8"));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, plain));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return toB64u(out);
}
export async function decrypt(keyB64, data) {
  const bytes = fromB64u(data);
  const key = await subtle.importKey("raw", fromB64u(keyB64), "AES-GCM", false, ["decrypt"]);
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(zlib.inflateRawSync(Buffer.from(plain), { maxOutputLength: 1 << 20 }).toString("utf8"));
}

// ---------- pairing code ----------
// base64url of: version byte 1 ‖ channel id (16 bytes) ‖ key (32) ‖ writer token (32) ‖ relay URL (UTF-8).
// Packing the binary parts keeps the code around 150 characters.
const LOCAL_URL = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?$/;
export function validRelay(url) {
  if (typeof url !== "string" || url.length > 200) return false;
  if (LOCAL_URL.test(url)) return true;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && !u.username && !u.password && u.pathname === "/" && !u.search && !u.hash && url === u.origin;
  } catch { return false; }
}
export function encodeCode({ relay, channelId, key, writerToken }) {
  const parts = [Uint8Array.of(1), fromB64u(channelId), fromB64u(key), fromB64u(writerToken), new TextEncoder().encode(relay)];
  return toB64u(Buffer.concat(parts));
}
export function decodeCode(code) {
  if (typeof code !== "string") return null;
  code = code.trim();
  if (!/^[A-Za-z0-9_-]{100,400}$/.test(code)) return null;
  const b = fromB64u(code);
  if (b[0] !== 1 || b.length < 82) return null;
  const conn = {
    relay: new TextDecoder().decode(b.slice(81)),
    channelId: toB64u(b.slice(1, 17)),
    key: toB64u(b.slice(17, 49)),
    writerToken: toB64u(b.slice(49, 81)),
  };
  return validConnection(conn) ? conn : null;
}
export function validConnection(c) {
  return !!c && validRelay(c.relay) &&
    typeof c.channelId === "string" && /^[A-Za-z0-9_-]{22}$/.test(c.channelId) &&
    typeof c.key === "string" && /^[A-Za-z0-9_-]{43}$/.test(c.key) &&
    typeof c.writerToken === "string" && /^[A-Za-z0-9_-]{43}$/.test(c.writerToken);
}

// ---------- config ----------
export const configDir = () => process.env.TODOS_CONFIG_DIR || path.join(os.homedir(), ".config", "todos");
export const connectionFile = () => path.join(configDir(), "connection.json");
// TODOS_CONNECTION (a pairing code) wins over the file, for cloud sessions that start from a fresh container.
export function loadConnection() {
  if (process.env.TODOS_CONNECTION) return decodeCode(process.env.TODOS_CONNECTION);
  try {
    const c = JSON.parse(fs.readFileSync(connectionFile(), "utf8"));
    if (!validConnection(c)) return null;
    return { relay: c.relay, channelId: c.channelId, key: c.key, writerToken: c.writerToken };
  } catch { return null; }
}
export function saveConnection(conn) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = connectionFile(), tmp = file + "." + process.pid + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(conn, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
export function removeConnection() {
  try { fs.unlinkSync(connectionFile()); return true; } catch { return false; }
}

// ---------- sending ----------
export async function send(conn, message, { timeout = 2500, retries = 1 } = {}) {
  const data = await encrypt(conn.key, message);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(conn.relay + "/c/" + conn.channelId + "/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + conn.writerToken },
      body: JSON.stringify({ data }),
      signal: AbortSignal.timeout(timeout),
      redirect: "error", // never replay the writer token to wherever a redirect points
    });
    if (res.status === 429 && attempt < retries) { await new Promise(r => setTimeout(r, 700)); continue; }
    return res.status;
  }
}

// ---------- what gets sent ----------
// The folder holding .git (or the working folder), then, for a git worktree, the main checkout it belongs to:
// .todos-ignore is checked in each, and the last one names the project. Never sent as a full path.
export function projectRoots(cwd) {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 40; i++) {
    const git = path.join(dir, ".git");
    if (fs.existsSync(git)) {
      const main = mainCheckout(git);
      return main && main !== dir ? [dir, main] : [dir];
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return [path.resolve(cwd)];
}
export const projectRoot = cwd => projectRoots(cwd).at(-1);
// In a worktree .git is a file, "gitdir: <main>/.git/worktrees/<name>", and that folder's commondir file points
// back to <main>/.git. null for anything else (a normal repo, a submodule, a bare repo, unreadable files).
function mainCheckout(git) {
  try {
    if (!fs.statSync(git).isFile()) return null;
    const m = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(fs.readFileSync(git, "utf8").slice(0, 4096));
    if (!m) return null;
    const gitdir = path.resolve(path.dirname(git), m[1]);
    const common = path.resolve(gitdir, fs.readFileSync(path.join(gitdir, "commondir"), "utf8").slice(0, 4096).trim());
    if (path.basename(common) !== ".git" || !fs.statSync(common).isDirectory()) return null;
    return path.dirname(common);
  } catch { return null; }
}
// Controls and bidi overrides could garble or disguise text on the board.
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export const projectName = root => (path.basename(root).replace(/[\t\n]/g, "").replace(CONTROLS, "") || "project").slice(0, 120);

const KEEP_OUT = new Set(["secret pattern", "card number", "random token"]);
// First meaningful line of the prompt, without Markdown or code, at most 80 characters. null when there's
// nothing usable or it looks like it contains a secret (the board then shows "Untitled session in <project>").
export function titleFrom(prompt) {
  if (typeof prompt !== "string") return null;
  const text = prompt.slice(0, 20000).replace(/\r\n?/g, "\n").replace(CONTROLS, "")
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1[^\n]*$|(?![\s\S]))/gm, "\n"); // fenced code blocks
  for (const raw of text.split("\n")) {
    if (/^( {4}|\t)/.test(raw)) continue; // indented code
    // Check the line as typed too: stripping Markdown can break up a secret (MY_API_KEY=… → MYAPIKEY=…).
    const typed = secretCheck(raw.slice(0, 2000));
    if (!typed.ok && KEEP_OUT.has(typed.reason)) return null;
    const line = raw
      .replace(/<\/?[A-Za-z][^>]{0,200}>/g, " ")
      .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,3}[.)]\s+)+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/`+([^`]*)`+/g, "$1")
      .replace(/(\*\*|\*|~~)(\S(?:.*?\S)?)\1/g, "$2")
      // _ and __ only count as emphasis at word boundaries, so snake_case names stay intact.
      .replace(/(^|[^\p{L}\p{N}_])(__?)(\S(?:.*?\S)?)\2(?![\p{L}\p{N}_])/gu, "$1$3")
      .replace(/\s+/g, " ").trim();
    if (!/[\p{L}\p{N}]/u.test(line)) continue;
    const full = secretCheck(line.slice(0, 2000));
    if (!full.ok && KEEP_OUT.has(full.reason)) return null;
    let title = line;
    if (title.length > 80) {
      const cut = title.slice(0, 79), space = cut.lastIndexOf(" ");
      title = (space > 50 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, "") + "…";
    }
    // Only a secret counts here too: a long line without spaces (Chinese, Japanese) is a "single token" once cut.
    const last = secretCheck(title);
    return last.ok || !KEEP_OUT.has(last.reason) ? title : null;
  }
  return null;
}
