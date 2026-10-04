/** Minimal DOM building helper. `h('div.a.b#id', {attrs}, ...children)` */
type Child = Node | string | number | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}${string}` | string,
  attrs?: Record<string, unknown> | Child,
  ...children: Child[]
): HTMLElement {
  const m = /^([a-z0-9-]*)((?:[.#][\w-]+)*)$/i.exec(spec);
  const tag = (m?.[1] || 'div') as string;
  const el = document.createElement(tag);
  if (m?.[2]) {
    for (const tok of m[2].match(/[.#][\w-]+/g) ?? []) {
      if (tok[0] === '.') el.classList.add(tok.slice(1));
      else el.id = tok.slice(1);
    }
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
    for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'class') el.className = String(v);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v);
      else if (k === 'html') el.innerHTML = String(v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  } else if (attrs !== undefined) {
    children.unshift(attrs as Child);
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el: Element) {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function fmtWhen(iso: string) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} d ago`;
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** SVG icon sprites drawn in code so they stay crisp at any size. */
export function icon(name: string, cls = ''): HTMLElement {
  const paths: Record<string, string> = {
    cross: '<path d="M7 7l10 10M17 7L7 17" stroke-linecap="round"/>',
    circle: '<circle cx="12" cy="12" r="6.5"/>',
    square: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
    triangle: '<path d="M12 5.5l7 12H5z" stroke-linejoin="round"/>',
    dpad: '<path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z" stroke-linejoin="round"/>',
    pad: '<path d="M6.5 8h11a4.5 4.5 0 0 1 4.4 3.6l1 5.1A2.6 2.6 0 0 1 20.4 20c-1 0-1.9-.5-2.4-1.3L16.6 16H7.4L6 18.7A2.7 2.7 0 0 1 3.6 20 2.6 2.6 0 0 1 1.1 16.7l1-5.1A4.5 4.5 0 0 1 6.5 8z" stroke-linejoin="round"/><path d="M7 12h3M8.5 10.5v3" stroke-linecap="round"/><circle cx="16" cy="11" r=".9" fill="currentColor"/><circle cx="17.8" cy="12.8" r=".9" fill="currentColor"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6 10h1M9 10h1M12 10h1M15 10h1M18 10h1M6 13h1M9 13h1M12 13h1M15 13h1M18 13h1M8 16h8" stroke-linecap="round"/>',
    memcard: '<path d="M5 3h11l3 3v15H5z" stroke-linejoin="round"/><path d="M8 3v5h6V3M8 14h8M8 17h5" stroke-linecap="round"/>',
    disc: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.6"/><path d="M12 3a9 9 0 0 1 9 9" stroke-linecap="round" opacity=".5"/>',
    play: '<path d="M8 5.5v13l10-6.5z" stroke-linejoin="round"/>',
    pause: '<path d="M8 5v14M16 5v14" stroke-linecap="round"/>',
    save: '<path d="M5 4h11l3 3v13H5z" stroke-linejoin="round"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
    load: '<path d="M12 4v11M8 11l4 4 4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 20h14" stroke-linecap="round"/>',
    home: '<path d="M4 11l8-7 8 7v9H4z" stroke-linejoin="round"/><path d="M10 20v-6h4v6"/>',
    gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" stroke-linecap="round"/>',
    power: '<path d="M12 3v9" stroke-linecap="round"/><path d="M7.5 6.5a7 7 0 1 0 9 0" stroke-linecap="round"/>',
    users: '<circle cx="9" cy="8" r="3.5"/><circle cx="17" cy="9" r="2.6"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M15.5 20a5 5 0 0 1 6-4.9" stroke-linecap="round"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0" stroke-linecap="round"/>',
    chevronL: '<path d="M15 5l-7 7 7 7" stroke-linecap="round" stroke-linejoin="round"/>',
    chevronR: '<path d="M9 5l7 7-7 7" stroke-linecap="round" stroke-linejoin="round"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-linecap="round" stroke-linejoin="round"/>',
    plus: '<path d="M12 5v14M5 12h14" stroke-linecap="round"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" stroke-linecap="round" stroke-linejoin="round"/>',
    restart: '<path d="M4 12a8 8 0 1 0 2.3-5.7" stroke-linecap="round"/><path d="M4 4v5h5" stroke-linecap="round" stroke-linejoin="round"/>',
    star: '<path d="M12 3.5l2.6 5.6 6 .7-4.5 4.1 1.2 6-5.3-3-5.3 3 1.2-6L3.4 9.8l6-.7z" stroke-linejoin="round"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5" stroke-linecap="round"/>',
    fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke-linecap="round" stroke-linejoin="round"/>',
    volume: '<path d="M4 9v6h3l5 4V5L7 9z" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11" stroke-linecap="round"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    zap: '<path d="M13 2L4 14h7l-1 8 9-12h-7z" stroke-linejoin="round"/>',
    warn: '<path d="M12 3.5l9.5 16.5h-19z" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke-linecap="round"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2" stroke-linecap="round" stroke-linejoin="round"/>',
    sort: '<path d="M7 5v14M4 16l3 3 3-3M13 7h8M13 12h6M13 17h4" stroke-linecap="round" stroke-linejoin="round"/>',
  };
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${paths[name] ?? ''}</svg>`;
  return span;
}
