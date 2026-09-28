/**
 * "Who's playing?" — pick or create a profile. Profiles own memory cards, save states and
 * preferences, so friends can pick up where they left off from any machine on the network.
 */
import { api } from '../core/api';
import { app, type Screen } from '../core/app';
import { clear, h, icon } from '../core/dom';
import { FocusRing } from '../core/focus';
import { sfx } from '../core/sfx';
import { avatarUrl, store } from '../core/store';
import type { NavEvent, Profile } from '../core/types';
import { button, confirmDialog, Dialog, hintBar, textEntryDialog } from '../ui/components';

const AVATARS = ['avatar-01', 'avatar-02', 'avatar-03', 'avatar-04', 'avatar-05', 'avatar-06'];

export class ProfilesScreen implements Screen {
  name = 'profiles';
  el: HTMLElement;
  private grid: HTMLElement;
  private ring: FocusRing;
  private onPicked: (p: Profile) => void;
  private manage = false;

  constructor(onPicked: (p: Profile) => void) {
    this.onPicked = onPicked;
    this.grid = h('div.profile-grid');
    this.el = h(
      'div.profiles',
      h('div.bg-main'),
      h('div.profiles-head', h('h1.title-glow', "Who's playing?"), h('p.subtitle', 'Your saves and settings follow your profile.')),
      this.grid,
      h(
        'div.profiles-foot',
        button({
          label: 'Manage profiles',
          icon: 'gear',
          size: 'sm',
          onClick: () => {
            this.manage = !this.manage;
            this.el.classList.toggle('manage', this.manage);
            app.toast(this.manage ? 'Select a profile to edit or delete it' : 'Done managing', 'info', 1600);
          },
        }),
      ),
      hintBar([
        { glyph: 'cross', label: 'Select' },
        { glyph: 'dpad', label: 'Navigate' },
      ]),
    );
    this.ring = new FocusRing(this.el);
  }

  async mount() {
    await this.refresh();
  }
  unmount() {}

  private async refresh() {
    let profiles: Profile[] = [];
    try {
      profiles = await api.profiles();
    } catch {
      app.toast('Cannot reach the WebStationX server', 'warn');
    }
    clear(this.grid);
    for (const p of profiles) this.grid.appendChild(this.card(p));
    this.grid.appendChild(
      h(
        'button.profile-card.profile-new',
        { type: 'button', 'data-focus': true, tabindex: -1, 'data-focus-default': profiles.length === 0 || undefined, onClick: () => this.create() },
        h('div.profile-orb.orb-new', icon('plus')),
        h('div.profile-name', 'New profile'),
      ),
    );
    this.ring.focusDefault();
  }

  private card(p: Profile) {
    return h(
      'button.profile-card',
      {
        type: 'button',
        'data-focus': true,
        tabindex: -1,
        'data-focus-default': store.profile?.id === p.id || undefined,
        onClick: () => (this.manage ? this.edit(p) : this.pick(p)),
      },
      h('div.profile-orb', h('img', { src: avatarUrl(p.avatar), alt: '' })),
      h('div.profile-name', p.name),
      h('div.profile-meta', lastSeen(p.lastSeenAt)),
    );
  }

  private pick(p: Profile) {
    sfx.confirm();
    store.setProfile(p);
    this.onPicked(p);
  }

  private async create() {
    const name = await textEntryDialog('Enter your name');
    if (!name) return;
    const avatar = await this.pickAvatar(AVATARS[Math.floor(Math.random() * AVATARS.length)]);
    if (!avatar) return;
    try {
      const p = await api.createProfile(name, avatar);
      sfx.saved();
      store.setProfile(p);
      this.onPicked(p);
    } catch {
      app.toast('Could not create profile', 'warn');
    }
  }

  private pickAvatar(current: string): Promise<string | null> {
    return new Promise((resolve) => {
      let chosen: string | null = null;
      const dlg = new Dialog({
        title: 'Pick an icon',
        wide: true,
        body: h(
          'div.avatar-grid',
          AVATARS.map((a) =>
            h(
              'button.avatar-pick',
              {
                type: 'button',
                'data-focus': true,
                tabindex: -1,
                'data-focus-default': a === current || undefined,
                onClick: () => {
                  chosen = a;
                  sfx.confirm();
                  dlg.close();
                  resolve(a);
                },
              },
              h('img', { src: avatarUrl(a), alt: '' }),
            ),
          ),
        ),
        actions: [],
        onCancel: () => {
          dlg.close();
          resolve(chosen);
        },
      });
      dlg.open();
    });
  }

  private edit(p: Profile) {
    const dlg = new Dialog({
      title: p.name,
      body: 'Edit this profile.',
      actions: [
        {
          label: 'Rename',
          icon: 'user',
          focusDefault: true,
          onClick: async () => {
            dlg.close();
            const name = await textEntryDialog('New name', p.name);
            if (!name) return;
            await api.updateProfile(p.id, { name });
            await this.refresh();
          },
        },
        {
          label: 'Change icon',
          icon: 'star',
          onClick: async () => {
            dlg.close();
            const a = await this.pickAvatar(p.avatar);
            if (!a) return;
            await api.updateProfile(p.id, { avatar: a });
            await this.refresh();
          },
        },
        {
          label: 'Delete',
          icon: 'trash',
          variant: 'danger',
          onClick: async () => {
            dlg.close();
            const ok = await confirmDialog(`Delete ${p.name}?`, 'All of their saves and memory cards will be erased. This cannot be undone.', 'Delete', true);
            if (!ok) return;
            await api.deleteProfile(p.id);
            if (store.profile?.id === p.id) store.setProfile(null);
            await this.refresh();
          },
        },
        { label: 'Back', onClick: () => dlg.close() },
      ],
    });
    dlg.open();
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
        this.ring.activate();
        return true;
    }
  }
}

function lastSeen(iso: string) {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return 'Playing now';
  if (d < 3_600_000) return `Seen ${Math.floor(d / 60_000)} min ago`;
  if (d < 86_400_000) return `Seen ${Math.floor(d / 3_600_000)} hr ago`;
  return `Seen ${Math.floor(d / 86_400_000)} d ago`;
}
