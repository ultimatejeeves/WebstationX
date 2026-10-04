/**
 * Boot screen: a short, skippable power-on sequence with our own chime.
 */
import type { Screen } from '../core/app';
import { h } from '../core/dom';
import { sfx } from '../core/sfx';
import type { NavEvent } from '../core/types';

export class BootScreen implements Screen {
  name = 'boot';
  readonly ambient = 'boot' as const;
  el: HTMLElement;
  private done: () => void;
  private finished = false;
  private timer = 0;

  constructor(done: () => void) {
    this.done = done;
    this.el = h(
      'div.boot',
      h('div.boot-bg'),
      h(
        'div.boot-center',
        h('div.boot-emblem', h('img', { src: '/assets/emblem.png', alt: '' })),
        h('div.boot-wordmark', h('span.w1', 'WEB'), h('span.w2', 'STATION'), h('span.w3', 'X')),
        h('div.boot-sub', 'PERSONAL ENTERTAINMENT SYSTEM'),
      ),
      h('div.boot-foot', h('span.boot-tip', 'Press any button')),
    );
  }

  mount() {
    // Stagger the reveal, play the chime and move on.
    requestAnimationFrame(() => {
      this.el.classList.add('boot-go');
      sfx.boot();
    });
    this.timer = window.setTimeout(() => this.finish(), 5400);
  }

  unmount() {
    clearTimeout(this.timer);
  }

  onNav(e: NavEvent) {
    if (e.action === 'any' || e.action === 'confirm' || e.action === 'start') this.finish();
    return true;
  }

  private finish() {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    this.el.classList.add('boot-done');
    setTimeout(() => this.done(), 350);
  }
}
