import { useEffect, useRef, useState } from 'react';
import { RpcError, type Api } from '../lib/api';
import { message } from '../lib/types';
import {
  checkedPreview,
  readRotation,
  receiptArchive,
  rotationConfirmed,
  rotationKey,
  type ArchivePreview,
  type RotationIntent,
} from '../lib/receipt-archive';

const blockers: Record<string, string> = {
  activity_uncertain: '执行状态尚未完成核对',
  unresolved_operations: '仍有未完成或结果未知的操作，请先检查回执',
  unresolved_automation_runs: '自动化运行尚未确认结束',
  workspace_witnesses: '文件操作恢复记录尚待核对',
};

export function ReceiptMaintenance({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const [preview, setPreview] = useState<ArchivePreview>(),
    [verified, setVerified] = useState('');
  const [attemptedExport, setAttemptedExport] = useState('');
  const [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [progress, setProgress] = useState(0);
  const [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [intent, setIntent] = useState<RotationIntent>(),
    [storageIssue, setStorageIssue] = useState(false);
  const controller = useRef<AbortController | null>(null),
    mounted = useRef(true),
    running = useRef(false);
  useEffect(() => {
    mounted.current = true;
    try {
      setIntent(readRotation());
    } catch (error) {
      setStorageIssue(true);
      setError(message(error));
    }
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const inspect = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    setConfirmed(false);
    setVerified('');
    setAttemptedExport('');
    const request = new AbortController();
    controller.current = request;
    try {
      const next = checkedPreview(
        await api.call('operation/maintenance/preview', {}, request.signal),
      );
      if (!mounted.current) return;
      setPreview(next);
      api.observeOperationGeneration?.(next.generation);
      if (intent && rotationConfirmed(next, intent)) {
        sessionStorage.removeItem(rotationKey);
        setIntent(undefined);
        setNotice('已通过服务代际和归档摘要确认上次轮换成功。');
        onChanged();
      } else if (intent) setNotice('上次轮换结果仍未能确认。本页只读核对，不会再次发送轮换。');
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const download = async () => {
    if (
      !preview ||
      running.current ||
      busy ||
      intent ||
      storageIssue ||
      attemptedExport === preview.exportId
    )
      return;
    running.current = true;
    setAttemptedExport(preview.exportId);
    setBusy(true);
    setError('');
    setProgress(0);
    setVerified('');
    setConfirmed(false);
    const request = new AbortController();
    controller.current = request;
    try {
      const blob = await receiptArchive(api, preview, request.signal, (loaded) => {
        if (mounted.current) setProgress(loaded);
      });
      if (!mounted.current || request.signal.aborted) return;
      const url = URL.createObjectURL(blob),
        link = document.createElement('a');
      link.href = url;
      link.download = `harness-receipts-generation-${preview.generation}-${preview.digest.slice(0, 12)}.json`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setVerified(preview.digest);
      setNotice('完整归档已校验并交给浏览器下载。请确认文件已保存后再继续。');
    } catch (error) {
      if (mounted.current) setError(message(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const rotate = async () => {
    if (
      !preview ||
      running.current ||
      busy ||
      intent ||
      storageIssue ||
      preview.blocked.length ||
      verified !== preview.digest ||
      !confirmed
    )
      return;
    running.current = true;
    const pending: RotationIntent = {
      generation: preview.generation,
      nextGeneration: preview.nextGeneration,
      digest: preview.digest,
      exportId: preview.exportId,
    };
    setBusy(true);
    setError('');
    try {
      const raw = JSON.stringify(pending);
      sessionStorage.setItem(rotationKey, raw);
      if (sessionStorage.getItem(rotationKey) !== raw)
        throw new Error('无法保存维护恢复标识，尚未发送轮换。');
      setIntent(pending);
      const result = await api.call('operation/maintenance/rotate', {
        exportId: pending.exportId,
        digest: pending.digest,
        nextGeneration: pending.nextGeneration,
        exportedDigest: verified,
        confirm: true,
      });
      if (
        result.rotated !== true ||
        result.generation !== pending.nextGeneration ||
        result.archivedDigest !== pending.digest
      )
        throw new Error('轮换响应无法核对，请只查询原维护结果。');
      sessionStorage.removeItem(rotationKey);
      if (mounted.current) {
        setIntent(undefined);
        setPreview(undefined);
        setVerified('');
        setConfirmed(false);
        setNotice('回执已归档并完成代际轮换。旧操作只会查询归档状态，不会重发。');
        onChanged();
      }
    } catch (error) {
      if (error instanceof RpcError && error.delivery === 'not_sent') {
        try {
          sessionStorage.removeItem(rotationKey);
          if (mounted.current) {
            setIntent(undefined);
            setPreview(undefined);
            setVerified('');
            setConfirmed(false);
          }
        } catch {
          if (mounted.current) setStorageIssue(true);
        }
      }
      if (mounted.current) setError(message(error));
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="info-card stack" aria-label="回执容量维护">
      <div className="section-heading">
        <h3>回执容量维护</h3>
        <button
          className="button small"
          disabled={busy || storageIssue}
          onClick={() => void inspect()}
        >
          {intent ? '核对上次轮换结果' : '读取容量与归档预览'}
        </button>
      </div>
      <p className="small muted">
        先完整导出并校验回执归档，再确认轮换。存在未知结果或运行中操作时禁止维护。归档文件可能包含任务内容，请妥善保存。
      </p>
      {preview && (
        <>
          <p>
            代际 {preview.generation} · 回执 {preview.receipts} 条 · 撤回记录 {preview.retirements}{' '}
            条 · {(preview.bytes / 1024).toFixed(1)} KiB
          </p>
          {preview.blocked.length > 0 && (
            <p role="alert" className="workspace-warning">
              暂不能轮换：{preview.blocked.map((reason) => blockers[reason] ?? reason).join('；')}
            </p>
          )}
          <button
            className="button"
            disabled={
              busy || Boolean(intent) || storageIssue || attemptedExport === preview.exportId
            }
            onClick={() => void download()}
          >
            下载并校验完整回执归档
          </button>
          {!busy && attemptedExport === preview.exportId && (
            <p className="small muted">
              若需再次下载，请先重新读取归档预览；每次导出需完整按序读取。
            </p>
          )}
          {progress > 0 && (
            <p role="status">
              已读取 {progress.toLocaleString()} / {preview.bytes.toLocaleString()} 字节
            </p>
          )}
          <label className="check-row">
            <input
              type="checkbox"
              disabled={
                busy || Boolean(intent) || verified !== preview.digest || preview.blocked.length > 0
              }
              checked={confirmed}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已保存校验通过的完整归档，确认轮换回执代际
          </label>
          <button
            className="button danger"
            disabled={
              busy ||
              Boolean(intent) ||
              storageIssue ||
              !confirmed ||
              verified !== preview.digest ||
              preview.blocked.length > 0
            }
            onClick={() => void rotate()}
          >
            确认归档并轮换
          </button>
        </>
      )}
      {intent && (
        <p className="workspace-warning">
          已记录维护请求，结果尚待确认。不能重复提交；请使用“核对上次轮换结果”。
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </section>
  );
}
