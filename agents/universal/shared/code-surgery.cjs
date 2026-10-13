"use strict";
// Deterministic Code Surgery Engine (bulkEdit / renameSymbol / applyPatch / revertChange)
// Zero npm dependencies. AST/lexical-aware, atomic apply, rollback safety, diff receipts.
//
// Model finds intent -> Deterministic tool executes surgery safely without LLM hallucination.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const usedWhereMod = require("./used-where.cjs");
const hunksMod = require("./hunks.cjs");

// ---------------------------------------------------------------------------
// 1. Unified Diff Generation & Formatting Helpers
// ---------------------------------------------------------------------------

function generateUnifiedDiff(filePath, oldContent, newContent) {
  const oldLines = (oldContent || "").split("\n");
  const newLines = (newContent || "").split("\n");

  if (oldContent === newContent) return "";

  const header = `--- a/${filePath}\n+++ b/${filePath}\n`;

  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++;
  }

  let oldEnd = oldLines.length - 1;
  let newEnd = newLines.length - 1;
  while (oldEnd >= start && newEnd >= start && oldLines[oldEnd] === newLines[newEnd]) {
    oldEnd--;
    newEnd--;
  }

  const contextBefore = Math.max(0, start - 3);
  const contextAfterOld = Math.min(oldLines.length, oldEnd + 4);
  const contextAfterNew = Math.min(newLines.length, newEnd + 4);

  const oldChunkCount = contextAfterOld - contextBefore;
  const newChunkCount = contextAfterNew - contextBefore;

  let diff = header;
  diff += `@@ -${contextBefore + 1},${oldChunkCount} +${contextBefore + 1},${newChunkCount} @@\n`;

  for (let i = contextBefore; i < start; i++) {
    diff += ` ${oldLines[i]}\n`;
  }
  for (let i = start; i <= oldEnd; i++) {
    diff += `-${oldLines[i]}\n`;
  }
  for (let i = start; i <= newEnd; i++) {
    diff += `+${newLines[i]}\n`;
  }
  for (let i = oldEnd + 1; i < contextAfterOld; i++) {
    diff += ` ${oldLines[i]}\n`;
  }

  return diff;
}

// ---------------------------------------------------------------------------
// 2. Syntax Validation Engine
// ---------------------------------------------------------------------------

