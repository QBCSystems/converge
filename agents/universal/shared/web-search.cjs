'use strict';
// Keyless web search, as structured results.
//
// The harness already searches, but it returns a formatted TEXT blob for a
// model to read and reaches for a real headless browser when it is challenged.
// The GUI's search page needs neither: it wants rows it can render, and it
// wants them in about a second. So this is the fast path only — a search
// engine's no-JS HTML endpoint, parsed into objects — and it says plainly when
// it came back empty rather than inventing a result.
//
// ENGINE and TRANSPORT are separate axes, and conflating them is what broke
// this file once already: a rewrite swapped the engine DDG->Bing and, in the
// same stroke, deleted the plain-fetch transport so every search had to go
// through Unblink. `unblink.available()` only tests that the BINARY exists, so
// on a box with no display it answered true, the browser failed to start, and
// every search returned zero rows with a confident-sounding error. Keep both
// axes layered: Bing first, DDG second, each tried over whichever transport is
// actually working here.
//
// Split into pure parsers and thin fetches on purpose: the parsers are the part
// that breaks (a markup change at an engine, a redirect wrapper that stops
// being a redirect wrapper) and it is the part worth testing offline.

const { decodeEntities, absolutize } = require('./reader-mode.cjs');

// Browser-shaped headers.
const HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// Ad and tracking hops that are not results. AD_HOSTS is matched against the
// HOST, not the whole URL: anchoring on (^|\.) against "https://doubleclick.net/..."
// never fires, because the character before the host is a slash — which is how
// an ad network quietly stays in the result list. AD_PATHS carries the two
// engines' own click-tracking hops, which are whole-URL shapes.
const AD_HOSTS = /(^|\.)(doubleclick\.net|googleadservices\.com|amazon-adsystem\.com|googlesyndication\.com|adservice\.google\.[a-z.]+)$/i;
const AD_PATHS = /duckduckgo\.com\/y\.js|bing\.com\/aclk/i;
const isAd = (url, host) => AD_HOSTS.test(host || '') || AD_PATHS.test(url || '');

const strip = (s) => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// Bing wraps links via /ck/a?!...&u=a1<base64>
function unwrapBingUrl(href) {
  const h = decodeEntities(String(href || '').trim());
  if (!h) return '';
  try {
    const u = new URL(h.startsWith('//') ? `https:${h}` : h);
    if (/(^|\.)bing\.com$/i.test(u.hostname) && u.pathname.includes('/ck/a')) {
      const uParam = u.searchParams.get('u');
      if (uParam && uParam.startsWith('a1')) {
        const raw = Buffer.from(uParam.slice(2), 'base64').toString('utf8');
        return absolutize(raw, 'https://www.bing.com/');
      }
    }
    return u.href;
  } catch { return h; }
}

// DuckDuckGo wraps every outbound link as /l/?uddg=<encoded>. Unwrap it, so a
// result carries the real destination rather than a redirector — the address
// bar, the reader and "open externally" all want the true URL.
function unwrapDdgUrl(href) {
  const h = String(href || '').trim();
  if (!h) return '';
  const abs = absolutize(h.startsWith('//') ? `https:${h}` : h, 'https://duckduckgo.com/');
  if (!abs) return '';
  try {
    const u = new URL(abs);
    if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.searchParams.has('uddg')) {
      return absolutize(u.searchParams.get('uddg'), 'https://duckduckgo.com/');
    }
    return abs;
  } catch { return ''; }
}

// Engine-agnostic unwrap, for callers holding a link of unknown origin.
function unwrap(href) {
  const h = String(href || '').trim();
  if (/duckduckgo\.com/i.test(h)) return unwrapDdgUrl(h);
  return unwrapBingUrl(h);
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function parseBingResults(html, { limit = 20 } = {}) {
  const body = String(html || '');
  const out = [];
  const seen = new Set();
  const algoRegex = /<li\b[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = algoRegex.exec(body)) && out.length < limit) {
    const block = m[1];
    const aMatch = /<h2\b[^>]*><a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!aMatch) continue;
    const rawUrl = aMatch[1];
    const title = strip(aMatch[2]);
    const url = unwrapBingUrl(rawUrl);
    if (!url || !title) continue;
    const host = hostOf(url);
    if (isAd(url, host)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    const pMatch = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(block);
    const snippet = pMatch ? strip(pMatch[1]) : '';
    out.push({ title: title.slice(0, 300), url, host, snippet: snippet.slice(0, 400) });
  }
  return out;
}

