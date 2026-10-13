// Lists that update in place: each row has a key and a signature (what it shows); a row whose signature has not
// changed keeps its element (scroll, focus, open state and all), a changed one is swapped, a new one comes in
// with the class "enter" (after the first fill), and rows no longer there go. Nothing else is touched.
//
//   reconcile(listEl, rows.map((r) => ({ key: r.id, sig: `${r.state}|${r.n}`, make: () => h('li', null, ...) })))

export function reconcile(container, items) {
  const first = !container.dataset.filled;
  const old = new Map();
  for (const n of [...container.children]) {
    if (n.dataset.key) old.set(n.dataset.key, n);
    else n.remove(); // a placeholder ("nothing yet") from before
  }
  const seen = new Set();
  let prev = null;
  for (const it of items) {
    if (seen.has(it.key)) continue;
    seen.add(it.key);
    let n = old.get(it.key);
    if (!n || n.dataset.sig !== it.sig) {
      const m = it.make();
      m.dataset.key = it.key;
      m.dataset.sig = it.sig;
      if (!n && !first) m.classList.add('enter');
      if (n) n.replaceWith(m);
      n = m;
    }
    const want = prev ? prev.nextSibling : container.firstChild;
    if (n !== want) container.insertBefore(n, want);
    prev = n;
  }
  for (const [k, n] of old) if (!seen.has(k)) n.remove();
  container.dataset.filled = '1';
}

/** For a list with no rows: one placeholder line (and forget it was filled, so its first rows do not animate). */
export function placeholder(container, node) {
  container.replaceChildren(node);
  delete container.dataset.filled;
}
