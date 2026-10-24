import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/store", () => ({ useStore: () => undefined }));
import { ItemView } from "../src/components/Timeline";

describe("Codex 0.164 item compatibility", () => {
  it("shows generated file identifiers without fetching them or dropping older inline images", () => {
    const item = { type: "imageGeneration" as const, id: "image", status: "completed", revisedPrompt: null, failure: null };
    const html = renderToStaticMarkup(<ItemView item={{ ...item, fileId: "file-new", savedPath: "/outputs/new.png" }} />);
    expect(html).toContain("file-new"); expect(html).toContain("/outputs/new.png"); expect(html).not.toContain("<img");
    expect(renderToStaticMarkup(<ItemView item={{ ...item, result: "data:image/png;base64,iVBORw0KGgo=" }} />)).toContain('<img src="data:image/png;base64,');
  });

  it("renders function text, image, audio and encrypted content without remote auto-fetches", () => {
    const html = renderToStaticMarkup(<ItemView item={{ type: "functionCallOutput", id: "call", name: "inspect", namespace: "tools", output: [
      { type: "input_text", text: "verified result" },
      { type: "input_image", image_url: "https://example.test/image.png" },
      { type: "input_image", file_id: "file-image" },
      { type: "input_audio", audio_url: "https://example.test/audio.wav" },
      { type: "encrypted_content", encrypted_content: "do-not-show-ciphertext" },
    ] }} />);
    expect(html).toContain("tools."); expect(html).toContain("verified result"); expect(html).toContain("file-image");
    expect(html).toContain('href="https://example.test/image.png"');
    expect(html).toContain('href="https://example.test/audio.wav"');
    expect(html).not.toContain('<img'); expect(html).not.toContain('<audio'); expect(html).not.toContain("do-not-show-ciphertext");
  });

  it("bounds function output items without reading an untrusted tail", () => {
    const output: any[] = Array.from({ length: 100 }, () => ({ type: "input_text", text: "ok" }));
    Object.defineProperty(output, "100", { get() { throw new Error("tail read"); } });
    const html = renderToStaticMarkup(<ItemView item={{ type: "functionCallOutput", id: "call", name: "inspect", namespace: null, output }} />);
    expect(html).toContain("浏览器预算"); expect(html).toContain("101");
  });

  it("displays plain string output and rejects non-http external media", () => {
    const item = { type: "functionCallOutput" as const, id: "call", name: "inspect", namespace: null };
    expect(renderToStaticMarkup(<ItemView item={{ ...item, output: "plain output" }} />)).toContain("plain output");
    const html = renderToStaticMarkup(<ItemView item={{ ...item, output: [{ type: "input_image", image_url: "javascript:alert(1)" }] }} />);
    expect(html).not.toContain("javascript:"); expect(html).not.toContain("<img");
  });

  it("bounds the aggregate content preview and makes malformed output visible", () => {
    const item = { type: "functionCallOutput" as const, id: "call", name: "inspect", namespace: null };
    const output = Array.from({length: 100}, () => ({type: "input_text" as const, text: "x".repeat(200_000)}));
    const html = renderToStaticMarkup(<ItemView item={{ ...item, output }} />);
    expect(html.length).toBeLessThan(1_100_000);
    expect(html).toContain("总预览预算");
    expect(renderToStaticMarkup(<ItemView item={{ ...item, output: {} as never }} />)).toContain("格式无效");
  });
});
