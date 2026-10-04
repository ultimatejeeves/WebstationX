/**
 * Keyboard & mouse binding editor. Pick a PlayStation button, then press any key or
 * mouse button to bind it. Fully navigable with a controller as well (for the friend who
 * sets things up for the keyboard player).
 */
import { app } from '../core/app';
import { clear, h, icon } from '../core/dom';
import { input } from '../core/input';
import { sfx } from '../core/sfx';
import { store } from '../core/store';
import {
  bindingLabel,
  codeToRetroKey,
  DEFAULT_KEYMAP,
  isMouseBinding,
  mouseButtonToRetro,
  PSX_BUTTONS,
  wheelToRetro,
  type Keymap,
  type PsxButton,
} from '../emu/keymap';
import { button, confirmDialog, Dialog } from './components';

export type KeybindResult = { changed: boolean };

export function openKeybindDialog(): Promise<KeybindResult> {
  return new Promise((resolve) => {
    const original = JSON.stringify(store.prefs.keymap);
    let keymap: Keymap = { ...store.prefs.keymap };
    let capturing: PsxButton | null = null;

    const list = h('div.bind-list', { 'data-scroll': 'y' });
    const status = h('div.bind-status', 'Select a button, then press the key or mouse button you want.');

    const rowFor = (id: PsxButton) => list.querySelector<HTMLElement>(`[data-bind="${id}"]`);

    const render = () => {
      clear(list);
      let lastGroup = '';
      for (const b of PSX_BUTTONS) {
        if (b.group !== lastGroup) {
          list.appendChild(h('div.bind-group', b.group));
          lastGroup = b.group;
        }
        const v = keymap[b.id];
        const dup = Object.entries(keymap).some(([k, val]) => k !== b.id && val !== 'nul' && val === v);
        list.appendChild(
          h(
            'div.bind-row',
            { 'data-bind': b.id },
            h('div.bind-label', b.glyph ? h(`span.glyph.glyph-${b.glyph}`, icon(b.glyph)) : h('span.glyph.glyph-blank'), b.label),
            h(
              'button.bind-value' + (v === 'nul' ? '.unbound' : '') + (dup ? '.dup' : '') + (isMouseBinding(v) ? '.mouse' : ''),
              { type: 'button', 'data-focus': true, tabindex: -1, onClick: () => startCapture(b.id) },
              h('kbd', bindingLabel(v)),
              dup ? h('span.bind-dup', 'also used') : null,
            ),
            h(
              'button.bind-clear',
              { type: 'button', 'data-focus': true, tabindex: -1, title: 'Unbind', onClick: () => setBinding(b.id, 'nul') },
              icon('cross'),
            ),
          ),
        );
      }
    };

    const setBinding = (id: PsxButton, value: string) => {
      // Steal the key from any other button so a key never triggers two things.
      if (value !== 'nul') for (const k of Object.keys(keymap) as PsxButton[]) if (k !== id && keymap[k] === value) keymap[k] = 'nul';
      keymap = { ...keymap, [id]: value };
      sfx.move();
      const focusedId = dlg.ring.current?.closest<HTMLElement>('.bind-row')?.dataset.bind;
      render();
      const target = rowFor((focusedId as PsxButton) ?? id)?.querySelector<HTMLElement>('.bind-value');
      dlg.ring.set(target ?? null, true);
    };

    const stopCapture = () => {
      capturing = null;
      input.capture = null;
      dlg.el.classList.remove('capturing');
      status.textContent = 'Select a button, then press the key or mouse button you want.';
      list.querySelectorAll('.bind-row.capturing').forEach((r) => r.classList.remove('capturing'));
    };

    const startCapture = (id: PsxButton) => {
      const label = PSX_BUTTONS.find((b) => b.id === id)!.label;
      capturing = id;
      dlg.el.classList.add('capturing');
      rowFor(id)?.classList.add('capturing');
      status.textContent = `Press a key or mouse button for ${label}. Esc cancels, Backspace unbinds.`;
      sfx.open();
      input.capture = (e) => {
        if (!capturing) return;
        if (e instanceof KeyboardEvent) {
          if (e.code === 'Escape') return stopCapture();
          if (e.code === 'Backspace' || e.code === 'Delete') {
            setBinding(capturing, 'nul');
            return stopCapture();
          }
          const key = codeToRetroKey(e.code);
          if (!key) {
            sfx.error();
            status.textContent = `That key is reserved. Try another for ${label}.`;
            return;
          }
          setBinding(capturing, key);
          stopCapture();
        } else if (e instanceof WheelEvent) {
          const n = wheelToRetro(e.deltaY, e.deltaX);
          if (n) {
            setBinding(capturing, `mouse:${n}`);
            stopCapture();
          }
        } else if (e instanceof MouseEvent) {
          const n = mouseButtonToRetro(e.button);
          if (n === null) return sfx.error();
          setBinding(capturing, `mouse:${n}`);
          stopCapture();
        }
      };
    };

    const finish = async (save: boolean) => {
      stopCapture();
      const changed = save && JSON.stringify(keymap) !== original;
      if (changed) await store.setPrefs({ keymap });
      dlg.close();
      resolve({ changed });
    };

    const dlg = new Dialog({
      title: 'Keyboard & mouse controls',
      wide: true,
      body: h(
        'div.bind-editor',
        h('p.bind-intro', 'These bindings belong to your profile and apply whenever you play from the keyboard. Any key, mouse button or wheel direction can be used.'),
        list,
        status,
      ),
      actions: [
        {
          label: 'Reset to defaults',
          icon: 'restart',
          onClick: async () => {
            if (!(await confirmDialog('Reset bindings?', 'This restores the standard keyboard layout.', 'Reset'))) return;
            keymap = { ...DEFAULT_KEYMAP };
            render();
            dlg.ring.focusDefault();
          },
        },
        { label: 'Cancel', onClick: () => void finish(false) },
        { label: 'Save', icon: 'check', variant: 'primary', onClick: () => void finish(true) },
      ],
      onCancel: () => {
        if (capturing) stopCapture();
        else void finish(false);
      },
      onNav: (e) => {
        if (capturing) return true; // swallow controller nav while waiting for a key
        // Circle/Backspace on a row unbinds it quickly.
        if (e.action === 'menu' && e.device !== 'kb') {
          const id = dlg.ring.current?.closest<HTMLElement>('.bind-row')?.dataset.bind as PsxButton | undefined;
          if (id) setBinding(id, 'nul');
          return true;
        }
        return false;
      },
    });
    const origClose = dlg.close.bind(dlg);
    dlg.close = () => {
      stopCapture();
      origClose();
    };
    render();
    dlg.open();
    requestAnimationFrame(() => dlg.ring.set(list.querySelector<HTMLElement>('.bind-value'), true));
  });
}

export function hasCustomKeymap() {
  return JSON.stringify(store.prefs.keymap) !== JSON.stringify(DEFAULT_KEYMAP);
}

export { button as _button, app as _app };