function isEsmFile(filePath, root) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".mjs") return true;
  if (ext !== ".js" || !root) return false;
  let dir = path.dirname(path.resolve(root, filePath));
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        return JSON.parse(fs.readFileSync(pkgPath, "utf8")).type === "module";
      } catch {
        return false;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function validateEsmSyntax(filePath, content) {
  const r = require("child_process").spawnSync(process.execPath, ["--input-type=module", "--check"], {
    input: content,
    encoding: "utf8",
  });
  if (r.status === 0) return { valid: true };
  const msg = String(r.stderr || "").split("\n").find((l) => /Error/.test(l)) || String(r.stderr || "").trim();
  return { valid: false, error: `JS SyntaxError in ${filePath}: ${msg}` };
}

function validateSyntax(filePath, content, root) {
  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".json") {
    try {
      JSON.parse(content);
      return { valid: true };
    } catch (err) {
      return { valid: false, error: `Invalid JSON syntax in ${filePath}: ${err.message}` };
    }
  }

  if (isEsmFile(filePath, root)) return validateEsmSyntax(filePath, content);

  // Pure JS / CommonJS / ESM syntax check via Node vm
  if (ext === ".js" || ext === ".cjs" || ext === ".mjs") {
    try {
      let vmCode = content
        .replace(/^#!.*?\n/, "\n")
        .replace(/\bimport\.meta\b/g, '({ url: "file:///dummy.js" })')
        .replace(/import\s+(?:(?:\*\s+as\s+[a-zA-Z0-9_$]+)|(?:\{[\s\S]*?\})|(?:[a-zA-Z0-9_$]+)|(?:[a-zA-Z0-9_$]+\s*,\s*\{[\s\S]*?\}))\s+from\s+[\x27\x22][^\x27\x22\r\n]+[\x27\x22];?/g, "/* import from */")
        .replace(/import\s+[\x27\x22][^\x27\x22\r\n]+[\x27\x22];?/g, "/* side-effect import */")
        .replace(/export\s+default\s+/g, "/* export default */ void ")
        .replace(/export\s*\{[\s\S]*?\}(?:\s*from\s*[\x27\x22][^\x27\x22\r\n]+[\x27\x22])?;?/g, "/* export {} */")
        .replace(/export\s+(?:async\s+)?(?:const|let|var|function|class)\s+/g, "/* export */ ");

      // Wrap in async IIFE so top-level await and return constructs in modules validate
      const wrapped = "(async () => {\n" + vmCode + "\n})();";
      new vm.Script(wrapped, { filename: filePath });
      return { valid: true };
    } catch (err) {
      if (err.name === "SyntaxError") {
        return { valid: false, error: `JS SyntaxError in ${filePath}: ${err.message}` };
      }
    }
  }

  return { valid: true };
}

// ---------------------------------------------------------------------------
// 3. Backup & Snapshot Store
// ---------------------------------------------------------------------------

function getBackupDir(root) {
  return path.join(root, ".converge", "backups");
}

function createBackupId() {
  const ts = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `backup-${ts}-${rand}`;
}

function saveBackup(root, { tool, description, files }) {
  try {
    const backupDir = getBackupDir(root);
    fs.mkdirSync(backupDir, { recursive: true });

    const id = createBackupId();
    const payload = {
      id,
      timestamp: new Date().toISOString(),
      tool: tool || "code_surgery",
      description: description || "",
      filesCount: Object.keys(files || {}).length,
      files: files || {},
    };

    const filePath = path.join(backupDir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");

    const latestPath = path.join(backupDir, "latest.json");
    try {
      fs.writeFileSync(latestPath, JSON.stringify({ id, timestamp: payload.timestamp, file: `${id}.json` }, null, 2), "utf8");
    } catch {}

    return id;
  } catch (err) {
    return null;
  }
}

function loadBackup(root, backupId) {
  const backupDir = getBackupDir(root);
  let targetId = backupId;

  if (!targetId || targetId === "latest") {
    const latestPath = path.join(backupDir, "latest.json");
    if (fs.existsSync(latestPath)) {
      try {
        const latestInfo = JSON.parse(fs.readFileSync(latestPath, "utf8"));
        if (latestInfo.id) targetId = latestInfo.id;
      } catch {}
    }
  }

  if (!targetId || targetId === "latest") {
    try {
      const entries = fs.readdirSync(backupDir).filter((f) => f.startsWith("backup-") && f.endsWith(".json"));
      if (entries.length === 0) return null;
      entries.sort().reverse();
      targetId = entries[0].replace(/\.json$/, "");
    } catch {
      return null;
    }
  }

  const backupFile = path.join(backupDir, targetId.endsWith(".json") ? targetId : `${targetId}.json`);
  if (!fs.existsSync(backupFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(backupFile, "utf8"));
  } catch {
    return null;
  }
}

function listBackups(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const backupDir = getBackupDir(root);
  const limit = options.limit || 20;

  if (!fs.existsSync(backupDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(backupDir).filter((f) => f.startsWith("backup-") && f.endsWith(".json"));
    files.sort().reverse();

    const out = [];
    for (const f of files.slice(0, limit)) {
      try {
        const content = JSON.parse(fs.readFileSync(path.join(backupDir, f), "utf8"));
        out.push({
          id: content.id || f.replace(/\.json$/, ""),
          timestamp: content.timestamp,
          tool: content.tool,
          description: content.description,
          filesCount: content.filesCount || (content.files ? Object.keys(content.files).length : 0),
          files: content.files ? Object.keys(content.files) : [],
        });
      } catch {}
    }
    return out;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// 4. Tool 1: bulkEdit
// ---------------------------------------------------------------------------

function bulkEdit(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const edits = Array.isArray(options.edits) ? options.edits : [];
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : Boolean(options.dry_run);
  const requireExactCount = options.requireExactCount ?? options.require_exact_count;
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (edits.length === 0) {
    const res = {
      ok: false,
      error: "No edits provided. Expected array of { path, old_text, new_text }.",
      filesChanged: [],
      replacementsCount: 0,
      totalEdits: 0,
      mode: dryRun ? "dry-run" : "apply",
    };
    res.report = formatBulkEdit(res);
    return res;
  }

  const editsByFile = new Map();
  for (let idx = 0; idx < edits.length; idx++) {
    const e = edits[idx];
    const relPath = (e.path || e.file || "").replace(/\\/g, "/");
    const oldText = e.old_text !== undefined ? e.old_text : e.oldText;
    const newText = e.new_text !== undefined ? e.new_text : e.newText;
    const matchAll = Boolean(e.match_all || e.matchAll || e.all);
    const optional = Boolean(e.optional);

    if (!relPath) {
      const res = { ok: false, error: `Edit at index ${idx} missing 'path' property.` };
      res.report = formatBulkEdit(res);
      return res;
    }
    if (oldText === undefined || newText === undefined) {
      const res = { ok: false, error: `Edit for '${relPath}' at index ${idx} missing 'old_text' or 'new_text'.` };
      res.report = formatBulkEdit(res);
      return res;
    }

    if (!editsByFile.has(relPath)) editsByFile.set(relPath, []);
    editsByFile.get(relPath).push({ oldText, newText, matchAll, optional, index: idx });
  }

  const originalContents = new Map();
  const newContents = new Map();
  const diffs = [];
  let totalReplacements = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const [relPath, fileEdits] of editsByFile.entries()) {
    const absPath = path.resolve(root, relPath);
    if (!absPath.startsWith(root)) {
      const res = { ok: false, error: `Path '${relPath}' escapes workspace root.` };
      res.report = formatBulkEdit(res);
      return res;
    }

    if (!fs.existsSync(absPath)) {
      const res = { ok: false, error: `Target file does not exist: ${relPath}` };
      res.report = formatBulkEdit(res);
      return res;
    }

    let currentContent = "";
    try {
      currentContent = fs.readFileSync(absPath, "utf8");
    } catch (err) {
      const res = { ok: false, error: `Cannot read target file '${relPath}': ${err.message}` };
      res.report = formatBulkEdit(res);
      return res;
    }

    originalContents.set(relPath, currentContent);
    let workingContent = currentContent;

    for (const edit of fileEdits) {
      const { oldText, newText, matchAll, optional, index } = edit;

      let count = 0;
      let pos = 0;
      while (oldText.length > 0 && (pos = workingContent.indexOf(oldText, pos)) !== -1) {
        count++;
        pos += oldText.length;
      }

      if (count === 0) {
        if (optional) continue;
        const res = {
          ok: false,
          error: `Target text not found in '${relPath}' (edit #${index + 1}). Target snippet:\n"${oldText.slice(0, 100)}${oldText.length > 100 ? "..." : ""}"`,
        };
        res.report = formatBulkEdit(res);
        return res;
      }

      if (requireExactCount !== undefined && requireExactCount !== null) {
        if (count !== requireExactCount) {
          const res = {
            ok: false,
            error: `Ambiguous match in '${relPath}': expected exactly ${requireExactCount} occurrence(s) of target text, but found ${count}. Set 'match_all: true' or provide more surrounding context.`,
          };
          res.report = formatBulkEdit(res);
          return res;
        }
      }

      if (matchAll) {
        workingContent = workingContent.split(oldText).join(newText);
        totalReplacements += count;
      } else {
        workingContent = workingContent.replace(oldText, newText);
        totalReplacements += 1;
      }
    }

    if (validateSyntaxOpt) {
      const val = validateSyntax(relPath, workingContent, root);
      if (!val.valid) {
        const res = {
          ok: false,
          error: `Syntax validation failed after edits to '${relPath}': ${val.error}`,
        };
        res.report = formatBulkEdit(res);
        return res;
      }
    }

    newContents.set(relPath, workingContent);

    const fileDiff = generateUnifiedDiff(relPath, currentContent, workingContent);
    if (fileDiff) {
      diffs.push(fileDiff);
      const oldL = currentContent.split("\n").length;
      const newL = workingContent.split("\n").length;
      if (newL > oldL) totalLinesAdded += newL - oldL;
      else if (oldL > newL) totalLinesRemoved += oldL - newL;
    }
  }

  const modifiedFiles = Array.from(editsByFile.keys()).filter(
    (f) => originalContents.get(f) !== newContents.get(f)
  );

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      filesChangedCount: modifiedFiles.length,
      filesChanged: modifiedFiles,
      totalEdits: edits.length,
      replacementsCount: totalReplacements,
      linesAdded: totalLinesAdded,
      linesRemoved: totalLinesRemoved,
      diff: diffs.join("\n"),
    };
    res.report = formatBulkEdit(res);
    return res;
  }

  const backupFiles = {};
  for (const [relPath, content] of originalContents.entries()) {
    backupFiles[relPath] = content;
  }

  const backupId = saveBackup(root, {
    tool: "bulk_edit",
    description: `bulkEdit across ${modifiedFiles.length} file(s) (${totalReplacements} replacements)`,
    files: backupFiles,
  });

  const writtenFiles = [];
  try {
    for (const [relPath, newContent] of newContents.entries()) {
      const absPath = path.resolve(root, relPath);
      fs.writeFileSync(absPath, newContent, "utf8");
      writtenFiles.push(relPath);
    }
  } catch (err) {
    for (const written of writtenFiles) {
      const orig = originalContents.get(written);
      if (orig !== undefined) {
        fs.writeFileSync(path.resolve(root, written), orig, "utf8");
      }
    }
    const res = {
      ok: false,
      error: `I/O write error during bulkEdit: ${err.message}. All modifications safely rolled back.`,
    };
    res.report = formatBulkEdit(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    backupId: backupId || undefined,
    filesChangedCount: modifiedFiles.length,
    filesChanged: modifiedFiles,
    totalEdits: edits.length,
    replacementsCount: totalReplacements,
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    diff: diffs.join("\n"),
  };
  res.report = formatBulkEdit(res);
  return res;
}

function formatBulkEdit(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Bulk Edit: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Bulk Edit (Dry-Run Preview):`);
    out.push(
      `• Files Affected: ${res.filesChangedCount}  • Total Edits: ${res.totalEdits}  • Replacements: ${res.replacementsCount}`
    );
    out.push("─".repeat(78));
    if (res.filesChangedCount === 0) {
      out.push("✓ No modifications detected.");
      return out.join("\n");
    }
    for (const f of res.filesChanged) {
      out.push(`  • ${f}`);
    }
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Bulk Edit: ✅ APPLIED SAFELY`);
    out.push(
      `• Files Modified: ${res.filesChangedCount}  • Replacements: ${res.replacementsCount}  • Backup ID: ${res.backupId || "n/a"}`
    );
    out.push("─".repeat(78));
    for (const f of res.filesChanged) {
      out.push(`  ✓ ${f}`);
    }
    if (res.backupId) {
      out.push(`\n💡 To undo this change, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 5. Tool 2: renameSymbol
// ---------------------------------------------------------------------------

function renameSymbol(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const symbol = (options.symbol || "").trim();
  const newName = (options.newName || options.new_name || "").trim();
  const scopeFile = options.scopeFile || options.scope_file;
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : options.apply !== undefined ? !options.apply : Boolean(options.dry_run);
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (!symbol || !newName) {
    const res = { ok: false, error: "Both 'symbol' and 'new_name' are required." };
    res.report = formatRenameSymbol(res);
    return res;
  }

  if (!/^[A-Za-z0-9_$]+$/.test(symbol) || !/^[A-Za-z0-9_$]+$/.test(newName)) {
    const res = {
      ok: false,
      error: `Invalid identifier name: '${symbol}' -> '${newName}'. Must contain only alphanumeric, $, and _ characters.`,
    };
    res.report = formatRenameSymbol(res);
    return res;
  }

  if (symbol === newName) {
    const res = { ok: false, error: `Symbol and new_name are identical ('${symbol}').` };
    res.report = formatRenameSymbol(res);
    return res;
  }

  const analysis = usedWhereMod.analyzeCodebase(root);
  const filesList = analysis.fileData || [];
  const targetFiles = scopeFile
    ? [path.resolve(root, scopeFile)]
    : filesList.map((f) => path.resolve(root, f.rel));

  const existingNewNameDecls = (analysis.symbolsByName && analysis.symbolsByName.get(newName)) || [];
  if (existingNewNameDecls.length > 0 && !scopeFile) {
    const conflictFiles = existingNewNameDecls.map((d) => d.file);
    const existingSymDecls = (analysis.symbolsByName && analysis.symbolsByName.get(symbol)) || [];
    const symFiles = new Set(existingSymDecls.map((d) => d.file));
    const overlaps = conflictFiles.filter((f) => symFiles.has(f));
    if (overlaps.length > 0) {
      const res = {
        ok: false,
        error: `Symbol collision: '${newName}' is already declared in ${overlaps.join(", ")}. Renaming '${symbol}' to '${newName}' would cause naming conflicts.`,
      };
      res.report = formatRenameSymbol(res);
      return res;
    }
  }

  const originalContents = new Map();
  const newContents = new Map();
  const diffs = [];
  let totalOccurrences = 0;

  for (const absPath of targetFiles) {
    if (!fs.existsSync(absPath)) continue;
    const relPath = path.relative(root, absPath).replace(/\\/g, "/");
    const ext = path.extname(relPath).toLowerCase();

    let rawSrc = "";
    try {
      rawSrc = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const sanSrc = usedWhereMod.sanitizeSource ? usedWhereMod.sanitizeSource(rawSrc, ext) : rawSrc;

    const rawLines = rawSrc.split("\n");
    const sanLines = sanSrc.split("\n");
    let fileMatches = 0;
    const newLines = [];

    for (let l = 0; l < rawLines.length; l++) {
      const rawLine = rawLines[l];
      const sanLine = sanLines[l] || "";

      if (!sanLine.includes(symbol)) {
        newLines.push(rawLine);
        continue;
      }

      let modifiedLine = "";
      let lastIndex = 0;
      let match;
      const lineRegex = new RegExp(`(?<![A-Za-z0-9_$])${symbol}(?![A-Za-z0-9_$])`, "g");

      while ((match = lineRegex.exec(sanLine)) !== null) {
        const matchIdx = match.index;
        modifiedLine += rawLine.slice(lastIndex, matchIdx) + newName;
        lastIndex = matchIdx + symbol.length;
        fileMatches++;
      }
      modifiedLine += rawLine.slice(lastIndex);
      newLines.push(modifiedLine);
    }

    if (fileMatches > 0) {
      const modifiedContent = newLines.join("\n");

      if (validateSyntaxOpt) {
        const val = validateSyntax(relPath, modifiedContent);
        if (!val.valid) {
          const res = {
            ok: false,
            error: `Syntax error after renaming '${symbol}' in '${relPath}': ${val.error}`,
          };
          res.report = formatRenameSymbol(res);
          return res;
        }
      }

      originalContents.set(relPath, rawSrc);
      newContents.set(relPath, modifiedContent);
      totalOccurrences += fileMatches;

      const fileDiff = generateUnifiedDiff(relPath, rawSrc, modifiedContent);
      if (fileDiff) diffs.push(fileDiff);
    }
  }

  const modifiedFiles = Array.from(originalContents.keys());

  if (modifiedFiles.length === 0 || totalOccurrences === 0) {
    const res = {
      ok: false,
      error: `Symbol '${symbol}' not found in any source declarations or call sites.`,
    };
    res.report = formatRenameSymbol(res);
    return res;
  }

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      symbol,
      newName,
      filesCount: modifiedFiles.length,
      filesChanged: modifiedFiles,
      occurrencesCount: totalOccurrences,
      diff: diffs.join("\n"),
    };
    res.report = formatRenameSymbol(res);
    return res;
  }

  const backupFiles = {};
  for (const [relPath, content] of originalContents.entries()) {
    backupFiles[relPath] = content;
  }

  const backupId = saveBackup(root, {
    tool: "rename_symbol",
    description: `renameSymbol '${symbol}' -> '${newName}' across ${modifiedFiles.length} file(s) (${totalOccurrences} occurrences)`,
    files: backupFiles,
  });

  const writtenFiles = [];
  try {
    for (const [relPath, newContent] of newContents.entries()) {
      const absPath = path.resolve(root, relPath);
      fs.writeFileSync(absPath, newContent, "utf8");
      writtenFiles.push(relPath);
    }
  } catch (err) {
    for (const written of writtenFiles) {
      const orig = originalContents.get(written);
      if (orig !== undefined) {
        fs.writeFileSync(path.resolve(root, written), orig, "utf8");
      }
    }
    const res = {
      ok: false,
      error: `I/O error during renameSymbol: ${err.message}. Changes safely reverted.`,
    };
    res.report = formatRenameSymbol(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    symbol,
    newName,
    backupId: backupId || undefined,
    filesCount: modifiedFiles.length,
    filesChanged: modifiedFiles,
    occurrencesCount: totalOccurrences,
    diff: diffs.join("\n"),
  };
  res.report = formatRenameSymbol(res);
  return res;
}

function formatRenameSymbol(res) {
  const out = [];
  if (!res.ok) {
    out.push(`AST Rename Symbol: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`AST Rename Symbol (Dry-Run Preview):`);
    out.push(
      `• Symbol: '${res.symbol}' ➔ '${res.newName}'  • Files: ${res.filesCount}  • Identifier Occurrences: ${res.occurrencesCount}`
    );
    out.push("─".repeat(78));
    for (const f of res.filesChanged) {
      out.push(`  • ${f}`);
    }
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`AST Rename Symbol: ✅ APPLIED SAFELY`);
    out.push(
      `• Renamed: '${res.symbol}' ➔ '${res.newName}'  • Files: ${res.filesCount}  • Occurrences: ${res.occurrencesCount}`
    );
    out.push("─".repeat(78));
    for (const f of res.filesChanged) {
      out.push(`  ✓ ${f}`);
    }
    if (res.backupId) {
      out.push(`\n💡 To undo this rename, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 6. Tool 3: applyPatch
// ---------------------------------------------------------------------------

function parseMultiFilePatch(patchText, stripPrefix = 1) {
  const files = [];
  const lines = (patchText || "").split("\n");
  let currentFile = null;
  let currentHunkLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ") || line.startsWith("--- ")) {
      let targetPath = null;
      if (line.startsWith("diff --git ")) {
        const m = /diff --git a\/(.+?) b\/(.+)/.exec(line);
        if (m) targetPath = m[2] !== "/dev/null" ? m[2] : m[1];
      } else if (line.startsWith("--- ")) {
        const rawPath = line.slice(4).trim().split("\t")[0];
        let p = rawPath.replace(/^([ab]\/|\/)/, "");
        if (stripPrefix > 1) {
          const parts = p.split("/");
          p = parts.slice(stripPrefix - 1).join("/");
        }
        targetPath = p;
      }

      if (targetPath && targetPath !== "/dev/null") {
        if (currentFile && currentHunkLines.length > 0) {
          currentFile.hunkText = currentHunkLines.join("\n");
          currentFile.hunks = hunksMod.parseHunks(currentFile.hunkText);
        }
        currentFile = { path: targetPath.replace(/\\/g, "/"), hunks: [], hunkText: "" };
        files.push(currentFile);
        currentHunkLines = [];
        continue;
      }
    }

    if (line.startsWith("+++ ")) {
      const rawPath = line.slice(4).trim().split("\t")[0];
      if (rawPath !== "/dev/null") {
        let p = rawPath.replace(/^([ab]\/|\/)/, "");
        if (stripPrefix > 1) {
          const parts = p.split("/");
          p = parts.slice(stripPrefix - 1).join("/");
        }
        if (currentFile) currentFile.path = p.replace(/\\/g, "/");
        else {
          currentFile = { path: p.replace(/\\/g, "/"), hunks: [], hunkText: "" };
          files.push(currentFile);
        }
      }
      continue;
    }

    if (currentFile) {
      currentHunkLines.push(line);
    }
  }

  if (currentFile && currentHunkLines.length > 0) {
    currentFile.hunkText = currentHunkLines.join("\n");
    currentFile.hunks = hunksMod.parseHunks(currentFile.hunkText);
  }

  return files.filter((f) => f.hunks && f.hunks.length > 0);
}

function applyPatch(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  let patchText = options.patch || options.diff || "";
  if (!patchText.includes("\n") && patchText.includes("\\n")) {
    patchText = patchText.split("\\n").join("\n");
  }
  const stripPrefix = options.stripPrefix ?? options.strip_prefix ?? 1;
  const dryRun = options.dryRun !== undefined ? Boolean(options.dryRun) : options.apply !== undefined ? !options.apply : Boolean(options.dry_run);
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (!patchText.trim()) {
    const res = { ok: false, error: "Empty patch provided." };
    res.report = formatApplyPatch(res);
    return res;
  }

  const parsedFiles = parseMultiFilePatch(patchText, stripPrefix);
  if (parsedFiles.length === 0) {
    const hunks = hunksMod.parseHunks(patchText);
    if (hunks.length === 0) {
      const res = { ok: false, error: "Could not parse any unified diff hunks (missing @@ -x,y +x,y @@ headers)." };
      res.report = formatApplyPatch(res);
      return res;
    }
    if (!options.file && !options.path) {
      const res = {
        ok: false,
        error: "Patch lacks file headers (--- a/... +++ b/...). Please specify 'path' or include diff file headers.",
      };
      res.report = formatApplyPatch(res);
      return res;
    }
    parsedFiles.push({
      path: (options.file || options.path).replace(/\\/g, "/"),
      hunks,
    });
  }

  const originalContents = new Map();
  const newContents = new Map();
  const diffs = [];
  let totalHunks = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  for (const pf of parsedFiles) {
    const relPath = pf.path;
    const absPath = path.resolve(root, relPath);

    if (!absPath.startsWith(root)) {
      const res = { ok: false, error: `Path '${relPath}' escapes workspace root.` };
      res.report = formatApplyPatch(res);
      return res;
    }

    let currentContent = "";
    if (fs.existsSync(absPath)) {
      try {
        currentContent = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        const res = { ok: false, error: `Cannot read target file '${relPath}': ${err.message}` };
        res.report = formatApplyPatch(res);
        return res;
      }
    }

    originalContents.set(relPath, currentContent);
    let workingContent = currentContent;

    for (let hIdx = 0; hIdx < pf.hunks.length; hIdx++) {
      const hunk = pf.hunks[hIdx];
      const applied = hunksMod.applyHunk(workingContent, hunk);
      if (applied === null) {
        const res = {
          ok: false,
          error: `Hunk #${hIdx + 1} failed to apply to '${relPath}': context mismatch (${hunk.header})`,
        };
        res.report = formatApplyPatch(res);
        return res;
      }
      workingContent = applied;
      totalHunks++;
    }

    if (validateSyntaxOpt) {
      const val = validateSyntax(relPath, workingContent);
      if (!val.valid) {
        const res = {
          ok: false,
          error: `Syntax validation failed on '${relPath}' after applying patch: ${val.error}`,
        };
        res.report = formatApplyPatch(res);
        return res;
      }
    }

    newContents.set(relPath, workingContent);

    const fileDiff = generateUnifiedDiff(relPath, currentContent, workingContent);
    if (fileDiff) {
      diffs.push(fileDiff);
      const oldL = currentContent.split("\n").length;
      const newL = workingContent.split("\n").length;
      if (newL > oldL) totalLinesAdded += newL - oldL;
      else if (oldL > newL) totalLinesRemoved += oldL - newL;
    }
  }

  const modifiedFiles = Array.from(parsedFiles.map((f) => f.path));

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      filesModifiedCount: modifiedFiles.length,
      filesModified: modifiedFiles,
      totalHunks,
      linesAdded: totalLinesAdded,
      linesRemoved: totalLinesRemoved,
      diff: diffs.join("\n"),
    };
    res.report = formatApplyPatch(res);
    return res;
  }

  const backupFiles = {};
  for (const [relPath, content] of originalContents.entries()) {
    backupFiles[relPath] = content;
  }

  const backupId = saveBackup(root, {
    tool: "apply_patch",
    description: `applyPatch across ${modifiedFiles.length} file(s) (${totalHunks} hunks)`,
    files: backupFiles,
  });

  const writtenFiles = [];
  try {
    for (const [relPath, newContent] of newContents.entries()) {
      const absPath = path.resolve(root, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, newContent, "utf8");
      writtenFiles.push(relPath);
    }
  } catch (err) {
    for (const written of writtenFiles) {
      const orig = originalContents.get(written);
      if (orig !== undefined) {
        fs.writeFileSync(path.resolve(root, written), orig, "utf8");
      }
    }
    const res = {
      ok: false,
      error: `I/O error applying patch: ${err.message}. Safe rollback executed.`,
    };
    res.report = formatApplyPatch(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    backupId: backupId || undefined,
    filesModifiedCount: modifiedFiles.length,
    filesModified: modifiedFiles,
    totalHunks,
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    diff: diffs.join("\n"),
  };
  res.report = formatApplyPatch(res);
  return res;
}

