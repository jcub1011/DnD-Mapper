/*
 * DiceAnimationTracker — gates UI roll log display behind 3D physics animation.
 *
 * Prevents the "spoiler problem" where replicated roll totals appear in the log
 * before the local 3D dice finish tumbling.
 * Includes a safety timeout fallback (3.5s) to guarantee results are never
 * permanently hidden if 3D simulation stalls or WebGL crashes.
 */

export interface IDiceAnimationTracker {
  isAnimating(rollId: string): boolean;
  markAnimating(rollId: string): void;
  markSettled(rollId: string): void;
  subscribe(listener: () => void): () => void;
  clear(): void;
}

export class DiceAnimationTracker implements IDiceAnimationTracker {
  private readonly animating = new Set<string>();
  private readonly timeouts = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly listeners = new Set<() => void>();
  private readonly fallbackTimeoutMs: number;

  constructor(fallbackTimeoutMs = 3500) {
    this.fallbackTimeoutMs = fallbackTimeoutMs;
  }

  isAnimating(rollId: string): boolean {
    return this.animating.has(rollId);
  }

  markAnimating(rollId: string): void {
    if (this.animating.has(rollId)) return;
    this.animating.add(rollId);

    if (this.fallbackTimeoutMs > 0) {
      const timer = setTimeout(() => {
        this.markSettled(rollId);
      }, this.fallbackTimeoutMs);
      this.timeouts.set(rollId, timer);
    }

    this.notify();
  }

  markSettled(rollId: string): void {
    const timer = this.timeouts.get(rollId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timeouts.delete(rollId);
    }

    if (this.animating.delete(rollId)) {
      this.notify();
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error("DiceAnimationTracker subscriber error", e);
      }
    }
  }

  clear(): void {
    for (const timer of this.timeouts.values()) {
      clearTimeout(timer);
    }
    this.timeouts.clear();
    const hadItems = this.animating.size > 0;
    this.animating.clear();
    if (hadItems) {
      this.notify();
    }
  }

  start(rollId: string): void {
    this.markAnimating(rollId);
  }

  settle(rollId: string): void {
    this.markSettled(rollId);
  }

  settleAll(): void {
    const rollIds = Array.from(this.animating);
    for (const id of rollIds) {
      this.markSettled(id);
    }
  }

  clearAll(): void {
    this.clear();
  }

  isAnyAnimating(): boolean {
    return this.animating.size > 0;
  }
}

export const diceAnimationTracker = new DiceAnimationTracker();
