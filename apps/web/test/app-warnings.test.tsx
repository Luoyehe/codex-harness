import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({
  state: {
    bootstrap: vi.fn(),
    connection: "open" as const,
    connectionError: null as string | null,
    appStatusLoad: { state: "loaded" as const, error: null as string | null },
    refresh: vi.fn(),
    codexState: "ready",
    sidebarOpen: false,
    setSidebarOpen: vi.fn(),
    globalWarnings: [{ id: "warning-1", message: "visible server warning" }],
    dismissGlobalWarning: vi.fn(),
  },
}));

vi.mock("../src/store", () => ({ useStore: (selector: (state: typeof model.state) => unknown) => selector(model.state) }));
vi.mock("../src/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../src/components/Timeline", () => ({ Timeline: () => null }));
vi.mock("../src/components/Composer", () => ({ Composer: () => null }));
vi.mock("../src/components/Drawer", () => ({ Drawer: () => null }));
vi.mock("../src/components/LoginModal", () => ({ LoginModal: () => null }));
vi.mock("../src/components/SettingsModal", () => ({ SettingsModal: () => null }));

import { App } from "../src/App";

it("renders global server warnings and offers an explicit dismissal", () => {
  let renderer!: ReactTestRenderer;
  act(() => { renderer = create(<App />); });
  const alert = renderer.root.findByProps({ role: "alert" });
  expect(JSON.stringify(renderer.toJSON())).toContain("visible server warning");
  act(() => alert.findByProps({ "aria-label": "关闭警告" }).props.onClick());
  expect(model.state.dismissGlobalWarning).toHaveBeenCalledWith("warning-1");
  act(() => renderer.unmount());
});
