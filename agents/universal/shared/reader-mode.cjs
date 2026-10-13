'use strict';
// Reader mode: turn a fetched page into something we can show, safely.
//
// The GUI's browser pane is a <webview> in the desktop app and an <iframe>
// everywhere else. An iframe cannot show most of the web — Google, news sites,
// docs, anything with X-Frame-Options or a frame-ancestors CSP simply refuses,
// and the pane goes blank with no explanation. That is most of why the browser
// "kinda doesn't work" when the GUI is served over HTTP.
//
// So the server fetches the page and we render it ourselves. The whole question
// is then how to render somebody else's HTML without handing them the GUI.
//
// THIS MODULE NEVER PRODUCES HTML. It returns a list of typed blocks
// ({ type: 'p', text: '…' }) and the client builds DOM nodes with textContent.
// A regex "sanitizer" that emits an HTML string is the classic way to get this
// wrong — one missed attribute context and a page we previewed is running
// script in the app. Emitting text-only blocks means there is no sanitizer to
// be wrong: nothing the page says can become markup. It is also why images are
// omitted for now (an <img src> is a request to the page's server carrying the
// reader's IP, which is a separate decision from "can we show the words").
//
// Same reasoning as applyUnfurl in the console: built as DOM, never as a string.

const BLOCK_MAX = 4000;      // one paragraph; longer is a page that lost a </p>
const BLOCKS_MAX = 1200;     // a whole document
const MAX_ITERS = 40_000;    // bound the scan so a hostile/huge page still terminates

// Elements whose CONTENT is never prose.
const DROP = /<(script|style|noscript|svg|canvas|template|iframe|object|embed|form|select|textarea)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
// Self-closing / unclosed variants of the same, plus comments.
const DROP_TAGS = /<(script|style|noscript|svg|canvas|template|iframe|object|embed|link|meta|input|button)\b[^>]*\/?>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
// Page furniture. Dropped whole — a nav full of link text reads as gibberish
// in a reader view and is the main thing that makes these look broken.
const FURNITURE = /<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', hellip: '…', middot: '·',
  trade: '™', copy: '©', reg: '®', deg: '°', eacute: 'é', egrave: 'è',
};
function decodeEntities(s) {
  return String(s || '').replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      // Reject surrogates and out-of-range: String.fromCodePoint throws on them,
      // and a page that emits them is trying something.
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    const k = ent.toLowerCase();
    return Object.prototype.hasOwnProperty.call(ENTITIES, k) ? ENTITIES[k] : m;
  });
}

const clean = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

function pickTitle(html) {
  const og = /<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i.exec(html);
  if (og && og[1].trim()) return clean(og[1]).slice(0, 300);
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) return clean(t[1]).slice(0, 300);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  return h1 ? clean(h1[1]).slice(0, 300) : '';
}

// Where the readable part of the page is.
//
// Every rule for this is a guess: <article> is sometimes a teaser card, <main>
// sometimes wraps only the header, and "find the content div" cannot work with
// regex at all (a non-greedy match stops at the FIRST </div>, truncating the
// page a paragraph in). Measured on real pages, each heuristic won on one site
// and lost badly on another — nodejs.org collapsed to a single heading under
// the <main> rule while Wikipedia needed it.
//
// So do not guess: extract from every candidate and keep whichever actually
// yielded the most prose. It is a few extra regex passes over one document, and
// it cannot lose to the body fallback by construction.
function candidateSections(html) {
  const out = [];
  for (const re of [/<article\b[^>]*>([\s\S]*?)<\/article>/i, /<main\b[^>]*>([\s\S]*?)<\/main>/i]) {
    const m = re.exec(html);
    if (m && m[1]) out.push(m[1]);
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html);
  out.push(body ? body[1] : html);
  return out;
}
const wordsIn = (blocks) => blocks.reduce((n, b) => n + (b.text ? b.text.split(/\s+/).length : 0), 0);
function bestSection(html) {
  let best = { section: '', blocks: [], words: -1 };
  for (const section of candidateSections(html)) {
    const blocks = extractBlocks(section);
    const words = wordsIn(blocks);
    if (words > best.words) best = { section, blocks, words };
  }
  return best;
}

