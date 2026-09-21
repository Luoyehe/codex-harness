const DEFAULT_MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_LIVE_BYTES = 50 * 1024 * 1024;
const DECODE_CHUNK_CHARS = 256 * 1024;
const IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export interface HistoricalImageLease {
  url: string;
  bytes: number;
  release(): void;
}

function decodedByteLength(base64: string): number {
  if (!base64 || base64.length % 4 !== 0) throw new Error("历史图片编码格式无效");
  let padding = 0;
  if (base64.endsWith("==")) padding = 2;
  else if (base64.endsWith("=")) padding = 1;
  return base64.length / 4 * 3 - padding;
}

function validBase64(value: string): boolean {
  let paddingStarted = false;
  let padding = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 61) {
      paddingStarted = true;
      padding += 1;
      if (padding > 2 || index < value.length - 2) return false;
      continue;
    }
    if (paddingStarted) return false;
    if (!(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) && !(code >= 48 && code <= 57) && code !== 43 && code !== 47) return false;
  }
  return true;
}

export class HistoricalImageUrlPool {
  private liveBytes = 0;

  constructor(
    private readonly maxLiveBytes = DEFAULT_MAX_LIVE_BYTES,
    private readonly maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
  ) {}

  acquire(base64: string, mime: string): HistoricalImageLease {
    if (typeof base64 !== "string" || typeof mime !== "string" || !IMAGE_MIMES.has(mime)) {
      throw new Error("历史图片响应格式无效");
    }
    const bytes = decodedByteLength(base64);
    if (bytes <= 0 || bytes > this.maxImageBytes || !validBase64(base64)) throw new Error("历史图片超过解码预算或编码无效");
    if (this.liveBytes + bytes > this.maxLiveBytes) throw new Error("历史图片内存预算已满，请关闭其他图片或会话后重试");
    this.liveBytes += bytes;
    try {
      const parts: Uint8Array[] = [];
      for (let offset = 0; offset < base64.length; offset += DECODE_CHUNK_CHARS) {
        const binary = atob(base64.slice(offset, offset + DECODE_CHUNK_CHARS));
        const part = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index++) part[index] = binary.charCodeAt(index);
        parts.push(part);
      }
      const url = URL.createObjectURL(new Blob(parts, { type: mime }));
      let released = false;
      return {
        url,
        bytes,
        release: () => {
          if (released) return;
          released = true;
          this.liveBytes = Math.max(0, this.liveBytes - bytes);
          try { URL.revokeObjectURL(url); } catch { /* Browser may be tearing down. */ }
        },
      };
    } catch (error) {
      this.liveBytes = Math.max(0, this.liveBytes - bytes);
      throw error;
    }
  }

  /** Test/diagnostic visibility without exposing mutable accounting. */
  get retainedBytes(): number { return this.liveBytes; }
}

export const historicalImageUrls = new HistoricalImageUrlPool();
