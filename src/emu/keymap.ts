/**
 * Keyboard & mouse bindings for the keyboard player.
 *
 * A binding value is a RetroArch key name (e.g. "x", "up", "kp_enter"), a mouse button
 * ("mouse:1" .. "mouse:9" in RetroArch's numbering), or "nul" for unbound.
 * Bindings are saved per profile in preferences and written into retroarch.cfg at launch.
 */

export type PsxButton =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'b' // Cross
  | 'a' // Circle
  | 'y' // Square
  | 'x' // Triangle
  | 'l'
  | 'r'
  | 'l2'
  | 'r2'
  | 'start'
  | 'select'
  | 'l_y_minus'
  | 'l_y_plus'
  | 'l_x_minus'
  | 'l_x_plus'
  | 'r_y_minus'
  | 'r_y_plus'
  | 'r_x_minus'
  | 'r_x_plus'
  | 'l3'
  | 'r3';

export type Keymap = Record<PsxButton, string>;

export const PSX_BUTTONS: { id: PsxButton; label: string; group: string; glyph?: string }[] = [
  { id: 'up', label: 'D-Pad Up', group: 'D-Pad', glyph: 'dpad' },
  { id: 'down', label: 'D-Pad Down', group: 'D-Pad', glyph: 'dpad' },
  { id: 'left', label: 'D-Pad Left', group: 'D-Pad', glyph: 'dpad' },
  { id: 'right', label: 'D-Pad Right', group: 'D-Pad', glyph: 'dpad' },
  { id: 'b', label: 'Cross', group: 'Face buttons', glyph: 'cross' },
  { id: 'a', label: 'Circle', group: 'Face buttons', glyph: 'circle' },
  { id: 'y', label: 'Square', group: 'Face buttons', glyph: 'square' },
  { id: 'x', label: 'Triangle', group: 'Face buttons', glyph: 'triangle' },
  { id: 'l', label: 'L1', group: 'Shoulders' },
  { id: 'r', label: 'R1', group: 'Shoulders' },
  { id: 'l2', label: 'L2', group: 'Shoulders' },
  { id: 'r2', label: 'R2', group: 'Shoulders' },
  { id: 'start', label: 'Start', group: 'System' },
  { id: 'select', label: 'Select', group: 'System' },
  { id: 'l_y_minus', label: 'Left stick Up', group: 'Left stick' },
  { id: 'l_y_plus', label: 'Left stick Down', group: 'Left stick' },
  { id: 'l_x_minus', label: 'Left stick Left', group: 'Left stick' },
  { id: 'l_x_plus', label: 'Left stick Right', group: 'Left stick' },
  { id: 'l3', label: 'L3 (stick click)', group: 'Left stick' },
  { id: 'r_y_minus', label: 'Right stick Up', group: 'Right stick' },
  { id: 'r_y_plus', label: 'Right stick Down', group: 'Right stick' },
  { id: 'r_x_minus', label: 'Right stick Left', group: 'Right stick' },
  { id: 'r_x_plus', label: 'Right stick Right', group: 'Right stick' },
  { id: 'r3', label: 'R3 (stick click)', group: 'Right stick' },
];

export const DEFAULT_KEYMAP: Keymap = {
  up: 'up',
  down: 'down',
  left: 'left',
  right: 'right',
  b: 'x',
  a: 'c',
  y: 'z',
  x: 's',
  l: 'q',
  r: 'e',
  l2: 'num1',
  r2: 'num3',
  start: 'enter',
  select: 'rshift',
  l_y_minus: 'i',
  l_y_plus: 'k',
  l_x_minus: 'j',
  l_x_plus: 'l',
  r_y_minus: 'nul',
  r_y_plus: 'nul',
  r_x_minus: 'nul',
  r_x_plus: 'nul',
  l3: 'nul',
  r3: 'nul',
};

/** Fill any missing or invalid entries from the defaults. */
export function normalizeKeymap(k: Partial<Keymap> | undefined | null): Keymap {
  const out = { ...DEFAULT_KEYMAP };
  if (!k) return out;
  for (const b of PSX_BUTTONS) {
    const v = k[b.id];
    if (typeof v === 'string' && v.length > 0 && v.length < 24) out[b.id] = v;
  }
  return out;
}

/* ---------- Browser KeyboardEvent.code -> RetroArch key name ---------- */

const CODE_TO_RA: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'enter',
  NumpadEnter: 'kp_enter',
  Tab: 'tab',
  Space: 'space',
  Backspace: 'backspace',
  Insert: 'insert',
  Delete: 'del',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  ShiftLeft: 'shift',
  ShiftRight: 'rshift',
  ControlLeft: 'ctrl',
  ControlRight: 'rctrl',
  AltLeft: 'alt',
  AltRight: 'ralt',
  CapsLock: 'capslock',
  NumLock: 'numlock',
  ScrollLock: 'scroll_lock',
  Pause: 'pause',
  Period: 'period',
  Comma: 'comma',
  Minus: 'minus',
  Equal: 'equals',
  Slash: 'slash',
  Backslash: 'backslash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  Backquote: 'backquote',
  BracketLeft: 'leftbracket',
  BracketRight: 'rightbracket',
  NumpadAdd: 'kp_plus',
  NumpadSubtract: 'kp_minus',
  NumpadMultiply: 'multiply',
  NumpadDivide: 'divide',
  NumpadDecimal: 'kp_period',
};

