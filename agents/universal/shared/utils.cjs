"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function cleanTitle(raw) {
  if (!raw) return "";
  let s = typeof raw === "object" ? JSON.stringify(raw) : String(raw).trim();
  if (!s) return "";
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  if (s.startsWith("[") || s.startsWith("{")) {
    try {
      const p = JSON.parse(s);
      if (Array.isArray(p) && p.length > 0) {
        const first = p[0];
        if (first && typeof first === "object") {
          s = first.title || first.name || first.step || first.stage || first.prompt || first.goal || s;
        } else if (typeof first === "string") {
          s = first;
        }
      } else if (p && typeof p === "object") {
        if (p.title || p.name || p.goal || p.objective) {
          s = p.title || p.name || p.goal || p.objective;
        } else if (Array.isArray(p.stages) && p.stages[0]) {
          const st = p.stages[0];
          s = typeof st === "object" ? (st.title || st.name || st.prompt || s) : String(st);
        } else if (Array.isArray(p.steps) && p.steps[0]) {
          const st = p.steps[0];
          s = typeof st === "object" ? (st.title || st.name || st.prompt || s) : String(st);
        } else if (Array.isArray(p.plan) && p.plan[0]) {
          const st = p.plan[0];
          s = typeof st === "object" ? (st.title || st.name || st.prompt || s) : String(st);
        }
      }
    } catch {}
  }
  if (typeof s === "string" && (s.startsWith("[") || s.startsWith("{") || s.includes("{\"title\":") || s.includes("{\"prompt\":") || s.includes("[{\""))) {
    const tm = s.match(/"title"\s*:\s*"([^"]+)"/);
    if (tm && tm[1]) {
      s = tm[1];
    } else {
      const pm = s.match(/"prompt"\s*:\s*"([^"]+)"/);
      if (pm && pm[1]) {
        s = pm[1];
      } else {
        const nm = s.match(/"name"\s*:\s*"([^"]+)"/);
        if (nm && nm[1]) s = nm[1];
      }
    }
  }
  s = String(s || "").replace(/\\n/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

function titleFromMessage(raw, fallback = "New conversation", maxLen = 80) {
  const cleaned = cleanTitle(raw);
  return cleaned ? cleaned.slice(0, maxLen) : fallback;
}

function shortenPath(p, max = 45) {
  const s = String(p || "").trim().replace(/\\/g, "/");
  if (!s || s.length <= max) return s;
  const parts = s.split("/").filter(Boolean);
  if (parts.length <= 1) {
    if (s.length > max) {
      const keep = Math.max(1, Math.floor((max - 3) / 2));
      return s.slice(0, keep) + "…" + s.slice(-keep);
    }
    return s;
  }
  let last = parts[parts.length - 1];
  if (last.length > max - 4) {
    const keep = Math.max(1, Math.floor((max - 5) / 2));
    last = last.slice(0, keep) + "…" + last.slice(-keep);
    return "…/" + last;
  }
  let out = last;
  for (let i = parts.length - 2; i >= 0; i--) {
    const candidate = parts[i] + "/" + out;
    if (candidate.length + 2 > max) {
      return "…/" + out;
    }
    out = candidate;
  }
  return out;
}

function fmtBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1048576) return (b / 1048576).toFixed(1) + " MB";
  if (b >= 1024) return Math.round(b / 1024) + " KB";
  return b + " B";
}

function fmtDur(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (total < 60) return total + "s";
  const mins = Math.floor(total / 60);
  if (mins < 60) return mins + "m " + String(total % 60).padStart(2, "0") + "s";
  return Math.floor(mins / 60) + "h " + String(mins % 60).padStart(2, "0") + "m";
}

function safeRenameSync(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (process.platform === "win32" && (err.code === "EPERM" || err.code === "EBUSY" || err.code === "EXDEV")) {
      fs.copyFileSync(src, dest);
      try { fs.unlinkSync(src); } catch {}
    } else {
      throw err;
    }
  }
}

