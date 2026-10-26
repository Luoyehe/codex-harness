// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prompts } from '../components/Prompts';
import { schemaSupported, validateValue } from '../lib/prompt-validation';
import type { Api } from '../lib/api';
import { Events } from '../lib/events';
import { usePrompts } from '../hooks/usePrompts';
import type { PromptRecord } from '../lib/types';
afterEach(cleanup);

describe('pending answer ownership', () => {
  it('locks the submitted question until the real prompt hook removes its acknowledgement', async () => {
    let resolve!: (value: unknown) => void;
    const pending = new Promise((accept) => {
      resolve = accept;
    });
    const prompt: PromptRecord = {
      promptId: 'pending',
      method: 'item/tool/requestUserInput',
      params: { questions: [{ id: 'q', header: '需求', question: '说明要求' }] },
    };
    const api = {
      call: vi.fn().mockResolvedValue({ prompts: [prompt] }),
      mutate: vi.fn().mockReturnValue(pending),
    } as unknown as Api;
    const events = new Events(),
      user = userEvent.setup();
    function Host() {
      const value = usePrompts(api, events, 'epoch');
      return <Prompts prompts={value.prompts} onAnswer={value.answer} />;
    }
    render(<Host />);
    const input = (await screen.findByRole('textbox', { name: '需求：答案' })) as HTMLInputElement;
    await user.type(input, 'answer A');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(input.matches(':disabled')).toBe(true);
    await user.type(input, 'unsent B');
    expect(input.value).toBe('answer A');
    fireEvent.submit(input.closest('form')!);
    expect(api.mutate).toHaveBeenCalledOnce();
    expect(api.mutate).toHaveBeenCalledWith('prompt/answer', {
      promptId: 'pending',
      response: { answers: { q: { answers: ['answer A'] } } },
    });
    await act(async () => resolve({}));
    expect(screen.queryByRole('textbox')).toBeNull();
  });
  it('unlocks the same question and preserves its secret other answer after a failed submission', async () => {
    let reject!: (error: Error) => void;
    const answer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              questions: [
                {
                  id: 'q',
                  header: '选择',
                  question: '说明',
                  isOther: true,
                  isSecret: true,
                  options: [{ label: '默认' }],
                },
              ],
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    const select = screen.getByRole('combobox', { name: '选择' });
    await user.selectOptions(select, screen.getByRole('option', { name: '其他' }));
    const input = screen.getByLabelText('选择：其他答案') as HTMLInputElement;
    await user.type(input, 'test-only answer');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(select.matches(':disabled')).toBe(true);
    expect(input.matches(':disabled')).toBe(true);
    await act(async () => reject(new Error('not sent')));
    expect(screen.getByRole('alert').textContent).toContain('not sent');
    expect(input.matches(':disabled')).toBe(false);
    expect(select.matches(':disabled')).toBe(false);
    expect(input.value).toBe('test-only answer');
    await user.type(input, ' revised');
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toHaveBeenLastCalledWith('p', {
      answers: { q: { answers: ['test-only answer revised'] } },
    });
  });
  it.each([
    [
      'structured MCP',
      {
        mode: 'form',
        requestedSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, enabled: { type: 'boolean' } },
        },
      },
      'mcpServer/elicitation/request',
      '确认',
    ],
    [
      'permissions',
      { permissions: { fileSystem: { write: ['/fixture'] } } },
      'item/permissions/requestApproval',
      '授予所选权限',
    ],
    [
      'URL confirmation',
      { mode: 'url', url: 'https://example.invalid/authorize' },
      'mcpServer/elicitation/request',
      '确认',
    ],
  ] as const)(
    'locks all %s controls until a failed answer returns',
    async (_name, params, method, button) => {
      let reject!: (error: Error) => void;
      const answer = vi.fn(
        () =>
          new Promise<void>((_, fail) => {
            reject = fail;
          }),
      );
      const user = userEvent.setup();
      const view = render(
        <Prompts prompts={[{ promptId: 'p', method, params }]} onAnswer={answer} />,
      );
      if ('mode' in params && params.mode === 'url')
        await user.click(screen.getByRole('checkbox', { name: '我已完成授权' }));
      const controls = [
        ...view.container.querySelectorAll(
          '.approval-card input,.approval-card select,.approval-card textarea',
        ),
      ];
      const originalDisabled = controls.map((control) => control.matches(':disabled'));
      await user.click(screen.getByRole('button', { name: button }));
      expect(answer).toHaveBeenCalledOnce();
      expect(controls.length).toBeGreaterThan(0);
      expect(controls.every((control) => control.matches(':disabled'))).toBe(true);
      await act(async () => reject(new Error('not sent')));
      expect(controls.map((control) => control.matches(':disabled'))).toEqual(originalDisabled);
    },
  );
});
describe('approval and structured answers', () => {
  it('only presents explicitly available command decisions and keeps objects intact', async () => {
    const response = {
        applyNetworkPolicyAmendment: {
          network_policy_amendment: { host: 'example.org', action: 'allow' },
        },
      },
      onAnswer = vi.fn().mockResolvedValue(undefined);
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/commandExecution/requestApproval',
            params: { availableDecisions: [response, 'decline'] },
          },
        ]}
        onAnswer={onAnswer}
      />,
    );
    expect(screen.queryByRole('button', { name: '允许这一次' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '应用网络规则' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('p', { decision: response }));
  });
  it('uses question ids and hidden other inputs, preserving answers after rejection', async () => {
    const onAnswer = vi.fn().mockRejectedValue(new Error('delivery rejected'));
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              questions: [
                {
                  id: 'auth',
                  header: '凭据',
                  question: '请选择',
                  isOther: true,
                  isSecret: true,
                  options: [{ label: '已有', description: '继续' }],
                },
              ],
            },
          },
        ]}
        onAnswer={onAnswer}
      />,
    );
    fireEvent.change(screen.getByRole('combobox', { name: '凭据' }), {
      target: { value: (screen.getByRole('option', { name: '其他' }) as HTMLOptionElement).value },
    });
    const input = screen.getByLabelText('凭据：其他答案') as HTMLInputElement;
    expect(input.type).toBe('password');
    fireEvent.change(input, { target: { value: 'temporary answer' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await screen.findByText('delivery rejected');
    expect(input.value).toBe('temporary answer');
    expect(onAnswer).toHaveBeenCalledWith('p', {
      answers: { auth: { answers: ['temporary answer'] } },
    });
  });
  it('rejects unsupported extension modes without preventing decline', () => {
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'mcpServer/elicitation/request',
            params: { mode: 'openai/form', requestedSchema: { type: 'object', properties: {} } },
          },
        ]}
        onAnswer={vi.fn()}
      />,
    );
    expect((screen.getByRole('button', { name: '确认' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });
  it('validates false, zero, empty strings and titled multi-select choices correctly', () => {
    const schema = {
      type: 'object',
      required: ['enabled', 'count', 'text', 'choices'],
      properties: {
        enabled: { type: 'boolean' },
        count: { type: 'integer', minimum: 0, maximum: 2 },
        text: { type: 'string', minLength: 0 },
        choices: {
          type: 'array',
          minItems: 1,
          items: {
            anyOf: [
              { const: 'a', title: 'A' },
              { const: 'b', title: 'B' },
            ],
          },
        },
      },
    };
    expect(schemaSupported(schema)).toBe(true);
    expect(validateValue(schema, { enabled: false, count: 0, text: '', choices: ['a'] })).toEqual(
      [],
    );
    expect(
      validateValue(schema, { enabled: false, count: 0, text: '', choices: ['outside'] }).length,
    ).toBeGreaterThan(0);
    expect(validateValue({ type: 'string', format: 'date' }, '2024-02-31').length).toBeGreaterThan(
      0,
    );
  });
  it('requires the matching thread and turn file changes before accepting, including grantRoot requests', async () => {
    const onAnswer = vi.fn().mockResolvedValue(undefined),
      onRefresh = vi.fn();
    const prompt = {
      promptId: 'file',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't', turnId: 'u', itemId: 'i', grantRoot: '/workspace' },
    };
    const turn = {
      id: 'u',
      status: 'inProgress',
      items: [
        {
          id: 'i',
          type: 'fileChange',
          changes: [
            {
              path: '/workspace/file.txt',
              kind: { type: 'update', move_path: null },
              diff: '-before\n+after',
            },
          ],
        },
      ],
    };
    const view = render(
      <Prompts prompts={[prompt]} onAnswer={onAnswer} onRefresh={onRefresh} contextThreadId="t" />,
    );
    expect((screen.getByRole('button', { name: '允许这一次' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole('button', { name: '允许本次会话' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole('button', { name: '拒绝' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: '重新同步变更' }));
    expect(onRefresh).toHaveBeenCalledOnce();
    view.rerender(
      <Prompts
        prompts={[prompt]}
        onAnswer={onAnswer}
        contextThreadId="other"
        contextTurns={[turn]}
      />,
    );
    expect((screen.getByRole('button', { name: '允许这一次' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(
      <Prompts
        prompts={[prompt]}
        onAnswer={onAnswer}
        contextThreadId="t"
        contextTurns={[{ ...turn, id: 'old-turn' }]}
      />,
    );
    expect((screen.getByRole('button', { name: '允许这一次' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(
      <Prompts prompts={[prompt]} onAnswer={onAnswer} contextThreadId="t" contextTurns={[turn]} />,
    );
    expect(screen.getByText(/-before\s+\+after/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '允许这一次' }));
    await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('file', { decision: 'accept' }));
  });
  it('accepts a verifiable empty-file addition but rejects a missing diff field', () => {
    const prompt = {
      promptId: 'file',
      method: 'item/fileChange/requestApproval',
      params: { threadId: 't', turnId: 'u', itemId: 'i' },
    };
    const props = { prompts: [prompt], onAnswer: vi.fn(), contextThreadId: 't' };
    const view = render(
      <Prompts
        {...props}
        contextTurns={[
          {
            id: 'u',
            status: 'inProgress',
            items: [
              { id: 'i', type: 'fileChange', changes: [{ path: '/empty', kind: { type: 'add' } }] },
            ],
          },
        ]}
      />,
    );
    expect((screen.getByRole('button', { name: '允许这一次' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    view.rerender(
      <Prompts
        {...props}
        contextTurns={[
          {
            id: 'u',
            status: 'inProgress',
            items: [
              {
                id: 'i',
                type: 'fileChange',
                changes: [{ path: '/empty', kind: { type: 'add' }, diff: '' }],
              },
            ],
          },
        ]}
      />,
    );
    expect((screen.getByRole('button', { name: '允许这一次' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.getByText(/内容为空/)).toBeTruthy();
  });
});
it('preserves a prepared answer while the request is collapsed to keep history readable', () => {
  render(
    <Prompts
      prompts={[
        {
          promptId: 'p',
          method: 'item/tool/requestUserInput',
          params: { questions: [{ id: 'q', header: '说明', question: '请说明', options: [] }] },
        },
      ]}
      onAnswer={vi.fn()}
    />,
  );
  fireEvent.change(screen.getByRole('textbox', { name: '说明：答案' }), {
    target: { value: 'keep my answer' },
  });
  fireEvent.click(screen.getByRole('button', { name: '收起请求，查看历史' }));
  expect(screen.getByText('1 项请求等待你的决定')).toBeTruthy();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: '展开待答请求' }));
  expect((screen.getByRole('textbox', { name: '说明：答案' }) as HTMLInputElement).value).toBe(
    'keep my answer',
  );
});

describe('opaque question identifiers and answer text', () => {
  it.each(['__proto__', 'constructor'])(
    'starts question %s empty and requires an explicit answer',
    (key) => {
      const answer = vi.fn();
      render(
        <Prompts
          prompts={[
            {
              promptId: 'p',
              method: 'item/tool/requestUserInput',
              params: {
                threadId: 'thread',
                turnId: 'turn',
                itemId: 'item',
                isBlocking: true,
                questions: [{ id: key, header: '问题', question: '请输入' }],
              },
            },
          ]}
          onAnswer={answer}
        />,
      );
      const input = screen.getByRole('textbox', { name: '问题：答案' }) as HTMLInputElement;
      expect(input.value).toBe('');
      fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
      expect(answer).not.toHaveBeenCalled();
      expect(screen.getByRole('alert').textContent).toContain('请完成所有问题');
    },
  );
  it.each(['__proto__', 'constructor'])('serializes an own answer for question %s', async (key) => {
    const answer = vi.fn().mockResolvedValue(undefined);
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              isBlocking: true,
              questions: [{ id: key, header: '问题', question: '请输入' }],
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: '问题：答案' }), {
      target: { value: '原样回答' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const response = answer.mock.calls[0]![1];
    expect(Object.hasOwn(response.answers, key)).toBe(true);
    expect(JSON.parse(JSON.stringify(response))).toEqual({
      answers: Object.fromEntries([[key, { answers: ['原样回答'] }]]),
    });
  });
  it('submits the literal __other option without enabling a custom answer', async () => {
    const answer = vi.fn().mockResolvedValue(undefined),
      user = userEvent.setup();
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              isBlocking: true,
              questions: [
                {
                  id: 'q',
                  header: '选择',
                  question: '请选择',
                  isOther: false,
                  options: [{ label: '__other', description: 'Literal option label' }],
                },
              ],
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    await user.selectOptions(
      screen.getByRole('combobox'),
      screen.getByRole('option', { name: /^__other/ }),
    );
    expect(screen.queryByLabelText('选择：其他答案')).toBeNull();
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(answer).toHaveBeenCalledWith('p', { answers: { q: { answers: ['__other'] } } });
  });
  it('submits literal __other as free text', async () => {
    const answer = vi.fn().mockResolvedValue(undefined);
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              isBlocking: true,
              questions: [{ id: 'q', header: '问题', question: '请输入' }],
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '__other' } });
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }));
    await waitFor(() =>
      expect(answer).toHaveBeenCalledWith('p', { answers: { q: { answers: ['__other'] } } }),
    );
  });
  it('keeps a custom draft separate from an offered __other label while switching modes', async () => {
    const answer = vi.fn().mockResolvedValue(undefined),
      user = userEvent.setup();
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'item/tool/requestUserInput',
            params: {
              threadId: 'thread',
              turnId: 'turn',
              itemId: 'item',
              isBlocking: true,
              questions: [
                {
                  id: '__proto__',
                  header: '选择',
                  question: '请选择',
                  isOther: true,
                  isSecret: true,
                  options: [
                    { label: '__other', description: 'Literal option label' },
                    { label: '普通', description: 'Ordinary option' },
                  ],
                },
              ],
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    const select = screen.getByRole('combobox');
    await user.selectOptions(select, screen.getByRole('option', { name: '其他' }));
    const custom = screen.getByLabelText('选择：其他答案') as HTMLInputElement;
    expect(custom.type).toBe('password');
    expect(custom.autocomplete).toBe('off');
    await user.type(custom, '  自定义草稿  ');
    await user.selectOptions(select, screen.getByRole('option', { name: /^__other/ }));
    expect(screen.queryByLabelText('选择：其他答案')).toBeNull();
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(JSON.parse(JSON.stringify(answer.mock.calls[0]![1]))).toEqual({
      answers: Object.fromEntries([['__proto__', { answers: ['__other'] }]]),
    });
    await user.selectOptions(select, screen.getByRole('option', { name: /^普通/ }));
    await user.selectOptions(select, screen.getByRole('option', { name: '其他' }));
    expect((screen.getByLabelText('选择：其他答案') as HTMLInputElement).value).toBe(
      '  自定义草稿  ',
    );
    await user.click(screen.getByRole('button', { name: '提交回答' }));
    expect(JSON.parse(JSON.stringify(answer.mock.calls[1]![1]))).toEqual({
      answers: Object.fromEntries([['__proto__', { answers: ['  自定义草稿  '] }]]),
    });
  });
});