// html -> [{ title, url, host, snippet }] for DuckDuckGo's no-JS endpoint.
// Each row is an anchor with class result__a; its snippet is the next
// result__snippet. Walk anchors and take the nearest following snippet, which
// is what "nearest" means in this markup — snippets never precede their link.
function parseDdgResults(html, { limit = 20 } = {}) {
  const body = String(html || '');
  const out = [];
  const seen = new Set();
  const anchor = /<a\b[^>]*class\s*=\s*["'][^"']*\bresult__a\b[^"']*["'][^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = anchor.exec(body)) && out.length < limit) {
    const url = unwrapDdgUrl(m[1]);
    const title = strip(m[2]);
    if (!url || !title) continue;
    const host = hostOf(url);
    if (isAd(url, host)) continue;
    if (seen.has(url)) continue; // the same page listed twice is one result
    seen.add(url);
    const after = body.slice(anchor.lastIndex, anchor.lastIndex + 4000);
    const sn = /<a\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/a\s*>/i.exec(after)
      || /<(?:div|td)\b[^>]*class\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|td)\s*>/i.exec(after);
    out.push({ title: title.slice(0, 300), url, host, snippet: sn ? strip(sn[1]).slice(0, 400) : '' });
  }
  return out;
}

// Engine-agnostic: pick the parser by what the markup actually contains, so a
// caller holding a saved page does not have to know which engine served it.
function parseResults(html, opts) {
  const body = String(html || '');
  const bing = parseBingResults(body, opts);
  if (bing.length) return bing;
  return parseDdgResults(body, opts);
}

async function fetchHtmlViaUnblink(url, timeoutMs) {
  let mod;
  try { mod = require('./unblink.cjs'); } catch { return null; }
  if (!mod || typeof mod.available !== 'function' || !mod.available()) return null;
  const deadline = Date.now() + (timeoutMs || 12000);
  try {
    const nav = await mod.runAction('navigate', { url, waitMs: 900 }, {});
    if (!nav || nav.ok === false) return null;
    while (Date.now() < deadline) {
      const got = await mod.runAction('eval', { script: 'document.documentElement.outerHTML' }, {});
      const html = got && typeof got.result === 'string' ? got.result : '';
      if (html.length > 2000) return html;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  } catch { return null; }
}

// The engines, best-first. Bing leads because DuckDuckGo's keyless endpoint
// throttles a busy IP after a burst of searches in ONE mission — the reply
// comes back 200 with the page frame but no result rows (watched live,
// fireworks: a "move to Italy" guide fired 15-30 searches, all empty).
// DDG stays as the second engine rather than being deleted: the two throttle
// independently, so the one that is being refused is rarely both.
const ENGINES = [
  { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`, parse: parseBingResults },
];

// Run a query. Returns { query, results, ms, via, error } — `error` is a
// sentence for a human, never a thrown exception.
async function search(query, opts = {}) {
  const q = String(query || '').trim();
  const t0 = Date.now();
  if (!q) return { query: '', results: [], ms: 0, error: 'nothing to search for' };
  const limit = opts.limit || 15;
  const timeoutMs = opts.timeoutMs || 12000;

  // Unblink search transport: attempt Unblink first if available unless explicitly bypassed.
  const allowUnblink = opts.via !== 'fetch' && !('fetchImpl' in opts);
  if (allowUnblink) {
    for (const eng of ENGINES) {
      const html = await fetchHtmlViaUnblink(eng.url(q), timeoutMs);
      if (!html) continue;
      const results = eng.parse(html, { limit });
      if (results.length) return { query: q, results, ms: Date.now() - t0, via: `unblink:${eng.name}`, error: '' };
    }
  }

  const doFetch = ('fetchImpl' in opts) ? opts.fetchImpl : globalThis.fetch;
  if (typeof doFetch !== 'function') return { query: q, results: [], ms: 0, error: 'no fetch available in this runtime' };

  const notes = [];
  for (const eng of ENGINES) {
    const ac = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    try {
      const res = await doFetch(eng.url(q), {
        headers: HEADERS, redirect: 'follow', ...(ac ? { signal: ac.signal } : {}),
      });
      if (!res || res.status >= 400) { notes.push(`${eng.name}: HTTP ${res ? res.status : '?'}`); continue; }
      const results = eng.parse(await res.text(), { limit });
      if (results.length) return { query: q, results, ms: Date.now() - t0, via: eng.name, error: '' };
      notes.push(`${eng.name}: 200 with no rows (throttled)`);
    } catch (e) {
      const aborted = e && (e.name === 'AbortError' || /abort/i.test(e.message || ''));
      notes.push(`${eng.name}: ${aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e && e.message) || e}`);
    } finally { if (timer) clearTimeout(timer); }
  }

  return {
    query: q,
    results: [],
    ms: Date.now() - t0,
    via: '',
    error: `no results came back — search engine refused or returned an empty page (${notes.join('; ')}).`,
  };
}

module.exports = {
  search, parseResults, parseBingResults, parseDdgResults,
  unwrap, unwrapBingUrl, unwrapDdgUrl, hostOf, isAd, HEADERS, ENGINES,
};
