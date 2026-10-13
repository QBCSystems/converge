"use strict";
// Universal Code Graph & Usage Analyzer (used-where / dead-code / call-chains / call-sites)
// Zero npm dependencies. Blazing fast, multi-language, AST/lexical-aware.
//
// Extracts declarations across JS/TS, Python, Go, Rust, C/C++, Java, C#, Ruby, PHP, Shell,
// masks comments/strings with exact position preservation, resolves call sites vs general
// references, builds caller->callee graphs, detects dead code with confidence,
// traces longest call chains, and ranks multi-call hotspots.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SKIP_DIR = new Set([
  "node_modules", ".git", ".agent", "dist", "build", "coverage",
  ".next", "vendor", "__pycache__", ".cache", "site", "target",
  "bin", "obj", ".turbo", ".yarn", "seed", "imports",
]);

const CODE_EXTS = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".mts", ".cts", ".tsx",
  ".py", ".pyw",
  ".go",
  ".rs",
  ".c", ".h", ".cpp", ".hpp", ".cc", ".cxx", ".hh", ".hxx",
  ".cs",
  ".java", ".kt", ".scala",
  ".rb",
  ".php",
  ".sh", ".bash", ".zsh",
]);

const BUILTINS = new Set([
  "undefined", "null", "true", "false", "NaN", "Infinity",
  "Object", "Array", "String", "Number", "Boolean", "Symbol", "Function",
  "Map", "Set", "WeakMap", "WeakSet", "Promise", "RegExp", "Error", "TypeError", "RangeError", "SyntaxError",
  "JSON", "Math", "Date", "Intl", "Reflect", "Proxy", "Buffer", "ArrayBuffer", "Uint8Array", "Int32Array",
  "process", "require", "module", "exports", "console", "global", "globalThis",
  "window", "document", "navigator", "location", "history", "localStorage", "sessionStorage",
  "fetch", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate",
  "parseInt", "parseFloat", "isNaN", "isFinite", "encodeURI", "encodeURIComponent", "decodeURI", "decodeURIComponent",
  "self", "this", "super", "arguments", "eval", "print", "len", "range", "dict", "list", "set", "tuple", "str", "int", "float", "bool",
]);

const BUILTIN_METHODS = new Set([
  // JS Array / Iterable prototype
  "push", "pop", "shift", "unshift", "slice", "splice", "indexOf", "lastIndexOf",
  "includes", "join", "split", "trim", "trimStart", "trimEnd", "trimLeft", "trimRight",
  "replace", "replaceAll", "toLowerCase", "toUpperCase", "startsWith", "endsWith",
  "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable",
  "forEach", "map", "filter", "reduce", "reduceRight", "find", "findIndex", "findLast",
  "findLastIndex", "some", "every", "flat", "flatMap", "concat", "fill", "copyWithin",
  "entries", "keys", "values", "sort", "reverse", "at",
  // JS Object / Function / Promise / Map / Set
  "assign", "create", "defineProperty", "defineProperties", "freeze", "seal",
  "fromEntries", "getOwnPropertyNames", "getOwnPropertyDescriptor", "getPrototypeOf",
  "bind", "call", "apply", "then", "catch", "finally", "all", "allSettled", "race", "any",
  "resolve", "reject", "get", "set", "has", "add", "delete", "clear",
  // Console / Logging
  "log", "error", "warn", "info", "debug", "trace", "dir", "table", "time", "timeEnd",
  "timeLog", "count", "countReset", "group", "groupEnd", "groupCollapsed", "assert",
  // RegExp / String matching
  "test", "exec", "match", "matchAll", "search", "padStart", "padEnd", "repeat",
  "charAt", "charCodeAt", "codePointAt", "substring", "substr", "normalize",
  // DOM / Web APIs
  "addEventListener", "removeEventListener", "dispatchEvent", "querySelector", "querySelectorAll",
  "getElementById", "getElementsByClassName", "getElementsByTagName", "createElement",
  "appendChild", "removeChild", "replaceChild", "insertBefore", "setAttribute", "getAttribute",
  "removeAttribute", "hasAttribute", "classList", "preventDefault", "stopPropagation",
  "stopImmediatePropagation", "focus", "blur", "click", "scroll", "scrollTo", "scrollBy",
  "postMessage", "cloneNode", "contains",
  // Node.js Streams / Events / FS / Process / HTTP
  "on", "once", "off", "emit", "addListener", "removeListener", "removeAllListeners",
  "pipe", "unpipe", "write", "end", "destroy", "close", "read", "pause", "resume",
  "listen", "send", "json", "status", "setHeader", "getHeader", "removeHeader", "writeHead",
  "format", "parse", "stringify", "now",
  // Python common built-in methods
  "append", "extend", "insert", "remove", "pop", "clear", "index", "count", "sort", "reverse",
  "copy", "keys", "values", "items", "get", "update", "setdefault", "strip", "lstrip", "rstrip",
  "split", "rsplit", "splitlines", "join", "find", "rfind", "replace", "startswith", "endswith",
  "encode", "decode", "format", "lower", "upper", "title", "capitalize",
]);

const INTERFACE_CANDIDATE_NAMES = new Set([
  "main", "init", "handler", "start", "run", "execute", "serve", "setup",
  "beforeEach", "afterEach", "beforeAll", "afterAll", "test", "it", "describe",
  "prepack", "postpack", "prepublish", "postinstall", "build", "render",
  "toJSON", "toString", "valueOf", "inspect", "dispose", "close", "cleanup",
  "componentDidMount", "componentWillUnmount", "getInitialProps", "getServerSideProps",
  "constructor", "componentDidCatch", "componentDidUpdate", "shouldComponentUpdate",
  "getDerivedStateFromError", "getDerivedStateFromProps", "getSnapshotBeforeUpdate",
  "default", "setUp", "tearDown",
]);

const MAX_FILE_SIZE = parseInt(process.env.CONVERGE_USED_WHERE_MAX_BYTES || "", 10) || 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// 1. Multi-Language Comment & String Sanitizer
// Replaces string literals and comments with whitespace/padding so that line
// and column numbers remain 100% exact while preserving template interpolations.
// ---------------------------------------------------------------------------

