// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Prompts } from '../components/Prompts';
import { McpArguments } from '../components/McpArguments';
import { validateValue } from '../lib/prompt-validation';
import type { Tool } from '../../protocol/ts/Tool';
afterEach(cleanup);
function form(properties: Record<string, unknown>, required: string[] = []) {
  const answer = vi.fn().mockResolvedValue(undefined);
  render(
    <Prompts
      prompts={[
        {
          promptId: 'p',
          method: 'mcpServer/elicitation/request',
          params: {
            mode: 'form',
            requestedSchema: { type: 'object', properties, required, additionalProperties: false },
          },
        },
      ]}
      onAnswer={answer}
    />,
  );
  return answer;
}
it('omits optional enum, boolean and numeric fields when an actual selection is returned to the empty option', async () => {
  const answer = form({
    choice: { type: 'string', enum: ['first', 'second'] },
    flag: { type: 'boolean' },
    count: { type: 'number' },
  });
  for (const [name, value] of [
    ['choice', '1'],
    ['flag', 'true'],
    ['count', '3'],
  ]) {
    fireEvent.change(screen.getByLabelText(name!), { target: { value } });
    fireEvent.change(screen.getByLabelText(name!), { target: { value: '' } });
  }
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith('p', { action: 'accept', content: {}, _meta: null }),
  );
});
it('preserves false, zero, an explicitly supplied empty string and explicitly supplied empty arrays', async () => {
  const answer = form(
    {
      flag: { type: 'boolean' },
      count: { type: 'integer' },
      text: { type: 'string' },
      choices: { type: 'array', items: { type: 'string', enum: ['one'] } },
      entries: { type: 'array', items: { type: 'number' } },
    },
    ['flag', 'count', 'text', 'choices', 'entries'],
  );
  fireEvent.change(screen.getByLabelText('flag *'), { target: { value: 'false' } });
  fireEvent.change(screen.getByLabelText('count *'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 text（必填）' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 choices（必填）' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 entries（必填）' }));
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith('p', {
      action: 'accept',
      content: { flag: false, count: 0, text: '', choices: [], entries: [] },
      _meta: null,
    }),
  );
});
it('distinguishes required missing arrays from empty arrays and lets optional arrays become absent again', async () => {
  const answer = form(
    {
      requiredList: { type: 'array', items: { type: 'string' } },
      optionalList: { type: 'array', items: { type: 'string', enum: ['one'] } },
    },
    ['requiredList'],
  );
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  expect(answer).not.toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('必填');
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 requiredList（必填）' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 optionalList（可选）' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'one' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 optionalList（可选）' }));
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith('p', {
      action: 'accept',
      content: { requiredList: [] },
      _meta: null,
    }),
  );
});
it('keeps null separate from omitted, false and an empty string', async () => {
  const answer = form(
    {
      maybe: { type: ['boolean', 'null'] },
      empty: { type: 'string', enum: ['', 'x'] },
      choice: { type: ['string', 'null'], enum: [null, 'value'] },
    },
    ['maybe', 'empty', 'choice'],
  );
  fireEvent.change(screen.getByLabelText('maybe *'), { target: { value: 'null' } });
  fireEvent.change(screen.getByLabelText('empty *'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('choice *'), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: '确认' }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith('p', {
      action: 'accept',
      content: { maybe: null, empty: '', choice: null },
      _meta: null,
    }),
  );
});

it.each(['__proto__', 'constructor'])(
  'keeps the elicitation field %s absent until supplied and absent after clearing',
  async (key) => {
    const answer = vi.fn().mockResolvedValue(undefined);
    render(
      <Prompts
        prompts={[
          {
            promptId: 'p',
            method: 'mcpServer/elicitation/request',
            params: {
              serverName: 'local',
              threadId: 'thread',
              mode: 'form',
              message: '请输入',
              requestedSchema: {
                type: 'object',
                properties: Object.fromEntries([[key, { type: 'string' }]]),
              },
            },
          },
        ]}
        onAnswer={answer}
      />,
    );
    const presence = screen.getByRole('checkbox', {
      name: `提供 ${key}（可选）`,
    }) as HTMLInputElement;
    const input = screen.getByRole('textbox', { name: key }) as HTMLInputElement;
    expect(presence.checked).toBe(false);
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    fireEvent.click(presence);
    fireEvent.change(input, { target: { value: 'supplied' } });
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() => expect(answer).toHaveBeenCalledOnce());
    const response = answer.mock.calls[0]![1];
    expect(Object.hasOwn(response.content, key)).toBe(true);
    expect(JSON.parse(JSON.stringify(response.content))).toEqual(
      Object.fromEntries([[key, 'supplied']]),
    );
    await waitFor(() => expect(presence.matches(':disabled')).toBe(false));
    fireEvent.click(presence);
    expect(presence.checked).toBe(false);
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    await waitFor(() =>
      expect(answer).toHaveBeenLastCalledWith('p', { action: 'accept', content: {}, _meta: null }),
    );
  },
);

