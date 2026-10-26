export function downloadBlob(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data),
    link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
export function downloadJson(value: unknown, filename: string): void {
  const text = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(text).length > 1024 * 1024)
    throw new Error('诊断摘要超过 1 MiB 下载上限。');
  downloadBlob(new Blob([text], { type: 'application/json' }), filename);
}
