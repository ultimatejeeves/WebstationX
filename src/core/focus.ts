/**
 * Spatial focus navigation for `[data-focus]` elements inside a container.
 * Directional moves pick the geometrically nearest candidate in that direction, which
 * makes controller navigation feel right regardless of how the layout is built.
 */
import { sfx } from './sfx';

export class FocusRing {
  current: HTMLElement | null = null;
  /** Optional group constraint: only move within this element unless leaving it via `escape`. */
  private container: HTMLElement;
  onChange: ((el: HTMLElement | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    container.addEventListener('pointermove', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-focus]');
      if (t && t !== this.current && this.container.contains(t) && !t.matches('[disabled],[aria-disabled="true"]')) this.set(t, true);
    });
  }

  candidates(): HTMLElement[] {
    return [...this.container.querySelectorAll<HTMLElement>('[data-focus]')].filter(
      (el) => !el.matches('[disabled],[aria-disabled="true"],.hidden') && el.offsetParent !== null && isVisible(el),
    );
  }

  set(el: HTMLElement | null, silent = false) {
    if (this.current === el) return;
    this.current?.classList.remove('focused');
    this.current = el;
    if (el) {
      el.classList.add('focused');
      if (typeof el.focus === 'function' && el.tabIndex >= 0) el.focus({ preventScroll: true });
      const scrollParent = el.closest<HTMLElement>('[data-scroll]');
      if (scrollParent) scrollIntoViewWithin(el, scrollParent);
      else el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      if (!silent) sfx.move();
    }
    this.onChange?.(el);
  }

  /** Focus the first candidate (or the one flagged data-focus-default). */
  focusDefault() {
    const list = this.candidates();
    const def = list.find((el) => el.hasAttribute('data-focus-default')) ?? list[0] ?? null;
    this.set(def, true);
  }

  /** Re-validate: if the current element vanished, focus the nearest fallback. */
  revalidate() {
    if (this.current && (!this.container.contains(this.current) || !this.candidates().includes(this.current))) {
      this.current.classList.remove('focused');
      this.current = null;
      this.focusDefault();
    }
  }

  move(dir: 'up' | 'down' | 'left' | 'right'): boolean {
    const list = this.candidates();
    if (list.length === 0) return false;
    if (!this.current || !list.includes(this.current)) {
      this.focusDefault();
      return true;
    }
    const cur = this.current.getBoundingClientRect();
    const cx = cur.left + cur.width / 2;
    const cy = cur.top + cur.height / 2;
    let best: HTMLElement | null = null;
    let bestScore = Infinity;
    for (const el of list) {
      if (el === this.current) continue;
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const dx = x - cx;
      const dy = y - cy;
      let primary: number;
      let secondary: number;
      switch (dir) {
        case 'up':
          primary = -dy;
          secondary = Math.abs(dx);
          break;
        case 'down':
          primary = dy;
          secondary = Math.abs(dx);
          break;
        case 'left':
          primary = -dx;
          secondary = Math.abs(dy);
          break;
        default:
          primary = dx;
          secondary = Math.abs(dy);
      }
      // Must be meaningfully in that direction (overlap tolerance for rows/columns).
      const overlap =
        dir === 'up' || dir === 'down' ? overlapAmount(cur.left, cur.right, r.left, r.right) : overlapAmount(cur.top, cur.bottom, r.top, r.bottom);
      if (primary <= 4) continue;
      const score = primary * primary + (overlap > 0 ? secondary * secondary * 0.3 : secondary * secondary * 2.5 + 40000);
      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) {
      this.set(best);
      return true;
    }
    return false;
  }

  activate() {
    if (!this.current) return;
    this.current.click();
  }
}

function overlapAmount(a1: number, a2: number, b1: number, b2: number) {
  return Math.min(a2, b2) - Math.max(a1, b1);
}

function isVisible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function scrollIntoViewWithin(el: HTMLElement, parent: HTMLElement) {
  const pr = parent.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const pad = 24;
  if (parent.dataset.scroll === 'x') {
    if (r.left < pr.left + pad) parent.scrollBy({ left: r.left - pr.left - pad, behavior: 'smooth' });
    else if (r.right > pr.right - pad) parent.scrollBy({ left: r.right - pr.right + pad, behavior: 'smooth' });
  } else {
    if (r.top < pr.top + pad) parent.scrollBy({ top: r.top - pr.top - pad, behavior: 'smooth' });
    else if (r.bottom > pr.bottom - pad) parent.scrollBy({ top: r.bottom - pr.bottom + pad, behavior: 'smooth' });
  }
}
