import { useRef, useState } from 'react';
import type { Api } from '../lib/api';
import { composing } from '../lib/types';
import { useWorkflow } from '../hooks/useWorkflow';
import { Dialog } from './Dialog';
type Props = { api: Api; threadId: string; name: string; onClose: () => void; onSaved: () => void };
export function RenameDialog(props: Props) {
  return <RenameForm key={props.threadId} {...props} />;
}
function RenameForm({ api, threadId, name: initial, onClose, onSaved }: Props) {
  const [name, setName] = useState(initial),
    running = useRef(false);
  const action = useWorkflow(api, threadId, true, onSaved);
  const frozen = action.busy || ['pending', 'unknown'].includes(action.operation?.state ?? '');
  const close = () => {
    if (!running.current) onClose();
  };
  const submit = async () => {
    if (running.current || action.disabled || !name.trim()) return;
    running.current = true;
    try {
      if (await action.run('thread/name/set', { threadId, name: name.trim() })) onClose();
    } finally {
      running.current = false;
    }
  };
  return (
    <Dialog title="重命名会话" onClose={close}>
      <form
        className="stack"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && composing(e)) e.preventDefault();
        }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <fieldset className="submission-fields stack" disabled={frozen}>
          <label className="field">
            会话名称
            <input
              autoFocus
              value={name}
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </label>
        </fieldset>
        {action.error && (
          <p className="error" role="alert">
            {action.error}
          </p>
        )}
        {action.notice && (
          <p className="small muted" role="status">
            {action.notice}
          </p>
        )}
        <button className="button primary" type="submit" disabled={action.disabled || !name.trim()}>
          保存名称
        </button>
      </form>
    </Dialog>
  );
}
