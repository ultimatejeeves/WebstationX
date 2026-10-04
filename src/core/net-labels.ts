/**
 * Display names for remote devices (`net:<peer>:<ord>`), kept here so the input layer can
 * label them without importing the networking code.
 */
const labels = new Map<string, string>();

export function setNetLabel(dev: string, label: string) {
  labels.set(dev, label);
}
export function clearNetLabel(dev: string) {
  labels.delete(dev);
}
export function netLabel(dev: string): string {
  return labels.get(dev) ?? 'Online player';
}
