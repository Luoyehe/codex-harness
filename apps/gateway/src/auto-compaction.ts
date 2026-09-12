import type { CodexSupervisor } from "./codex/process.js";
import { observedNotification } from "./protocol.js";

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
  /** Test/operations override; completion notifications should arrive well before this. */
  watchdogMs?: number;
}

interface ThreadState {
  lastTokens: number;
  window: number | null;
  turnActive: boolean;
  turnId: string | null;
  compacting: boolean;
  /** Comfort-zone latch (resets after compaction finishes). */
  tripped: boolean;
  /**
   * Re-arm guard: after a compaction completes, the next trigger requires a
   * usage reading BELOW the threshold first — stale post-compaction readings
   * at/above the threshold must not start a compaction loop.
   */
  usageDroppedBelowThreshold: boolean;
  watchdog: ReturnType<typeof setTimeout> | null;
  attempt: number;
}

const DEFAULT_USER_THRESHOLD = 0.9;
const DEFAULT_WATCHDOG_MS = 180_000;

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
      s = {
        lastTokens: 0,
        window: null,
        turnActive: false,
        turnId: null,
        compacting: false,
        tripped: false,
        usageDroppedBelowThreshold: true,
        watchdog: null,
        attempt: 0,
      };
      this.threads.set(threadId, s);
    }
    return s;
  }

  private userThreshold(): number {
    const t = this.getUserThreshold();
    return t > 0 && t < 1 ? t : 0; // 0 = disabled
  }

  observe(method: string, raw: unknown): void {
    const event = observedNotification(method, raw);
    if (!event) return;
    switch (event.method) {
      case "thread/tokenUsage/updated": {
        const params = event.params;
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
        const params = event.params;
        const s = this.get(params.threadId);
        s.turnActive = true;
        s.turnId = params.turn.id;
        return;
      }
      case "turn/completed": {
        const params = event.params;
        if (params?.threadId) {
          const s = this.get(params.threadId);
          if (s.turnId && s.turnId !== params.turn.id) return;
          s.turnActive = false;
          s.turnId = null;
          // A completed turn is the safe moment to compact.
          this.maybeCompact(params.threadId, s);
        }
        return;
      }
      case "item/completed": {
        const params = event.params;
        if (params?.item?.type === "contextCompaction" && params?.threadId) {
          const s = this.get(params.threadId);
          this.finishAttempt(s);
          // Compaction finished: require a below-threshold usage reading
          // before the next trigger (stale high readings must not loop).
          s.usageDroppedBelowThreshold = false;
        }
        return;
      }
      case "thread/compacted": {
        const params = event.params;
        // Fallback completion signal — some app-server builds send this
        // notification without (or before) the contextCompaction item.
        if (params?.threadId) {
          const s = this.get(params.threadId);
          this.finishAttempt(s);
          s.usageDroppedBelowThreshold = false;
        }
        return;
      }
      case "error": {
        const params = event.params;
        if (params?.threadId) {
          const s = this.get(params.threadId);
          if (s.turnId && s.turnId !== params.turnId) return;
          // A retryable turn error is not a safe between-turn boundary.
          if (params?.willRetry !== true) {
            s.turnActive = false;
            s.turnId = null;
            this.finishAttempt(s);
          }
        }
        return;
      }
      case "thread/archived": case "thread/deleted": case "thread/closed":
        this.forget(event.params.threadId);
        return;
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
    const attempt = ++s.attempt;
    const watchdogMs = this.deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    s.watchdog = setTimeout(() => {
      if (!s.compacting || s.attempt !== attempt) return;
      this.finishAttempt(s);
      const error = `compaction completion was not observed within ${Math.ceil(watchdogMs / 1000)}s`;
      process.stderr.write(`[auto-compact] ${threadId.slice(0, 8)} failed: ${error}\n`);
      this.deps.notify("thread/autoCompactFailed", { threadId, error });
    }, watchdogMs);
    s.watchdog.unref?.();

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
        if (!s.compacting || s.attempt !== attempt) return;
        process.stderr.write(`[auto-compact] ${threadId.slice(0, 8)} failed: ${err.message}\n`);
        this.finishAttempt(s); // allow retry on next trigger
        this.deps.notify("thread/autoCompactFailed", { threadId, error: err.message });
      });
  }

  private finishAttempt(s: ThreadState): void {
    if (s.watchdog) clearTimeout(s.watchdog);
    s.watchdog = null;
    s.compacting = false;
    s.tripped = false;
  }

  forget(threadId: string): void {
    const s = this.threads.get(threadId);
    if (s) {
      this.finishAttempt(s);
      s.attempt += 1;
    }
    this.threads.delete(threadId);
  }

  /** Drop connection-scoped activity after app-server restart/stop. */
  reset(): void {
    for (const s of this.threads.values()) {
      this.finishAttempt(s);
      s.attempt += 1;
    }
    this.threads.clear();
  }
}
