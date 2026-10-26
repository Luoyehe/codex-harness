import { useState } from 'react';
import { setEnterBehavior, useEnterBehavior, type EnterBehavior } from '../lib/input-preference';

export function InputPreferences() {
  const behavior = useEnterBehavior(),
    [error, setError] = useState('');
  return (
    <section className="stack">
      <h3>消息输入</h3>
      <label className="field">
        Enter 键行为
        <select
          value={behavior}
          onChange={(event) => {
            const saved = setEnterBehavior(event.target.value as EnterBehavior);
            setError(saved ? '' : '当前页面已采用此设置，但浏览器无法保存；重新打开后请核对。');
          }}
        >
          <option value="send">Enter 发送，Shift + Enter 换行</option>
          <option value="newline">Enter 换行，Ctrl / ⌘ + Enter 发送</option>
        </select>
      </label>
      <p className="small muted">输入法确认不会发送消息。此偏好只保存在当前浏览器。</p>
      {error && (
        <p className="error" role="status">
          {error}
        </p>
      )}
    </section>
  );
}
