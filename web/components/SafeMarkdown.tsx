import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export const RENDER_LIMITS = {
  markdownChars: 80_000,
  markers: 12_000,
  nodes: 8_000,
  depth: 32,
  textPage: 24_000,
};

export function markdownWithinBudget(text: string): boolean {
  if (text.length > RENDER_LIMITS.markdownChars) return false;
  let markers = 0,
    brackets = 0;
  for (const char of text) {
    if ('[]*_~`>#|\\'.includes(char) && ++markers > RENDER_LIMITS.markers) return false;
    if (char === '[' && ++brackets > RENDER_LIMITS.depth) return false;
    if (char === ']') brackets = Math.max(0, brackets - 1);
  }
  for (const line of text.split('\n')) {
    const prefix = line.match(/^[ >\t]*/)?.[0] ?? '';
    if (
      (prefix.match(/>/g)?.length ?? 0) > RENDER_LIMITS.depth ||
      prefix.replaceAll('\t', '    ').length > RENDER_LIMITS.depth * 4
    )
      return false;
  }
  return true;
}

// Both the parser input and its output need a budget. Walk iteratively so the
// checker itself cannot overflow on an unexpectedly deep syntax tree.
export function boundedMarkdownTree() {
  return (tree: unknown) => {
    const pending = [{ node: tree, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const { node, depth } = pending.pop()!;
      if (++nodes > RENDER_LIMITS.nodes || depth > RENDER_LIMITS.depth)
        throw new Error('Markdown rendering budget exceeded');
      if (node && typeof node === 'object' && 'children' in node && Array.isArray(node.children)) {
        for (const child of node.children) pending.push({ node: child, depth: depth + 1 });
      }
    }
  };
}

function downloadText(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  // Keep the URL alive until the browser has consumed the click.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function PlainText({ text, name = 'message.txt' }: { text: string; name?: string }) {
  const [page, setPage] = useState(0);
  const ranges = useMemo(() => {
    const result: [number, number][] = [];
    let start = 0;
    do {
      let end = Math.min(text.length, start + RENDER_LIMITS.textPage);
      if (
        end < text.length &&
        /[\uD800-\uDBFF]/u.test(text[end - 1]!) &&
        /[\uDC00-\uDFFF]/u.test(text[end]!)
      )
        end--;
      result.push([start, end]);
      start = end;
    } while (start < text.length);
    return result;
  }, [text]);
  const pages = ranges.length;
  const current = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [name]);
  return (
    <div className="stack">
      <pre className="raw">{text.slice(...ranges[current]!)}</pre>
      {pages > 1 && (
        <div className="inline wrap">
          <span className="small muted">
            完整内容共 {pages} 页，当前第 {current + 1} 页
          </span>
          <button
            className="button small"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一页文本
          </button>
          <button
            className="button small"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            下一页文本
          </button>
          <button className="button small" onClick={() => downloadText(text, name)}>
            下载完整文本
          </button>
        </div>
      )}
    </div>
  );
}

class MarkdownBoundary extends Component<
  { text: string; children: ReactNode },
  { failed: boolean; text: string }
> {
  state = { failed: false, text: this.props.text };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { text: string }, state: { text: string }) {
    return props.text === state.text ? null : { failed: false, text: props.text };
  }
  render() {
    return this.state.failed ? (
      <div className="stack">
        <p className="small muted" role="status">
          此条内容无法安全排版，已改为完整纯文本分页。
        </p>
        <PlainText text={this.props.text} />
      </div>
    ) : (
      this.props.children
    );
  }
}

export function SafeMarkdown({ text }: { text: string }) {
  if (!markdownWithinBudget(text))
    return (
      <div className="stack">
        <p className="small muted" role="status">
          此条内容较长或结构复杂，已改为完整纯文本分页。
        </p>
        <PlainText text={text} />
      </div>
    );
  return (
    <MarkdownBoundary text={text}>
      <div className="markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm, boundedMarkdownTree]}
          components={{
            a: ({ children, href }) => (
              <a href={href} target="_blank" rel="noreferrer">
                {children}
              </a>
            ),
            img: ({ alt }) => (
              <span className="image-placeholder">[图片：{alt || '远程图片'}]</span>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </MarkdownBoundary>
  );
}

export function Diff({ text }: { text: string }) {
  const [page, setPage] = useState(0);
  const { lines, ranges } = useMemo(() => {
    const lines = text.split('\n'),
      ranges: [number, number][] = [];
    let start = 0,
      chars = 0;
    for (let index = 0; index < lines.length; index++) {
      const length = lines[index]!.length + 1;
      if (index > start && (index - start >= 200 || chars + length > RENDER_LIMITS.textPage)) {
        ranges.push([start, index]);
        start = index;
        chars = 0;
      }
      chars += length;
    }
    ranges.push([start, lines.length]);
    return { lines, ranges };
  }, [text]);
  const pages = ranges.length;
  const current = Math.min(page, pages - 1);
  useEffect(() => setPage(0), [text]);
  if (lines.some((line) => line.length >= RENDER_LIMITS.textPage))
    return (
      <div className="stack">
        <p className="small muted">Diff 含有超长行，已改为完整纯文本分页。</p>
        <PlainText text={text} name="changes.diff" />
      </div>
    );
  return (
    <div>
      <pre className="diff">
        {lines.slice(...ranges[current]!).map((line, i) => (
          <span
            key={i}
            className={
              line.startsWith('+') && !line.startsWith('+++')
                ? 'diff-add'
                : line.startsWith('-') && !line.startsWith('---')
                  ? 'diff-remove'
                  : line.startsWith('@@')
                    ? 'diff-hunk'
                    : ''
            }
          >
            {line}
            {'\n'}
          </span>
        ))}
      </pre>
      {pages > 1 && (
        <div className="inline wrap">
          <span className="small muted">
            完整 Diff 共 {lines.length} 行，当前第 {current + 1} / {pages} 页
          </span>
          <button
            className="button small"
            disabled={current === 0}
            onClick={() => setPage(current - 1)}
          >
            上一页 Diff
          </button>
          <button
            className="button small"
            disabled={current + 1 === pages}
            onClick={() => setPage(current + 1)}
          >
            下一页 Diff
          </button>
          <button className="button small" onClick={() => downloadText(text, 'changes.diff')}>
            下载完整 Diff
          </button>
        </div>
      )}
    </div>
  );
}