it.each(['__proto__', 'constructor'])(
  'keeps the MCP tool field %s absent until supplied and absent after clearing',
  (key) => {
    const call = vi.fn(),
      tool: Tool = {
        name: 'fixture',
        inputSchema: {
          type: 'object',
          properties: Object.fromEntries([[key, { type: 'string' }]]),
          additionalProperties: false,
        },
      };
    render(<McpArguments tool={tool} disabled={false} onCall={call} />);
    const presence = screen.getByRole('checkbox', {
      name: `提供 ${key}（可选）`,
    }) as HTMLInputElement;
    const input = screen.getByRole('textbox', { name: key }) as HTMLInputElement;
    const confirm = screen.getByRole('checkbox', {
      name: '确认向此服务调用所选工具与上述参数',
    }) as HTMLInputElement;
    expect(presence.checked).toBe(false);
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    fireEvent.click(presence);
    fireEvent.change(input, { target: { value: 'supplied' } });
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: '调用 fixture' }));
    expect(call).toHaveBeenCalledOnce();
    expect(Object.hasOwn(call.mock.calls[0]![0], key)).toBe(true);
    expect(JSON.parse(JSON.stringify(call.mock.calls[0]![0]))).toEqual(
      Object.fromEntries([[key, 'supplied']]),
    );
    fireEvent.click(presence);
    expect(presence.checked).toBe(false);
    expect(input.value).toBe('');
    expect(input.disabled).toBe(true);
    expect(confirm.checked).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: '调用 fixture' }));
    expect(call).toHaveBeenLastCalledWith({});
  },
);

it.each(['__proto__', 'constructor'])('reads nested MCP schema field %s as an own value', (key) => {
  const call = vi.fn(),
    tool: Tool = {
      name: 'nested',
      inputSchema: {
        type: 'object',
        properties: {
          group: {
            type: 'object',
            properties: Object.fromEntries([[key, { type: 'string' }]]),
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
    };
  render(<McpArguments tool={tool} disabled={false} onCall={call} />);
  fireEvent.click(screen.getByRole('checkbox', { name: '提供 group（可选）' }));
  const presence = screen.getByRole('checkbox', {
    name: `提供 ${key}（可选）`,
  }) as HTMLInputElement;
  const input = screen.getByRole('textbox', { name: key }) as HTMLInputElement;
  expect(presence.checked).toBe(false);
  expect(input.value).toBe('');
  expect(input.disabled).toBe(true);
  fireEvent.click(presence);
  fireEvent.change(input, { target: { value: 'nested answer' } });
  const confirm = screen.getByRole('checkbox', { name: '确认向此服务调用所选工具与上述参数' });
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: '调用 nested' }));
  expect(Object.hasOwn(call.mock.calls[0]![0].group, key)).toBe(true);
  expect(JSON.parse(JSON.stringify(call.mock.calls[0]![0]))).toEqual({
    group: Object.fromEntries([[key, 'nested answer']]),
  });
  fireEvent.click(presence);
  expect(presence.checked).toBe(false);
  expect(input.disabled).toBe(true);
  fireEvent.click(confirm);
  fireEvent.click(screen.getByRole('button', { name: '调用 nested' }));
  expect(call).toHaveBeenLastCalledWith({ group: {} });
});

it.each(['__proto__', 'constructor'])(
  'checks own schema properties for %s in the pure validator',
  (key) => {
    const supplied = Object.fromEntries([[key, 'value']]);
    expect(
      validateValue({ type: 'object', properties: {}, additionalProperties: false }, supplied),
    ).toEqual([`${key}不是允许的字段。`]);
    expect(
      validateValue({ type: 'object', properties: {}, additionalProperties: true }, supplied),
    ).toEqual([]);
    const schema = {
      type: 'object',
      properties: Object.fromEntries([[key, { type: 'string' }]]),
      additionalProperties: false,
    };
    expect(validateValue(schema, supplied)).toEqual([]);
    expect(validateValue(schema, Object.fromEntries([[key, 1]]))).toEqual([`${key}必须是文本。`]);
  },
);