function atomicWrite(file, data, options = {}) {
  const mode = options.mode;
  const encoding = options.encoding || "utf8";
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const strData = (typeof data === "object" && !Buffer.isBuffer(data) && data !== null)
    ? JSON.stringify(data, null, options.indent != null ? options.indent : 2)
    : data;
  const rand = crypto.randomBytes(4).toString("hex");
  const tmp = path.join(dir, "." + path.basename(file) + "." + process.pid + "." + Date.now() + "." + rand + ".tmp");
  if (mode != null) {
    fs.writeFileSync(tmp, strData, { mode, encoding: Buffer.isBuffer(strData) ? undefined : encoding });
  } else {
    fs.writeFileSync(tmp, strData, { encoding: Buffer.isBuffer(strData) ? undefined : encoding });
  }
  safeRenameSync(tmp, file);
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function atomicJson(file, value, indent = 2) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, indent)}\n`, "utf8");
  safeRenameSync(tmp, file);
}

function appendJsonl(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, "utf8");
}

function readJsonl(file, maxEntries = null) {
  try {
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    const slice = maxEntries != null ? lines.slice(-maxEntries) : lines;
    return slice.map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function safeName(v) {
  return String(v || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
const safeId = safeName;

function safeAttachmentName(name) {
  const base = path.basename(String(name || 'attachment.bin')).replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '');
  return base || 'attachment.bin';
}

function sha256(v) {
  return crypto.createHash("sha256").update(typeof v === "object" ? JSON.stringify(v) : String(v || "")).digest("hex");
}

function isProcessAlive(pid) {
  if (!pid || typeof pid !== "number" || isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code !== "ESRCH";
  }
}

function sleepSync(ms) {
  if (ms <= 0) return;
  try {
    const buf = new SharedArrayBuffer(4);
    const int32 = new Int32Array(buf);
    Atomics.wait(int32, 0, 0, ms);
  } catch {
    const start = Date.now();
    while (Date.now() - start < ms) {}
  }
}

function ensureDir(dir) {
  if (!dir) return;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort */ }
}

function parseSystemNotifications(text) {
  if (!text || typeof text !== "string") return [{ type: "text", content: text || "" }];
  const parts = [];
  const regex = /<(SYSTEM_NOTIFICATION|notification|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|USER_REQUEST)>([\s\S]*?)<\/\1>/gi;
  let lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ type: "text", content: text.slice(lastIndex, match.index) });
    }
    const tag = match[1].toLowerCase();
    const type = (tag === 'system_notification' || tag === 'notification') ? 'system_notification' : tag;
    parts.push({ type, content: match[2].trim() });
    lastIndex = regex.lastIndex;
  }
  if (lastIndex < text.length) {
    parts.push({ type: "text", content: text.slice(lastIndex) });
  }
  return parts.length ? parts : [{ type: "text", content: text }];
}

function wsAccept(key) {
  return crypto.createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
}

function wsFrameHeader(len) {
  return len < 126
    ? Buffer.from([0x81, len])
    : len < 65536
      ? Buffer.from([0x81, 126, len >> 8, len & 255])
      : Buffer.from([0x81, 127, 0, 0, 0, 0, (len / 2 ** 24) & 255, (len / 2 ** 16) & 255, (len / 2 ** 8) & 255, len & 255]);
}

function wsPong(socket, data) {
  const body = data && data.length <= 125 ? data : Buffer.alloc(0);
  try { socket.write(Buffer.concat([Buffer.from([0x8a, body.length]), body])); } catch { /* gone */ }
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return [];
  if (typeof v[Symbol.iterator] === 'function' && !Buffer.isBuffer(v)) {
    try { return Array.from(v); } catch { return []; }
  }
  return [];
}

module.exports = {
  cleanTitle,
  titleFromMessage,
  shortenPath,
  fmtBytes,
  fmtDur,
  ensureDir,
  atomicWrite,
  atomicWriteSync: atomicWrite,
  atomicJson,
  appendJsonl,
  readJson,
  readJsonSync: readJson,
  readJsonl,
  safeName,
  safeId,
  safeAttachmentName,
  sha256,
  isProcessAlive,
  sleepSync,
  parseSystemNotifications,
  wsAccept,
  wsFrameHeader,
  wsPong,
  asArray,
};