function formatApplyPatch(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Apply Patch: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Apply Patch (Dry-Run Preview):`);
    out.push(`• Files: ${res.filesModifiedCount}  • Hunks Verified: ${res.totalHunks}`);
    out.push("─".repeat(78));
    for (const f of res.filesModified) {
      out.push(`  • ${f}`);
    }
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Apply Patch: ✅ APPLIED SAFELY`);
    out.push(`• Files Modified: ${res.filesModifiedCount}  • Hunks Applied: ${res.totalHunks}  • Backup ID: ${res.backupId || "n/a"}`);
    out.push("─".repeat(78));
    for (const f of res.filesModified) {
      out.push(`  ✓ ${f}`);
    }
    if (res.backupId) {
      out.push(`\n💡 To undo this patch, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 7. Tool 4: revertChange
// ---------------------------------------------------------------------------

function revertChange(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const backupId = options.backupId || options.backup_id || "latest";

  const backup = loadBackup(root, backupId);
  if (!backup) {
    const res = {
      ok: false,
      error: `Backup not found: '${backupId}'. revert_change with backup_id \"latest\" restores the most recent backup.`,
    };
    res.report = formatRevertChange(res);
    return res;
  }

  const filesToRestore = backup.files || {};
  const restoredFiles = [];

  try {
    for (const [relPath, content] of Object.entries(filesToRestore)) {
      const absPath = path.resolve(root, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      fs.writeFileSync(absPath, content, "utf8");
      restoredFiles.push(relPath);
    }
  } catch (err) {
    const res = {
      ok: false,
      error: `Failed to restore files from backup '${backup.id}': ${err.message}`,
    };
    res.report = formatRevertChange(res);
    return res;
  }

  const res = {
    ok: true,
    reverted: true,
    backupId: backup.id,
    timestamp: backup.timestamp,
    tool: backup.tool,
    filesRestoredCount: restoredFiles.length,
    filesRestored: restoredFiles,
  };
  res.report = formatRevertChange(res);
  return res;
}

