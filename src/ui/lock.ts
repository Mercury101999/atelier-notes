/** Auto-lock on idle and when the app is hidden; panic lock with Esc pressed twice. */
export class LockGuard {
  private timer = 0;
  private minutes = 3;
  private active = false;
  private lastEsc = 0;
  /** While a native file picker is open, mobile browsers hide the page; don't lock for that. */
  pickerOpen = false;

  constructor(private onLock: () => void) {
    const reset = () => this.reset();
    for (const ev of ['pointerdown', 'keydown', 'touchstart', 'wheel', 'input']) addEventListener(ev, reset, { passive: true, capture: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden && this.active && !this.pickerOpen) this.fire(); });
    addEventListener('pagehide', () => { if (this.active && !this.pickerOpen) this.fire(); });
    addEventListener('focus', () => { setTimeout(() => (this.pickerOpen = false), 1500); });
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.key !== 'Escape') return;
      const now = performance.now();
      if (now - this.lastEsc < 700) this.fire();
      this.lastEsc = now;
    });
  }
  start(minutes: number) { this.minutes = minutes; this.active = true; this.reset(); }
  setMinutes(m: number) { this.minutes = m; this.reset(); }
  stop() { this.active = false; clearTimeout(this.timer); }
  reset() {
    if (!this.active) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.fire(), this.minutes * 60_000);
  }
  fire() { if (!this.active) return; this.stop(); this.onLock(); }
}
