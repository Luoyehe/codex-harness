import type { CodexSupervisor } from "./codex/process.js";
import { observedNotification } from "./protocol.js";
import { isDefiniteAppServerRejection } from "./codex/rpc.js";

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
  requestCompact?(threadId: string): Promise<unknown>;
}

interface ThreadState {
  lastTokens: number;
  window: number | null;
  turnActive: boolean;
  statusActive: boolean;
  /** An explicit idle status or a completed tracked turn proved a boundary. */
  idleKnown: boolean;
  turnId: string | null;
  compacting: boolean;
  uncertain: boolean;
  conflicted: boolean;
  acknowledged: boolean;
  completed: boolean;
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
  static readonly MAX_TRACKED_THREADS = 1024;
  private threads = new Map<string, ThreadState>();
  private getUserThreshold: () => number;

  constructor(deps: AutoCompactionDeps, getUserThreshold?: () => number) {
    this.deps = deps;
    this.getUserThreshold = getUserThreshold ?? (() => DEFAULT_USER_THRESHOLD);
  }

  private deps: AutoCompactionDeps;

  private get(threadId: string): ThreadState | null {
    let s = this.threads.get(threadId);
    if (s) {
      // Map insertion order is our bounded LRU; current activity stays hot.
      this.threads.delete(threadId);
      this.threads.set(threadId, s);
    } else {
      // Disabled auto-compaction has no reason to retain notification-only
      // thread state. When enabled, keep a hard generation-scoped ceiling so
      // valid-but-unique notifications cannot grow the worker indefinitely.
      if (this.userThreshold() <= 0) return null;
      if (this.threads.size >= AutoCompaction.MAX_TRACKED_THREADS) {
        let evictable: string | undefined;
        for (const [candidate, state] of this.threads) {
          // A post-compaction high-usage tombstone prevents replaying a stale
          // reading. It remains protected until a below-threshold update
          // explicitly re-arms it.
          if (!state.turnActive && !state.statusActive && !state.compacting && !state.uncertain
              && !state.conflicted && state.usageDroppedBelowThreshold) {
            evictable = candidate;
            break;
          }
        }
        if (!evictable) return null;
        this.threads.delete(evictable);
      }
      // usageDropped… starts true: the FIRST compaction of a thread has no
      // "wait for usage to drop" precondition (nothing compacted yet).
      s = {
        lastTokens: 0,
        window: null,
        turnActive: false,
        statusActive: false,
        idleKnown: false,
        turnId: null,
        compacting: false,
        uncertain: false,
        conflicted: false,
        acknowledged: true,
        completed: false,
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
        const tokens = u.last?.totalTokens ?? u.total?.totalTokens;
        const window = u.modelContextWindow;
        if (!Number.isSafeInteger(tokens) || tokens < 0
            || window !== null && (!Number.isSafeInteger(window) || window <= 0)) return;
        const s = this.get(tid);
        if (!s) return;
        s.lastTokens = tokens;
        s.window = window;
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
        if (!s) return;
        if (s.conflicted) return;
        if (s.turnActive && s.turnId && s.turnId !== params.turn.id) {
          // Never infer an idle boundary from conflicting turn identities.
          // Disable automatic compaction for this thread until lifecycle reset.
          s.conflicted = true;
          s.turnId = null;
          return;
        }
        s.turnActive = true;
        s.idleKnown = false;
        s.turnId = params.turn.id;
        return;
      }
      case "turn/completed": {
        const params = event.params;
        if (params?.threadId) {
          const s = this.get(params.threadId);
          if (!s) return;
          // A completion first seen after attaching may belong to an older
          // turn and does not prove that an unobserved current turn is idle.
          // Only the exact turn we observed starting can establish this
          // boundary; otherwise wait for an explicit non-active status.
          if (!s.turnActive || !s.turnId || s.turnId !== params.turn.id) return;
          s.turnActive = false;
          s.turnId = null;
          // If a status event still says active, wait for its matching idle
          // transition. Builds without status notifications retain the
          // protocol-proven completed-turn boundary.
          s.idleKnown = !s.statusActive && !s.conflicted;
          // A completed turn is the safe moment to compact.
          this.maybeCompact(params.threadId, s);
        }
        return;
      }
      case "item/completed": {
        const params = event.params;
        if (params?.item?.type === "contextCompaction" && params?.threadId) {
          const s = this.get(params.threadId);
          if (!s) return;
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
          if (!s) return;
          this.finishAttempt(s);
          s.usageDroppedBelowThreshold = false;
        }
        return;
      }
      case "error": {
        const params = event.params;
        if (params?.threadId) {
          const s = this.get(params.threadId);
          if (!s) return;
          // An uncorrelated late turn error is not evidence that a separate
          // compact/start attempt completed. Only end the exact active normal
          // turn; compaction completion has its own protocol signals.
          if (!s.turnActive || !s.turnId || s.turnId !== params.turnId) return;
          // A retryable turn error is not a safe between-turn boundary.
          if (params?.willRetry !== true) {
            s.turnActive = false;
            s.turnId = null;
            s.idleKnown = !s.statusActive && !s.conflicted;
            this.maybeCompact(params.threadId, s);
          }
        }
        return;
      }
      case "thread/status/changed": {
        const s = this.get(event.params.threadId);
        if (!s) return;
        if (event.params.status.type === "active") {
          s.statusActive = true;
          s.idleKnown = false;
          return;
        }
        // idle/notLoaded/systemError all prove that the app-server does not
        // currently own an active task for this thread. A separately tracked
        // turn still wins until its exact completion arrives.
        s.statusActive = false;
        s.idleKnown = !s.turnActive && !s.conflicted;
        this.maybeCompact(event.params.threadId, s);
        return;
      }
      case "thread/archived": case "thread/deleted": case "thread/closed":
        this.forget(event.params.threadId);
        return;
    }
  }

