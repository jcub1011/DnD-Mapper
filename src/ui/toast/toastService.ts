export type ToastTone = "info" | "success" | "warn" | "danger";

export interface ToastEntry {
  readonly id: string;
  readonly message: string;
  readonly tone: ToastTone;
}

export class ToastService {
  private _entries: ToastEntry[] = [];
  private listeners: Set<(entries: readonly ToastEntry[]) => void> = new Set();
  private timers = new Map<string, number>();

  get entries(): readonly ToastEntry[] {
    return this._entries;
  }

  show(message: string, tone: ToastTone = "info", durationMs = 3500): string {
    const id = "toast-" + Math.random().toString(36).slice(2, 9);
    const entry: ToastEntry = { id, message, tone };
    this._entries = [...this._entries, entry];
    this.notify();

    if (durationMs > 0 && typeof window !== "undefined") {
      const timer = window.setTimeout(() => this.dismiss(id), durationMs);
      this.timers.set(id, timer);
    }

    return id;
  }

  success(message: string, durationMs = 3500): string {
    return this.show(message, "success", durationMs);
  }

  warn(message: string, durationMs = 4000): string {
    return this.show(message, "warn", durationMs);
  }

  error(message: string, durationMs = 5000): string {
    return this.show(message, "danger", durationMs);
  }

  info(message: string, durationMs = 3500): string {
    return this.show(message, "info", durationMs);
  }

  dismiss(id: string): void {
    if (this.timers.has(id)) {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
    }
    this._entries = this._entries.filter((e) => e.id !== id);
    this.notify();
  }

  clear(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this._entries = [];
    this.notify();
  }

  subscribe(listener: (entries: readonly ToastEntry[]) => void): () => void {
    this.listeners.add(listener);
    listener(this._entries);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this._entries);
    }
  }
}

export const toastService = new ToastService();
