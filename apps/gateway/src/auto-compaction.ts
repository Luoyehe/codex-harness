import type { CodexSupervisor } from "./codex/process.js";

/**
 * Auto-compaction: when the conversation's context usage crosses the user's
 * chosen threshold (default 90%, 0 = disabled), compact BETWEEN turns to
 * keep things running smoothly. Never fires mid-turn — compacting during a
 * running task could disrupt the agent's chain of thought.
 *
 * User controls (settings → 通用 → 舒适压缩阈值): 80%, 85%, 90%, 95%, or off.
 */

export interface AutoCompactionDeps {
  supervisor: CodexSupervisor;
  notify(method: string, params: unknown): void;
}

interface ThreadState {
  lastTokens: number;
  window: number | null;
  turnActive: boolean;
  compacting: boolean;
  /** Comfort-zone latch (resets after compaction finishes). */
  tripped: boolean;
  /**
   * Re-arm guard: after a compaction completes, the next trigger requires a
   * usage reading BELOW the threshold first — stale post-compaction readings
   * at/above the threshold must not start a compaction loop.
   */
  usageDroppedBelowThreshold: boolean;
}

const DEFAULT_USER_THRESHOLD = 0.9;

export class AutoCompaction {
  private threads = new Map<string, ThreadState>();
  private getUserThreshold: () => number;

  constructor(deps: AutoCompactionDeps, getUserThreshold?: () => number) {
    this.deps = deps;
    this.getUserThreshold = getUserThreshold ?? (() => DEFAULT_USER_THRESHOLD);
  }

  private deps: AutoCompactionDeps;

  private get(threadId: string): ThreadState {
    let s = this.threads.get(threadId);
    if (!s) {
      // usageDropped… starts true: the FIRST compaction of a thread has no
      // "wait for usage to drop" precondition (nothing compacted yet).
      s = { lastTokens: 0, window: null, turnActive: false, compacting: false, tripped: false, usageDroppedBelowThreshold: true };
      this.threads.set(threadId, s);
    }
    return s;
  }

  private userThreshold(): number {
    const t = this.getUserThreshold();
    return t > 0 && t < 1 ? t : 0; // 0 = disabled
  }

  observe(method: string, params: any): void {
    switch (method) {
      case "thread/tokenUsage/updated": {
        const tid = params?.threadId;
        const u = params?.tokenUsage;
        if (!tid || !u) return;
        const s = this.get(tid);
        s.lastTokens = u.last?.totalTokens ?? u.total?.totalTokens ?? 0;
        s.window = u.modelContextWindow ?? null;
        // Track whether usage has dipped below the threshold since the last
        // compaction — the re-arm precondition (see ThreadState).
        const threshold = this.userThreshold();
        if (threshold <= 0 || (s.window && s.window > 0 && s.lastTokens / s.window < threshold)) {
          s.usageDroppedBelowThreshold = true;
        }
        this.maybeCompact(tid, s);
        return;
      }
      case "turn/started": {
        if (params?.threadId) this.get(params.threadId).turnActive = true;
        return;
      }
      case "turn/completed": {
        if (params?.threadId) {
          const s = this.get(params.threadId);
          s.turnActive = false;
          // A completed turn is the safe moment to compact.
          this.maybeCompact(params.threadId, s);
        }
        return;
      }
      case "item/completed": {
        if (params?.item?.type === "contextCompaction" && params?.threadId) {
          const s = this.get(params.threadId);
          s.compacting = false;
          s.tripped = false;
          // Compaction finished: require a below-threshold usage reading
          // before the next trigger (stale high readings must not loop).
          s.usageDroppedBelowThreshold = false;
        }
        return;
      }
      case "thread/compacted": {
        // Fallback completion signal — some app-server builds send this
        // notification without (or before) the contextCompaction item.
        if (params?.threadId) {
          const s = this.get(params.threadId);
          s.compacting = false;
          s.tripped = false;
          s.usageDroppedBelowThreshold = false;
        }
        return;
      }
      case "error": {
        if (params?.threadId) {
          const s = this.get(params.threadId);
          s.turnActive = false;
          s.compacting = false;
        }
        return;
      }
    }
  }

  private maybeCompact(threadId: string, s: ThreadState): void {
    if (!s.window || s.window <= 0) return;
    if (s.compacting || s.turnActive || s.tripped) return;

    const threshold = this.userThreshold();
    if (threshold <= 0) return;

    const ratio = s.lastTokens / s.window;
    if (ratio < threshold) return;
    // Post-compaction re-arm guard: only trigger again after usage has been
    // observed BELOW the threshold (a fresh rise back over it is a genuinely
    // new compaction need, not a stale reading).
    if (!s.usageDroppedBelowThreshold) return;

    // Trip the latch first so concurrent notifications don't double-fire.
    s.tripped = true;
    s.compacting = true;

    this.deps.notify("thread/autoCompacting", {
      threadId,
      usedTokens: s.lastTokens,
      windowTokens: s.window,
      thresholdPct: Math.round(threshold * 100),
    });

    process.stderr.write(
      `[auto-compact] ${threadId.slice(0, 8)} ${Math.round(ratio * 100)}% used, compacting\n`,
    );

    this.deps.supervisor
      .request("thread/compact/start", { threadId })
      .then(() => {
        // Success — the contextCompaction item will clear the latches.
      })
      .catch((err: Error) => {
        process.stderr.write(`[auto-compact] ${threadId.slice(0, 8)} failed: ${err.message}\n`);
        s.compacting = false;
        s.tripped = false; // allow retry on next trigger
        this.deps.notify("thread/autoCompactFailed", { threadId, error: err.message });
      });
  }

  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
}
