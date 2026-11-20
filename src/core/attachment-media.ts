const fourCC = (bytes: Uint8Array, offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
const mp4Brands = new Set(['isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'iso7', 'iso8', 'iso9', 'mp41', 'mp42', 'M4V ', 'avc1', 'av01', 'dash', 'MSNV']);

/** Follow bounded ISO BMFF box headers, skipping media payloads without scanning them for magic strings. */
function containerMedia(bytes: Uint8Array, declared: string): string | undefined {
  if (bytes.length < 8) return;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let brand = '', audio = false, video = false, quickTimeHandler = false, remaining = 2048;
  const levels = ['moov', 'trak', 'mdia'];
  function visit(start: number, end: number, depth: number) {
    for (let offset = start; offset + 8 <= end && remaining > 0;) {
      remaining--;
      let size = view.getUint32(offset), header = 8;
      const kind = fourCC(bytes, offset + 4);
      if (size === 1) {
        if (offset + 16 > end || view.getUint32(offset + 8) !== 0) return;
        size = view.getUint32(offset + 12); header = 16;
      } else if (!size) size = end - offset;
      if (size < header || size > end - offset) return;
      const data = offset + header;
      if (depth === 0 && kind === 'ftyp' && size >= header + 8) brand = fourCC(bytes, data);
      if (depth < levels.length && kind === levels[depth]) visit(data, offset + size, depth + 1);
      if (depth === levels.length && kind === 'hdlr' && size >= header + 12) {
        const handler = fourCC(bytes, data + 8);
        if (handler === 'soun') audio = true;
        if (handler === 'vide') video = true;
        if ((handler === 'soun' || handler === 'vide') && fourCC(bytes, data + 4) === 'mhlr') quickTimeHandler = true;
      }
      offset += size;
    }
  }
  visit(0, bytes.length, 0);
  if (['avif', 'avis'].includes(brand)) return 'image/avif';
  if (['heic', 'heix', 'hevc', 'hevx'].includes(brand)) return 'image/heic';
  if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
  if (brand === 'qt  ') return audio && !video ? 'audio/quicktime' : 'video/quicktime';
  if (mp4Brands.has(brand)) {
    if (audio && !video) return 'audio/mp4';
    if (video || declared === 'video/mp4' || declared === 'video/quicktime' || brand === 'M4V ') return 'video/mp4';
  }
  // Classic QuickTime identifies its media handler with mhlr even without a file-type atom.
  if (!brand && quickTimeHandler) return video ? 'video/quicktime' : 'audio/quicktime';
  // A generic video track alone does not distinguish older containers.
  if (!brand && video && ['video/quicktime', 'video/mp4'].includes(declared)) return declared;
}

/** Browser metadata is a hint. Use actual media bytes in both the composer and native upload service. */
export function attachmentMediaType(bytes: Uint8Array, provided: string): string {
  const header = provided.split(';')[0]?.trim().toLowerCase() || 'application/octet-stream';
  const prefix = (...expected: number[]) => expected.every((value, i) => bytes[i] === value);
  if (prefix(137, 80, 78, 71, 13, 10, 26, 10)) return 'image/png';
  if (prefix(255, 216, 255)) return 'image/jpeg';
  if (fourCC(bytes, 0) === 'GIF8' && (bytes[4] === 55 || bytes[4] === 57) && bytes[5] === 97) return 'image/gif';
  if (fourCC(bytes, 0) === 'RIFF' && fourCC(bytes, 8) === 'WEBP') return 'image/webp';
  const container = containerMedia(bytes, header);
  if (container) return container;
  if (['image/png','image/jpeg','image/gif','image/webp','video/quicktime','video/mp4'].includes(header)) return 'application/octet-stream';
  return header;
}

/** Kept stable so old queue entries and transcripts still identify the managed path. */
export const visionReferenceGuidance = '\nDecide whether an available and authorized vision tool can read this file. If the image was not read successfully, say so. Answer any independent text request normally.';