/** Keys the shell reserves (menu toggle) and refuses to bind. */
export const RESERVED_CODES = new Set(['Escape', 'F1']);

export function codeToRetroKey(code: string): string | null {
  if (RESERVED_CODES.has(code)) return null;
  if (CODE_TO_RA[code]) return CODE_TO_RA[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1].toLowerCase();
  m = /^Digit([0-9])$/.exec(code);
  if (m) return `num${m[1]}`;
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `keypad${m[1]}`;
  m = /^F([0-9]{1,2})$/.exec(code);
  if (m && Number(m[1]) >= 2 && Number(m[1]) <= 12) return `f${m[1]}`;
  return null;
}

/** Browser MouseEvent.button -> RetroArch mouse button index. */
export function mouseButtonToRetro(button: number): number | null {
  switch (button) {
    case 0:
      return 1; // left
    case 2:
      return 2; // right
    case 1:
      return 3; // middle
    case 3:
      return 8; // back
    case 4:
      return 9; // forward
  }
  return null;
}

export function wheelToRetro(deltaY: number, deltaX: number): number | null {
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? 4 : deltaY > 0 ? 5 : null;
  return deltaX < 0 ? 6 : 7;
}

const MOUSE_LABELS: Record<number, string> = {
  1: 'Left click',
  2: 'Right click',
  3: 'Middle click',
  4: 'Wheel up',
  5: 'Wheel down',
  6: 'Wheel left',
  7: 'Wheel right',
  8: 'Mouse back',
  9: 'Mouse forward',
};

const KEY_LABELS: Record<string, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  enter: 'Enter',
  kp_enter: 'Num Enter',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  insert: 'Ins',
  del: 'Del',
  home: 'Home',
  end: 'End',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  shift: 'L-Shift',
  rshift: 'R-Shift',
  ctrl: 'L-Ctrl',
  rctrl: 'R-Ctrl',
  alt: 'L-Alt',
  ralt: 'R-Alt',
  capslock: 'Caps',
  numlock: 'NumLk',
  scroll_lock: 'ScrLk',
  pause: 'Pause',
  period: '.',
  comma: ',',
  minus: '-',
  equals: '=',
  slash: '/',
  backslash: '\\',
  semicolon: ';',
  quote: "'",
  backquote: '`',
  leftbracket: '[',
  rightbracket: ']',
  kp_plus: 'Num +',
  kp_minus: 'Num -',
  multiply: 'Num *',
  divide: 'Num /',
  kp_period: 'Num .',
  nul: '—',
};

/** Human readable label for a binding value. */
export function bindingLabel(v: string): string {
  if (!v || v === 'nul') return '—';
  if (v.startsWith('mouse:')) return MOUSE_LABELS[Number(v.slice(6))] ?? `Mouse ${v.slice(6)}`;
  if (KEY_LABELS[v]) return KEY_LABELS[v];
  let m = /^num([0-9])$/.exec(v);
  if (m) return m[1];
  m = /^keypad([0-9])$/.exec(v);
  if (m) return `Num ${m[1]}`;
  m = /^f([0-9]{1,2})$/.exec(v);
  if (m) return `F${m[1]}`;
  return v.length === 1 ? v.toUpperCase() : v;
}

export const isMouseBinding = (v: string) => v.startsWith('mouse:');

/** Compact summary rows for help panels. */
export function keymapHints(k: Keymap): { key: string; does: string }[] {
  const pair = (a: PsxButton, b: PsxButton) => `${bindingLabel(k[a])} / ${bindingLabel(k[b])}`;
  const dpad = [k.up, k.down, k.left, k.right];
  const dpadLabel = dpad.every((v, i) => v === ['up', 'down', 'left', 'right'][i]) ? 'Arrows' : dpad.map(bindingLabel).join(' ');
  const stick = [k.l_y_minus, k.l_x_minus, k.l_y_plus, k.l_x_plus];
  const rows = [
    { key: dpadLabel, does: 'D-Pad' },
    { key: bindingLabel(k.b), does: 'Cross' },
    { key: bindingLabel(k.a), does: 'Circle' },
    { key: bindingLabel(k.y), does: 'Square' },
    { key: bindingLabel(k.x), does: 'Triangle' },
    { key: pair('l', 'r'), does: 'L1 / R1' },
    { key: pair('l2', 'r2'), does: 'L2 / R2' },
    { key: bindingLabel(k.start), does: 'Start' },
    { key: bindingLabel(k.select), does: 'Select' },
  ];
  if (stick.some((v) => v !== 'nul')) rows.push({ key: stick.map(bindingLabel).join(' '), does: 'Left stick' });
  rows.push({ key: 'Esc', does: 'Menu' });
  return rows;
}
