// The processes `npm run dev` starts (ASQL, the engines), written down as they start and as they go, so a dev server
// that died without its exit handlers (killed hard, its window closed, a crash) leaves nothing a next start cannot
// find: that start stops whatever the last one left behind before it starts its own. Without this an orphaned ASQL
// kept port 3307 (a later start found it answering and used it, binary and all), and an orphaned engine kept its
// executable locked.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const FILE = path.join(process.env.CONVERGE_LOCAL_STATE || path.join(os.homedir(), '.converge-local'), 'dev-children.json');

const read = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || []; } catch { return []; } };
const write = (list) => {
  try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(list)); } catch { /* best effort */ }
};

/** The executable a live pid runs, or '' when it is gone (or cannot be read). */
function exeOf(pid) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).Path`],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    return String(r.stdout || '').trim();
  }
  try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { /* not Linux, or gone */ }
  const r = spawnSync('ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  return String(r.stdout || '').trim();
}

/** Note a child this dev server started; it is crossed off when it exits. */
export function track(child, what) {
  if (!child?.pid) return;
  const exe = child.spawnfile || '';
  write([...read().filter((c) => c.pid !== child.pid), { pid: child.pid, exe, what, owner: process.pid }]);
  child.once('exit', () => write(read().filter((c) => c.pid !== child.pid)));
}

/**
 * Stop what an earlier dev server left running: every recorded child that is still alive and still the same program
 * (a pid can be reused; a different program under it is left alone). Returns what was stopped.
 */
export function reapOrphans() {
  const stopped = [], kept = [];
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (const c of read()) {
    if (c.owner === process.pid) continue;
    if (alive(c.owner)) { kept.push(c); continue; }   // a dev server still running: its children are its own
    const exe = exeOf(c.pid);
    if (!exe) continue;
    const same = path.basename(exe).toLowerCase().replace(/\.exe$/, '') === path.basename(c.exe).toLowerCase().replace(/\.exe$/, '');
    if (!same) continue;
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else process.kill(c.pid, 'SIGKILL');
      stopped.push(`${c.what} (pid ${c.pid})`);
    } catch { /* already gone */ }
  }
  write(kept);
  return stopped;
}
