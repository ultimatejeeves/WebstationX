/**
 * Application shell: owns the root element, the active screen, screen transitions,
 * and a modal stack. Navigation events are routed to the top-most modal, else the screen.
 */
import { clear, h } from './dom';
import { FocusRing } from './focus';
import { input } from './input';
import { sfx } from './sfx';
import type { NavEvent } from './types';

export interface Screen {
  readonly el: HTMLElement;
  readonly name: string;
  mount(): void | Promise<void>;
  unmount(): void;
  /** Return true when the event was consumed. */
  onNav(e: NavEvent): boolean | void;
}

export interface Modal {
  readonly el: HTMLElement;
  readonly ring: FocusRing;
  onNav(e: NavEvent): boolean | void;
  close(): void;
}

class App {
  root!: HTMLElement;
  private stage!: HTMLElement;
  private modalLayer!: HTMLElement;
  private toastLayer!: HTMLElement;
  screen: Screen | null = null;
  private modals: Modal[] = [];
  private transitioning = false;

  init(root: HTMLElement) {
    this.root = root;
    this.stage = h('div.stage');
    this.modalLayer = h('div.modal-layer');
    this.toastLayer = h('div.toast-layer');
    root.append(this.stage, this.modalLayer, this.toastLayer);
    input.on((e) => this.dispatch(e));
    input.start();
    const unlock = () => sfx.unlock();
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  private dispatch(e: NavEvent) {
    const top = this.modals[this.modals.length - 1];
    if (top) {
      if (top.onNav(e)) return;
      if (['up', 'down', 'left', 'right'].includes(e.action) && !e.repeat) top.ring.move(e.action as never);
      else if (['up', 'down', 'left', 'right'].includes(e.action)) top.ring.move(e.action as never);
      else if (e.action === 'confirm') top.ring.activate();
      else if (e.action === 'back') {
        sfx.back();
        top.close();
      }
      return;
    }
    if (this.transitioning) return;
    this.screen?.onNav(e);
  }

  async go(next: Screen, opts: { transition?: 'fade' | 'none' } = {}) {
    if (this.transitioning) return;
    this.transitioning = true;
    input.suspended = false;
    const transition = opts.transition ?? 'fade';
    const prev = this.screen;
    this.closeAllModals();
    if (prev) {
      if (transition === 'fade') {
        prev.el.classList.add('screen-out');
        await new Promise((r) => setTimeout(r, 220));
      }
      prev.unmount();
      prev.el.remove();
    }
    this.screen = next;
    next.el.classList.add('screen', `screen-${next.name}`);
    if (transition === 'fade') next.el.classList.add('screen-in');
    this.stage.appendChild(next.el);
    document.body.dataset.screen = next.name;
    await next.mount();
    requestAnimationFrame(() => next.el.classList.remove('screen-in'));
    this.transitioning = false;
  }

  /* ---------- Modals ---------- */

  openModal(modal: Modal) {
    this.modals.push(modal);
    modal.el.classList.add('modal-in');
    this.modalLayer.appendChild(modal.el);
    this.modalLayer.classList.add('active');
    requestAnimationFrame(() => {
      modal.el.classList.remove('modal-in');
      modal.ring.focusDefault();
    });
    sfx.open();
  }

  removeModal(modal: Modal) {
    const i = this.modals.indexOf(modal);
    if (i < 0) return;
    this.modals.splice(i, 1);
    modal.el.classList.add('modal-out');
    setTimeout(() => modal.el.remove(), 180);
    if (this.modals.length === 0) this.modalLayer.classList.remove('active');
  }

  closeAllModals() {
    for (const m of [...this.modals]) m.close();
  }

  get hasModal() {
    return this.modals.length > 0;
  }

  /* ---------- Toasts ---------- */

  toast(text: string, kind: 'info' | 'ok' | 'warn' = 'info', ms = 2600) {
    const t = h(`div.toast.toast-${kind}`, text);
    this.toastLayer.appendChild(t);
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, ms);
  }

  clearStage() {
    clear(this.stage);
  }
}

export const app = new App();
