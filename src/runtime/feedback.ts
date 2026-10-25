import path from 'node:path';
import { DeliveryError, jsonBytes, object, onlyKeys, string, type CallContext, type JsonObject, type JsonValue } from './types.js';
import { validateOfficial } from './validation.js';
type Call = (method: string, params: JsonValue) => Promise<JsonValue>;
export class Feedback {
  constructor(private native: Call) {}
  async submit(method: string, params: JsonObject, context: CallContext, write: Call): Promise<JsonValue> {
    const save = method === 'feedback/save';
    onlyKeys(params, ['cwd', 'classification', 'reason', 'threadId', 'includeLogs', 'confirm']);
    if (params.confirm !== true || typeof params.includeLogs !== 'boolean') throw new DeliveryError('invalid_params', 'Confirm the feedback destination and explicitly choose whether to include logs');
    const cwd = string(params.cwd, 'cwd'), classification = string(params.classification, 'classification', 128);
    if (!['bug', 'good_result', 'bad_result', 'other'].includes(classification)) throw new DeliveryError('invalid_params', 'Choose a feedback category');
    const body: JsonObject = { classification, reason: params.reason === undefined ? null : string(params.reason, 'reason', 16 * 1024, true), threadId: null, includeLogs: params.includeLogs, extraLogFiles: [], tags: { client: 'codex-harness' } };
    {
      const threadId = string(params.threadId, 'threadId', 256), result = await this.native('thread/read', { threadId, includeTurns: false }); validateOfficial('ThreadReadResponse', result);
      const thread = object(object(result).thread); if (thread.id !== threadId || thread.cwd !== cwd) throw new DeliveryError('feedback_scope', 'Feedback conversation must belong to the selected registered project'); body.threadId = threadId;
    }
    const id = string(context.operationId, 'operationId', 36);
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) throw new DeliveryError('invalid_params', 'Feedback requires a durable operation id');
    const filename = '.harness-feedback-' + id + '.zip'; if (save) body.savePath = path.join(cwd, filename);
    validateOfficial(save ? 'FeedbackSaveParams' : 'FeedbackUploadParams', body); jsonBytes(body, 24 * 1024);
    const response = await write(method, body);
    try {
      validateOfficial(save ? 'FeedbackSaveResponse' : 'FeedbackUploadResponse', response); const result = object(response);
      if (save && result.savedPath !== body.savePath) throw new Error('Feedback path mismatch');
      return { feedbackId: id, threadId: result.threadId!, promptHash: result.promptHash!, ...(save ? { path: filename, saved: true } : { uploaded: true }) };
    } catch { throw new DeliveryError('feedback_unknown', 'Feedback was sent without a valid acknowledgement; inspect the original operation', 'unknown'); }
  }
}
