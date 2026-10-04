/**
 * Keep the emulator running while the host's tab is in the background.
 *
 * Browsers stop requestAnimationFrame for hidden tabs, which would freeze the game for
 * every remote player the moment the host alt-tabs. The core schedules its main loop through
 * the global `requestAnimationFrame`, so while a stream is live and the tab is hidden we
 * route those calls through a timer instead. Chrome does not throttle timers on pages that
 * are playing audio or holding a WebRTC connection, which a streaming host always is.
 */

let active = false;
let installed = false;
const FRAME_MS = 1000 / 60;

export function setStreamingKeepAlive(on: boolean) {
  active = on;
  if (!installed && on) install();
}

function install() {
  installed = true;
  const realRaf = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const timers = new Map<number, number>();
  let nextId = 1 << 30; // far away from the browser's own ids
  let last = 0;
  window.requestAnimationFrame = (cb: FrameRequestCallback): number => {
    if (!active || !document.hidden) return realRaf(cb);
    const id = nextId++;
    const now = performance.now();
    const delay = Math.max(0, FRAME_MS - (now - last));
    const t = window.setTimeout(() => {
      timers.delete(id);
      last = performance.now();
      cb(last);
    }, delay);
    timers.set(id, t);
    return id;
  };
  window.cancelAnimationFrame = (id: number) => {
    const t = timers.get(id);
    if (t !== undefined) {
      clearTimeout(t);
      timers.delete(id);
    } else realCancel(id);
  };
}
