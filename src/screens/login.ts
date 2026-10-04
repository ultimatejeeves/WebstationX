/**
 * Sign-in: enter the invite code the owner handed out. Shown once per browser; the session
 * cookie keeps friends signed in until their code is revoked.
 */
import { api } from '../core/api';
import { app, type Screen } from '../core/app';
import { h } from '../core/dom';
import { FocusRing } from '../core/focus';
import { sfx } from '../core/sfx';
import type { NavEvent } from '../core/types';
import { button, hintBar } from '../ui/components';

const MAX = 12;
const ROWS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ', '23456789'];

export class LoginScreen implements Screen {
  name = 'login';
  el: HTMLElement;
  private ring: FocusRing;
  private value = '';
  private display: HTMLElement;
  private inputEl: HTMLInputElement;
  private status: HTMLElement;
  private busy = false;
  private onDone: (name: string) => void;

  constructor(onDone: (name: string) => void) {
    this.onDone = onDone;
    this.display = h('div.code-display');
    this.status = h('div.login-status');
    this.inputEl = h('input.osk-input.login-input', {
      type: 'text',
      maxlength: MAX + 2,
      autocomplete: 'off',
      spellcheck: 'false',
      autocapitalize: 'characters',
      'data-focus': true,
      'data-focus-default': true,
      tabindex: 0,
      'aria-label': 'Invite code',
      onInput: (e: Event) => {
        this.value = normalize((e.target as HTMLInputElement).value);
        this.render();
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.stopPropagation();
          void this.submit();
        }
      },
    }) as HTMLInputElement;
    const grid = h(
      'div.osk-grid.login-grid',
      ROWS.map((row) =>
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
                  if (this.value.length >= MAX) return sfx.error();
                  this.value += ch;
                  sfx.move();
                  this.render();
                },
              },
              ch,
            ),
          ),
        ),
      ),
    );
    this.el = h(
      'div.login',
      h('div.bg-main'),
      h(
        'div.login-panel',
        h('div.login-emblem', h('img', { src: '/assets/emblem.png', alt: '' })),
        h('div.lobby-kicker', 'PRIVATE SYSTEM'),
        h('h1.title-glow', 'Enter your invite code'),
        h('p.subtitle', 'Ask the owner for a code. You only need to do this once on each device.'),
        this.display,
        this.inputEl,
        grid,
        this.status,
        h(
          'div.login-actions',
          button({ label: 'Delete', icon: 'chevronL', onClick: () => this.backspace() }),
          button({ label: 'Sign in', icon: 'check', variant: 'primary', size: 'lg', onClick: () => void this.submit() }),
        ),
      ),
      hintBar([
        { glyph: 'cross', label: 'Pick' },
        { glyph: 'circle', label: 'Delete' },
        { glyph: 'triangle', label: 'Sign in' },
      ]),
    );
    this.ring = new FocusRing(this.el);
    this.render();
  }

  mount() {
    this.ring.focusDefault();
    setTimeout(() => this.inputEl.focus(), 50);
  }
  unmount() {}

  private render() {
    const cells: HTMLElement[] = [];
    for (let i = 0; i < 8; i++) cells.push(h(`span.code-cell${this.value[i] ? '.on' : ''}${i === this.value.length ? '.cursor' : ''}`, this.value[i] ?? ''));
    for (let i = 8; i < this.value.length; i++) cells.push(h('span.code-cell.on', this.value[i]));
    this.display.replaceChildren(...cells);
    const pretty = this.value.replace(/(.{4})(?=.)/g, '$1-');
    if (this.inputEl.value !== pretty) this.inputEl.value = pretty;
  }

  private backspace() {
    this.value = this.value.slice(0, -1);
    this.render();
  }

  private async submit() {
    if (this.busy) return;
    if (this.value.length < 4) {
      sfx.error();
      this.status.textContent = 'Type the whole code first';
      return;
    }
    this.busy = true;
    this.status.textContent = 'Checking…';
    this.el.classList.add('busy');
    try {
      const { name } = await api.login(this.value);
      sfx.saved();
      this.status.textContent = `Welcome, ${name}`;
      setTimeout(() => this.onDone(name), 450);
    } catch (e) {
      sfx.error();
      this.status.textContent = e instanceof Error ? e.message : 'Sign in failed';
      this.el.classList.remove('busy');
      this.busy = false;
      this.el.classList.add('shake');
      setTimeout(() => this.el.classList.remove('shake'), 500);
    }
  }

  onNav(e: NavEvent) {
    switch (e.action) {
      case 'up':
      case 'down':
      case 'left':
      case 'right':
        this.ring.move(e.action);
        return true;
      case 'confirm':
        if (this.ring.current === this.inputEl || (e.device === 'kb' && e.raw === 'Enter')) void this.submit();
        else this.ring.activate();
        return true;
      case 'back':
        if (e.device === 'kb' && e.raw === 'Backspace' && document.activeElement === this.inputEl) return false;
        this.backspace();
        return true;
      case 'menu':
      case 'start':
        void this.submit();
        return true;
      case 'any':
        // Typing anywhere on the screen enters the code, even when an on-screen key is focused.
        if (e.device === 'kb' && e.raw && /^[a-z0-9]$/i.test(e.raw) && document.activeElement !== this.inputEl) {
          if (this.value.length < MAX) {
            this.value += e.raw.toUpperCase();
            this.render();
          }
        }
        return true;
    }
    return false;
  }
}

function normalize(s: string) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, MAX);
}
