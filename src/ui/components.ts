/**
 * Reusable UI pieces: buttons, dialogs, the on-screen keyboard, and the top bar.
 * Everything here is focusable through `data-focus` so controllers can drive it.
 */
import { app, type Modal } from '../core/app';
import { h, icon } from '../core/dom';
import { FocusRing } from '../core/focus';
import { input } from '../core/input';
import { sfx } from '../core/sfx';
import type { NavEvent } from '../core/types';

export type ButtonOpts = {
  label: string;
  icon?: string;
  hint?: string;
  variant?: 'primary' | 'ghost' | 'danger' | 'glass';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  focusDefault?: boolean;
  onClick?: (ev: Event) => void;
};

export function button(o: ButtonOpts): HTMLButtonElement {
  const b = h(
    `button.btn.btn-${o.variant ?? 'glass'}.btn-${o.size ?? 'md'}`,
    {
      type: 'button',
      'data-focus': true,
      'data-focus-default': o.focusDefault || undefined,
      disabled: o.disabled || undefined,
      tabindex: -1,
      onClick: (ev: Event) => {
        if (b.disabled) return;
        sfx.confirm();
        o.onClick?.(ev);
      },
    },
    o.icon ? icon(o.icon) : null,
    h('span.btn-label', o.label),
    o.hint ? h('span.btn-hint', o.hint) : null,
  ) as HTMLButtonElement;
  return b;
}

/* ---------- Dialog ---------- */

export type DialogOpts = {
  title: string;
  body?: HTMLElement | string;
  actions: ButtonOpts[];
  /** Called on Back/Circle/Esc. Defaults to closing the dialog. */
  onCancel?: () => void;
  wide?: boolean;
  onNav?: (e: NavEvent, dlg: Dialog) => boolean | void;
  /** Runs once whenever the dialog goes away, however it was closed. */
  onClose?: () => void;
};

export class Dialog implements Modal {
  el: HTMLElement;
  ring: FocusRing;
  private opts: DialogOpts;
  private closed = false;

  constructor(opts: DialogOpts) {
    this.opts = opts;
    const panel = h(
      `div.dialog${opts.wide ? '.dialog-wide' : ''}`,
      h('div.dialog-title', opts.title),
      opts.body ? h('div.dialog-body', opts.body) : null,
      h(
        'div.dialog-actions',
        opts.actions.map((a) =>
          button({
            ...a,
            onClick: (ev) => {
              a.onClick?.(ev);
            },
          }),
        ),
      ),
    );
    this.el = h('div.modal-backdrop', { onClick: (e: Event) => e.target === this.el && this.cancel() }, panel);
    this.ring = new FocusRing(panel);
  }

  onNav(e: NavEvent) {
    return this.opts.onNav?.(e, this);
  }

  cancel() {
    if (this.opts.onCancel) this.opts.onCancel();
    else this.close();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    app.removeModal(this);
    this.opts.onClose?.();
  }

  open() {
    app.openModal(this);
    return this;
  }
}

export function confirmDialog(title: string, body: string, okLabel = 'Yes', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const dlg = new Dialog({
      title,
      body,
      actions: [
        {
          label: okLabel,
          variant: danger ? 'danger' : 'primary',
          icon: 'check',
          onClick: () => {
            dlg.close();
            resolve(true);
          },
        },
        {
          label: 'Cancel',
          focusDefault: true,
          onClick: () => {
            dlg.close();
            resolve(false);
          },
        },
      ],
      onCancel: () => {
        dlg.close();
        resolve(false);
      },
    });
    dlg.open();
  });
}

/* ---------- On-screen keyboard (for controller-only name entry) ---------- */

