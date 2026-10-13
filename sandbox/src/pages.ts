// The page this Worker serves itself: where a visitor picks a demo. Everything after it is converge's own dashboard.

const CSS = `
:root{--bg:#0b0f17;--panel:#121826;--line:#243049;--text:#e8edf6;--dim:#93a1ba;--accent:#6ea8ff;--ok:#43d08a}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--text);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:880px;margin:0 auto;padding:56px 22px 80px}
.brand{font-weight:700;letter-spacing:.02em;color:var(--dim);font-size:14px}
h1{font-size:clamp(32px,6vw,52px);line-height:1.08;margin:14px 0 14px;letter-spacing:-.02em}
.lead{color:var(--dim);font-size:18px;max-width:640px;margin:0 0 34px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px;margin:6px 0 26px}
button.card{all:unset;box-sizing:border-box;cursor:pointer;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 20px 18px;display:block;transition:.15s}
button.card:hover,button.card:focus-visible{border-color:var(--accent);transform:translateY(-2px)}
button.card[disabled]{opacity:.5;cursor:default;transform:none}
.card h3{margin:0 0 6px;font-size:19px}.card p{margin:0;color:var(--dim);font-size:15px}.card .go{display:inline-block;margin-top:14px;color:var(--accent);font-weight:600;font-size:15px}
.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:18px;margin:34px 0 8px;padding:0;list-style:none;counter-reset:s}
.steps li{counter-increment:s;color:var(--dim);font-size:15px}.steps li b{display:block;color:var(--text);margin-bottom:2px}
.steps li:before{content:counter(s);display:inline-flex;width:24px;height:24px;border-radius:50%;background:var(--line);color:var(--text);font-size:13px;font-weight:700;align-items:center;justify-content:center;margin-bottom:8px}
.note{margin-top:30px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;color:var(--dim);font-size:14px}
.note b{color:var(--text)}
#status{margin-top:22px;min-height:26px;color:var(--dim)}#status.err{color:#ff8d8d}
.spin{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--accent);border-radius:50%;animation:r .8s linear infinite;vertical-align:-2px;margin-right:8px}
@keyframes r{to{transform:rotate(360deg)}}
a{color:var(--accent)}
`;

const shell = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${CSS}</style></head><body><main>${body}</main></body></html>`;

const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The landing page: one card per template (SANDBOX_TEMPLATES), each starting a session on a copy of that project. */
export function landingPage(enabled: boolean, converge: string, templates: string[]): string {
  const on = enabled && templates.length > 0;
  const cards = templates.map((t) => `<button class="card" data-t="${esc(t)}" ${on ? '' : 'disabled'}><h3>${esc(t)}</h3><p>Your own copy of ${esc(t)} for an hour. Ask for something new, or a fix.</p><span class="go">Start with ${esc(t)} &rarr;</span></button>`).join('\n  ');
  const off = !enabled ? `Sandbox is switched off for now.${templates.length ? ` The <a href="${esc(converge)}/?project=${encodeURIComponent(templates[0])}&watch=1">live demo</a> is still running.` : ''}`
    : !templates.length ? 'No starting projects are set up yet (SANDBOX_TEMPLATES).' : '';
  return shell('Try converge', `
<div class="brand">converge</div>
<h1>Put a team of AI agents on a codebase.<br>Watch it happen.</h1>
<p class="lead">Pick a starting project, say what you want, and a team of agents builds it in parallel. Every change is checked by converge before it lands, and you can watch each one arrive.</p>
<div class="cards">
  ${cards}
</div>
<div id="status">${off}</div>
<ol class="steps">
  <li><b>Pick</b>You get your own copy of the project for an hour. Nothing you do touches anyone else's.</li>
  <li><b>Ask</b>Type what you want into the box at the bottom of the board and press Start. It is planned into tasks, one agent each.</li>
  <li><b>Watch</b>Agents claim files, push, get checked, and land, live on the same board.</li>
</ol>
<p class="note"><b>Free.</b> It runs on Cloudflare's own models at no cost to you, within a small allowance per sandbox.</p>
<script>
const status = document.getElementById('status');
const say = (t, err) => { status.className = err ? 'err' : ''; status.innerHTML = err ? t : '<span class="spin"></span>' + t; };
document.querySelectorAll('button.card').forEach((b) => b.addEventListener('click', async () => {
  document.querySelectorAll('button.card').forEach((x) => (x.disabled = true));
  say('Creating your project&hellip;');
  let r;
  try { r = await fetch('/__sandbox/new', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ template: b.dataset.t }) }); }
  catch { say('Could not reach the server. Try again.', true); document.querySelectorAll('button.card').forEach((x) => (x.disabled = false)); return; }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { say(d.error || 'Something went wrong. Try again.', true); document.querySelectorAll('button.card').forEach((x) => (x.disabled = false)); return; }
  say('Opening your project&hellip;');
  location.href = d.dashboard;
}));
</script>`);
}
