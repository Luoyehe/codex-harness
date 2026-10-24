import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  bootstrap: vi.fn(), connection: "open", connectionError: null,
  appStatusLoad: { state: "loaded" }, refresh: vi.fn(), codexState: "ready",
  sidebarOpen: true, setSidebarOpen: vi.fn(), globalWarnings: [], dismissGlobalWarning: vi.fn(),
  currentProject: "/workspace", activeThreadId: null, sessions: [], setDrawerTab: vi.fn(),
}));
vi.mock("../src/store", () => ({ useStore: (selector: (state: typeof model) => unknown) => selector(model) }));
vi.mock("../src/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../src/components/Timeline", () => ({ Timeline: () => null }));
vi.mock("../src/components/Composer", () => ({ Composer: () => null }));
vi.mock("../src/components/Drawer", () => ({ Drawer: () => null }));
vi.mock("../src/components/LoginModal", () => ({ LoginModal: () => null }));
vi.mock("../src/components/SettingsModal", () => ({ SettingsModal: () => null }));

import { App } from "../src/App";
import { Dialog } from "../src/components/Dialog";

type KeyEvent = { key: string; isComposing?: boolean; keyCode?: number; shiftKey?: boolean;
  preventDefault: ReturnType<typeof vi.fn>; stopPropagation: ReturnType<typeof vi.fn> };
let active: FocusNode | null;
class FocusNode {
  tabIndex = 0;
  isConnected = true;
  inert = false;
  constructor(readonly children: FocusNode[] = []) {}
  contains(node: unknown): boolean { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll() { return this.children; }
  getClientRects() { return [{}]; }
  closest() { return null; }
  focus = vi.fn(() => { active = this; });
}
const handlers = new Map<string, Set<(event: any) => void>>();
let view: ReactTestRenderer | undefined;
const keydown = (key: string, composition: Partial<KeyEvent> = {}) => {
  const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...composition };
  act(() => { for (const handler of handlers.get("keydown") ?? []) handler(event); });
  return event;
};
const compositions = [{ isComposing: true, keyCode: 27 }, { isComposing: false, keyCode: 229 }];

beforeEach(() => {
  active = null; handlers.clear(); model.sidebarOpen = true; model.setSidebarOpen.mockReset();
  vi.stubGlobal("HTMLElement", FocusNode);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  vi.stubGlobal("document", {
    get activeElement() { return active; },
    querySelector: () => null,
    addEventListener(type: string, handler: (event: any) => void) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type)!.add(handler);
    },
    removeEventListener(type: string, handler: (event: any) => void) { handlers.get(type)?.delete(handler); },
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) });
});
afterEach(() => {
  if (view) act(() => view!.unmount());
  view = undefined; vi.unstubAllGlobals();
});

describe("dialog composition and focus containment", () => {
  it.each(compositions)("leaves IME confirmation/cancellation untouched and preserves ordinary keys: %j", composition => {
    const opener = new FocusNode(), first = new FocusNode(), last = new FocusNode();
    const node = new FocusNode([first, last]), onClose = vi.fn();
    opener.focus();
    act(() => { view = create(<Dialog label="编辑项目" onClose={onClose}><input /><button>完成</button></Dialog>,
      { createNodeMock: element => element.props.role === "dialog" ? node : null }); });
    expect(active).toBe(first);
    for (const key of ["Enter", "Escape", "Tab"]) {
      const event = keydown(key, composition);
      expect(onClose).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(active).toBe(first);
    }
    expect(keydown("Enter").preventDefault).not.toHaveBeenCalled();
    expect(keydown("Tab", { shiftKey: true }).preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(last);
    expect(keydown("Tab").preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    const escape = keydown("Escape");
    expect(escape.preventDefault).toHaveBeenCalledOnce();
    expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    act(() => view!.unmount()); view = undefined;
    expect(active).toBe(opener);
    expect(handlers.get("keydown")?.size).toBe(0);
  });

  it("still keeps a busy dialog open on ordinary Escape", () => {
    const node = new FocusNode(), onClose = vi.fn();
    act(() => { view = create(<Dialog label="保存中" busy onClose={onClose}>保存中</Dialog>, { createNodeMock: () => node }); });
    expect(keydown("Escape").preventDefault).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("mobile navigation composition and focus containment", () => {
  it.each(compositions)("keeps composing navigation open and preserves normal Escape/Tab: %j", composition => {
    const menu = new FocusNode(), first = new FocusNode(), last = new FocusNode();
    const nav = new FocusNode([first, last]), content = new FocusNode();
    act(() => { view = create(<App />, { createNodeMock: element => {
      if (element.props.id === "workspace-navigation") return nav;
      if (element.props.className === "workspace") return content;
      if (element.props["aria-label"] === "打开导航") return menu;
      return new FocusNode();
    } }); });
    expect(content.inert).toBe(true);
    expect(active).toBe(first);
    for (const key of ["Enter", "Escape", "Tab"]) {
      const event = keydown(key, composition);
      expect(model.setSidebarOpen).not.toHaveBeenCalled();
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(active).toBe(first);
    }
    expect(keydown("Tab", { shiftKey: true }).preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(last);
    expect(keydown("Tab").preventDefault).toHaveBeenCalledOnce();
    expect(active).toBe(first);
    expect(keydown("Escape").preventDefault).toHaveBeenCalledOnce();
    expect(model.setSidebarOpen).toHaveBeenCalledExactlyOnceWith(false);
    expect(active).toBe(menu);
    act(() => view!.unmount()); view = undefined;
    expect(content.inert).toBe(false);
    expect(handlers.get("keydown")?.size).toBe(0);
  });
});