function isRegexPrefix(out) {
  let j = out.length - 1;
  while (j >= 0 && (out[j] === " " || out[j] === "\t" || out[j] === "\n" || out[j] === "\r")) j--;
  if (j < 0) return true;
  const lastChar = out[j];
  if (/[=({\[,:;!&|?+\-*%^~<>]/.test(lastChar)) return true;
  let k = j;
  while (k >= 0 && /[A-Za-z0-9_$]/.test(out[k])) k--;
  const word = out.slice(k + 1, j + 1);
  if (/^(?:return|typeof|void|throw|case|yield|await|delete|in|instanceof)$/.test(word)) return true;
  return false;
}

function sanitizeSource(src, ext) {
  const len = src.length;
  let out = "";
  let i = 0;

  const isJsTs = /\.[cm]?[jt]sx?$/.test(ext);
  const isPy = ext === ".py" || ext === ".pyw";
  const isRb = ext === ".rb";
  const isSh = ext === ".sh" || ext === ".bash" || ext === ".zsh";
  const isPhp = ext === ".php";
  const isCs = ext === ".cs";

  // JS/TS template stack: array of { inExpr: boolean, braceDepth: number }
  const templateStack = [];

  while (i < len) {
    const ch = src[i];
    const next = i + 1 < len ? src[i + 1] : "";

    // Inside a JS/TS template string literal (outside ${...} expression)
    if (isJsTs && templateStack.length > 0 && !templateStack[templateStack.length - 1].inExpr) {
      if (ch === "\\" && i + 1 < len) {
        out += src[i] === "\n" ? "\n" : " ";
        out += src[i + 1] === "\n" ? "\n" : " ";
        i += 2;
        continue;
      }
      if (ch === "$" && next === "{") {
        const top = templateStack[templateStack.length - 1];
        top.inExpr = true;
        top.braceDepth = 0;
        out += "  ";
        i += 2;
        continue;
      }
      if (ch === "`") {
        templateStack.pop();
        out += " ";
        i++;
        continue;
      }
      out += ch === "\n" ? "\n" : " ";
      i++;
      continue;
    }

    // Python / Ruby / Shell / PHP hash comments
    if ((isPy || isRb || isSh || isPhp) && ch === "#") {
      while (i < len && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Python triple quotes
    if (isPy && (src.slice(i, i + 3) === "\"\"\"" || src.slice(i, i + 3) === "'''")) {
      const q = src.slice(i, i + 3);
      out += "   ";
      i += 3;
      while (i < len && src.slice(i, i + 3) !== q) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < len) { out += "   "; i += 3; }
      continue;
    }

    // Line comments (//)
    if (ch === "/" && next === "/") {
      while (i < len && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }

    // Block comments (/* ... */)
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < len && !(src[i] === "*" && i + 1 < len && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < len) { out += "  "; i += 2; }
      continue;
    }

    // JS/TS Regex Literal (/pattern/flags)
    // Two JSX shapes must NOT be read as regex starts, or the sanitizer blanks
    // to the next "/" and swallows real references (this deleted CodeView from
    // the console as "dead code"):
    //   </div>   — "<" is a regex-prefix char, so every closing tag qualified
    //   /> after a blanked string attribute — `<img src="x" />` leaves "=" as
    //   the prefix. `/>/ ` (split on ">") stays a regex: it closes immediately.
    const jsxCloseTag = src[i - 1] === "<";
    const jsxSelfClose = next === ">" && src[i + 2] !== "/";
    if (isJsTs && ch === "/" && next !== "/" && next !== "*" && !jsxCloseTag && !jsxSelfClose && isRegexPrefix(out)) {
      out += " ";
      i++;
      let inCharClass = false;
      while (i < len) {
        if (src[i] === "\\") {
          out += src[i] === "\n" ? "\n" : " ";
          out += src[i + 1] === "\n" ? "\n" : " ";
          i += 2;
          continue;
        }
        if (src[i] === "[") { inCharClass = true; out += " "; i++; continue; }
        if (src[i] === "]") { inCharClass = false; out += " "; i++; continue; }
        if (src[i] === "/" && !inCharClass) {
          out += " ";
          i++;
          while (i < len && /[a-z]/i.test(src[i])) { out += " "; i++; }
          break;
        }
        if (src[i] === "\n") break;
        out += " ";
        i++;
      }
      continue;
    }

    // JS/TS template literal start
    if (isJsTs && ch === "`") {
      templateStack.push({ inExpr: false, braceDepth: 0 });
      out += " ";
      i++;
      continue;
    }

    // Track braces inside JS/TS template expression
    if (isJsTs && templateStack.length > 0 && templateStack[templateStack.length - 1].inExpr) {
      const top = templateStack[templateStack.length - 1];
      if (ch === "{") {
        top.braceDepth++;
        out += "{";
        i++;
        continue;
      }
      if (ch === "}") {
        if (top.braceDepth > 0) {
          top.braceDepth--;
          out += "}";
          i++;
        } else {
          top.inExpr = false;
          out += " ";
          i++;
        }
        continue;
      }
    }

    // Standard string literals ('...' or "...")
    if (ch === "\"" || ch === "'") {
      const q = ch;
      out += " ";
      i++;
      let escaped = false;
      while (i < len) {
        if (escaped) {
          out += src[i] === "\n" ? "\n" : " ";
          escaped = false;
          i++;
          continue;
        }
        if (src[i] === "\\") {
          escaped = true;
          out += " ";
          i++;
          continue;
        }
        if (src[i] === q) {
          out += " ";
          i++;
          break;
        }
        if (src[i] === "\n" && !isPy && !isRb && !isSh) {
          out += "\n";
          i++;
          break;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    out += ch;
    i++;
  }

  return out;
}

// ---------------------------------------------------------------------------
// 2. Multi-Language Symbol & Declaration Extraction
// ---------------------------------------------------------------------------

function extractDeclarations(relPath, originalSrc, sanitizedSrc) {
  const ext = path.extname(relPath).toLowerCase();
  const lines = originalSrc.split("\n");
  const sanLines = sanitizedSrc.split("\n");
  const decls = [];

  const isJsTs = /\.[cm]?[jt]sx?$/.test(ext);
  const isPy = ext === ".py" || ext === ".pyw";
  const isGo = ext === ".go";
  const isRs = ext === ".rs";
  const isC = /\.(c|h|cpp|hpp|cc|cxx|hh|hxx)$/.test(ext);
  const isCs = ext === ".cs";
  const isJava = ext === ".java" || ext === ".kt" || ext === ".scala";
  const isRb = ext === ".rb";
  const isPhp = ext === ".php";
  const isSh = ext === ".sh" || ext === ".bash" || ext === ".zsh";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const sanLine = sanLines[i] || "";
    const lineNum = i + 1;
    const trimmed = sanLine.trim();
    if (!trimmed) continue;

    // --- JavaScript / TypeScript ---
    if (isJsTs) {
      let m = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      if (m) {
        const isExported = /\bexport\b/.test(rawLine) || /\bmodule\.exports\b/.test(rawLine);
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>|(?:async\s*)?function|class\b)/.exec(trimmed);
      if (m) {
        const isExported = /\bexport\b/.test(rawLine);
        const kind = trimmed.includes("class") ? "class" : "function";
        decls.push({ name: m[1], line: lineNum, kind, exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      if (m) {
        const isExported = /\bexport\b/.test(rawLine);
        decls.push({ name: m[1], line: lineNum, kind: "class", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:export\s+)?(?:type|interface|enum)\s+([A-Za-z0-9_$]+)/.exec(trimmed);
      if (m) {
        const isExported = /\bexport\b/.test(rawLine);
        decls.push({ name: m[1], line: lineNum, kind: "type", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:async\s+)?(?:\*\s*)?(?:get\s+|set\s+)?([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{/.exec(trimmed);
      if (m && !/^(?:if|for|while|switch|catch|function|return|typeof)\b/.test(m[1])) {
        decls.push({ name: m[1], line: lineNum, kind: "method", exported: false, file: relPath });
        continue;
      }

      // Object property method or property definition: foo: { ... }, foo: function, foo: async () =>, foo: () =>, foo: [ ... ]
      m = /^([A-Za-z0-9_$]+)\s*:\s*(?:\{|\[|(?:async\s*)?(?:function\*?\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>))/.exec(trimmed);
      if (m && !/^(?:case|default)\b/.test(m[1])) {
        const isExported = /\bexport\b/.test(rawLine) || /\bmodule\.exports\b/.test(rawLine);
        const isCallable = /(?:function|=>)/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: isCallable ? "method" : "property", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "export", exported: true, file: relPath });
        continue;
      }

      if (!rawLine.startsWith(' ') && !rawLine.startsWith('\t') || /\bexport\b/.test(rawLine)) {
        m = /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=/.exec(trimmed);
        if (m) {
          const isExported = /\bexport\b/.test(rawLine);
          decls.push({ name: m[1], line: lineNum, kind: 'variable', exported: isExported, file: relPath });
          continue;
        }
      }
    }

    // --- Python ---
    if (isPy) {
      let m = /^(?:async\s+)?def\s+([A-Za-z0-9_]+)\s*\(/.exec(trimmed);
      if (m) {
        const isPrivate = m[1].startsWith("_") && !m[1].startsWith("__");
        const isMethod = /^\s{2,}/.test(sanLine);
        decls.push({ name: m[1], line: lineNum, kind: isMethod ? "method" : "function", exported: !isPrivate, file: relPath });
        continue;
      }

      m = /^class\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        const isPrivate = m[1].startsWith("_");
        decls.push({ name: m[1], line: lineNum, kind: "class", exported: !isPrivate, file: relPath });
        continue;
      }

      if (/^[A-Z0-9_]{2,}\s*=/.test(trimmed)) {
        m = /^([A-Za-z0-9_]+)\s*=/.exec(trimmed);
        if (m) decls.push({ name: m[1], line: lineNum, kind: "variable", exported: true, file: relPath });
      }
    }

    // --- Go ---
    if (isGo) {
      let m = /^func\s+(?:\([^)]+\)\s+)?([A-Za-z0-9_]+)\s*\(/.exec(trimmed);
      if (m) {
        const isExported = /^[A-Z]/.test(m[1]);
        decls.push({ name: m[1], line: lineNum, kind: trimmed.includes("(") && trimmed.indexOf("(") < trimmed.indexOf(m[1]) ? "method" : "function", exported: isExported, file: relPath });
        continue;
      }

      m = /^type\s+([A-Za-z0-9_]+)\s+(?:struct|interface)/.exec(trimmed);
      if (m) {
        const isExported = /^[A-Z]/.test(m[1]);
        decls.push({ name: m[1], line: lineNum, kind: "type", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:const|var)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        const isExported = /^[A-Z]/.test(m[1]);
        decls.push({ name: m[1], line: lineNum, kind: "variable", exported: isExported, file: relPath });
        continue;
      }
    }

    // --- Rust ---
    if (isRs) {
      let m = /^(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        const isExported = /^pub\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:pub(?:\([^)]+\))?\s+)?(?:struct|enum|trait|type|union)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        const isExported = /^pub\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "type", exported: isExported, file: relPath });
        continue;
      }
    }

    // --- C / C++ ---
    if (isC) {
      if (trimmed.startsWith("#define")) {
        const m = /^#define\s+([A-Za-z0-9_]+)/.exec(trimmed);
        if (m) decls.push({ name: m[1], line: lineNum, kind: "macro", exported: true, file: relPath });
        continue;
      }

      let m = /^(?:class|struct|enum|union)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "type", exported: true, file: relPath });
        continue;
      }

      m = /^(?:[A-Za-z0-9_:<>&*]+\s+)+([A-Za-z0-9_]+)\s*\([^;{}]*\)\s*(?:const\s*)?\{/.exec(trimmed);
      if (m && !/^(?:if|for|while|switch|catch)\b/.test(m[1])) {
        const isStatic = /\bstatic\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: !isStatic, file: relPath });
        continue;
      }
    }

    // --- Java / C# ---
    if (isJava || isCs) {
      let m = /^(?:public|protected|private|\s)*(?:class|interface|record|enum|struct)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        const isExported = /\bpublic\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "class", exported: isExported, file: relPath });
        continue;
      }

      m = /^(?:(?:public|protected|private|static|final|abstract|synchronized|override|async|virtual|sealed|readonly)\s+)+[A-Za-z0-9_<>[\]\s,]+\s+([A-Za-z0-9_]+)\s*\([^;{}]*\)\s*\{/.exec(trimmed);
      if (m && !/^(?:if|for|while|switch|catch)\b/.test(m[1])) {
        const isExported = /\bpublic\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "method", exported: isExported, file: relPath });
        continue;
      }
    }

    // --- Ruby ---
    if (isRb) {
      let m = /^def\s+(?:self\.)?([A-Za-z0-9_?!]+)/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: true, file: relPath });
        continue;
      }
      m = /^(?:class|module)\s+([A-Za-z0-9_:]+)/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "class", exported: true, file: relPath });
        continue;
      }
    }

    // --- PHP ---
    if (isPhp) {
      let m = /^(?:(?:public|protected|private|static)\s+)*function\s+([A-Za-z0-9_]+)\s*\(/.exec(trimmed);
      if (m) {
        const isPrivate = /\bprivate\b/.test(trimmed);
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: !isPrivate, file: relPath });
        continue;
      }
      m = /^(?:class|interface|trait|enum)\s+([A-Za-z0-9_]+)/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "class", exported: true, file: relPath });
        continue;
      }
    }

    // --- Shell ---
    if (isSh) {
      let m = /^(?:function\s+)?([A-Za-z0-9_-]+)\s*\(\)\s*\{/.exec(trimmed) || /^function\s+([A-Za-z0-9_-]+)\s*\{/.exec(trimmed);
      if (m) {
        decls.push({ name: m[1], line: lineNum, kind: "function", exported: true, file: relPath });
        continue;
      }
    }
  }

  // Cross-reference exports for multi-line or separate export statements
  if (isJsTs) {
    const exportedNames = new Set();

    // Multi-line module.exports = { ... } and export { ... }
    const objRegex = /(?:module\.)?exports\s*=\s*\{([^}]+)\}|export\s*\{([^}]+)\}/g;
    let objMatch;
    while ((objMatch = objRegex.exec(sanitizedSrc)) !== null) {
      const block = objMatch[1] || objMatch[2] || "";
      const parts = block.split(",");
      for (const p of parts) {
        const item = p.trim().split(/\s*:\s*|\s+as\s+/)[0].trim();
        if (item && /^[A-Za-z0-9_$]+$/.test(item)) exportedNames.add(item);
      }
    }

    // Single export statements: module.exports = identifier; or export default identifier;
    const singleExp = /(?:module\.)?exports\s*=\s*([A-Za-z0-9_$]+)\s*;|export\s+default\s+([A-Za-z0-9_$]+)\s*;/g;
    let sMatch;
    while ((sMatch = singleExp.exec(sanitizedSrc)) !== null) {
      const name = sMatch[1] || sMatch[2];
      if (name && name !== "function" && name !== "class") exportedNames.add(name);
    }

    // module.exports.foo = ... or exports.foo = ...
    const mExp = /(?:module\.)?exports\.([A-Za-z0-9_$]+)\s*=/g;
    let expMatch;
    while ((expMatch = mExp.exec(sanitizedSrc)) !== null) {
      if (expMatch[1]) exportedNames.add(expMatch[1]);
    }

    for (const d of decls) {
      if (exportedNames.has(d.name)) {
        d.exported = true;
      }
    }
  } else if (isPy) {
    const m = /__all__\s*=\s*\[([^\]]+)\]/.exec(sanitizedSrc);
    if (m) {
      const names = m[1].match(/[A-Za-z0-9_]+/g) || [];
      for (const n of names) {
        const target = decls.find((d) => d.name === n);
        if (target) target.exported = true;
      }
    }
  }

  estimateSpans(decls, lines, ext);
  return decls;
}

