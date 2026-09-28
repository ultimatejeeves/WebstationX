import type { Catalog, Profile, SaveSummary } from './types';

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`);
  return (await res.json()) as T;
}

const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  catalog: () => json<Catalog>('/api/catalog'),

  profiles: () => json<Profile[]>('/api/profiles'),
  createProfile: (name: string, avatar: string) => json<Profile>('/api/profiles', jsonBody('POST', { name, avatar })),
  updateProfile: (id: string, patch: Partial<Pick<Profile, 'name' | 'avatar' | 'prefs'>>) =>
    json<Profile>(`/api/profiles/${id}`, jsonBody('PATCH', patch)),
  deleteProfile: (id: string) => json<{ ok: true }>(`/api/profiles/${id}`, { method: 'DELETE' }),

  saves: (pid: string, gid: string) => json<SaveSummary>(`/api/saves/${pid}/${gid}`),

  async memcard(pid: string, gid: string): Promise<Blob | null> {
    const res = await fetch(`/api/saves/${pid}/${gid}/memcard`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`memcard ${res.status}`);
    return res.blob();
  },
  putMemcard: (pid: string, gid: string, blob: Blob) =>
    fetch(`/api/saves/${pid}/${gid}/memcard`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } }),

  async state(pid: string, gid: string, slot: string): Promise<Blob | null> {
    const res = await fetch(`/api/saves/${pid}/${gid}/state/${slot}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`state ${res.status}`);
    return res.blob();
  },
  async putState(pid: string, gid: string, slot: string, state: Blob, thumbnail?: Blob, label?: string) {
    const q = label ? `?label=${encodeURIComponent(label)}` : '';
    await fetch(`/api/saves/${pid}/${gid}/state/${slot}${q}`, {
      method: 'PUT',
      body: state,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    if (thumbnail)
      await fetch(`/api/saves/${pid}/${gid}/state/${slot}/thumbnail`, {
        method: 'PUT',
        body: thumbnail,
        headers: { 'Content-Type': 'image/png' },
      });
  },
  deleteState: (pid: string, gid: string, slot: string) => fetch(`/api/saves/${pid}/${gid}/state/${slot}`, { method: 'DELETE' }),
};
