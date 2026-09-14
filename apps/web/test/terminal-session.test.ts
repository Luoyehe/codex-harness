import { afterEach, describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import type { FitAddon } from "@xterm/addon-fit";
import { TerminalSession } from "../src/utils/terminal-session";
import { deferred } from "./fixtures";

function fixture() {
  let resize = () => {};
  let data = (_text: string) => {};
  let observe = () => {};
  let frame = () => {};
  let geometry = { cols: 120, rows: 40 };
  const disconnect = vi.fn();
  const disposeListener = vi.fn();
  const order: string[] = [];
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { observe = callback; }
    observe() {}
    disconnect = disconnect;
  });
  vi.stubGlobal("requestAnimationFrame", vi.fn((callback: () => void) => { frame = callback; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const term = {
    cols: 80, rows: 24,
    onData(callback: typeof data) { data = callback; return { dispose: disposeListener }; },
    onResize(callback: typeof resize) { order.push("listen"); resize = callback; return { dispose: disposeListener }; },
    open: vi.fn(), focus: vi.fn(), write: vi.fn(), writeln: vi.fn(), dispose: vi.fn(),
  };
  const fit = { fit: vi.fn(() => {
    order.push("fit");
    if (term.cols === geometry.cols && term.rows === geometry.rows) return;
    Object.assign(term, geometry); resize();
  }) };
  const container = { style: { display: "" }, remove: vi.fn() };
  const create = deferred<{ processId: string }>();
  const rpc = vi.fn((method: string, _params?: Record<string, unknown>) => method === "terminal/exec" ? create.promise : Promise.resolve({}));
  const exited = vi.fn();
  const session = new TerminalSession(term as unknown as Terminal, fit as unknown as FitAddon, container as unknown as HTMLDivElement, rpc as ConstructorParameters<typeof TerminalSession>[3], exited);
  return { session, term, fit, container, rpc, exited, create, disconnect, disposeListener, order,
    observe: () => observe(), flushFrame: () => frame(), data: (text: string) => data(text),
    geometry: (cols: number, rows: number) => { geometry = { cols, rows }; },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("terminal bounded ordered byte transport", () => {
  it("chunks multi-byte pastes beyond 64 KiB and serializes subsequent keystrokes without loss", async () => {
    const f = fixture(); const starting = f.session.start(null);
    f.create.resolve({ processId: f.session.processId }); await starting;
    const acknowledged = deferred<{}>();
    f.rpc.mockImplementation((method) => method === "terminal/write" ? acknowledged.promise : Promise.resolve({}));
    const paste = "中🙂abc".repeat(15_000);
    f.data(paste); f.data("\r");
    expect(f.rpc.mock.calls.filter(([method]) => method === "terminal/write")).toHaveLength(1);
    acknowledged.resolve({});
    for (let index = 0; index < 20; index++) await Promise.resolve();
    const chunks = f.rpc.mock.calls.filter(([method]) => method === "terminal/write").map(([, params]) => atob(String(params?.base64)));
    expect(chunks.every((chunk) => chunk.length <= 32 * 1024)).toBe(true);
    expect(chunks.length).toBeGreaterThan(2);
    expect(new TextDecoder().decode(Uint8Array.from(chunks.join(""), (char) => char.charCodeAt(0)))).toBe(paste + "\r");
    f.session.dispose();
  });

  it("never replays an unacknowledged chunk or executes the remaining suffix", async () => {
    const f = fixture(); const starting = f.session.start(null);
    f.create.resolve({ processId: f.session.processId }); await starting;
    f.rpc.mockImplementation((method) => method === "terminal/write" ? Promise.reject(new Error("connection closed")) : Promise.resolve({}));
    f.data("a".repeat(100_000) + "\r");
    for (let index = 0; index < 5; index++) await Promise.resolve();
    f.data("echo should-not-run\r");
    expect(f.rpc.mock.calls.filter(([method]) => method === "terminal/write")).toHaveLength(1);
    expect(f.term.writeln).toHaveBeenCalledWith(expect.stringContaining("部分内容可能已经执行"));
    f.session.dispose();
  });

  it("refuses oversized input as a whole and stops runaway unrendered output", async () => {
    const f = fixture(); const starting = f.session.start(null);
    f.create.resolve({ processId: f.session.processId }); await starting;
    f.data("x".repeat(1024 * 1024 + 1));
    expect(f.rpc.mock.calls.some(([method]) => method === "terminal/write")).toBe(false);
    expect(f.term.writeln).toHaveBeenCalledWith(expect.stringContaining("本次输入未发送"));
    const data = btoa("x".repeat(1024 * 1024));
    for (let index = 0; index < 5; index++) f.session.handleNotification({ method: "command/exec/outputDelta", params: { processId: f.session.processId, deltaBase64: data, stream: "stdout", capReached: false } });
    expect(f.session.exited).toBe(true);
    expect(f.rpc).toHaveBeenCalledWith("terminal/terminate", { processId: f.session.processId });
    f.session.dispose();
  });
});

describe("terminal startup and geometry", () => {
  it("allocates a valid random UUID when a LAN HTTP context lacks randomUUID", () => {
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0x12) });
    const f = fixture();
    expect(f.session.processId).toBe("12121212-1212-4212-9212-121212121212");
    f.session.dispose();
  });

  it("retains early output and exit received before exec acknowledges the preallocated ID", async () => {
    const f = fixture();
    const starting = f.session.start("P");
    expect(f.rpc).toHaveBeenCalledWith("terminal/exec", { processId: f.session.processId, cols: 120, rows: 40, cwd: "P" });
    f.session.handleNotification({ method: "command/exec/outputDelta", params: { processId: f.session.processId, deltaBase64: btoa("startup output"), stream: "stdout", capReached: false } });
    f.session.handleNotification({ method: "terminal/exited", params: { processId: f.session.processId, exitCode: 1, error: "synthetic failure" } });
    f.create.resolve({ processId: f.session.processId }); await starting;
    expect(f.term.write).toHaveBeenCalledWith(new TextEncoder().encode("startup output"), expect.any(Function));
    expect(f.session.exited).toBe(true); expect(f.exited).toHaveBeenCalledOnce();
    expect(f.term.writeln).toHaveBeenCalledWith(expect.stringContaining("synthetic failure"));
    f.data("do not send after exit");
    expect(f.rpc.mock.calls.map(([method]) => method)).toEqual(["terminal/exec"]);
    f.session.dispose();
  });

  it("sends measured creation dimensions and explicitly synchronizes the latest size after creation", async () => {
    const f = fixture();
    expect(f.order).toEqual(["listen", "fit"]);
    const starting = f.session.start(null);
    f.geometry(144, 50); f.observe(); f.flushFrame();
    expect(f.rpc).toHaveBeenCalledTimes(1);
    f.create.resolve({ processId: f.session.processId }); await starting;
    expect(f.rpc).toHaveBeenLastCalledWith("terminal/resize", { processId: f.session.processId, cols: 144, rows: 50 });
    f.geometry(160, 60); f.observe(); f.observe();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    f.flushFrame();
    expect(f.rpc).toHaveBeenLastCalledWith("terminal/resize", { processId: f.session.processId, cols: 160, rows: 60 });
    f.session.dispose();
    expect(f.disconnect).toHaveBeenCalledOnce(); expect(f.disposeListener).toHaveBeenCalledTimes(2);
    expect(f.container.remove).toHaveBeenCalledOnce(); expect(f.term.dispose).toHaveBeenCalledOnce();
  });

  it("fits a formerly hidden tab and cancels pending geometry work on disposal", async () => {
    const f = fixture(); const starting = f.session.start(null);
    f.create.resolve({ processId: f.session.processId }); await starting;
    f.container.style.display = "none"; f.geometry(200, 80); f.observe(); f.flushFrame();
    expect(f.term.cols).toBe(120);
    f.container.style.display = ""; f.session.fitVisible();
    expect(f.rpc).toHaveBeenLastCalledWith("terminal/resize", { processId: f.session.processId, cols: 200, rows: 80 });
    f.observe(); f.session.dispose(); f.session.dispose();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(f.rpc.mock.calls.filter(([method]) => method === "terminal/terminate")).toHaveLength(1);
  });

  it("cleans up a creation acknowledged after its view was disposed", async () => {
    const f = fixture(); const starting = f.session.start(null); f.session.dispose();
    f.create.resolve({ processId: f.session.processId }); await starting;
    expect(f.term.dispose).toHaveBeenCalledOnce();
    expect(f.rpc).toHaveBeenLastCalledWith("terminal/terminate", { processId: f.session.processId });
    expect(f.rpc.mock.calls.some(([method]) => method === "terminal/resize")).toBe(false);
  });
});