function formatRevertChange(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Revert Change: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  out.push(`Revert Change: ✅ RESTORED SUCCESSFULLY`);
  out.push(`• Backup ID: ${res.backupId}  • Original Operation: ${res.tool}  • Files Restored: ${res.filesRestoredCount}`);
  out.push("─".repeat(78));
  for (const f of res.filesRestored) {
    out.push(`  ✓ ${f}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 8. Tool 5: importCleanup
// ---------------------------------------------------------------------------

function importCleanup(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const files = Array.isArray(options.files)
    ? options.files
    : options.file || options.path
    ? [options.file || options.path]
    : [];
  const dryRun =
    options.dryRun !== undefined
      ? Boolean(options.dryRun)
      : options.dry_run !== undefined
      ? Boolean(options.dry_run)
      : options.apply === false;
  const removeUnused = options.removeUnused !== false && options.remove_unused !== false;
  const dedupe = options.dedupe !== false;
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (files.length === 0) {
    const res = { ok: false, error: "No files specified for import cleanup. Provide 'file' or 'files'." };
    res.report = formatImportCleanup(res);
    return res;
  }

  const originalContents = new Map();
  const newContents = new Map();
  const diffs = [];
  const modifiedFiles = [];
  let totalImportsRemoved = 0;
  let totalImportsDeduped = 0;

  for (const rawPath of files) {
    const relPath = rawPath.replace(/\\/g, "/");
    const absPath = path.resolve(root, relPath);
    if (!absPath.startsWith(root) || !fs.existsSync(absPath)) continue;

    let content = "";
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    originalContents.set(relPath, content);
    let working = content;
    const lines = working.split("\n");
    let changedInFile = false;

    // Precompute body code outside of imports/requires to accurately detect unused symbols
    const bodyLines = lines.filter((l) => {
      const t = l.trim();
      return !t.startsWith("import ") && !t.includes("require(");
    });
    const bodyCode = bodyLines.join("\n");

    // Phase 1: Clean up CommonJS requires
    const seenRequires = new Map(); // specifier -> { lineIdx, varName, destructured: Set }
    const linesToRemove = new Set();
    const lineReplacements = new Map();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // const { a, b } = require("mod");
      const cjsDestructMatch = /^(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\((['"][^'"]+['"])\);?$/.exec(trimmed);
      if (cjsDestructMatch) {
        const rawKeys = cjsDestructMatch[1].split(",").map((k) => k.trim()).filter(Boolean);
        const specifier = cjsDestructMatch[2];

        // Check unused if requested
        let activeKeys = rawKeys;
        if (removeUnused) {
          activeKeys = rawKeys.filter((k) => {
            const id = k.split(/\s*:\s*|\s+as\s+/)[0].trim();
            if (!id) return false;
            const regex = new RegExp(`\\b${id}\\b`);
            return regex.test(bodyCode);
          });
        }

        // Dedupe keys
        const uniqueKeys = Array.from(new Set(activeKeys));

        if (uniqueKeys.length === 0) {
          linesToRemove.add(i);
          totalImportsRemoved++;
          changedInFile = true;
        } else if (uniqueKeys.length !== rawKeys.length) {
          const indent = /^(\s*)/.exec(line)[1];
          lineReplacements.set(i, `${indent}const { ${uniqueKeys.join(", ")} } = require(${specifier});`);
          totalImportsRemoved += rawKeys.length - uniqueKeys.length;
          changedInFile = true;
        }
        continue;
      }

      // const foo = require("mod");
      const cjsSingleMatch = /^(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\((['"][^'"]+['"])\);?$/.exec(trimmed);
      if (cjsSingleMatch) {
        const id = cjsSingleMatch[1];
        const specifier = cjsSingleMatch[2];

        if (dedupe && seenRequires.has(specifier)) {
          const prev = seenRequires.get(specifier);
          if (prev.varName === id) {
            linesToRemove.add(i);
            totalImportsDeduped++;
            changedInFile = true;
            continue;
          }
        }

        if (removeUnused) {
          const regex = new RegExp(`\\b${id}\\b`);
          if (!regex.test(bodyCode)) {
            linesToRemove.add(i);
            totalImportsRemoved++;
            changedInFile = true;
            continue;
          }
        }

        seenRequires.set(specifier, { lineIdx: i, varName: id });
        continue;
      }

      // Phase 2: Clean up ESM imports
      // import { a, b } from "mod";
      const esmDestructMatch = /^import\s+\{([^}]+)\}\s+from\s+(['"][^'"]+['"]);?$/.exec(trimmed);
      if (esmDestructMatch) {
        const rawKeys = esmDestructMatch[1].split(",").map((k) => k.trim()).filter(Boolean);
        const specifier = esmDestructMatch[2];

        let activeKeys = rawKeys;
        if (removeUnused) {
          activeKeys = rawKeys.filter((k) => {
            const id = k.split(/\s+as\s+/)[0].trim();
            if (!id) return false;
            const regex = new RegExp(`\\b${id}\\b`);
            return regex.test(bodyCode);
          });
        }

        const uniqueKeys = Array.from(new Set(activeKeys));
        if (uniqueKeys.length === 0) {
          linesToRemove.add(i);
          totalImportsRemoved++;
          changedInFile = true;
        } else if (uniqueKeys.length !== rawKeys.length) {
          const indent = /^(\s*)/.exec(line)[1];
          lineReplacements.set(i, `${indent}import { ${uniqueKeys.join(", ")} } from ${specifier};`);
          totalImportsRemoved += rawKeys.length - uniqueKeys.length;
          changedInFile = true;
        }
        continue;
      }
    }

    if (changedInFile) {
      const newLines = [];
      for (let i = 0; i < lines.length; i++) {
        if (linesToRemove.has(i)) continue;
        if (lineReplacements.has(i)) newLines.push(lineReplacements.get(i));
        else newLines.push(lines[i]);
      }
      working = newLines.join("\n");

      if (validateSyntaxOpt) {
        const val = validateSyntax(relPath, working);
        if (!val.valid) {
          const res = { ok: false, error: `Syntax validation failed on '${relPath}': ${val.error}` };
          res.report = formatImportCleanup(res);
          return res;
        }
      }

      newContents.set(relPath, working);
      modifiedFiles.push(relPath);
      const fileDiff = generateUnifiedDiff(relPath, content, working);
      if (fileDiff) diffs.push(fileDiff);
    }
  }

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      filesModifiedCount: modifiedFiles.length,
      filesModified: modifiedFiles,
      totalImportsRemoved,
      totalImportsDeduped,
      diff: diffs.join("\n"),
    };
    res.report = formatImportCleanup(res);
    return res;
  }

  const backupFiles = {};
  for (const [relPath, content] of originalContents.entries()) {
    if (newContents.has(relPath)) {
      backupFiles[relPath] = content;
    }
  }

  const backupId = saveBackup(root, {
    tool: "import_cleanup",
    description: `importCleanup on ${modifiedFiles.length} file(s)`,
    files: backupFiles,
  });

  const writtenFiles = [];
  try {
    for (const [relPath, newContent] of newContents.entries()) {
      const absPath = path.resolve(root, relPath);
      fs.writeFileSync(absPath, newContent, "utf8");
      writtenFiles.push(relPath);
    }
  } catch (err) {
    for (const written of writtenFiles) {
      const orig = originalContents.get(written);
      if (orig !== undefined) fs.writeFileSync(path.resolve(root, written), orig, "utf8");
    }
    const res = { ok: false, error: `I/O error during import cleanup: ${err.message}. Safe rollback executed.` };
    res.report = formatImportCleanup(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    backupId: backupId || undefined,
    filesModifiedCount: modifiedFiles.length,
    filesModified: modifiedFiles,
    totalImportsRemoved,
    totalImportsDeduped,
    diff: diffs.join("\n"),
  };
  res.report = formatImportCleanup(res);
  return res;
}

function formatImportCleanup(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Import Cleanup: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Import Cleanup (Dry-Run Preview):`);
    out.push(`• Files Analyzed: ${res.filesModifiedCount}  • Unused/Duplicate Imports Cleaned: ${res.totalImportsRemoved + (res.totalImportsDeduped || 0)}`);
    out.push("─".repeat(78));
    for (const f of res.filesModified) {
      out.push(`  • ${f}`);
    }
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Import Cleanup: ✅ APPLIED SAFELY`);
    out.push(`• Files Modified: ${res.filesModifiedCount}  • Imports Cleaned: ${res.totalImportsRemoved}  • Backup ID: ${res.backupId || "n/a"}`);
    out.push("─".repeat(78));
    for (const f of res.filesModified) {
      out.push(`  ✓ ${f}`);
    }
    if (res.backupId) {
      out.push(`\n💡 To undo this cleanup, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 9. Tool 6: replaceWhere
// ---------------------------------------------------------------------------

function replaceWhere(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const file = (options.file || options.path || "").replace(/\\/g, "/");
  const search = options.search !== undefined ? options.search : options.oldText;
  const replace = options.replace !== undefined ? options.replace : options.newText;
  const insideFunction = options.insideFunction || options.inside_function;
  const insideClass = options.insideClass || options.inside_class;
  const dryRun =
    options.dryRun !== undefined
      ? Boolean(options.dryRun)
      : options.dry_run !== undefined
      ? Boolean(options.dry_run)
      : options.apply === false;
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (!file) {
    const res = { ok: false, error: "Target 'file' is required for replaceWhere." };
    res.report = formatReplaceWhere(res);
    return res;
  }
  if (search === undefined || replace === undefined) {
    const res = { ok: false, error: "Both 'search' and 'replace' parameters are required." };
    res.report = formatReplaceWhere(res);
    return res;
  }

  const absPath = path.resolve(root, file);
  if (!absPath.startsWith(root) || !fs.existsSync(absPath)) {
    const res = { ok: false, error: `File not found: '${file}'` };
    res.report = formatReplaceWhere(res);
    return res;
  }

  let rawSrc = "";
  try {
    rawSrc = fs.readFileSync(absPath, "utf8");
  } catch (err) {
    const res = { ok: false, error: `Cannot read '${file}': ${err.message}` };
    res.report = formatReplaceWhere(res);
    return res;
  }

  const ext = path.extname(file).toLowerCase();
  const sanSrc = usedWhereMod.sanitizeSource ? usedWhereMod.sanitizeSource(rawSrc, ext) : rawSrc;
  const decls = usedWhereMod.extractDeclarations ? usedWhereMod.extractDeclarations(file, rawSrc, sanSrc) : [];

  let startLine = 1;
  let endLine = rawSrc.split("\n").length;
  let scopeDescription = "entire file";

  if (insideFunction) {
    const targetDecl = decls.find(
      (d) => (d.kind === "function" || d.kind === "method") && d.name === insideFunction
    );
    if (!targetDecl || !targetDecl.fromLine || !targetDecl.toLine) {
      const res = { ok: false, error: `Function '${insideFunction}' not found in '${file}'.` };
      res.report = formatReplaceWhere(res);
      return res;
    }
    startLine = targetDecl.fromLine;
    endLine = targetDecl.toLine;
    scopeDescription = `function '${insideFunction}' (lines ${startLine}-${endLine})`;
  } else if (insideClass) {
    const targetDecl = decls.find((d) => d.kind === "class" && d.name === insideClass);
    if (!targetDecl || !targetDecl.fromLine || !targetDecl.toLine) {
      const res = { ok: false, error: `Class '${insideClass}' not found in '${file}'.` };
      res.report = formatReplaceWhere(res);
      return res;
    }
    startLine = targetDecl.fromLine;
    endLine = targetDecl.toLine;
    scopeDescription = `class '${insideClass}' (lines ${startLine}-${endLine})`;
  }

  const lines = rawSrc.split("\n");
  const scopeLines = lines.slice(startLine - 1, endLine);
  const scopeText = scopeLines.join("\n");

  let count = 0;
  let newScopeText = "";
  if (typeof search === "string") {
    newScopeText = scopeText.replaceAll(search, () => {
      count++;
      return replace;
    });
  } else if (search instanceof RegExp) {
    newScopeText = scopeText.replace(search, () => {
      count++;
      return replace;
    });
  }

  if (count === 0) {
    const res = {
      ok: false,
      error: `Search pattern not found within ${scopeDescription} in '${file}'.`,
      file,
      scope: scopeDescription,
    };
    res.report = formatReplaceWhere(res);
    return res;
  }

  const beforeLines = lines.slice(0, startLine - 1);
  const afterLines = lines.slice(endLine);
  const newContent = [...beforeLines, newScopeText, ...afterLines].join("\n");

  if (validateSyntaxOpt) {
    const val = validateSyntax(file, newContent);
    if (!val.valid) {
      const res = { ok: false, error: `Syntax validation failed on '${file}': ${val.error}` };
      res.report = formatReplaceWhere(res);
      return res;
    }
  }

  const diff = generateUnifiedDiff(file, rawSrc, newContent);

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      file,
      scope: scopeDescription,
      replacementsCount: count,
      diff,
    };
    res.report = formatReplaceWhere(res);
    return res;
  }

  const backupId = saveBackup(root, {
    tool: "replace_where",
    description: `replaceWhere in ${file} (${scopeDescription})`,
    files: { [file]: rawSrc },
  });

  try {
    fs.writeFileSync(absPath, newContent, "utf8");
  } catch (err) {
    const res = { ok: false, error: `Failed to write '${file}': ${err.message}` };
    res.report = formatReplaceWhere(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    file,
    scope: scopeDescription,
    replacementsCount: count,
    backupId: backupId || undefined,
    diff,
  };
  res.report = formatReplaceWhere(res);
  return res;
}

function formatReplaceWhere(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Replace Where: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Replace Where (Dry-Run Preview):`);
    out.push(`• File: ${res.file}  • Scope: ${res.scope}  • Matches: ${res.replacementsCount}`);
    out.push("─".repeat(78));
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Replace Where: ✅ APPLIED SAFELY`);
    out.push(`• File: ${res.file}  • Scope: ${res.scope}  • Replacements: ${res.replacementsCount}  • Backup ID: ${res.backupId || "n/a"}`);
    out.push("─".repeat(78));
    if (res.backupId) {
      out.push(`💡 To undo this replacement, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 10. Tool 7: moveSymbol
// ---------------------------------------------------------------------------

function moveSymbol(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const symbol = options.symbol || options.name;
  const fromFile = (options.fromFile || options.from_file || "").replace(/\\/g, "/");
  const toFile = (options.toFile || options.to_file || "").replace(/\\/g, "/");
  const dryRun =
    options.dryRun !== undefined
      ? Boolean(options.dryRun)
      : options.dry_run !== undefined
      ? Boolean(options.dry_run)
      : options.apply === false;
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  if (!symbol || !fromFile || !toFile) {
    const res = { ok: false, error: "Parameters 'symbol', 'from_file', and 'to_file' are all required." };
    res.report = formatMoveSymbol(res);
    return res;
  }

  const absFrom = path.resolve(root, fromFile);
  const absTo = path.resolve(root, toFile);

  if (!absFrom.startsWith(root) || !fs.existsSync(absFrom)) {
    const res = { ok: false, error: `Source file not found: '${fromFile}'` };
    res.report = formatMoveSymbol(res);
    return res;
  }

  let fromSrc = fs.readFileSync(absFrom, "utf8");
  let toSrc = fs.existsSync(absTo) ? fs.readFileSync(absTo, "utf8") : "";

  const ext = path.extname(fromFile).toLowerCase();
  const sanSrc = usedWhereMod.sanitizeSource ? usedWhereMod.sanitizeSource(fromSrc, ext) : fromSrc;
  const decls = usedWhereMod.extractDeclarations ? usedWhereMod.extractDeclarations(fromFile, fromSrc, sanSrc) : [];

  const targetDecl = decls.find((d) => d.name === symbol && d.fromLine && d.toLine);
  if (!targetDecl) {
    const res = { ok: false, error: `Symbol '${symbol}' declaration not found in '${fromFile}'.` };
    res.report = formatMoveSymbol(res);
    return res;
  }

  const fromLines = fromSrc.split("\n");
  const symbolSpan = fromLines.slice(targetDecl.fromLine - 1, targetDecl.toLine).join("\n");

  // Remove from fromFile
  const newFromLines = [
    ...fromLines.slice(0, targetDecl.fromLine - 1),
    ...fromLines.slice(targetDecl.toLine),
  ];
  const newFromSrc = newFromLines.join("\n");

  // Append to toFile
  let newToSrc = toSrc;
  if (newToSrc.length > 0 && !newToSrc.endsWith("\n")) newToSrc += "\n";
  newToSrc += `\n${symbolSpan}\n`;

  if (validateSyntaxOpt) {
    const valFrom = validateSyntax(fromFile, newFromSrc);
    if (!valFrom.valid) {
      const res = { ok: false, error: `Syntax validation failed on source '${fromFile}': ${valFrom.error}` };
      res.report = formatMoveSymbol(res);
      return res;
    }
    const valTo = validateSyntax(toFile, newToSrc);
    if (!valTo.valid) {
      const res = { ok: false, error: `Syntax validation failed on destination '${toFile}': ${valTo.error}` };
      res.report = formatMoveSymbol(res);
      return res;
    }
  }

  const diffFrom = generateUnifiedDiff(fromFile, fromSrc, newFromSrc);
  const diffTo = generateUnifiedDiff(toFile, toSrc, newToSrc);
  const combinedDiff = [diffFrom, diffTo].filter(Boolean).join("\n");

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      symbol,
      fromFile,
      toFile,
      linesMoved: targetDecl.toLine - targetDecl.fromLine + 1,
      diff: combinedDiff,
    };
    res.report = formatMoveSymbol(res);
    return res;
  }

  const backupId = saveBackup(root, {
    tool: "move_symbol",
    description: `moveSymbol '${symbol}' from ${fromFile} to ${toFile}`,
    files: { [fromFile]: fromSrc, [toFile]: toSrc },
  });

  try {
    fs.writeFileSync(absFrom, newFromSrc, "utf8");
    fs.mkdirSync(path.dirname(absTo), { recursive: true });
    fs.writeFileSync(absTo, newToSrc, "utf8");
  } catch (err) {
    fs.writeFileSync(absFrom, fromSrc, "utf8");
    if (toSrc) fs.writeFileSync(absTo, toSrc, "utf8");
    const res = { ok: false, error: `Failed to write moved files: ${err.message}. Safe rollback executed.` };
    res.report = formatMoveSymbol(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    symbol,
    fromFile,
    toFile,
    linesMoved: targetDecl.toLine - targetDecl.fromLine + 1,
    backupId: backupId || undefined,
    diff: combinedDiff,
  };
  res.report = formatMoveSymbol(res);
  return res;
}

function formatMoveSymbol(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Move Symbol: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Move Symbol (Dry-Run Preview):`);
    out.push(`• Symbol: '${res.symbol}'  • Source: ${res.fromFile}  • Destination: ${res.toFile}  • Lines: ${res.linesMoved}`);
    out.push("─".repeat(78));
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Move Symbol: ✅ MOVED SAFELY`);
    out.push(`• Symbol: '${res.symbol}'  • Source: ${res.fromFile}  • Destination: ${res.toFile}  • Backup ID: ${res.backupId || "n/a"}`);
    out.push("─".repeat(78));
    if (res.backupId) {
      out.push(`💡 To undo this move, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 11. Tool 8: formatChanged
// ---------------------------------------------------------------------------

function formatChanged(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  let targetFiles = Array.isArray(options.files)
    ? options.files
    : options.file || options.path
    ? [options.file || options.path]
    : [];

  const backupId = options.backupId || options.backup_id;
  if (backupId) {
    const b = loadBackup(root, backupId);
    if (b && b.files) {
      targetFiles = Object.keys(b.files);
    }
  }

  const dryRun =
    options.dryRun !== undefined
      ? Boolean(options.dryRun)
      : options.dry_run !== undefined
      ? Boolean(options.dry_run)
      : options.apply === false;
  const trimTrailingWhitespace = options.trimTrailingWhitespace !== false;
  const ensureNewlineAtEof = options.ensureNewlineAtEof !== false;

  if (targetFiles.length === 0) {
    const res = { ok: false, error: "No target files specified for formatChanged. Provide 'files' or 'backup_id'." };
    res.report = formatFormatChanged(res);
    return res;
  }

  const originalContents = new Map();
  const newContents = new Map();
  const diffs = [];
  const modifiedFiles = [];

  for (const rawPath of targetFiles) {
    const relPath = rawPath.replace(/\\/g, "/");
    const absPath = path.resolve(root, relPath);
    if (!absPath.startsWith(root) || !fs.existsSync(absPath)) continue;

    let content = "";
    try {
      content = fs.readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    originalContents.set(relPath, content);
    let working = content.replace(/\r\n/g, "\n");

    if (trimTrailingWhitespace) {
      working = working
        .split("\n")
        .map((l) => l.replace(/[\t ]+$/, ""))
        .join("\n");
    }

    if (ensureNewlineAtEof && working.length > 0 && !working.endsWith("\n")) {
      working += "\n";
    }

    if (working !== content) {
      newContents.set(relPath, working);
      modifiedFiles.push(relPath);
      const fileDiff = generateUnifiedDiff(relPath, content, working);
      if (fileDiff) diffs.push(fileDiff);
    }
  }

  if (dryRun) {
    const res = {
      ok: true,
      mode: "dry-run",
      applied: false,
      filesFormattedCount: modifiedFiles.length,
      filesFormatted: modifiedFiles,
      diff: diffs.join("\n"),
    };
    res.report = formatFormatChanged(res);
    return res;
  }

  const backupFiles = {};
  for (const [relPath, content] of originalContents.entries()) {
    if (newContents.has(relPath)) backupFiles[relPath] = content;
  }

  const newBackupId = saveBackup(root, {
    tool: "format_changed",
    description: `formatChanged on ${modifiedFiles.length} file(s)`,
    files: backupFiles,
  });

  const writtenFiles = [];
  try {
    for (const [relPath, newContent] of newContents.entries()) {
      const absPath = path.resolve(root, relPath);
      fs.writeFileSync(absPath, newContent, "utf8");
      writtenFiles.push(relPath);
    }
  } catch (err) {
    for (const written of writtenFiles) {
      const orig = originalContents.get(written);
      if (orig !== undefined) fs.writeFileSync(path.resolve(root, written), orig, "utf8");
    }
    const res = { ok: false, error: `I/O error formatting files: ${err.message}. Safe rollback executed.` };
    res.report = formatFormatChanged(res);
    return res;
  }

  const res = {
    ok: true,
    mode: "apply",
    applied: true,
    backupId: newBackupId || undefined,
    filesFormattedCount: modifiedFiles.length,
    filesFormatted: modifiedFiles,
    diff: diffs.join("\n"),
  };
  res.report = formatFormatChanged(res);
  return res;
}

function formatFormatChanged(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Format Changed: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  if (res.mode === "dry-run") {
    out.push(`Format Changed (Dry-Run Preview):`);
    out.push(`• Files Touched: ${res.filesFormattedCount}`);
    out.push("─".repeat(78));
    for (const f of res.filesFormatted) {
      out.push(`  • ${f}`);
    }
    if (res.diff) {
      out.push("\nDiff Preview:");
      out.push(res.diff);
    }
  } else {
    out.push(`Format Changed: ✅ FORMATTED SAFELY`);
    out.push(`• Files Formatted: ${res.filesFormattedCount}  • Backup ID: ${res.backupId || "n/a"}`);
    out.push("─".repeat(78));
    for (const f of res.filesFormatted) {
      out.push(`  ✓ ${f}`);
    }
    if (res.backupId) {
      out.push(`\n💡 To undo this formatting, call revert_change with backup_id ${res.backupId}`);
    }
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 12. Tool 9: commitReceipt
// ---------------------------------------------------------------------------

function commitReceipt(workdir, options = {}) {
  const { execSync } = require("child_process");
  const root = path.resolve(workdir || process.cwd());
  const backupId = options.backupId || options.backup_id;
  const message = options.message;
  let files = Array.isArray(options.files) ? options.files : options.file ? [options.file] : [];

  if (backupId) {
    const b = loadBackup(root, backupId);
    if (b && b.files) {
      files = Object.keys(b.files);
    }
  }

  if (!message) {
    const res = { ok: false, error: "Commit message is required ('message')." };
    res.report = formatCommitReceipt(res);
    return res;
  }

  if (files.length === 0) {
    const res = { ok: false, error: "No files specified or found in backup receipt to commit." };
    res.report = formatCommitReceipt(res);
    return res;
  }

  try {
    // Stage ONLY the specified files
    for (const f of files) {
      execSync(`git add ${JSON.stringify(f)}`, { cwd: root, stdio: "pipe" });
    }

    const out = execSync(`git commit -m ${JSON.stringify(message)}`, {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
    });

    const shaMatch = /\[(?:[^\s]+)\s+([0-9a-f]{7,40})\]/i.exec(out);
    const commitHash = shaMatch ? shaMatch[1] : "committed";

    const res = {
      ok: true,
      commitHash,
      message,
      filesCommittedCount: files.length,
      filesCommitted: files,
      rawOutput: out.trim(),
    };
    res.report = formatCommitReceipt(res);
    return res;
  } catch (err) {
    const res = {
      ok: false,
      error: `Git commit failed: ${err.message} (${err.stderr ? err.stderr.toString().trim() : ""})`,
    };
    res.report = formatCommitReceipt(res);
    return res;
  }
}

function formatCommitReceipt(res) {
  const out = [];
  if (!res.ok) {
    out.push(`Commit Receipt: ❌ FAILED`);
    out.push(`• Reason: ${res.error}`);
    return out.join("\n");
  }

  out.push(`Commit Receipt: ✅ COMMITTED SAFELY`);
  out.push(`• Commit: ${res.commitHash}  • Files: ${res.filesCommittedCount}  • Message: "${res.message}"`);
  out.push("─".repeat(78));
  for (const f of res.filesCommitted) {
    out.push(`  ✓ ${f}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// 9. Atomic Staged Multi-File Patch Transaction System
// ---------------------------------------------------------------------------
// Implements the 3-phase workflow:
// Phase 1: Intent Declaration & Manifest
// Phase 2: In-Memory Pre-Flight & Unified Review Buffer
// Phase 3: All-or-Nothing Commit with Auto-Rollback

const stagedTransactions = new Map();

function stageMultiFileTransaction(workdir, options = {}) {
  const root = path.resolve(workdir || process.cwd());
  const intent = String(options.intent || options.plan || options.reason || "Multi-file transaction");
  const txId = options.transaction_id || `tx-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const stripPrefix = options.stripPrefix ?? options.strip_prefix ?? 1;
  const validateSyntaxOpt = options.validateSyntax !== false && options.validate_syntax !== false;

  let patchText = options.patch || options.diff || "";
  if (!patchText.includes("\n") && patchText.includes("\\n")) {
    patchText = patchText.split("\\n").join("\n");
  }

  let parsedFiles = parseMultiFilePatch(patchText, stripPrefix);

  // If explicit files array is provided with new content or patches:
  if (Array.isArray(options.files) && options.files.length > 0) {
    for (const f of options.files) {
      if (!f.path) continue;
      const relPath = f.path.replace(/\\/g, "/");
      if (f.patch) {
        const fileHunks = hunksMod.parseHunks(f.patch);
        parsedFiles.push({ path: relPath, hunks: fileHunks });
      } else if (f.content !== undefined || f.new_content !== undefined) {
        const newCont = f.content !== undefined ? f.content : f.new_content;
        const abs = path.resolve(root, relPath);
        const oldCont = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
        const fileDiff = generateUnifiedDiff(relPath, oldCont, newCont);
        const fileHunks = hunksMod.parseHunks(fileDiff);
        parsedFiles.push({ path: relPath, hunks: fileHunks, directContent: newCont });
      }
    }
  }

  if (parsedFiles.length === 0) {
    const res = {
      ok: false,
      transaction_id: txId,
      intent,
      error: "No valid file patches or diffs found in transaction payload.",
    };
    res.report = formatMultiFileTransaction(res);
    return res;
  }

  const manifest = [];
  const originalContents = new Map();
  const newContents = new Map();
  const fileDiffs = [];
  let totalHunks = 0;
  let totalLinesAdded = 0;
  let totalLinesRemoved = 0;

  // Phase 1 & 2: Validate all files in-memory before touching disk
  for (const pf of parsedFiles) {
    const relPath = pf.path;
    const absPath = path.resolve(root, relPath);

    if (!absPath.startsWith(root)) {
      const res = {
        ok: false,
        transaction_id: txId,
        intent,
        error: `Path '${relPath}' escapes workspace root. Transaction aborted.`,
      };
      res.report = formatMultiFileTransaction(res);
      return res;
    }

    const exists = fs.existsSync(absPath);
    let currentContent = "";
    if (exists) {
      try {
        currentContent = fs.readFileSync(absPath, "utf8");
      } catch (err) {
        const res = {
          ok: false,
          transaction_id: txId,
          intent,
          error: `Cannot read target file '${relPath}': ${err.message}`,
        };
        res.report = formatMultiFileTransaction(res);
        return res;
      }
    }

    let modifiedContent = currentContent;
    if (pf.directContent !== undefined) {
      modifiedContent = pf.directContent;
    } else {
      if (!pf.hunks || pf.hunks.length === 0) {
        const res = {
          ok: false,
          transaction_id: txId,
          intent,
          error: `No valid diff hunks found for target file '${relPath}'.`,
        };
        res.report = formatMultiFileTransaction(res);
        return res;
      }

      for (let hIdx = 0; hIdx < pf.hunks.length; hIdx++) {
        const hunk = pf.hunks[hIdx];
        const applied = hunksMod.applyHunk(modifiedContent, hunk);
        if (applied === null) {
          const res = {
            ok: false,
            transaction_id: txId,
            intent,
            error: `Deterministic pre-flight patch verification failed on '${relPath}' (hunk #${hIdx + 1}): context mismatch (${hunk.header || 'hunk header'}). Zero files were touched.`,
          };
          res.report = formatMultiFileTransaction(res);
          return res;
        }
        modifiedContent = applied;
      }
    }

    if (validateSyntaxOpt) {
      const syntax = validateSyntax(relPath, modifiedContent);
      if (!syntax.valid) {
        const res = {
          ok: false,
          transaction_id: txId,
          intent,
          error: `Syntax validation failed on '${relPath}': ${syntax.error}. Entire transaction rejected.`,
        };
        res.report = formatMultiFileTransaction(res);
        return res;
      }
    }

    const op = !exists ? "+" : modifiedContent === "" ? "-" : "M";
    const explicitManifestItem = Array.isArray(options.manifest)
      ? options.manifest.find((m) => m.path === relPath || m.file === relPath)
      : null;
    const reason = explicitManifestItem ? explicitManifestItem.reason || explicitManifestItem.note || "" : "";

    manifest.push({
      path: relPath,
      op,
      reason,
      hunkCount: pf.hunks ? pf.hunks.length : 1,
    });

    originalContents.set(relPath, { absPath, exists, content: currentContent });
    newContents.set(relPath, { absPath, exists, content: modifiedContent });

    const fileDiff = generateUnifiedDiff(relPath, currentContent, modifiedContent);
    const added = (fileDiff.match(/^\+[^+]/gm) || []).length;
    const removed = (fileDiff.match(/^-[^-]/gm) || []).length;

    totalHunks += pf.hunks ? pf.hunks.length : 1;
    totalLinesAdded += added;
    totalLinesRemoved += removed;

    fileDiffs.push({
      path: relPath,
      op,
      hunkCount: pf.hunks ? pf.hunks.length : 1,
      linesAdded: added,
      linesRemoved: removed,
      diff: fileDiff,
    });
  }

  const stagedRecord = {
    ok: true,
    transaction_id: txId,
    intent,
    staged: true,
    committed: false,
    filesCount: manifest.length,
    hunksCount: totalHunks,
    linesAdded: totalLinesAdded,
    linesRemoved: totalLinesRemoved,
    manifest,
    diffs: fileDiffs,
    originalContents,
    newContents,
    workdir: root,
    timestamp: new Date().toISOString(),
  };

  stagedTransactions.set(txId, stagedRecord);
  stagedRecord.report = formatMultiFileTransaction(stagedRecord);
  return stagedRecord;
}

function applyMultiFileTransaction(workdir, options = {}) {
  let staged = null;
  if (options.transaction_id && stagedTransactions.has(options.transaction_id)) {
    staged = stagedTransactions.get(options.transaction_id);
  } else {
    staged = stageMultiFileTransaction(workdir, options);
    if (!staged.ok) return staged;
  }

  if (options.dry_run || options.dryRun) {
    return staged;
  }

  const root = staged.workdir;
  const backupFiles = {};
  for (const [relPath, item] of staged.originalContents) {
    backupFiles[relPath] = item.content;
  }

  const backupId = saveBackup(root, {
    tool: "multi_file_patch",
    description: `Transaction ${staged.transaction_id}: ${staged.intent}`,
    files: backupFiles,
  });
  const modifiedFiles = [];
  let writeFailed = false;
  let writeError = null;

  // Phase 3: All-or-nothing atomic write to disk
  for (const [relPath, item] of staged.newContents) {
    try {
      const dir = path.dirname(item.absPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(item.absPath, item.content, "utf8");
      modifiedFiles.push(relPath);
    } catch (err) {
      writeFailed = true;
      writeError = err;
      break;
    }
  }

  if (writeFailed) {
    // Immediate full rollback
    for (const [relPath, item] of staged.originalContents) {
      try {
        if (item.exists) {
          fs.writeFileSync(item.absPath, item.content, "utf8");
        } else if (fs.existsSync(item.absPath)) {
          fs.unlinkSync(item.absPath);
        }
      } catch {}
    }

    const res = {
      ok: false,
      transaction_id: staged.transaction_id,
      intent: staged.intent,
      error: `Disk write failed during transaction commit (${writeError.message}). Automatic rollback restored all files.`,
    };
    res.report = formatMultiFileTransaction(res);
    return res;
  }

  staged.committed = true;
  staged.staged = false;
  staged.backup_id = backupId;
  stagedTransactions.delete(staged.transaction_id);

  const res = {
    ok: true,
    transaction_id: staged.transaction_id,
    intent: staged.intent,
    committed: true,
    staged: false,
    backup_id: backupId,
    filesCommitted: modifiedFiles,
    filesCount: modifiedFiles.length,
    hunksCount: staged.hunksCount,
    linesAdded: staged.linesAdded,
    linesRemoved: staged.linesRemoved,
    manifest: staged.manifest,
    diffs: staged.diffs,
    report: "",
  };
  res.report = formatMultiFileTransaction(res);
  return res;
}

function abortMultiFileTransaction(options = {}) {
  const txId = options.transaction_id || options.txId;
  if (!txId || !stagedTransactions.has(txId)) {
    return { ok: false, error: `No active staged transaction found for '${txId}'.` };
  }
  stagedTransactions.delete(txId);
  return {
    ok: true,
    transaction_id: txId,
    aborted: true,
    report: `Transaction ${txId} aborted. Tree remains pristine; all modifications discarded.`,
  };
}

function formatMultiFileTransaction(res) {
  const out = [];
  const status = !res.ok
    ? "❌ FAILED / ABORTED"
    : res.committed
    ? "✅ COMMITTED (ALL-OR-NOTHING)"
    : "⏳ STAGED (READY FOR VERDICT)";

  out.push(`Transaction ${res.transaction_id || "TX"}: ${status}`);
  out.push(`• Intent: ${res.intent || "No intent specified"}`);
  if (res.backup_id) out.push(`• Backup Receipt ID: ${res.backup_id}`);
  if (res.error) {
    out.push(`• Error: ${res.error}`);
    return out.join("\n");
  }

  out.push("─".repeat(78));
  out.push("PHASE 1: INTENT DECLARATION (MANIFEST)");
  if (Array.isArray(res.manifest)) {
    for (const m of res.manifest) {
      const opTag = m.op === "+" ? "[+]" : m.op === "-" ? "[-]" : "[M]";
      const reasonStr = m.reason ? `  (${m.reason})` : "";
      out.push(`  ${opTag} ${m.path}${reasonStr}`);
    }
  }

  out.push("─".repeat(78));
  out.push(`PHASE 2: UNIFIED ATOMIC REVIEW BUFFER (${res.filesCount || 0} files, +${res.linesAdded || 0}/-${res.linesRemoved || 0} lines)`);
  if (Array.isArray(res.diffs)) {
    for (const d of res.diffs) {
      out.push(`\n=== File: ${d.path} [${d.op}] (+${d.linesAdded}/-${d.linesRemoved}) ===`);
      out.push(d.diff.trim());
    }
  }

  out.push("\n" + "─".repeat(78));
  if (res.committed) {
    out.push("PHASE 3: VERDICT → ALL FILES COMMITTED ATOMICALLY TO DISK");
  } else {
    out.push("PHASE 3: VERDICT → STAGED. Use Space/Tab to review, Ctrl+Enter to commit, Esc to abort.");
  }

  return out.join("\n");
}

module.exports = {
  bulkEdit,
  renameSymbol,
  applyPatch,
  revertChange,
  importCleanup,
  replaceWhere,
  moveSymbol,
  formatChanged,
  commitReceipt,
  stageMultiFileTransaction,
  applyMultiFileTransaction,
  abortMultiFileTransaction,
  formatMultiFileTransaction,
  listBackups,
  validateSyntax,
  generateUnifiedDiff,
  formatBulkEdit,
  formatRenameSymbol,
  formatApplyPatch,
  formatRevertChange,
  formatImportCleanup,
  formatReplaceWhere,
  formatMoveSymbol,
  formatFormatChanged,
  formatCommitReceipt,
};
