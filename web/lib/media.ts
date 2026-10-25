import { object, type Item } from './types';
import { workspacePath } from './workspace';

export const MEDIA_BYTES = 4 * 1024 * 1024;
export type MediaSource = { kind: 'image' | 'audio' | 'file'; label: string; path?: string; inline?: string; url?: string; unavailable?: string };
export function mediaSources(item: Item): MediaSource[] {
  const sources: MediaSource[] = [];
  if (item.type === 'userMessage' && Array.isArray(item.content)) for (const raw of item.content.slice(0, 64)) {
    const input = object(raw);
    if (['localImage', 'localAudio'].includes(String(input.type)) && typeof input.path === 'string') sources.push({ kind: input.type === 'localImage' ? 'image' : 'audio', label: input.type === 'localImage' ? '附加图片' : '附加音频', path: input.path });
    if (['image', 'audio'].includes(String(input.type))) sources.push({ kind: input.type as 'image' | 'audio', label: input.type === 'image' ? '附加图片' : '附加音频', ...(typeof input.url === 'string' ? input.url.startsWith('data:') ? { inline: input.url } : { url: input.url } : { unavailable: '原生只提供文件 ID，没有可读取的媒体内容。' }) });
    if (input.type === 'text' && typeof input.text === 'string') {
      const match = /^Attached file ("[^\n]+") is available at ("[^\n]+").$/.exec(input.text);
      if (match) try { const name = JSON.parse(match[1]!), path = JSON.parse(match[2]!); if (typeof name === 'string' && typeof path === 'string') sources.push({ kind: 'file', label: name, path }); } catch { /* Ordinary text remains text. */ }
    }
  }
  if (item.type === 'imageView' && typeof item.path === 'string') sources.push({ kind: 'image', label: '查看的图片', path: item.path });
  if (item.type === 'imageGeneration') sources.push({ kind: 'image', label: '生成的图片', ...(typeof item.result === 'string' && item.result ? /^https?:/.test(item.result) ? { url: item.result } : { inline: item.result } : typeof item.savedPath === 'string' ? { path: item.savedPath } : { unavailable: '原生只提供文件 ID，没有可读取的图片内容。' }) });
  return sources.slice(0, 8);
}
export function projectMediaPath(root: string | undefined, filename: string): string | undefined {
  if (!root || !root.startsWith('/') || !filename.startsWith(root.replace(/\/$/, '') + '/')) return undefined;
  try { return workspacePath(filename.slice(root.replace(/\/$/, '').length + 1)); } catch { return undefined; }
}
export function externalMediaUrl(value: string): string | undefined {
  try { const url = new URL(value); if (url.protocol === 'https:' && !url.username && !url.password && value.length <= 8192) return url.href; } catch { /* Never turn a local path into a remote request. */ }
  return undefined;
}
export function mediaBytes(value: string, allowEmpty = false): Uint8Array {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(value), base64 = match ? match[2]! : value;
  if (base64.length > Math.ceil(MEDIA_BYTES / 3) * 4 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('媒体内容超过 4 MiB 或编码无效。');
  const decoded = atob(base64); if (!decoded.length && !allowEmpty || decoded.length > MEDIA_BYTES) throw new Error('媒体内容为空或超过 4 MiB。');
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}
export function mediaMime(bytes: Uint8Array, kind: 'image' | 'audio' | 'file'): string {
  if (kind === 'file') return 'application/octet-stream';
  const text = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end)), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (kind === 'audio') {
    if (text(0, 4) === 'RIFF' && text(8, 12) === 'WAVE') return 'audio/wav';
    if (text(0, 4) === 'OggS') return 'audio/ogg';
    if (text(0, 3) === 'ID3' || bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224) return 'audio/mpeg';
    if (text(4, 8) === 'ftyp') return 'audio/mp4';
    if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return 'audio/webm';
    throw new Error('不支持此音频格式。支持 WAV、MP3、M4A、WebM 和 Ogg。');
  }
  let width = 0, height = 0, mime = '';
  if (bytes.length >= 24 && bytes[0] === 137 && text(1, 4) === 'PNG' && text(12, 16) === 'IHDR') { mime = 'image/png'; width = view.getUint32(16); height = view.getUint32(20); }
  else if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(text(0, 6))) { mime = 'image/gif'; width = view.getUint16(6, true); height = view.getUint16(8, true); }
  else if (bytes.length >= 30 && text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    mime = 'image/webp'; const little24 = (offset: number) => bytes[offset]! + bytes[offset + 1]! * 256 + bytes[offset + 2]! * 65536;
    if (text(12, 16) === 'VP8X') { width = little24(24) + 1; height = little24(27) + 1; }
    else if (text(12, 16) === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 1 && bytes[25] === 0x2a) { width = view.getUint16(26, true) & 0x3fff; height = view.getUint16(28, true) & 0x3fff; }
    else if (text(12, 16) === 'VP8L' && bytes[20] === 0x2f) { const bits = view.getUint32(21, true); width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1; }
  } else if (bytes[0] === 255 && bytes[1] === 216) {
    mime = 'image/jpeg'; let at = 2;
    while (at + 4 < bytes.length && at < 131072) {
      if (bytes[at++] !== 255) break;
      while (bytes[at] === 255) at++;
      const marker = bytes[at++]; if (marker === undefined || marker === 0xda || marker === 0xd9 || at + 2 > bytes.length) break;
      if (marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      const length = view.getUint16(at); if (length < 2 || at + length > bytes.length) break;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 7) { height = view.getUint16(at + 3); width = view.getUint16(at + 5); break; }
      at += length;
    }
  }
  if (!mime || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 40_000_000) throw new Error('图片格式或尺寸不适合预览。仅支持有界 PNG、JPEG、GIF、WebP；不渲染 SVG 或 HTML。');
  return mime;
}
