/**
 * Preferences dialog. Every option is a horizontal chooser so it works with a d-pad.
 */
import { api } from '../core/api';
import { app } from '../core/app';
import { h, icon } from '../core/dom';
import { deviceGraphics, deviceSettings, hardwareSummary, setDeviceSettings, TIER_LABELS, TIERS, type DeviceSettings } from '../core/hardware';
import { sfx } from '../core/sfx';
import { store } from '../core/store';
import type { Prefs } from '../core/types';
import { clearDiscCache } from '../emu/disc-cache';
import { keymapHints } from '../emu/keymap';
import { openKeybindDialog } from '../ui/keybind-dialog';
import { button, Dialog, type ButtonOpts } from '../ui/components';

/** One horizontal chooser: a profile pref, or a device-local setting (get/set decide where it lives). */
type Choice = {
  id: string;
  label: string;
  help: string | (() => string);
  options: () => { value: unknown; label: string }[];
  get: () => unknown;
  set: (value: unknown) => void;
};

function pref<K extends keyof Prefs>(key: K, label: string, help: string, options: { value: Prefs[K]; label: string }[]): Choice {
  return {
    id: key,
    label,
    help,
    options: () => options,
    get: () => store.prefs[key],
    set: (v) => void store.setPrefs({ [key]: v } as Partial<Prefs>),
  };
}

const SAVED_HERE = 'Saved on this device only.';

/** Graphics choices, kept per device (localStorage) rather than on the profile. */
function deviceChoices(): Choice[] {
  return [
    {
      id: 'gfxPreset',
      label: 'Graphics preset',
      help: () => {
        const g = deviceGraphics();
        const note = g.demotedTo ? ` Lowered automatically after slow play.` : '';
        return `${g.pending ? 'Detecting this device…' : hardwareSummary(g.hardware)}${note} ${SAVED_HERE}`;
      },
      options: () => [
        { value: 'auto', label: `Auto (${TIER_LABELS[deviceGraphics().detectedTier]})` },
        ...[...TIERS].reverse().map((t) => ({ value: t, label: TIER_LABELS[t] })),
      ],
      get: () => deviceSettings().preset,
      set: (v) => setDeviceSettings({ preset: v as DeviceSettings['preset'] }),
    },
    {
      id: 'gfxPs2Res',
      label: 'PS2 resolution',
      help: `Sharpness of PS2 3D. Higher needs a faster graphics card. ${SAVED_HERE}`,
      options: () => [
        { value: 'preset', label: `Preset (${deviceGraphics().presetResolution}x)` },
        ...([1, 2, 3, 4] as const).map((r) => ({ value: r, label: `${r}x` })),
      ],
      get: () => deviceSettings().ps2Resolution,
      set: (v) => setDeviceSettings({ ps2Resolution: v as DeviceSettings['ps2Resolution'] }),
    },
    {
      id: 'gfxPs2Speed',
      label: 'PS2 CPU speed',
      help: `Auto keeps games at real speed: when this device can't run the PS2's CPU fast enough, the game drops frames instead of slowing down. Full never skips CPU time (heavy scenes run in slow motion). 75% and 50% always give the game less. ${SAVED_HERE}`,
      options: () => [
        { value: 'auto', label: 'Auto' },
        { value: 'full', label: 'Full' },
        { value: '3/4', label: '75%' },
        { value: '1/2', label: '50%' },
      ],
      get: () => deviceSettings().ps2Speed,
      set: (v) => setDeviceSettings({ ps2Speed: v as DeviceSettings['ps2Speed'] }),
    },
    {
      id: 'deviceCheck',
      label: 'Device check',
      help: `Flags games that are likely to run badly on this device before you start them. ${SAVED_HERE}`,
      options: () => [
        { value: true, label: 'On' },
        { value: false, label: 'Off' },
      ],
      get: () => deviceSettings().deviceCheck,
      set: (v) => setDeviceSettings({ deviceCheck: v as boolean }),
    },
  ];
}

const CHOICES: Choice[] = [
  pref('filter', 'Picture', 'CRT adds scanlines and glow. Sharp keeps pixels crisp. Smooth blurs them.', [
    { value: 'crt', label: 'CRT' },
    { value: 'sharp', label: 'Sharp' },
    { value: 'smooth', label: 'Smooth' },
  ]),
  pref('aspect', 'Screen shape', '4:3 is how the game was meant to look.', [
    { value: '4:3', label: '4:3' },
    { value: 'fill', label: 'Fill screen' },
  ]),
  pref('autoFrameskip', 'Performance mode', 'Lets the emulator skip frames to keep sound smooth on slower machines.', [
    { value: false, label: 'Off' },
    { value: true, label: 'On' },
  ]),
  pref('consoleBoot', 'Console boot logo', 'Show the original console start-up before the game loads.', [
    { value: false, label: 'Skip' },
    { value: true, label: 'Show' },
  ]),
  pref('volume', 'Game volume', '', [0, 20, 40, 60, 80, 100].map((v) => ({ value: v, label: v === 0 ? 'Mute' : `${v}%` }))),
  pref('musicVolume', 'Menu music', '', [0, 25, 50, 75, 100].map((v) => ({ value: v, label: v === 0 ? 'Off' : `${v}%` }))),
  pref('uiSounds', 'Menu sounds', '', [
    { value: true, label: 'On' },
    { value: false, label: 'Off' },
  ]),
];

export function openSettings(extra?: { inGame?: boolean }) {
  const rows = [...deviceChoices(), ...CHOICES].map((c) => row(c));
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
    body: h('div.settings', rows, keyHelp, extra?.inGame ? h('p.settings-note', 'Picture and sound changes apply immediately. Graphics preset, resolution, CPU speed and boot options apply next time a game starts.') : null),
    actions: [
      {
        label: 'Clear disc cache',
        icon: 'trash',
        onClick: async () => {
          await clearDiscCache();
          app.toast('Disc cache cleared', 'ok');
        },
      },
      ...(store.session.gated
        ? [
            {
              label: 'Sign out',
              icon: 'home',
              hint: store.session.name ? `Signed in as ${store.session.name}` : undefined,
              onClick: async () => {
                await api.logout();
                location.reload();
              },
            } satisfies ButtonOpts,
          ]
        : []),
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

/** The choice each row shows (rows are plain elements). */
const CHOICE_OF = new WeakMap<HTMLElement, Choice>();

function row(c: Choice) {
  const label = h('span.setting-current');
  const el = h(
    'div.setting-row',
    { 'data-key': c.id },
    h('div.setting-text', h('div.setting-label', c.label), h('div.setting-help')),
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
  CHOICE_OF.set(el, c);
  refresh(el);
  return el;
}

function refresh(el: HTMLElement) {
  const c = CHOICE_OF.get(el)!;
  const v = c.get();
  const options = c.options();
  const opt = options.find((o) => o.value === v) ?? options[0];
  el.querySelector('.setting-current')!.textContent = opt.label;
  const help = typeof c.help === 'function' ? c.help() : c.help;
  const helpEl = el.querySelector<HTMLElement>('.setting-help')!;
  helpEl.textContent = help;
  helpEl.hidden = !help;
}

function step(el: HTMLElement, dir: 1 | -1) {
  const c = CHOICE_OF.get(el)!;
  const options = c.options();
  const idx = options.findIndex((o) => o.value === c.get());
  const next = options[(idx + dir + options.length) % options.length];
  sfx.move();
  c.set(next.value);
  // A change can relabel other rows (a preset changes what "Preset (n x)" means).
  el.parentElement?.querySelectorAll<HTMLElement>('.setting-row').forEach(refresh);
}
