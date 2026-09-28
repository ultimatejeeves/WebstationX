/**
 * Preferences dialog. Every option is a horizontal chooser so it works with a d-pad.
 */
import { app } from '../core/app';
import { h, icon } from '../core/dom';
import { sfx } from '../core/sfx';
import { store } from '../core/store';
import type { Prefs } from '../core/types';
import { clearDiscCache } from '../emu/disc-cache';
import { keymapHints } from '../emu/keymap';
import { openKeybindDialog } from '../ui/keybind-dialog';
import { button, Dialog } from '../ui/components';

type Choice<K extends keyof Prefs> = { key: K; label: string; help: string; options: { value: Prefs[K]; label: string }[] };

const CHOICES: Choice<keyof Prefs>[] = [
  {
    key: 'filter',
    label: 'Picture',
    help: 'CRT adds scanlines and glow. Sharp keeps pixels crisp. Smooth blurs them.',
    options: [
      { value: 'crt', label: 'CRT' },
      { value: 'sharp', label: 'Sharp' },
      { value: 'smooth', label: 'Smooth' },
    ],
  },
  {
    key: 'aspect',
    label: 'Screen shape',
    help: '4:3 is how the game was meant to look.',
    options: [
      { value: '4:3', label: '4:3' },
      { value: 'fill', label: 'Fill screen' },
    ],
  },
  {
    key: 'enhanced',
    label: 'Enhanced resolution',
    help: 'Renders 3D at double resolution. Needs a reasonably quick machine.',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
  {
    key: 'autoFrameskip',
    label: 'Performance mode',
    help: 'Lets the emulator skip frames to keep sound smooth on slower machines.',
    options: [
      { value: false, label: 'Off' },
      { value: true, label: 'On' },
    ],
  },
  {
    key: 'consoleBoot',
    label: 'Console boot logo',
    help: 'Show the original console start-up before the game loads.',
    options: [
      { value: false, label: 'Skip' },
      { value: true, label: 'Show' },
    ],
  },
  {
    key: 'volume',
    label: 'Game volume',
    help: '',
    options: [0, 20, 40, 60, 80, 100].map((v) => ({ value: v, label: v === 0 ? 'Mute' : `${v}%` })),
  },
  {
    key: 'uiSounds',
    label: 'Menu sounds',
    help: '',
    options: [
      { value: true, label: 'On' },
      { value: false, label: 'Off' },
    ],
  },
];

export function openSettings(extra?: { inGame?: boolean }) {
  const rows = CHOICES.map((c) => row(c));
  const keyGrid = h('div.keyhelp-grid');
  const renderKeys = () => {
    keyGrid.replaceChildren(...keymapHints(store.prefs.keymap).map((k) => h('div.keyhelp-item', h('kbd', k.key), h('span', k.does))));
  };
  renderKeys();
  const keyHelp = h(
    'div.keyhelp',
    h(
      'div.keyhelp-head',
      h('div.keyhelp-title', icon('keyboard'), 'Keyboard & mouse'),
      button({
        label: 'Change bindings',
        icon: 'gear',
        size: 'sm',
        onClick: async () => {
          const { changed } = await openKeybindDialog();
          renderKeys();
          if (changed) app.toast(extra?.inGame ? 'Bindings saved. Use Controls > Apply now to use them in this game.' : 'Bindings saved', 'ok', 3200);
        },
      }),
    ),
    keyGrid,
  );
  const dlg = new Dialog({
    title: 'Settings',
    wide: true,
    body: h('div.settings', rows, keyHelp, extra?.inGame ? h('p.settings-note', 'Picture and sound changes apply immediately. Resolution and boot options apply next time a game starts.') : null),
    actions: [
      {
        label: 'Clear disc cache',
        icon: 'trash',
        onClick: async () => {
          await clearDiscCache();
          app.toast('Disc cache cleared', 'ok');
        },
      },
      { label: 'Done', icon: 'check', variant: 'primary', onClick: () => dlg.close() },
    ],
    onNav: (e) => {
      if (e.action === 'left' || e.action === 'right') {
        const cur = dlg.ring.current;
        const rowEl = cur?.closest<HTMLElement>('.setting-row');
        if (rowEl && cur?.classList.contains('setting-value')) {
          step(rowEl, e.action === 'right' ? 1 : -1);
          return true;
        }
      }
      return false;
    },
  });
  dlg.open();
  return dlg;
}

function row(c: Choice<keyof Prefs>) {
  const label = h('span.setting-current');
  const el = h(
    'div.setting-row',
    { 'data-key': c.key },
    h('div.setting-text', h('div.setting-label', c.label), c.help ? h('div.setting-help', c.help) : null),
    h(
      'button.setting-value',
      {
        type: 'button',
        'data-focus': true,
        tabindex: -1,
        onClick: () => step(el, 1),
      },
      icon('chevronL', 'arrow-l'),
      label,
      icon('chevronR', 'arrow-r'),
    ),
  );
  refresh(el, c);
  return el;
}

function refresh(el: HTMLElement, c: Choice<keyof Prefs>) {
  const v = store.prefs[c.key];
  const opt = c.options.find((o) => o.value === v) ?? c.options[0];
  el.querySelector('.setting-current')!.textContent = opt.label;
}

function step(el: HTMLElement, dir: 1 | -1) {
  const key = el.dataset.key as keyof Prefs;
  const c = CHOICES.find((x) => x.key === key)!;
  const idx = c.options.findIndex((o) => o.value === store.prefs[key]);
  const next = c.options[(idx + dir + c.options.length) % c.options.length];
  sfx.move();
  void store.setPrefs({ [key]: next.value } as Partial<Prefs>);
  refresh(el, c);
}
