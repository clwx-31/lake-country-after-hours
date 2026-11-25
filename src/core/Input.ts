// Keyboard state with edge detection. Held keys clear on blur so nothing sticks.

export type Action =
  | 'throttle' | 'brake' | 'left' | 'right' | 'drift' | 'nitro' | 'ability'
  | 'camera' | 'rear' | 'map' | 'pause' | 'recover' | 'confirm' | 'alt' | 'time' | 'online' | 'fire';

const BINDINGS: Record<string, Action> = {
  KeyW: 'throttle', ArrowUp: 'throttle',
  KeyS: 'brake', ArrowDown: 'brake',
  KeyA: 'left', ArrowLeft: 'left',
  KeyD: 'right', ArrowRight: 'right',
  Space: 'drift',
  ShiftLeft: 'nitro', ShiftRight: 'nitro',
  KeyT: 'time',
  KeyO: 'online',
  KeyE: 'ability',
  KeyF: 'fire',
  KeyC: 'camera',
  KeyV: 'rear',
  KeyM: 'map',
  Escape: 'pause',
  KeyR: 'recover',
  Enter: 'confirm', NumpadEnter: 'confirm',
  Tab: 'alt',
};

export class Input {
  private held = new Set<Action>();
  private pressed = new Set<Action>();
  private codesHeld = new Set<string>();
  /** Synthetic steering for automated playtests (overrides keys when set). */
  scripted: Partial<Record<Action, boolean>> | null = null;
  enabled = true;
  onAnyKey: (() => void) | null = null;

  constructor(target: Window = window) {
    target.addEventListener('keydown', (e) => {
      this.onAnyKey?.();
      // Typing in a text field (lobby code, name) never drives the car.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const a = BINDINGS[e.code];
      if (!a) return;
      if (a === 'alt' || a === 'drift' || e.code.startsWith('Arrow')) e.preventDefault();
      if (!this.codesHeld.has(e.code)) {
        this.codesHeld.add(e.code);
        if (!this.held.has(a)) this.pressed.add(a);
        this.held.add(a);
      }
    });
    target.addEventListener('keyup', (e) => {
      const a = BINDINGS[e.code];
      this.codesHeld.delete(e.code);
      if (!a) return;
      // Another key bound to the same action may still be down.
      for (const code of this.codesHeld) if (BINDINGS[code] === a) return;
      this.held.delete(a);
    });
    target.addEventListener('blur', () => this.clear());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.clear();
    });
  }

  clear() {
    this.held.clear();
    this.pressed.clear();
    this.codesHeld.clear();
  }

  down(a: Action) {
    if (this.scripted && a in this.scripted) return !!this.scripted[a];
    return this.enabled && this.held.has(a);
  }

  /** True once per physical press; consumed when read. */
  hit(a: Action) {
    if (!this.pressed.has(a)) return false;
    this.pressed.delete(a);
    return this.enabled || a === 'pause' || a === 'confirm' || a === 'map';
  }

  /** Inject a one-shot press (used by playtest automation). */
  tap(a: Action) {
    this.pressed.add(a);
  }

  endFrame() {
    this.pressed.clear();
  }
}