  private maybeCompact(threadId: string, s: ThreadState): void {
    if (!s.window || s.window <= 0) return;
    if (!s.idleKnown || s.compacting || s.turnActive || s.statusActive
        || s.tripped || s.uncertain || s.conflicted) return;

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
    s.acknowledged = false;
    s.completed = false;
    const attempt = ++s.attempt;
    const watchdogMs = this.deps.watchdogMs ?? DEFAULT_WATCHDOG_MS;
    s.watchdog = setTimeout(() => {
      if (!s.compacting || s.attempt !== attempt) return;
      s.watchdog = null;
      s.uncertain = true;
      const error = `compaction completion was not observed within ${Math.ceil(watchdogMs / 1000)}s`;
      process.stderr.write(`[auto-compact] ${threadId.slice(0, 8)} failed: ${error}\n`);
      this.deps.notify("thread/autoCompactFailed", { threadId, error, outcome: "unknown" });
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

    (this.deps.requestCompact ? this.deps.requestCompact(threadId) : this.deps.supervisor.request("thread/compact/start", { threadId }))
      .then(() => {
        if (s.attempt !== attempt) return;
        s.acknowledged = true;
        if (s.completed) this.finishAttempt(s);
      })
      .catch((caught: unknown) => {
        if (!s.compacting || s.attempt !== attempt) return;
        // Promise rejection values are runtime input. Do not let a string/null
        // rejection throw again while reading `.message`, and do not echo an
        // arbitrary value that could contain provider response data.
        const err = caught instanceof Error
          ? caught
          : new Error("compaction request rejected without an Error");
        process.stderr.write(`[auto-compact] ${threadId.slice(0, 8)} failed: ${err.message}\n`);
        const definite = (err as any)?.delivery === "rejected" || isDefiniteAppServerRejection(err);
        if (definite) { s.acknowledged = true; this.finishAttempt(s); } // only an explicit rejection permits a fresh trigger
        else { s.uncertain = true; if (s.watchdog) clearTimeout(s.watchdog); s.watchdog = null; }
        this.deps.notify("thread/autoCompactFailed", { threadId, error: err.message, outcome: definite ? "rejected" : "unknown" });
      });
  }

  private finishAttempt(s: ThreadState): void {
    if (s.watchdog) clearTimeout(s.watchdog);
    s.watchdog = null;
    if (s.uncertain) return; // late completion cannot authorize an automatic retry
    if (s.compacting && !s.acknowledged) { s.completed = true; return; }
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
