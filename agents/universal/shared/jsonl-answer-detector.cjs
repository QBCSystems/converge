// Structural detector for terminal JSONL answer frames.
// Feeding raw stdout text must never treat a quoted/escaped `"t":"answer"`
// inside tool output, source code, or logs as a real answer event.
class JsonlAnswerDetector {
  constructor(maxCarry = 65536) { this.buf = ''; this.answered = false; this.maxCarry = maxCarry; }
  feed(chunk) {
    if (this.answered) return true;
    this.buf += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev && ev.t === 'answer') { this.answered = true; return true; }
      } catch {}
    }
    if (this.buf.length > this.maxCarry) this.buf = this.buf.slice(-this.maxCarry);
    return this.answered;
  }
  flush() {
    if (this.answered) return true;
    const line = this.buf.trim();
    this.buf = '';
    if (!line) return false;
    try { const ev = JSON.parse(line); if (ev && ev.t === 'answer') this.answered = true; } catch {}
    return this.answered;
  }
}
module.exports = { JsonlAnswerDetector };