export function textEntryDialog(title: string, initial = '', maxLen = 16): Promise<string | null> {
  return new Promise((resolve) => {
    let value = initial;
    const display = h('div.osk-display', h('span.osk-value', value), h('span.osk-caret'));
    const inputEl = h('input.osk-input', {
      type: 'text',
      maxlength: maxLen,
      value,
      autocomplete: 'off',
      spellcheck: 'false',
      'data-focus': true,
      'data-focus-default': true,
      tabindex: 0,
      onInput: (e: Event) => {
        value = (e.target as HTMLInputElement).value.slice(0, maxLen);
        render();
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          done();
        }
      },
    }) as HTMLInputElement;
    const rows = ['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ0123', '456789-_. '];
    const grid = h(
      'div.osk-grid',
      rows.map((row) =>
        h(
          'div.osk-row',
          [...row].map((ch) =>
            h(
              'button.osk-key',
              {
                type: 'button',
                'data-focus': true,
                tabindex: -1,
                onClick: () => {
                  if (value.length >= maxLen) return sfx.error();
                  value += ch === ' ' ? ' ' : ch;
                  sfx.move();
                  render();
                },
              },
              ch === ' ' ? '␣' : ch,
            ),
          ),
        ),
      ),
    );
    const render = () => {
      display.querySelector('.osk-value')!.textContent = value;
      if (inputEl.value !== value) inputEl.value = value;
    };
    const done = () => {
      const v = value.trim();
      if (!v) return sfx.error();
      dlg.close();
      resolve(v);
    };
    const body = h(
      'div.osk',
      display,
      inputEl,
      grid,
      h('div.osk-hint', 'Type with your keyboard, or pick letters with the controller. ', h('b', 'Square'), ' deletes.'),
    );
    const dlg = new Dialog({
      title,
      body,
      wide: true,
      actions: [
        {
          label: 'Delete',
          icon: 'chevronL',
          onClick: () => {
            value = value.slice(0, -1);
            render();
          },
        },
        { label: 'Done', icon: 'check', variant: 'primary', onClick: done },
        {
          label: 'Cancel',
          onClick: () => {
            dlg.close();
            resolve(null);
          },
        },
      ],
      onCancel: () => {
        dlg.close();
        resolve(null);
      },
      onNav: (e) => {
        if (e.action === 'any' && e.device !== 'kb') return false;
        if (e.device !== 'kb' && e.raw === undefined && e.action === 'back') {
          // Circle: behave as backspace when there is text; otherwise cancel.
          if (value) {
            value = value.slice(0, -1);
            render();
            return true;
          }
        }
        return false;
      },
    });
    dlg.open();
    // Square (Y) deletes on gamepads: handled via the 'menu' action which we map from Y.
    const off = (e: NavEvent) => {
      if (e.action === 'menu' && e.device !== 'kb') {
        value = value.slice(0, -1);
        render();
      }
    };
    const stop = input.on(off);
    const origClose = dlg.close.bind(dlg);
    dlg.close = () => {
      stop();
      origClose();
    };
  });
}

/* ---------- Top bar ---------- */

export function topBar(opts: { left?: HTMLElement | null; right?: HTMLElement | null; title?: string }) {
  const clock = h('span.clock');
  const tick = () => {
    clock.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };
  tick();
  const iv = setInterval(tick, 10_000);
  const el = h(
    'header.topbar',
    h('div.topbar-left', opts.left ?? null),
    h('div.topbar-title', opts.title ?? ''),
    h('div.topbar-right', opts.right ?? null, clock),
  );
  (el as HTMLElement & { dispose: () => void }).dispose = () => clearInterval(iv);
  return el as HTMLElement & { dispose: () => void };
}

/** Bottom row of button glyph hints, e.g. ✕ Select  ○ Back */
export function hintBar(items: { glyph: string; label: string }[]) {
  return h(
    'footer.hintbar',
    items.map((i) => h('span.hint', h(`span.glyph.glyph-${i.glyph}`, icon(i.glyph)), i.label)),
  );
}

/**
 * A small corner button for touch screens, where there is no Esc key: opens the in-game menu the same
 * way the keyboard and controller shortcuts do. Hidden by CSS unless the pointer is coarse.
 */
export function touchMenuButton() {
  return h(
    'button.touch-menu',
    { type: 'button', 'aria-label': 'Menu', onClick: () => input.emit({ action: 'menu', device: 'kb', repeat: false }) },
    icon('pause'),
  );
}

export function badge(text: string, cls = '') {
  return h(`span.badge ${cls}`.trim(), text);
}