function estimateSpans(decls, lines, ext = "") {
  const isPy = ext === ".py" || ext === ".pyw";
  for (let i = 0; i < decls.length; i++) {
    const curr = decls[i];
    const next = decls[i + 1];
    curr.fromLine = curr.line;
    const startIdx = Math.max(0, curr.line - 1);

    if (curr.kind === "function" || curr.kind === "method" || curr.kind === "class") {
      if (isPy) {
        const startIndent = (/^(\s*)/.exec(lines[startIdx] || "") || ["", ""])[1].length;
        let endIdx = startIdx;
        for (let j = startIdx + 1; j < lines.length; j++) {
          const l = lines[j];
          if (!l.trim() || /^\s*#/.test(l)) continue;
          const curIndent = (/^(\s*)/.exec(l) || ["", ""])[1].length;
          if (curIndent <= startIndent) break;
          endIdx = j;
        }
        curr.toLine = endIdx + 1;
      } else {
        let depth = 0;
        let started = false;
        let endIdx = startIdx;
        for (let j = startIdx; j < lines.length; j++) {
          const line = lines[j];
          for (let k = 0; k < line.length; k++) {
            const ch = line[k];
            if (ch === "{") {
              depth++;
              started = true;
            } else if (ch === "}") {
              depth--;
              if (started && depth <= 0) {
                curr.toLine = j + 1;
                break;
              }
            }
          }
          if (started && depth <= 0) {
            curr.toLine = j + 1;
            break;
          }
          endIdx = j;
        }
        if (!curr.toLine) {
          curr.toLine = next ? Math.max(curr.fromLine, next.line - 1) : lines.length;
        }
      }
    } else {
      let endIdx = startIdx;
      for (let j = startIdx; j < Math.min(lines.length, startIdx + 20); j++) {
        const l = lines[j];
        if (l.includes(";") || (j > startIdx && !/^\s+/.test(l))) {
          endIdx = j;
          break;
        }
      }
      curr.toLine = endIdx + 1;
    }
  }
}

// ---------------------------------------------------------------------------
// 3. File Scanner & Codebase Walk
// ---------------------------------------------------------------------------

function walkCodeFiles(root, out = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const ent of entries) {
    if (SKIP_DIR.has(ent.name) || ent.name.startsWith(".")) continue;
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkCodeFiles(abs, out);
    } else if (ent.isFile()) {
      const ext = path.extname(ent.name).toLowerCase();
      if (CODE_EXTS.has(ext)) {
        try {
          const st = fs.statSync(abs);
          if (st.size <= MAX_FILE_SIZE) out.push(abs);
        } catch {}
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 4. Primary Codebase Analysis Engine
// ---------------------------------------------------------------------------

function analyzeCodebase(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const filePaths = walkCodeFiles(root);

  const fileData = [];
  const symbolsByName = new Map();
  const selfDeclSet = new Set();

  // Phase 1: Read, sanitize, extract declarations
  for (const abs of filePaths) {
    let rawSrc = "";
    try {
      rawSrc = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    const ext = path.extname(rel).toLowerCase();
    const sanSrc = sanitizeSource(rawSrc, ext);
    const decls = extractDeclarations(rel, rawSrc, sanSrc).filter(
      (d) => !BUILTINS.has(d.name) && d.name.length >= 2
    );

    fileData.push({
      rel,
      abs,
      ext,
      rawSrc,
      sanSrc,
      decls,
      lines: rawSrc.split("\n"),
      sanLines: sanSrc.split("\n"),
    });

    for (const d of decls) {
      if (!symbolsByName.has(d.name)) symbolsByName.set(d.name, []);
      symbolsByName.get(d.name).push(d);
      selfDeclSet.add(`${rel}:${d.line}:${d.name}`);
    }
  }

  // Phase 2: Find all references, call sites, and caller linkages
  const usagesBySymbol = new Map();
  const callGraph = new Map();
  const callersByCallee = new Map();

  for (const data of fileData) {
    const { rel, sanLines, lines, decls } = data;
    let declIdx = 0;

    for (let lIdx = 0; lIdx < sanLines.length; lIdx++) {
      const sanLine = sanLines[lIdx];
      const origLine = lines[lIdx] || "";
      const lineNum = lIdx + 1;
      if (!sanLine.trim()) continue;

      const callableDecls = decls.filter((d) => d.kind === "function" || d.kind === "method" || d.kind === "class");
      const enclosingDecl = callableDecls.slice().reverse().find((d) => lineNum >= d.fromLine && lineNum <= d.toLine);
      const enclosing = enclosingDecl ? enclosingDecl.name : "<module>";
      const callerKey = `${rel}:${enclosing}`;

      const idRegex = /(?<![A-Za-z0-9_$])([A-Za-z0-9_$]{2,})(?![A-Za-z0-9_$])/g;
      let match;
      while ((match = idRegex.exec(sanLine)) !== null) {
        const symName = match[1];
        const knownDecls = symbolsByName.get(symName);
        if (!knownDecls) continue;

        if (selfDeclSet.has(`${rel}:${lineNum}:${symName}`)) continue;

        const before = sanLine.slice(0, match.index).trimEnd();
        const isMember = before.endsWith(".") || before.endsWith("?.") || before.endsWith("->") || before.endsWith("::");

        // Isolate standard language built-in methods from being treated as calls to unrelated symbols in other files
        if (isMember && BUILTIN_METHODS.has(symName)) {
          const hasLocalDecl = knownDecls.some((d) => d.file === rel && (d.kind === "method" || d.kind === "function"));
          if (!hasLocalDecl) continue;
        }

        const restOfLine = sanLine.slice(match.index + symName.length).trimStart();
        const isCall = restOfLine.startsWith("(") || restOfLine.startsWith("?.(") || before.endsWith("new");

        const isExportRef = /\b(?:module\.exports|export\s*\{|exports\.)\b/.test(sanLine);
        const usage = {
          symbol: symName,
          file: rel,
          line: lineNum,
          col: match.index + 1,
          isCall,
          isMember,
          isExportRef,
          callerSymbol: enclosing,
          callerKey,
          snippet: origLine.trim(),
        };

        let uList = usagesBySymbol.get(symName);
        if (!uList) { uList = []; usagesBySymbol.set(symName, uList); }
        uList.push(usage);

        if (isCall) {
          const sameFileTarget = knownDecls.find((d) => d.file === rel);
          const targets = sameFileTarget ? [sameFileTarget] : (!BUILTIN_METHODS.has(symName) ? knownDecls.filter((d) => d.exported || knownDecls.length === 1) : []);
          for (const td of targets) {
            const targetKey = `${td.file}:${td.name}`;
            if (callerKey !== targetKey) {
              let cg = callGraph.get(callerKey);
              if (!cg) { cg = new Set(); callGraph.set(callerKey, cg); }
              cg.add(targetKey);

              let cbc = callersByCallee.get(targetKey);
              if (!cbc) { cbc = new Set(); callersByCallee.set(targetKey, cbc); }
              cbc.add(callerKey);
            }
          }
        }
      }
    }
  }

  // Phase 3: Dead Code Detection
  const deadCode = [];
  for (const [name, declList] of symbolsByName.entries()) {
    const usages = usagesBySymbol.get(name) || [];
    const nonExportUsages = usages.filter((u) => !u.isExportRef);
    const refCount = nonExportUsages.length;

    if (refCount === 0) {
      for (const d of declList) {
        const isCandidate = INTERFACE_CANDIDATE_NAMES.has(d.name) || d.name.toLowerCase().includes("test") || BUILTIN_METHODS.has(d.name);
        let classification = "dead_internal";
        let confidence = 0.95;

        if (d.exported) {
          classification = "dead_exported";
          confidence = 0.70;
        } else if (d.kind === "type") {
          classification = "dead_type";
          confidence = 0.90;
        } else if (d.kind === "property") {
          // An object-literal key with zero textual references is routinely
          // alive through dynamic lookup (STATUS[status], STEER_STATE[s.state])
          // — textual absence proves nothing, so a property must never clear
          // the pruner's 0.8 bar. Deleting these keys broke lookups that were
          // exercised on every render.
          classification = "dead_property";
          confidence = 0.40;
        }

        if (isCandidate) {
          confidence = 0.25;
        }

        deadCode.push({
          name: d.name,
          file: d.file,
          line: d.line,
          fromLine: d.fromLine || d.line,
          toLine: d.toLine || d.line,
          kind: d.kind,
          exported: d.exported,
          classification,
          confidence,
          isInterfaceCandidate: isCandidate,
        });
      }
    }
  }

  deadCode.sort((a, b) => b.confidence - a.confidence || a.file.localeCompare(b.file) || a.line - b.line);

  // Phase 4: Longest Call Chains & Graph Depth (O(V+E) DP with cycle breaking)
  const memoLongest = new Map();
  const visiting = new Set();

  function getLongestPath(nodeKey, maxDepth = 30) {
    if (visiting.has(nodeKey) || maxDepth <= 0) return [nodeKey];
    if (memoLongest.has(nodeKey)) return memoLongest.get(nodeKey);

    const callees = callGraph.get(nodeKey);
    if (!callees || callees.size === 0) {
      const p = [nodeKey];
      memoLongest.set(nodeKey, p);
      return p;
    }

    visiting.add(nodeKey);
    let bestSubPath = [];

    for (const nextKey of callees) {
      if (visiting.has(nextKey)) continue;
      const sub = getLongestPath(nextKey, maxDepth - 1);
      if (sub.length > bestSubPath.length) {
        bestSubPath = sub;
      }
    }

    visiting.delete(nodeKey);
    const result = [nodeKey, ...bestSubPath];
    memoLongest.set(nodeKey, result);
    return result;
  }

  const allChains = [];
  for (const nodeKey of callGraph.keys()) {
    const p = getLongestPath(nodeKey);
    if (p.length >= 2) {
      allChains.push(p);
    }
  }

  allChains.sort((a, b) => b.length - a.length);
  const seenRootsAndLeaves = new Set();
  const topChains = [];
  for (const c of allChains) {
    const key = `${c[0]}->${c[c.length - 1]}:${c.length}`;
    if (!seenRootsAndLeaves.has(key)) {
      seenRootsAndLeaves.add(key);
      topChains.push(c);
      if (topChains.length >= 30) break;
    }
  }

  const longestChains = topChains.map((chain) => ({
    length: chain.length,
    depth: chain.length - 1,
    root: chain[0],
    leaf: chain[chain.length - 1],
    path: chain,
  }));

  // Phase 5: Multi-Call Sites & Hotspots
  const hotspots = [];
  for (const [name, declList] of symbolsByName.entries()) {
    const usages = usagesBySymbol.get(name) || [];
    const calls = usages.filter((u) => u.isCall);
    const callers = new Set(usages.map((u) => u.callerKey));
    const callingFiles = new Set(usages.map((u) => u.file));

    if (calls.length > 0 || usages.length > 0) {
      hotspots.push({
        name,
        definitions: declList.map((d) => ({ file: d.file, line: d.line, kind: d.kind, exported: d.exported })),
        totalUses: usages.length,
        callCount: calls.length,
        refCount: usages.length - calls.length,
        distinctCallers: callers.size,
        distinctFiles: callingFiles.size,
      });
    }
  }

  hotspots.sort((a, b) => b.callCount - a.callCount || b.totalUses - a.totalUses);

  const totalSymbols = Array.from(symbolsByName.values()).reduce((acc, v) => acc + v.length, 0);
  const totalUsages = Array.from(usagesBySymbol.values()).reduce((acc, v) => acc + v.length, 0);
  const totalCalls = Array.from(usagesBySymbol.values()).reduce((acc, v) => acc + v.filter((u) => u.isCall).length, 0);

  return {
    workdir: root,
    scannedFiles: filePaths.length,
    totalSymbols,
    totalUsages,
    totalCalls,
    deadCodeCount: deadCode.length,
    deadCode,
    longestChains,
    hotspots: hotspots.slice(0, 50),
    symbolsByName,
    usagesBySymbol,
    callGraph,
    callersByCallee,
    fileData,
  };
}

// ---------------------------------------------------------------------------
// 5. Targeted Queries & Queries by Feature
// ---------------------------------------------------------------------------

function usedWhere(workdir, symbolName, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  const name = String(symbolName || "").trim();
  if (!name) return { error: "Symbol name is required for usedWhere query" };

  const decls = analysis.symbolsByName.get(name) || [];
  const usages = analysis.usagesBySymbol.get(name) || [];

  let finalDecls = [...decls];
  let finalUsages = [...usages];

  // If no definitions or usages were found via primary index, perform an exhaustive
  // token scan across scanned fileData to locate object properties, tool definitions,
  // or unindexed declarations so that valid symbols are never reported as false zero.
  if (finalDecls.length === 0 || finalUsages.length === 0) {
    const symRegex = new RegExp(`(?<![A-Za-z0-9_$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_$])`, "g");
    const knownDeclSet = new Set(finalDecls.map((d) => `${d.file}:${d.line}`));
    const knownUsageSet = new Set(finalUsages.map((u) => `${u.file}:${u.line}:${u.col}`));

    for (const fileItem of analysis.fileData) {
      const { rel, sanLines, lines, decls: fDecls } = fileItem;
      for (let lIdx = 0; lIdx < sanLines.length; lIdx++) {
        const sanLine = sanLines[lIdx];
        const origLine = lines[lIdx] || "";
        const lineNum = lIdx + 1;
        symRegex.lastIndex = 0;
        let match;
        while ((match = symRegex.exec(sanLine)) !== null) {
          const col = match.index + 1;
          const before = sanLine.slice(0, match.index).trimEnd();
          const after = sanLine.slice(match.index + name.length).trimStart();
          const isCall = after.startsWith("(") || after.startsWith("?.(") || before.endsWith("new");
          const isMember = before.endsWith(".") || before.endsWith("?.");
          const isDef = /^(?:const|let|var|function|class|type|interface)\s+$/.test(before) ||
                        (after.startsWith(":") && !after.startsWith("::") && !isMember) ||
                        (after.startsWith("=") && !after.startsWith("=="));

          const callableDecls = fDecls.filter((d) => d.kind === "function" || d.kind === "method" || d.kind === "class");
          const enclosingDecl = callableDecls.slice().reverse().find((d) => lineNum >= d.fromLine && lineNum <= d.toLine);
          const enclosing = enclosingDecl ? enclosingDecl.name : "<module>";
          const callerKey = `${rel}:${enclosing}`;

          if (isDef && !knownDeclSet.has(`${rel}:${lineNum}`)) {
            finalDecls.push({
              name,
              line: lineNum,
              kind: isCall || after.startsWith(":") ? "property" : "variable",
              exported: /\bexport\b/.test(origLine) || /\bmodule\.exports\b/.test(origLine),
              file: rel,
            });
            knownDeclSet.add(`${rel}:${lineNum}`);
          } else if (!knownDeclSet.has(`${rel}:${lineNum}`) && !knownUsageSet.has(`${rel}:${lineNum}:${col}`)) {
            finalUsages.push({
              symbol: name,
              file: rel,
              line: lineNum,
              col,
              isCall,
              isMember,
              isExportRef: /\b(?:module\.exports|export\s*\{|exports\.)\b/.test(origLine),
              callerSymbol: enclosing,
              callerKey,
              snippet: origLine.trim(),
            });
            knownUsageSet.add(`${rel}:${lineNum}:${col}`);
          }
        }
      }
    }
  }

  // Phase 2 fallback: Also check raw files for literal string references (e.g. tool lists, dispatch arrays, event maps)
  // so dynamically dispatched tools, MCP endpoints, or config keys are identified accurately.
  const strRegex = new RegExp(`['"\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}['"\`]`, "g");
  for (const fileItem of analysis.fileData) {
    const { rel, lines, decls: fDecls } = fileItem;
    for (let lIdx = 0; lIdx < lines.length; lIdx++) {
      const line = lines[lIdx];
      const lineNum = lIdx + 1;
      strRegex.lastIndex = 0;
      let match;
      while ((match = strRegex.exec(line)) !== null) {
        const col = match.index + 1;
        if (!finalUsages.some((u) => u.file === rel && u.line === lineNum)) {
          const callableDecls = fDecls.filter((d) => d.kind === "function" || d.kind === "method" || d.kind === "class");
          const enclosingDecl = callableDecls.slice().reverse().find((d) => lineNum >= d.fromLine && lineNum <= d.toLine);
          const enclosing = enclosingDecl ? enclosingDecl.name : "<module>";
          finalUsages.push({
            symbol: name,
            file: rel,
            line: lineNum,
            col,
            isCall: false,
            isMember: false,
            isStringRef: true,
            isExportRef: false,
            callerSymbol: enclosing,
            callerKey: `${rel}:${enclosing}`,
            snippet: line.trim(),
          });
        }
      }
    }
  }

  const calls = finalUsages.filter((u) => u.isCall);
  const nonCalls = finalUsages.filter((u) => !u.isCall);
  const nonExportUsages = finalUsages.filter((u) => !u.isExportRef);

  const callerKeys = new Set(finalUsages.map((u) => u.callerKey));

  const callees = new Set();
  for (const d of finalDecls) {
    const key = `${d.file}:${d.name}`;
    const directCallees = analysis.callGraph.get(key);
    if (directCallees) {
      for (const c of directCallees) callees.add(c);
    }
  }

  return {
    symbol: name,
    definitions: finalDecls.map((d) => ({
      file: d.file,
      line: d.line,
      kind: d.kind,
      exported: d.exported,
    })),
    totalUses: finalUsages.length,
    callCount: calls.length,
    refCount: nonCalls.length,
    distinctCallers: callerKeys.size,
    distinctFiles: new Set(finalUsages.map((u) => u.file)).size,
    callSites: calls.map((u) => ({
      file: u.file,
      line: u.line,
      col: u.col,
      caller: u.callerSymbol,
      snippet: u.snippet,
    })),
    references: nonCalls.map((u) => ({
      file: u.file,
      line: u.line,
      col: u.col,
      caller: u.callerSymbol,
      snippet: u.snippet,
    })),
    upstreamCallers: Array.from(callerKeys),
    downstreamCallees: Array.from(callees),
    isDeadCode: finalDecls.length > 0 && nonExportUsages.length === 0,
  };
}

function findDeadCode(workdir, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  let results = analysis.deadCode;

  if (options.file) {
    const f = options.file.replace(/\\/g, "/");
    results = results.filter((d) => d.file.includes(f));
  }
  if (options.minConfidence) {
    results = results.filter((d) => d.confidence >= options.minConfidence);
  }
  if (options.excludeExported) {
    results = results.filter((d) => !d.exported);
  }
  if (options.kind) {
    results = results.filter((d) => d.kind === options.kind);
  }

  return {
    workdir: analysis.workdir,
    scannedFiles: analysis.scannedFiles,
    totalSymbols: analysis.totalSymbols,
    deadCount: results.length,
    items: results.slice(0, options.limit || 100),
  };
}

function findCallChains(workdir, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  let chains = analysis.longestChains;

  if (options.symbol) {
    const sym = options.symbol;
    chains = chains.filter((c) => c.path.some((p) => p.includes(`:${sym}`)));
  }
  if (options.minDepth) {
    chains = chains.filter((c) => c.depth >= options.minDepth);
  }

  return {
    workdir: analysis.workdir,
    totalChains: chains.length,
    chains: chains.slice(0, options.limit || 20),
  };
}

function findMultiCallSites(workdir, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  let items = analysis.hotspots;

  if (options.minCalls) {
    items = items.filter((h) => h.callCount >= options.minCalls);
  }
  if (options.file) {
    const f = options.file.replace(/\\/g, "/");
    items = items.filter((h) => h.definitions.some((d) => d.file.includes(f)));
  }

  return {
    workdir: analysis.workdir,
    scannedFiles: analysis.scannedFiles,
    totalSymbols: analysis.totalSymbols,
    hotspots: items.slice(0, options.limit || 25),
  };
}

function analyzeFile(workdir, targetRelPath, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  const target = targetRelPath.replace(/\\/g, "/");
  const fileEntry = analysis.fileData.find((f) => f.rel === target || f.rel.endsWith(target));

  if (!fileEntry) {
    return { error: `File not found: ${targetRelPath}` };
  }

  const rel = fileEntry.rel;
  const decls = fileEntry.decls;

  const symbolReports = decls.map((d) => {
    const usages = analysis.usagesBySymbol.get(d.name) || [];
    const nonExportUsages = usages.filter((u) => !u.isExportRef);
    const calls = usages.filter((u) => u.isCall);
    const internalUses = usages.filter((u) => u.file === rel);
    const externalUses = usages.filter((u) => u.file !== rel);
    return {
      name: d.name,
      line: d.line,
      kind: d.kind,
      exported: d.exported,
      totalUses: usages.length,
      callCount: calls.length,
      internalUses: internalUses.length,
      externalUses: externalUses.length,
      isDead: nonExportUsages.length === 0,
    };
  });

  const outboundCallees = new Set();
  for (const d of decls) {
    const callerKey = `${rel}:${d.name}`;
    const callees = analysis.callGraph.get(callerKey);
    if (callees) {
      for (const c of callees) outboundCallees.add(c);
    }
  }

  const inboundCallers = new Set();
  for (const d of decls) {
    const calleeKey = `${rel}:${d.name}`;
    const callers = analysis.callersByCallee.get(calleeKey);
    if (callers) {
      for (const c of callers) inboundCallers.add(c);
    }
  }

  return {
    file: rel,
    lineCount: fileEntry.lines.length,
    symbolsCount: decls.length,
    symbols: symbolReports,
    deadSymbols: symbolReports.filter((s) => s.isDead),
    outboundCallsCount: outboundCallees.size,
    outboundCalls: Array.from(outboundCallees),
    inboundCallersCount: inboundCallers.size,
    inboundCallers: Array.from(inboundCallers),
  };
}

// ---------------------------------------------------------------------------
// 6. CLI & Human-Readable Output Formatters
// ---------------------------------------------------------------------------

function formatUsedWhere(res) {
  if (res.error) return `Error: ${res.error}`;
  const out = [];
  out.push(`Symbol: ${res.symbol}`);
  out.push(`Definitions (${res.definitions.length}):`);
  for (const d of res.definitions) {
    out.push(`  • ${d.file}:${d.line} [${d.kind}${d.exported ? ", exported" : ""}]`);
  }

  out.push(`\nUsage Summary: ${res.totalUses} total references (${res.callCount} call sites, ${res.refCount} references) across ${res.distinctFiles} file(s) in ${res.distinctCallers} caller scope(s)`);

  if (res.isDeadCode) {
    out.push(`\n⚠️  DEAD CODE WARNING: Symbol has 0 references anywhere in the codebase!`);
    return out.join("\n");
  }

  if (res.callSites.length > 0) {
    out.push(`\nCall Sites (${res.callSites.length}):`);
    for (const c of res.callSites.slice(0, 25)) {
      out.push(`  → ${c.file}:${c.line} (in ${c.caller})\n     ${c.snippet}`);
    }
    if (res.callSites.length > 25) {
      out.push(`  ... and ${res.callSites.length - 25} more call site(s)`);
    }
  }

  if (res.references.length > 0) {
    out.push(`\nGeneral References (${res.references.length}):`);
    for (const r of res.references.slice(0, 15)) {
      out.push(`  • ${r.file}:${r.line} (in ${r.caller})\n     ${r.snippet}`);
    }
    if (res.references.length > 15) {
      out.push(`  ... and ${res.references.length - 15} more reference(s)`);
    }
  }

  if (res.downstreamCallees.length > 0) {
    out.push(`\nDownstream Calls (what ${res.symbol} calls):`);
    for (const c of res.downstreamCallees.slice(0, 15)) {
      out.push(`  ↳ ${c}`);
    }
  }

  return out.join("\n");
}

function formatDeadCode(res) {
  const out = [];
  out.push(`Dead Code Analysis (${res.deadCount} dead/unused symbol(s) found across ${res.scannedFiles} files):`);
  out.push("─".repeat(78));

  if (res.items.length === 0) {
    out.push("✓ No dead code detected!");
    return out.join("\n");
  }

  for (const item of res.items) {
    const badge = item.isInterfaceCandidate ? "[LIKELY FRAMEWORK-INVOKED — VERIFY]"
      : item.classification === "dead_internal" ? "[HIGH CONFIDENCE INTERNAL]"
      : item.classification === "dead_exported" ? "[UNUSED EXPORT]"
      : item.classification === "dead_property" ? "[POSSIBLY DYNAMIC — VERIFY]"
      : "[UNUSED TYPE]";
    out.push(`• ${item.name} (${item.file}:${item.line}) ${badge} [${item.kind}]`);
  }

  if (res.deadCount > res.items.length) {
    out.push(`\n... and ${res.deadCount - res.items.length} more item(s)`);
  }

  return out.join("\n");
}

function formatCallChains(res) {
  const out = [];
  out.push(`Long Call Chains & Call Graph Depth (${res.totalChains} chains found):`);
  out.push("─".repeat(78));

  if (res.chains.length === 0) {
    out.push("No long call chains detected.");
    return out.join("\n");
  }

  for (let i = 0; i < res.chains.length; i++) {
    const c = res.chains[i];
    out.push(`Chain #${i + 1} (depth ${c.depth}, ${c.length} nodes):`);
    for (let j = 0; j < c.path.length; j++) {
      const indent = "  ".repeat(j + 1);
      out.push(`${indent}${j === 0 ? "root: " : "↳ "}${c.path[j]}`);
    }
    out.push("");
  }

  return out.join("\n");
}

function formatMultiCallSites(res) {
  const out = [];
  out.push(`Multi-Call Sites & Hotspots (Top ${res.hotspots.length} most heavily called symbols):`);
  out.push("─".repeat(78));

  for (let i = 0; i < res.hotspots.length; i++) {
    const h = res.hotspots[i];
    const defStr = h.definitions.map((d) => `${d.file}:${d.line}`).join(", ");
    out.push(`${i + 1}. ${h.name} — ${h.callCount} call site(s), ${h.totalUses} total uses across ${h.distinctFiles} file(s) (${h.distinctCallers} callers)`);
    out.push(`   defined at: ${defStr}`);
  }

  return out.join("\n");
}

function formatSummary(analysis) {
  const out = [];
  out.push("Codebase Usage & Graph Summary:");
  out.push(`• Files Scanned: ${analysis.scannedFiles}`);
  out.push(`• Total Symbols: ${analysis.totalSymbols}`);
  out.push(`• Total Usages:  ${analysis.totalUsages} (${analysis.totalCalls} call sites)`);
  out.push(`• Dead Symbols:  ${analysis.deadCodeCount} (${Math.round((analysis.deadCodeCount / (analysis.totalSymbols || 1)) * 100)}% of symbols)`);
  out.push(`• Longest Chain: ${analysis.longestChains[0] ? analysis.longestChains[0].depth : 0} levels deep`);

  if (analysis.hotspots.length > 0) {
    out.push(`\nTop 5 Hotspots (Highest Fan-in):`);
    for (let i = 0; i < Math.min(5, analysis.hotspots.length); i++) {
      const h = analysis.hotspots[i];
      out.push(`  ${i + 1}. ${h.name}: ${h.callCount} calls (${h.distinctFiles} files)`);
    }
  }

  return out.join("\n");
}

function getSummary(workdir, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  return {
    workdir: analysis.workdir,
    scannedFiles: analysis.scannedFiles,
    totalSymbols: analysis.totalSymbols,
    totalUsages: analysis.totalUsages,
    totalCalls: analysis.totalCalls,
    deadCodeCount: analysis.deadCodeCount,
    deadPercent: Math.round((analysis.deadCodeCount / (analysis.totalSymbols || 1)) * 100),
    longestChainDepth: analysis.longestChains[0] ? analysis.longestChains[0].depth : 0,
    topHotspots: analysis.hotspots.slice(0, 10),
    topDeadCode: analysis.deadCode.slice(0, 20),
    formatted: formatSummary(analysis),
  };
}

function formatFileAnalysis(res) {
  if (res.error) return `Error: ${res.error}`;
  const out = [];
  out.push(`File Analysis: ${res.file}`);
  out.push(`• Lines: ${res.lineCount}`);
  out.push(`• Symbols: ${res.symbolsCount} (${res.deadSymbols.length} dead/unused)`);
  out.push(`• Inbound External Callers: ${res.inboundCallersCount}`);
  out.push(`• Outbound Dependencies: ${res.outboundCallsCount}`);

  out.push(`\nSymbols in File:`);
  for (const s of res.symbols) {
    const status = s.isDead ? "⚠️ DEAD" : `${s.callCount} calls (${s.externalUses} external)`;
    out.push(`  • ${s.name}:${s.line} [${s.kind}${s.exported ? ", exported" : ""}] → ${status}`);
  }

  return out.join("\n");
}

function isTestFile(filePath) {
  const norm = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  return (
    norm.startsWith("test/") ||
    norm.startsWith("tests/") ||
    norm.startsWith("spec/") ||
    norm.startsWith("specs/") ||
    norm.includes(".test.") ||
    norm.includes(".spec.") ||
    norm.includes("_test.") ||
    norm.includes("-test.")
  );
}

function blastRadius(workdir, target, options = {}) {
  const analysis = options.analysis || analyzeCodebase(workdir, options);
  const normTarget = String(target || "").trim().replace(/\\/g, "/");
  if (!normTarget) {
    return { error: "blastRadius requires a target symbol name or file path." };
  }

  // Check if target is a file path
  const isFileTarget =
    normTarget.includes("/") ||
    normTarget.includes(".") ||
    analysis.fileData.some((f) => f.rel === normTarget || f.rel.endsWith(normTarget));

  if (isFileTarget) {
    const fileEntry = analysis.fileData.find(
      (f) => f.rel === normTarget || f.rel.endsWith(normTarget)
    );
    if (!fileEntry) {
      return { error: `Target file not found in codebase: ${normTarget}` };
    }
    const rel = fileEntry.rel;
    const fileDecls = fileEntry.decls;

    const directCallerMap = new Map();
    const affectedFilesSet = new Set([rel]);
    const affectedTestsSet = new Set();
    if (isTestFile(rel)) affectedTestsSet.add(rel);

    for (const d of fileDecls) {
      const calleeKey = `${rel}:${d.name}`;
      const callers = analysis.callersByCallee.get(calleeKey);
      if (callers) {
        for (const c of callers) {
          const [cFile] = c.split(":");
          affectedFilesSet.add(cFile);
          if (isTestFile(cFile)) affectedTestsSet.add(cFile);
          directCallerMap.set(c, (directCallerMap.get(c) || 0) + 1);
        }
      }
      const usages = analysis.usagesBySymbol.get(d.name) || [];
      for (const u of usages) {
        if (u.file !== rel) {
          affectedFilesSet.add(u.file);
          if (isTestFile(u.file)) affectedTestsSet.add(u.file);
        }
      }
    }

    // Transitive caller traversal (BFS)
    const transitiveCallers = new Map();
    const queue = [];
    for (const [cKey] of directCallerMap) {
      queue.push({ key: cKey, depth: 1 });
      transitiveCallers.set(cKey, 1);
    }

    let maxDepth = queue.length > 0 ? 1 : 0;
    while (queue.length > 0) {
      const { key, depth } = queue.shift();
      maxDepth = Math.max(maxDepth, depth);
      const callers = analysis.callersByCallee.get(key);
      if (callers) {
        for (const up of callers) {
          if (!transitiveCallers.has(up)) {
            transitiveCallers.set(up, depth + 1);
            const [upFile] = up.split(":");
            affectedFilesSet.add(upFile);
            if (isTestFile(upFile)) affectedTestsSet.add(upFile);
            queue.push({ key: up, depth: depth + 1 });
          }
        }
      }
    }

    // Group affected files by top-level subsystem directory
    const subsystemMap = new Map();
    for (const f of affectedFilesSet) {
      const parts = f.split("/");
      const sub = parts.length > 1 ? parts[0] + "/" : "root";
      subsystemMap.set(sub, (subsystemMap.get(sub) || 0) + 1);
    }

    const sortedDirectCallers = Array.from(directCallerMap.entries())
      .map(([caller, count]) => ({ caller, count }))
      .sort((a, b) => b.count - a.count);

    const directFilesSet = new Set(Array.from(directCallerMap.keys()).map((k) => k.split(":")[0]));

    let severity = "LOW";
    if (affectedFilesSet.size > 15 || maxDepth >= 4) {
      severity = "CRITICAL";
    } else if (affectedFilesSet.size > 5 || maxDepth >= 2) {
      severity = "HIGH";
    } else if (affectedFilesSet.size > 1) {
      severity = "MEDIUM";
    }

    return {
      targetType: "file",
      target: rel,
      lineCount: fileEntry.lines.length,
      symbolsCount: fileDecls.length,
      symbols: fileDecls.map((d) => d.name),
      directCallerCount: directCallerMap.size,
      directCallers: sortedDirectCallers,
      directFilesCount: directFilesSet.size,
      directFiles: Array.from(directFilesSet),
      transitiveCallerCount: transitiveCallers.size,
      transitiveCallers: Array.from(transitiveCallers.entries()).map(([key, depth]) => ({ caller: key, depth })),
      affectedFilesCount: affectedFilesSet.size,
      affectedFiles: Array.from(affectedFilesSet),
      affectedTestsCount: affectedTestsSet.size,
      affectedTests: Array.from(affectedTestsSet),
      subsystems: Object.fromEntries(subsystemMap.entries()),
      maxDepth,
      severity,
    };
  }

  // Symbol target
  const symName = normTarget;
  const decls = analysis.symbolsByName.get(symName) || [];
  const usages = analysis.usagesBySymbol.get(symName) || [];
  const callSites = usages.filter((u) => u.isCall);
  const nonExportUsages = usages.filter((u) => !u.isExportRef);

  const affectedFilesSet = new Set(decls.map((d) => d.file));
  const affectedTestsSet = new Set();
  for (const d of decls) {
    if (isTestFile(d.file)) affectedTestsSet.add(d.file);
  }

  const directCallerMap = new Map();
  for (const d of decls) {
    const calleeKey = `${d.file}:${d.name}`;
    const callers = analysis.callersByCallee.get(calleeKey);
    if (callers) {
      for (const c of callers) {
        const [cFile] = c.split(":");
        affectedFilesSet.add(cFile);
        if (isTestFile(cFile)) affectedTestsSet.add(cFile);
        directCallerMap.set(c, (directCallerMap.get(c) || 0) + 1);
      }
    }
  }

  for (const u of usages) {
    affectedFilesSet.add(u.file);
    if (isTestFile(u.file)) affectedTestsSet.add(u.file);
  }

  // Transitive traversal
  const transitiveCallers = new Map();
  const queue = [];
  for (const [cKey] of directCallerMap) {
    queue.push({ key: cKey, depth: 1 });
    transitiveCallers.set(cKey, 1);
  }

  let maxDepth = queue.length > 0 ? 1 : 0;
  while (queue.length > 0) {
    const { key, depth } = queue.shift();
    maxDepth = Math.max(maxDepth, depth);
    const callers = analysis.callersByCallee.get(key);
    if (callers) {
      for (const up of callers) {
        if (!transitiveCallers.has(up)) {
          transitiveCallers.set(up, depth + 1);
          const [upFile] = up.split(":");
          affectedFilesSet.add(upFile);
          if (isTestFile(upFile)) affectedTestsSet.add(upFile);
          queue.push({ key: up, depth: depth + 1 });
        }
      }
    }
  }

  const subsystemMap = new Map();
  for (const f of affectedFilesSet) {
    const parts = f.split("/");
    const sub = parts.length > 1 ? parts[0] + "/" : "root";
    subsystemMap.set(sub, (subsystemMap.get(sub) || 0) + 1);
  }

  const sortedDirectCallers = Array.from(directCallerMap.entries())
    .map(([caller, count]) => ({ caller, count }))
    .sort((a, b) => b.count - a.count);

  const directFilesSet = new Set(Array.from(directCallerMap.keys()).map((k) => k.split(":")[0]));

  let severity = "LOW";
  if (nonExportUsages.length === 0 && decls.length > 0) {
    severity = "NONE (DEAD CODE)";
  } else if (affectedFilesSet.size > 15 || maxDepth >= 4) {
    severity = "CRITICAL";
  } else if (affectedFilesSet.size > 5 || maxDepth >= 2) {
    severity = "HIGH";
  } else if (affectedFilesSet.size > 1) {
    severity = "MEDIUM";
  }

  return {
    targetType: "symbol",
    target: symName,
    definitions: decls.map((d) => ({ file: d.file, line: d.line, kind: d.kind, exported: d.exported })),
    isDeadCode: decls.length > 0 && nonExportUsages.length === 0,
    totalUsages: usages.length,
    callSitesCount: callSites.length,
    callSites: callSites.map((c) => ({ file: c.file, line: c.line, caller: c.callerSymbol, snippet: c.snippet })),
    directCallerCount: directCallerMap.size,
    directCallers: sortedDirectCallers,
    directFilesCount: directFilesSet.size,
    directFiles: Array.from(directFilesSet),
    transitiveCallerCount: transitiveCallers.size,
    transitiveCallers: Array.from(transitiveCallers.entries()).map(([key, depth]) => ({ caller: key, depth })),
    affectedFilesCount: affectedFilesSet.size,
    affectedFiles: Array.from(affectedFilesSet),
    affectedTestsCount: affectedTestsSet.size,
    affectedTests: Array.from(affectedTestsSet),
    subsystems: Object.fromEntries(subsystemMap.entries()),
    maxDepth,
    severity,
  };
}

function formatBlastRadius(res) {
  if (res.error) return `Error: ${res.error}`;
  const out = [];
  const sevIcon =
    res.severity === "CRITICAL"
      ? "🔴 CRITICAL"
      : res.severity === "HIGH"
      ? "🟠 HIGH"
      : res.severity === "MEDIUM"
      ? "🟡 MEDIUM"
      : res.severity === "NONE (DEAD CODE)"
      ? "⚪ ZERO RISK (DEAD CODE)"
      : "🟢 LOW";

  out.push(`Blast Radius Analysis: ${res.target} [${res.targetType}]`);
  out.push(`Impact Severity: ${sevIcon} (${res.affectedFilesCount} affected file(s), max call depth ${res.maxDepth})`);
  out.push("─".repeat(78));

  if (res.targetType === "symbol") {
    out.push(`Definitions (${res.definitions.length}):`);
    for (const d of res.definitions) {
      out.push(`  • ${d.file}:${d.line} [${d.kind}${d.exported ? ", exported" : ""}]`);
    }

    if (res.isDeadCode) {
      out.push(`\n✓ Symbol is unreferenced dead code. Blast radius is zero.`);
      return out.join("\n");
    }

    if (res.callSitesCount > 0) {
      out.push(`\nDirect Call Sites (${res.callSitesCount}):`);
      for (const c of res.callSites.slice(0, 10)) {
        out.push(`  → ${c.file}:${c.line} (in ${c.caller})\n     ${c.snippet}`);
      }
      if (res.callSitesCount > 10) {
        out.push(`  ... and ${res.callSitesCount - 10} more call site(s)`);
      }
    }
  } else {
    out.push(`Symbols Declared in File: ${res.symbolsCount} (${res.symbols.slice(0, 8).join(", ")}${res.symbolsCount > 8 ? "..." : ""})`);
  }

  // Subsystem distribution
  if (res.subsystems && Object.keys(res.subsystems).length > 0) {
    const subList = Object.entries(res.subsystems)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} (${v})`)
      .join(", ");
    out.push(`\nAffected Subsystems: ${subList}`);
  }

  // Direct callers (highest signal)
  if (res.directCallers && res.directCallers.length > 0) {
    out.push(`\nDirect Immediate Callers (${res.directCallers.length} caller site(s) across ${res.directFilesCount || 0} file(s)):`);
    for (const dc of res.directCallers.slice(0, 10)) {
      const name = typeof dc === "object" ? `${dc.caller} (${dc.count}x)` : dc;
      out.push(`  → ${name}`);
    }
    if (res.directCallers.length > 10) {
      out.push(`  ... and ${res.directCallers.length - 10} more direct caller(s)`);
    }
  }

  // Transitive callers summary
  if (res.transitiveCallerCount > 0) {
    const depthCounts = new Map();
    for (const t of res.transitiveCallers || []) {
      depthCounts.set(t.depth, (depthCounts.get(t.depth) || 0) + 1);
    }
    const depthSummary = Array.from(depthCounts.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([d, c]) => `depth ${d}: ${c}`)
      .join(", ");
    out.push(`\nTransitive Upstream Tree: ${res.transitiveCallerCount} total callers (${depthSummary})`);
  }

  // Affected test suites & suggested verification command
  if (res.affectedTestsCount > 0) {
    out.push(`\nTargeted Test Suites (${res.affectedTestsCount} test file(s) exercising this path):`);
    for (const t of res.affectedTests.slice(0, 12)) {
      out.push(`  🧪 ${t}`);
    }
    if (res.affectedTests.length > 12) {
      out.push(`  ... and ${res.affectedTests.length - 12} more test file(s)`);
    }
    out.push(`\nSuggested Verification Command:`);
    out.push(`  node --test ${res.affectedTests.slice(0, 8).join(" ")}`);
  } else {
    out.push(`\n🧪 No test files directly exercising this blast path found.`);
  }

  return out.join("\n");
}

function parseGitDiff(rawDiff) {
  const fileDiffs = [];
  const lines = rawDiff.split("\n");
  let currentFile = null;
  let oldLine = 0;
  let newLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("diff --git ")) {
      const match = /diff --git a\/(.+?) b\/(.+)/.exec(line);
      if (match) {
        currentFile = {
          file: match[2] !== "/dev/null" ? match[2] : match[1],
          oldFile: match[1],
          newFile: match[2],
          isDeleted: match[2] === "/dev/null",
          deletedLines: new Set(),
          addedLines: new Set(),
          deletedDecls: [],
          addedDecls: [],
        };
        fileDiffs.push(currentFile);
      }
      continue;
    }

    if (!currentFile) continue;

    if (line.startsWith("@@ ")) {
      const match = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (match) {
        oldLine = parseInt(match[1], 10);
        newLine = parseInt(match[2], 10);
      }
      continue;
    }

    if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;

    if (line.startsWith("-")) {
      const content = line.slice(1);
      currentFile.deletedLines.add(oldLine);
      const declMatch =
        /^(?:\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>|\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|\s*(?:def|class)\s+([A-Za-z0-9_]+))/.exec(
          content
        );
      if (declMatch) {
        const sym = declMatch[1] || declMatch[2] || declMatch[3] || declMatch[4];
        if (sym && !BUILTINS.has(sym) && !/^(?:if|for|while|switch|catch|function)$/.test(sym)) {
          currentFile.deletedDecls.push({ name: sym, line: oldLine, raw: content.trim() });
        }
      }
      oldLine++;
    } else if (line.startsWith("+")) {
      const content = line.slice(1);
      currentFile.addedLines.add(newLine);
      const declMatch =
        /^(?:\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)|\s*(?:export\s+)?const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>|\s*([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{|\s*(?:def|class)\s+([A-Za-z0-9_]+))/.exec(
          content
        );
      if (declMatch) {
        const sym = declMatch[1] || declMatch[2] || declMatch[3] || declMatch[4];
        if (sym && !BUILTINS.has(sym) && !/^(?:if|for|while|switch|catch|function)$/.test(sym)) {
          currentFile.addedDecls.push({ name: sym, line: newLine, raw: content.trim() });
        }
      }
      newLine++;
    } else {
      oldLine++;
      newLine++;
    }
  }

  return fileDiffs;
}

function diffReview(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const ref = options.ref || "HEAD";

  let rawDiff = options.diffText;
  if (typeof rawDiff !== "string") {
    const { spawnSync } = require("child_process");
    const args = options.staged
      ? ["diff", "--cached", "--no-color", "-U3"]
      : ["diff", ref, "--no-color", "-U3"];
    let gitRes = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (gitRes.status !== 0 || !gitRes.stdout.trim()) {
      gitRes = spawnSync("git", ["diff", "--no-color", "-U3"], { cwd: root, encoding: "utf8" });
    }
    rawDiff = gitRes.stdout || "";
  }

  if (!rawDiff.trim()) {
    return {
      ok: true,
      passed: true,
      hasDiff: false,
      breakingChangesCount: 0,
      breakingChanges: [],
      warningsCount: 0,
      warnings: [],
      modifiedFilesCount: 0,
      impactedFilesCount: 0,
      impactedFiles: [],
      suggestedTestsCount: 0,
      suggestedTests: [],
      formatted: `✓ No git diff detected against ${ref}. Working tree is clean.`,
    };
  }

  const analysis = options.analysis || analyzeCodebase(root, options);
  const fileDiffs = parseGitDiff(rawDiff);
  const breakingChanges = [];
  const warnings = [];
  const modifiedSymbols = [];
  const impactedFilesSet = new Set();
  const suggestedTestsSet = new Set();

  for (const fd of fileDiffs) {
    impactedFilesSet.add(fd.file);
    if (isTestFile(fd.file)) suggestedTestsSet.add(fd.file);

    // Blast radius on modified file
    const fileBlast = blastRadius(root, fd.file, { ...options, analysis });
    if (fileBlast && fileBlast.affectedTests) {
      for (const t of fileBlast.affectedTests) suggestedTestsSet.add(t);
    }

    // Check deleted declarations
    for (const delDecl of fd.deletedDecls) {
      const symName = delDecl.name;
      const remainingDecls = (analysis.symbolsByName.get(symName) || []).filter(
        (d) => !(d.file === fd.file && Math.abs(d.line - delDecl.line) <= 10)
      );

      const usages = analysis.usagesBySymbol.get(symName) || [];
      const externalActiveCalls = usages.filter(
        (u) => u.isCall && (u.file !== fd.file || !fd.deletedLines.has(u.line))
      );

      if (remainingDecls.length === 0 && externalActiveCalls.length > 0) {
        breakingChanges.push({
          type: "deleted_symbol_with_active_callers",
          severity: "CRITICAL",
          symbol: symName,
          file: fd.file,
          line: delDecl.line,
          reason: `Symbol '${symName}' was deleted or renamed in ${fd.file}:${delDecl.line}, but ${externalActiveCalls.length} active call site(s) remain in the codebase.`,
          callSites: externalActiveCalls.slice(0, 10).map((c) => `${c.file}:${c.line} (${c.callerSymbol})`),
        });
      }

      const symBlast = blastRadius(root, symName, { ...options, analysis });
      if (symBlast && symBlast.affectedTests) {
        for (const t of symBlast.affectedTests) suggestedTestsSet.add(t);
      }
    }

    // Check added declarations for dead code warnings
    for (const addDecl of fd.addedDecls) {
      modifiedSymbols.push({ name: addDecl.name, file: fd.file, line: addDecl.line });
      const usages = analysis.usagesBySymbol.get(addDecl.name) || [];
      const nonExportUsages = usages.filter((u) => !u.isExportRef);
      if (
        nonExportUsages.length === 0 &&
        !INTERFACE_CANDIDATE_NAMES.has(addDecl.name) &&
        !isTestFile(fd.file)
      ) {
        warnings.push({
          type: "unused_new_symbol",
          symbol: addDecl.name,
          file: fd.file,
          line: addDecl.line,
          message: `New symbol '${addDecl.name}' declared in ${fd.file}:${addDecl.line} is not referenced anywhere.`,
        });
      }
    }
  }

  const ok = breakingChanges.length === 0;

  const res = {
    ok,
    passed: ok,
    hasDiff: true,
    breakingChangesCount: breakingChanges.length,
    breakingChanges,
    warningsCount: warnings.length,
    warnings,
    modifiedFilesCount: fileDiffs.length,
    impactedFilesCount: impactedFilesSet.size,
    impactedFiles: Array.from(impactedFilesSet),
    suggestedTestsCount: suggestedTestsSet.size,
    suggestedTests: Array.from(suggestedTestsSet),
  };

  res.formatted = formatDiffReview(res);
  return res;
}

function formatDiffReview(res) {
  if (!res.hasDiff) return res.formatted || "✓ No git diff detected. Working tree clean.";
  const out = [];
  const statusIcon = res.ok ? "✅ PASSED" : "❌ FAILED (BREAKING CHANGES DETECTED)";
  out.push(`Semantic AST Diff Review: ${statusIcon}`);
  out.push(
    `• Modified Files: ${res.modifiedFilesCount}  • Total Impacted Files: ${res.impactedFilesCount}  • Breaking Changes: ${res.breakingChangesCount}`
  );
  out.push("─".repeat(78));

  if (res.breakingChanges.length > 0) {
    out.push(`\n🚨 CRITICAL BREAKING CHANGES (${res.breakingChanges.length}):`);
    for (let i = 0; i < res.breakingChanges.length; i++) {
      const b = res.breakingChanges[i];
      out.push(`  ${i + 1}. [${b.symbol}] ${b.reason}`);
      if (b.callSites && b.callSites.length > 0) {
        out.push(`     Active Call Sites:`);
        for (const cs of b.callSites) {
          out.push(`       → ${cs}`);
        }
      }
    }
  } else {
    out.push(`\n✓ No breaking API/symbol removals detected.`);
  }

  if (res.warnings.length > 0) {
    out.push(`\n⚠️  WARNINGS (${res.warnings.length}):`);
    for (const w of res.warnings) {
      out.push(`  • ${w.message}`);
    }
  }

  if (res.impactedFilesCount > 0) {
    out.push(`\nImpacted Files (${res.impactedFilesCount}):`);
    for (const f of res.impactedFiles.slice(0, 15)) {
      out.push(`  • ${f}`);
    }
    if (res.impactedFilesCount > 15) {
      out.push(`  ... and ${res.impactedFilesCount - 15} more file(s)`);
    }
  }

  if (res.suggestedTestsCount > 0) {
    out.push(`\n🧪 Suggested Verification Tests (${res.suggestedTestsCount}):`);
    for (const t of res.suggestedTests) {
      out.push(`  • ${t}`);
    }
    out.push(`\nRun Tests:`);
    out.push(`  node --test ${res.suggestedTests.join(" ")}`);
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 7. Duplicate Code & Function Clone Analyzer (dedupe)
// ---------------------------------------------------------------------------

function findDuplicates(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const minLines = Math.max(2, parseInt(options.minLines, 10) || 3);
  const targetFile = options.file ? String(options.file).trim().replace(/^\.?\/+/, "") : null;
  const analysis = options.analysis || analyzeCodebase(root, options);

  const functionEntries = [];

  for (const fileEntry of analysis.fileData) {
    const relPath = fileEntry.rel;
    if (targetFile && relPath !== targetFile && !relPath.startsWith(targetFile + "/")) continue;
    const lines = fileEntry.lines;
    const decls = fileEntry.decls.filter((d) => d.kind === "function" || d.kind === "method");

    for (const d of decls) {
      if (!d.fromLine || !d.toLine) continue;
      const spanLength = d.toLine - d.fromLine + 1;
      if (spanLength < minLines) continue;

      const rawLines = lines.slice(d.fromLine - 1, d.toLine);
      const nonBlankLines = rawLines.filter((l) => l.trim().length > 0);
      if (nonBlankLines.length < minLines) continue;

      const sanitizedLines = fileEntry.sanLines.slice(d.fromLine - 1, d.toLine);

      // 1. Exact normalized text (whitespace collapsed)
      const exactNorm = nonBlankLines.map((l) => l.trim()).join(" ");
      const exactHash = crypto.createHash("sha256").update(exactNorm).digest("hex").slice(0, 16);

      // 2. Structural normalized (abstract variable / identifier names)
      let structText = sanitizedLines.join("\n");
      structText = structText.replace(/\b[0-9]+\b/g, "_NUM_");
      const kw = new Set([
        "function", "return", "if", "else", "for", "while", "const", "let", "var",
        "async", "await", "try", "catch", "throw", "new", "this", "typeof", "instanceof",
        "in", "of", "switch", "case", "break", "default", "continue", "def", "class",
        "import", "from", "export",
      ]);
      structText = structText.replace(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/g, (id) => (kw.has(id) ? id : "_ID_"));
      structText = structText.split("\n").map((l) => l.trim()).filter(Boolean).join(" ");
      const structHash = crypto.createHash("sha256").update(structText).digest("hex").slice(0, 16);

      functionEntries.push({
        name: d.name,
        file: relPath,
        fromLine: d.fromLine,
        toLine: d.toLine,
        lineCount: spanLength,
        exactHash,
        structHash,
        snippet: rawLines.slice(0, 6).join("\n"),
        exported: d.exported,
      });
    }
  }

  // Group exact duplicates
  const exactGroups = new Map();
  for (const f of functionEntries) {
    if (!exactGroups.has(f.exactHash)) exactGroups.set(f.exactHash, []);
    exactGroups.get(f.exactHash).push(f);
  }

  const exactDuplicates = [];
  const handledFuncs = new Set();

  for (const [hash, group] of exactGroups.entries()) {
    if (group.length >= 2) {
      const locations = new Set(group.map((g) => `${g.file}:${g.fromLine}`));
      if (locations.size >= 2) {
        for (const g of group) handledFuncs.add(`${g.file}:${g.fromLine}`);
        const avgLines = Math.round(group.reduce((acc, g) => acc + g.lineCount, 0) / group.length);
        const savedLines = (group.length - 1) * avgLines;
        exactDuplicates.push({
          type: "exact",
          hash,
          symbolNames: Array.from(new Set(group.map((g) => g.name))),
          instanceCount: group.length,
          avgLines,
          estimatedLineSavings: savedLines,
          instances: group.map((g) => ({
            name: g.name,
            file: g.file,
            fromLine: g.fromLine,
            toLine: g.toLine,
            exported: g.exported,
          })),
          snippet: group[0].snippet,
        });
      }
    }
  }

  // Group structural near-duplicates
  const structGroups = new Map();
  for (const f of functionEntries) {
    if (handledFuncs.has(`${f.file}:${f.fromLine}`)) continue;
    if (!structGroups.has(f.structHash)) structGroups.set(f.structHash, []);
    structGroups.get(f.structHash).push(f);
  }

  const structuralDuplicates = [];
  for (const [hash, group] of structGroups.entries()) {
    if (group.length >= 2) {
      const locations = new Set(group.map((g) => `${g.file}:${g.fromLine}`));
      if (locations.size >= 2) {
        const avgLines = Math.round(group.reduce((acc, g) => acc + g.lineCount, 0) / group.length);
        const savedLines = (group.length - 1) * avgLines;
        structuralDuplicates.push({
          type: "structural_clone",
          hash,
          symbolNames: Array.from(new Set(group.map((g) => g.name))),
          instanceCount: group.length,
          avgLines,
          estimatedLineSavings: savedLines,
          instances: group.map((g) => ({
            name: g.name,
            file: g.file,
            fromLine: g.fromLine,
            toLine: g.toLine,
            exported: g.exported,
          })),
          snippet: group[0].snippet,
        });
      }
    }
  }

  exactDuplicates.sort((a, b) => b.estimatedLineSavings - a.estimatedLineSavings);
  structuralDuplicates.sort((a, b) => b.estimatedLineSavings - a.estimatedLineSavings);

  const totalExactSavings = exactDuplicates.reduce((acc, d) => acc + d.estimatedLineSavings, 0);
  const totalStructuralSavings = structuralDuplicates.reduce((acc, d) => acc + d.estimatedLineSavings, 0);

  const res = {
    scannedFiles: analysis.scannedFiles,
    totalFunctionsScanned: functionEntries.length,
    exactDuplicateGroupsCount: exactDuplicates.length,
    exactDuplicates,
    structuralCloneGroupsCount: structuralDuplicates.length,
    structuralDuplicates,
    totalEstimatedLineSavings: totalExactSavings + totalStructuralSavings,
  };

  res.formatted = formatDuplicates(res);
  return res;
}

function formatDuplicates(res) {
  const out = [];
  out.push(`Duplicate Code Analysis:`);
  out.push(
    `• Scanned Files: ${res.scannedFiles}  • Functions Analyzed: ${res.totalFunctionsScanned}  • Exact Clones: ${res.exactDuplicateGroupsCount}  • Structural Clones: ${res.structuralCloneGroupsCount}`
  );
  out.push(`• Potential Line Savings: ${res.totalEstimatedLineSavings} lines`);
  out.push("─".repeat(78));

  if (res.exactDuplicateGroupsCount === 0 && res.structuralCloneGroupsCount === 0) {
    out.push("✓ No duplicate functions detected!");
    return out.join("\n");
  }

  if (res.exactDuplicateGroupsCount > 0) {
    out.push(`\nExact Duplicate Groups (${res.exactDuplicateGroupsCount}):`);
    for (let i = 0; i < Math.min(res.exactDuplicates.length, 15); i++) {
      const g = res.exactDuplicates[i];
      const names = g.symbolNames.join(", ");
      out.push(
        `\n  ${i + 1}. [${names}] — ${g.instanceCount} instances (~${g.avgLines} lines each, save ~${g.estimatedLineSavings} lines)`
      );
      for (const inst of g.instances) {
        out.push(`     • ${inst.file}:${inst.fromLine}-${inst.toLine} (${inst.name})`);
      }
      out.push(`     Snippet:`);
      for (const snipLine of g.snippet.split("\n").slice(0, 3)) {
        out.push(`       ${snipLine}`);
      }
    }
    if (res.exactDuplicateGroupsCount > 15) {
      out.push(`\n  ... and ${res.exactDuplicateGroupsCount - 15} more exact duplicate group(s)`);
    }
  }

  if (res.structuralCloneGroupsCount > 0) {
    out.push(`\nStructural Near-Duplicates / Algorithm Clones (${res.structuralCloneGroupsCount}):`);
    for (let i = 0; i < Math.min(res.structuralDuplicates.length, 10); i++) {
      const g = res.structuralDuplicates[i];
      const names = g.symbolNames.join(", ");
      out.push(
        `\n  ${i + 1}. [${names}] — ${g.instanceCount} instances (~${g.avgLines} lines each)`
      );
      for (const inst of g.instances) {
        out.push(`     • ${inst.file}:${inst.fromLine}-${inst.toLine} (${inst.name})`);
      }
    }
    if (res.structuralCloneGroupsCount > 10) {
      out.push(`\n  ... and ${res.structuralCloneGroupsCount - 10} more structural clone(s)`);
    }
  }

  out.push(`\n💡 Recommended Action: Consolidate top duplicate utilities into shared modules (e.g. shared/utils.cjs).`);
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 8. Safe Automated Dead Code Pruner (prune-dead)
// ---------------------------------------------------------------------------

function pruneDeadCode(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const isApply = Boolean(options.apply || options.fix);
  const targetFile = options.file ? String(options.file).trim().replace(/^\.?\/+/, "") : null;
  const analysis = options.analysis || analyzeCodebase(root, options);
  const deadRes = findDeadCode(root, { file: targetFile, minConfidence: 0.8, excludeExported: true, analysis });

  const candidates = [];
  for (const item of deadRes.items) {
    if (item.classification !== "dead_internal") continue;
    if (item.totalUses > 0 || item.callCount > 0) continue;
    const br = blastRadius(root, item.name, { analysis });
    if (!br.isDeadCode || br.directCallerCount > 0) continue;
    candidates.push(item);
  }

  if (candidates.length === 0 || !isApply) {
    const res = {
      mode: isApply ? "apply" : "dry-run",
      applied: false,
      candidatesCount: candidates.length,
      candidates: candidates.map((c) => ({
        name: c.name,
        file: c.file,
        line: c.line,
        kind: c.kind,
        fromLine: c.fromLine,
        toLine: c.toLine,
        lineCount: c.toLine ? c.toLine - c.fromLine + 1 : 1,
      })),
      filesCount: new Set(candidates.map((c) => c.file)).size,
      linesSaved: candidates.reduce((acc, c) => acc + (c.toLine ? c.toLine - c.fromLine + 1 : 1), 0),
    };
    res.formatted = formatPruneDeadCode(res);
    return res;
  }

  // Apply mode
  const fileMap = new Map();
  for (const c of candidates) {
    if (!fileMap.has(c.file)) fileMap.set(c.file, []);
    fileMap.get(c.file).push(c);
  }

  const backups = new Map();
  const modifiedFiles = [];
  let linesPruned = 0;
  let symbolsPruned = 0;

  try {
    for (const [relPath, items] of fileMap.entries()) {
      const absPath = path.join(root, relPath);
      if (!fs.existsSync(absPath)) continue;
      const origContent = fs.readFileSync(absPath, "utf8");
      backups.set(absPath, origContent);

      const lines = origContent.split("\n");
      items.sort((a, b) => b.fromLine - a.fromLine);

      for (const it of items) {
        const fromIdx = Math.max(0, it.fromLine - 1);
        const toIdx = Math.min(lines.length - 1, it.toLine ? it.toLine - 1 : fromIdx);
        const count = toIdx - fromIdx + 1;
        lines.splice(fromIdx, count);
        linesPruned += count;
        symbolsPruned++;
      }

      let cleaned = lines.join("\n").replace(/\n{3,}/g, "\n\n");
      fs.writeFileSync(absPath, cleaned, "utf8");
      modifiedFiles.push(relPath);
    }

    // Verify with diffReview
    const diff = diffReview(root);
    if (!diff.ok) {
      // Revert all modified files immediately
      for (const [absPath, orig] of backups.entries()) {
        fs.writeFileSync(absPath, orig, "utf8");
      }
      const res = {
        mode: "apply",
        applied: false,
        error: "Diff review failed: breaking changes detected upon pruning dead code. All changes safely reverted.",
        diffReview: diff,
        candidatesCount: candidates.length,
      };
      res.formatted = formatPruneDeadCode(res);
      return res;
    }

    const res = {
      mode: "apply",
      applied: true,
      modifiedFilesCount: modifiedFiles.length,
      modifiedFiles,
      symbolsPrunedCount: symbolsPruned,
      linesPruned,
      diffReview: diff,
    };
    res.formatted = formatPruneDeadCode(res);
    return res;
  } catch (err) {
    for (const [absPath, orig] of backups.entries()) {
      fs.writeFileSync(absPath, orig, "utf8");
    }
    const res = {
      mode: "apply",
      applied: false,
      error: `Error pruning dead code: ${err.message}. All changes safely reverted.`,
      candidatesCount: candidates.length,
    };
    res.formatted = formatPruneDeadCode(res);
    return res;
  }
}

function formatPruneDeadCode(res) {
  const out = [];
  if (res.mode === "dry-run") {
    out.push(`Dead Code Pruner (Dry-Run Preview):`);
    out.push(
      `• Verified Zero-Risk Dead Candidates: ${res.candidatesCount}  • Files: ${res.filesCount}  • Potential Line Savings: ${res.linesSaved} lines`
    );
    out.push("─".repeat(78));
    if (res.candidatesCount === 0) {
      out.push("✓ No dead code candidates found to prune.");
      return out.join("\n");
    }
    for (const c of res.candidates.slice(0, 20)) {
      out.push(`  • ${c.name} (${c.file}:${c.fromLine || c.line}${c.toLine ? `-${c.toLine}` : ""}) [${c.kind}] (${c.lineCount} lines)`);
    }
    if (res.candidatesCount > 20) {
      out.push(`  ... and ${res.candidatesCount - 20} more candidate(s)`);
    }
    out.push(`\n💡 To safely prune these verified dead symbols, run:`);
    out.push(`  (prune with --apply to delete them)`);
  } else {
    if (res.applied) {
      out.push(`Dead Code Pruner: ✅ APPLIED SAFELY`);
      out.push(
        `• Pruned Symbols: ${res.symbolsPrunedCount}  • Modified Files: ${res.modifiedFilesCount}  • Lines Removed: ${res.linesPruned}`
      );
      out.push("─".repeat(78));
      out.push(`Modified Files:`);
      for (const f of res.modifiedFiles) {
        out.push(`  ✓ ${f}`);
      }
      out.push(`\nAST Diff Review: ${res.diffReview.ok ? "✅ PASSED (0 breaking changes)" : "❌ FAILED"}`);
    } else {
      out.push(`Dead Code Pruner: ❌ FAILED`);
      out.push(`• Reason: ${res.error}`);
    }
  }
  return out.join("\n");
}

module.exports = {
  analyzeCodebase,
  usedWhere,
  findDeadCode,
  findCallChains,
  findMultiCallSites,
  analyzeFile,
  blastRadius,
  diffReview,
  findDuplicates,
  pruneDeadCode,
  parseGitDiff,
  getSummary,
  sanitizeSource,
  extractDeclarations,
  isTestFile,
  formatUsedWhere,
  formatDeadCode,
  formatCallChains,
  formatMultiCallSites,
  formatSummary,
  formatFileAnalysis,
  formatBlastRadius,
  formatDiffReview,
  formatDuplicates,
  formatPruneDeadCode,
};

