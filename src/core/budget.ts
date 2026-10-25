import { HarnessError } from './errors.js';
export class Budget {
  #count = 0; #bytes = 0;
  constructor(readonly maxCount: number, readonly maxBytes: number) {}
  acquire(bytes: number): () => void {
    const reservation = this.reserve();
    try { reservation.add(bytes); return reservation.release; }
    catch (error) { reservation.release(); throw error; }
  }
  reserve(): { add: (bytes: number) => void; release: () => void } {
    if (this.#count >= this.maxCount)
      throw new HarnessError('capacity', '服务正在处理较多内容，请稍后重试。');
    this.#count++; let charged = 0; let released = false;
    return {
      add: bytes => {
        if (released || !Number.isSafeInteger(bytes) || bytes < 0 || this.#bytes + bytes > this.maxBytes)
          throw new HarnessError('capacity', '服务正在处理较多内容，请稍后重试。');
        charged += bytes; this.#bytes += bytes;
      },
      release: () => { if (!released) { released = true; this.#count--; this.#bytes -= charged; } },
    };
  }
  get usage(): { count: number; bytes: number } { return { count: this.#count, bytes: this.#bytes }; }
}
