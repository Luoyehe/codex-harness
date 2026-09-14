import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeDispatcher } from "../src/api.js";
import { runScript, scheduleServiceRestart } from "../src/admin.js";

vi.mock("../src/admin.js", async (original) => ({
  ...await original<typeof import("../src/admin.js")>(),
  runScript: vi.fn(),
  scheduleServiceRestart: vi.fn().mockResolvedValue(undefined),
}));

const dispatch = () => makeDispatcher({ supervisor: {} } as any);
beforeEach(() => { vi.clearAllMocks(); });

describe("provider management outcomes", () => {
  it("does not restart an unchanged provider setup", async () => {
    vi.mocked(runScript).mockResolvedValue({ code: 0, output: '[codex-harness-result] {"changed":false,"restartRequired":false}\n' });
    await expect(dispatch()("admin/provider/switch", { mode: "openai" })).resolves.toMatchObject({
      ok: true, changed: false, restartRequired: false, restarting: false,
    });
    expect(scheduleServiceRestart).not.toHaveBeenCalled();
  });

  it("reports and schedules an actual provider change", async () => {
    vi.mocked(runScript).mockResolvedValue({ code: 0, output: '[codex-harness-result] {"changed":true,"restartRequired":true}\n' });
    await expect(dispatch()("admin/provider/switch", { mode: "openai" })).resolves.toMatchObject({
      ok: true, changed: true, restartRequired: true, restarting: true,
    });
    expect(scheduleServiceRestart).toHaveBeenCalledTimes(1);
  });

  it("never restarts a failed setup even if its output contains a success marker", async () => {
    vi.mocked(runScript).mockResolvedValue({ code: 1, output: '[codex-harness-result] {"changed":true,"restartRequired":true}\n' });
    await expect(dispatch()("admin/provider/switch", { mode: "openai" })).resolves.toMatchObject({
      ok: false, changed: false, restartRequired: false, restarting: false,
    });
    expect(scheduleServiceRestart).not.toHaveBeenCalled();
  });

  it("keeps old edge RPCs read-only and directs users to server-side administration", async () => {
    for (const params of [{ disable: true }, { domain: "fixture.example", tls: "auto" }]) {
      await expect(dispatch()("admin/edge/config", params)).resolves.toMatchObject({
        ok: false, changed: false, restartRequired: false, restarting: false,
        output: expect.stringContaining("sudo codex-harness edge"),
      });
    }
    expect(runScript).not.toHaveBeenCalled();
    expect(scheduleServiceRestart).not.toHaveBeenCalled();
  });
});
