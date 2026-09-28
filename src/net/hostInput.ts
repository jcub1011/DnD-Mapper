/*
 * DM Host Key Streaming tracker.
 *
 * Captures keys held by the DM and synchronizes them with the authority
 * with rate limiting (max 1 dispatch per 50ms = 20 msg/s ceiling).
 */

export function isEditableElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") return false;
  if ("tagName" in target) {
    const el = target as HTMLElement;
    const tag = el.tagName?.toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      return true;
    }
    if (el.isContentEditable) {
      return true;
    }
  }
  return false;
}

export function normalizeKey(key: string): string {
  if (key === " " || key.toLowerCase() === "space") {
    return "SPACE";
  }
  return key.toUpperCase();
}

function areKeySetsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (let i = 0; i < a.length; i++) {
    if (!setB.has(a[i])) return false;
  }
  return true;
}

export interface HostInputTrackerOptions {
  readonly onKeysChanged: (heldKeys: readonly string[]) => void;
  readonly target?: Window | EventTarget;
  readonly throttleMs?: number;
}

export class HostInputTracker {
  private readonly onKeysChanged: (heldKeys: readonly string[]) => void;
  private readonly target: EventTarget;
  private readonly throttleMs: number;

  private heldKeys = new Set<string>();
  private lastEmittedKeys: string[] = [];
  private lastDispatchTime = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attached = false;

  constructor(options: HostInputTrackerOptions) {
    this.onKeysChanged = options.onKeysChanged;
    this.target = options.target ?? (typeof window !== "undefined" ? window : ({} as EventTarget));
    this.throttleMs = options.throttleMs ?? 50;
  }

  public getHeldKeys(): readonly string[] {
    return Array.from(this.heldKeys).sort();
  }

  public attach(): void {
    if (this.attached || !this.target || typeof this.target.addEventListener !== "function") {
      return;
    }
    this.target.addEventListener("keydown", this.handleKeyDown as EventListener);
    this.target.addEventListener("keyup", this.handleKeyUp as EventListener);
    this.target.addEventListener("blur", this.handleBlur as EventListener);
    this.attached = true;
  }

  public detach(): void {
    if (!this.attached) return;
    if (this.target && typeof this.target.removeEventListener === "function") {
      this.target.removeEventListener("keydown", this.handleKeyDown as EventListener);
      this.target.removeEventListener("keyup", this.handleKeyUp as EventListener);
      this.target.removeEventListener("blur", this.handleBlur as EventListener);
    }
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.heldKeys.clear();
    this.attached = false;
  }

  public destroy(): void {
    this.detach();
  }

  private isInputFocused(e: Event): boolean {
    if (isEditableElement(e.target)) {
      return true;
    }
    if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
      return true;
    }
    return false;
  }

  private readonly handleKeyDown = (e: KeyboardEvent): void => {
    if (e.repeat) return;
    if (this.isInputFocused(e)) return;

    const key = normalizeKey(e.key);
    if (!this.heldKeys.has(key)) {
      this.heldKeys.add(key);
      this.scheduleDispatch();
    }
  };

  private readonly handleKeyUp = (e: KeyboardEvent): void => {
    const key = normalizeKey(e.key);
    if (this.heldKeys.has(key)) {
      this.heldKeys.delete(key);
      this.scheduleDispatch();
    }
  };

  private readonly handleBlur = (): void => {
    if (this.heldKeys.size > 0) {
      this.heldKeys.clear();
      this.scheduleDispatch();
    }
  };

  private scheduleDispatch(): void {
    if (this.timer !== null) {
      return;
    }

    const now = Date.now();
    const elapsed = now - this.lastDispatchTime;

    if (elapsed >= this.throttleMs) {
      this.doDispatch(now);
    } else {
      const remaining = this.throttleMs - elapsed;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.doDispatch(Date.now());
      }, remaining);
    }
  }

  private doDispatch(time: number): void {
    const current = Array.from(this.heldKeys).sort();
    if (!areKeySetsEqual(current, this.lastEmittedKeys)) {
      this.lastEmittedKeys = current;
      this.lastDispatchTime = time;
      this.onKeysChanged(current);
    }
  }
}
