export function downloadBlob(data: Blob, filename: string): void {
  const url = URL.createObjectURL(data),
    link = document.createElement('a');
  link.href = url;
  const basename = filename.split(/[\\/]/).pop() ?? '';
  link.download = basename.replace(/[\x00-\x1f\x7f<>:"|?*]/g, '_').replace(/^\.+|[. ]+$/g, '').slice(0, 200) || 'download';
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Downloads can be handed off asynchronously on mobile browsers. Keep the
    // URL alive for a bounded grace period; never revoke it during the click.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}
export function downloadJson(value: unknown, filename: string): void {
  const text = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(text).length > 1024 * 1024)
    throw new Error('JSON 文件超过 1 MiB 下载上限，请缩小导出范围。');
  downloadBlob(new Blob([text], { type: 'application/json' }), filename);
}