// An <li> whose whole content is a single anchor. Whitespace and one wrapping
// inline tag (a <span> inside the link, say) still count as "just a link".
const NAV_LI = /^\s*(?:<[a-z]+\b[^>]*>\s*)?<a\b[^>]*>[\s\S]*?<\/a\s*>\s*(?:<\/[a-z]+>\s*)?$/i;

// Structured blocks, in document order. Everything is text.
function extractBlocks(section) {
  const blocks = [];
  const push = (type, text, extra) => {
    const t = String(text || '').trim();
    if (!t) return;
    if (blocks.length >= BLOCKS_MAX) return;
    blocks.push({ type, text: t.slice(0, BLOCK_MAX), ...(extra || {}) });
  };
  // One pass over the block-level tags we care about, in source order.
  const re = /<(h[1-6]|p|li|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi;
  let m;
  let iters = 0;
  while ((m = re.exec(section))) {
    // Bound the SCAN, not the content.
    //
    // This used to be a cumulative byte budget that `break`s when spent, so one
    // pathological match ended extraction for the whole document. Measured on
    // nodejs.org/api/fs.html: an unclosed tag made a single match ~400KB long,
    // and the page rendered as its <h1> and nothing else — 1 block out of a
    // thousand paragraphs. An iteration cap terminates a hostile page just as
    // surely without letting one bad match speak for the rest, and an
    // over-long block is truncated by `push` rather than dropped, because
    // silently losing a paragraph is the worse failure.
    if (++iters > MAX_ITERS) break;
    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (tag === 'pre') {
      // Keep newlines in code; they are the content.
      const code = decodeEntities(inner.replace(/<[^>]*>/g, '')).replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
      push('code', code);
      continue;
    }
    const text = clean(inner);
    if (!text) continue;
    if (tag[0] === 'h') push('h', text, { level: Math.min(6, Math.max(1, Number(tag[1]) || 2)) });
    // A list item that is nothing but a link is navigation, not content. This is
    // what makes a docs sidebar ("About this documentation", "Usage and example",
    // …) show up as the first 200 "paragraphs" of the article.
    else if (tag === 'li') { if (!NAV_LI.test(inner)) push('li', text); }
    else if (tag === 'blockquote') push('quote', text);
    else push('p', text);
  }
  return blocks;
}

// Links worth offering as onward navigation. Same-page anchors, javascript: and
// mailto: are not navigation.
function extractLinks(section, baseUrl) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(section)) && out.length < 200) {
    const href = decodeEntities(m[1]).trim();
    const text = clean(m[2]);
    if (!text || text.length > 200) continue;
    const abs = absolutize(href, baseUrl);
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push({ url: abs, text });
  }
  return out;
}

// Only ever produce http(s). `javascript:`, `data:`, `blob:`, `file:` and
// friends are how a "link" becomes an execution vector, so they resolve to
// nothing rather than being passed through for the client to judge.
function absolutize(href, baseUrl) {
  const h = String(href || '').trim();
  if (!h || h.startsWith('#')) return '';
  try {
    const u = new URL(h, baseUrl || undefined);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
  } catch { return ''; }
}

// html -> { title, host, url, blocks, links, words }
function readerDocument(html, url) {
  const raw = String(html || '');
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* caller may pass no url */ }
  const title = pickTitle(raw);
  const stripped = raw.replace(COMMENTS, ' ').replace(DROP, ' ').replace(DROP_TAGS, ' ');
  const { section, blocks, words } = bestSection(stripped.replace(FURNITURE, ' '));
  return { title, host, url: url || '', blocks, links: extractLinks(section, url), words: Math.max(0, words) };
}

module.exports = { readerDocument, decodeEntities, absolutize, extractBlocks, pickTitle, BLOCK_MAX, BLOCKS_MAX };
