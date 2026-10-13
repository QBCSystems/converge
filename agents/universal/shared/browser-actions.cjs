// Page interaction + condition checking over injected CDP. Shared by the agent's
// own `browser` tool (universal-agent.cjs) and browser-mcp, the same way
// shared/cdp.cjs is shared with the browser validator — one implementation, so
// the two surfaces cannot drift into behaving differently.
//
// Real input events (Input.dispatchMouseEvent / insertText / dispatchKeyEvent)
// rather than el.click() / el.value= shims, so framework handlers fire the way
// they do for a person.
'use strict';

const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', vk: 9, text: '\t' },
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
};

function createActions({ cdp, browserEval }) {
  const sel = (s) => JSON.stringify(String(s));

  // Every selector-based tool funnels through here: scrolls the match into view
  // and returns its centre point, so a click lands where a person would click.
  async function elementBox(selector, nth = 0) {
    const raw = await browserEval(`(() => {
      const els = Array.from(document.querySelectorAll(${sel(selector)}));
      const el = els[${Number(nth) || 0}];
      if (!el) return JSON.stringify({ found: false, count: els.length });
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return JSON.stringify({
        found: true, count: els.length, tag: el.tagName.toLowerCase(),
        x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height,
        visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
          && cs.display !== 'none' && Number(cs.opacity) !== 0,
        disabled: !!el.disabled
      });
    })()`);
    try { return JSON.parse(raw); } catch { return { found: false, count: 0 }; }
  }

  async function requireElement(selector, nth = 0, what = 'element') {
    const box = await elementBox(selector, nth);
    if (!box.found) throw new Error(`${what}: no element matches ${selector}${nth ? ` at index ${nth}` : ''} (${box.count} match${box.count === 1 ? '' : 'es'})`);
    if (!box.visible) throw new Error(`${what}: ${selector} exists but is not visible (${box.w}x${box.h})`);
    if (box.disabled) throw new Error(`${what}: ${selector} is disabled`);
    return box;
  }

  async function clickAt(x, y) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async function click(selector, nth = 0) {
    const box = await requireElement(selector, nth, 'click');
    await clickAt(box.x, box.y);
    return { clicked: selector, nth, tag: box.tag, at: { x: Math.round(box.x), y: Math.round(box.y) } };
  }

  async function type(selector, text, { nth = 0, append = false } = {}) {
    const box = await requireElement(selector, nth, 'type');
    // click first so focus travels the real path, then select-all so insertText
    // replaces instead of appending
    await clickAt(box.x, box.y);
    const focused = await browserEval(`(() => {
      const el = document.querySelectorAll(${sel(selector)})[${nth}];
      if (!el) return false;
      el.focus();
      ${append ? '' : `if (el.select) el.select();
      else if (el.isContentEditable) document.getSelection().selectAllChildren(el);`}
      return document.activeElement === el;
    })()`);
    if (!focused) throw new Error(`type: ${selector} did not take focus (disabled fieldset, or covered by an overlay?)`);
    await cdp('Input.insertText', { text: String(text) });
    const value = await browserEval(`(() => {
      const el = document.querySelectorAll(${sel(selector)})[${nth}];
      return el ? String(el.value !== undefined ? el.value : el.innerText || '') : '';
    })()`);
    return { typed: String(text), into: selector, value };
  }

  async function press(name, { times = 1, selector = null, nth = 0 } = {}) {
    const k = KEYS[name];
    if (!k) throw new Error(`unsupported key "${name}" — supported: ${Object.keys(KEYS).join(', ')}`);
    if (selector) {
      const box = await requireElement(selector, nth, 'press');
      await clickAt(box.x, box.y);
    }
    const n = Math.max(1, Number(times) || 1);
    for (let i = 0; i < n; i++) {
      await cdp('Input.dispatchKeyEvent', {
        type: k.text ? 'keyDown' : 'rawKeyDown', key: k.key, code: k.code,
        windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(k.text ? { text: k.text } : {}),
      });
      await cdp('Input.dispatchKeyEvent', {
        type: 'keyUp', key: k.key, code: k.code,
        windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk,
      });
    }
    return { pressed: name, times: n };
  }

  // One predicate evaluator shared by wait_for and assert, so "wait until X"
  // and "prove X" can never disagree about what X means.
  async function checkCondition({ selector, nth = 0, text, gone, urlContains, titleContains, count, minCount }) {
    const state = JSON.parse(await browserEval(`(() => {
      const out = { url: location.href, title: document.title };
      out.bodyText = (document.body ? document.body.innerText || '' : '');
      ${selector ? `
      const els = Array.from(document.querySelectorAll(${sel(selector)}));
      out.count = els.length;
      const el = els[${Number(nth) || 0}];
      if (el) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        out.visible = r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'
          && cs.display !== 'none' && Number(cs.opacity) !== 0;
        out.elText = String(el.innerText || el.value || '');
      } else { out.visible = false; out.elText = ''; }` : 'out.count = null;'}
      return JSON.stringify(out);
    })()`));

    const fails = [];
    if (selector && !gone && !state.visible) fails.push(`${selector} is not visible (${state.count} match${state.count === 1 ? '' : 'es'})`);
    if (selector && gone && state.visible) fails.push(`${selector} is still visible`);
    if (text != null) {
      const has = String(selector ? state.elText : state.bodyText).includes(text);
      if (!gone && !has) fails.push(`text ${JSON.stringify(text)} not found in ${selector || 'page'}`);
      if (gone && has) fails.push(`text ${JSON.stringify(text)} is still present`);
    }
    if (urlContains != null && !String(state.url).includes(urlContains)) fails.push(`url ${state.url} does not contain ${JSON.stringify(urlContains)}`);
    if (titleContains != null && !String(state.title).includes(titleContains)) fails.push(`title ${JSON.stringify(state.title)} does not contain ${JSON.stringify(titleContains)}`);
    if (count != null && state.count !== Number(count)) fails.push(`${selector} matched ${state.count}, expected exactly ${count}`);
    if (minCount != null && !(state.count >= Number(minCount))) fails.push(`${selector} matched ${state.count}, expected at least ${minCount}`);
    return { ok: fails.length === 0, fails, state };
  }

  async function waitFor(args) {
    const timeoutMs = Math.max(100, Number(args.timeoutMs) || 10000);
    if (args.selector == null && args.text == null && args.urlContains == null) {
      throw new Error('wait_for needs at least one of: selector, text, urlContains');
    }
    const started = Date.now();
    for (;;) {
      const last = await checkCondition(args);
      if (last.ok) return { waited: true, ms: Date.now() - started };
      if (Date.now() - started > timeoutMs) {
        throw new Error(`wait_for timed out after ${timeoutMs}ms — ${last.fails.join('; ')}`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  // Throws on failure: a passing assert must be evidence, not a status field an
  // agent can skim past.
  async function assertPage(args, consoleErrors = []) {
    const keys = ['selector', 'text', 'urlContains', 'titleContains', 'count', 'minCount', 'noConsoleErrors'];
    // `false` is not a criterion — a caller that coerces absent flags with !!
    // would otherwise turn "you asked for nothing" into a vacuous pass
    if (!keys.some((k) => args[k] != null && args[k] !== false)) {
      throw new Error(`assert needs at least one of: ${keys.join(', ')}`);
    }
    const res = await checkCondition(args);
    const fails = [...res.fails];
    if (args.noConsoleErrors && consoleErrors.length) {
      fails.push(`page logged ${consoleErrors.length} error(s): ${consoleErrors.slice(0, 3).map((e) => String(e.text).slice(0, 160)).join(' | ')}`);
    }
    if (fails.length) throw new Error(`assertion failed — ${fails.join('; ')}`);
    return { asserted: true, url: res.state.url, title: res.state.title, ...(args.selector ? { matches: res.state.count } : {}) };
  }

  async function readText({ selector, nth = 0, max = 4000 }) {
    if (selector) {
      const box = await elementBox(selector, nth);
      if (!box.found) throw new Error(`read_text: no element matches ${selector}`);
    }
    const text = await browserEval(`(() => {
      ${selector
    ? `const el = document.querySelectorAll(${sel(selector)})[${nth}];
         return el ? String(el.innerText || el.value || '') : '';`
    : 'return document.body ? document.body.innerText || \'\' : \'\';'}
    })()`);
    const cap = Math.max(1, Number(max) || 4000);
    return { text: String(text || '').slice(0, cap), truncated: String(text || '').length > cap };
  }

  return { elementBox, requireElement, clickAt, click, type, press, checkCondition, waitFor, assertPage, readText };
}

module.exports = { createActions, KEYS };
