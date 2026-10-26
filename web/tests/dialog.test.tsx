// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode, useState } from 'react';
import { Dialog, DialogScope } from '../components/Dialog';
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue([
    { width: 10, height: 10 },
  ] as unknown as DOMRectList);
});
afterEach(cleanup);
describe('dialog keyboard containment', () => {
  it('wraps focus and gives composed Escape to the input method', () => {
    const close = vi.fn();
    render(
      <Dialog title="Dialog" onClose={close}>
        <input aria-label="Name" />
        <button>Last</button>
      </Dialog>,
    );
    const last = screen.getByRole('button', { name: 'Last' }),
      first = screen.getByRole('button', { name: '关闭对话框' });
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(last, { key: 'Escape', keyCode: 229 });
    expect(close).not.toHaveBeenCalled();
    fireEvent.keyDown(last, { key: 'Escape' });
    expect(close).toHaveBeenCalledOnce();
  });
  it('returns focus to the still-present opening control', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();
    const view = render(
      <Dialog title="Dialog" onClose={vi.fn()}>
        <input aria-label="Name" />
      </Dialog>,
    );
    screen.getByRole('textbox').focus();
    view.unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it('gives only the topmost dialog ownership of Escape and Tab', () => {
    const outerClose = vi.fn(),
      innerClose = vi.fn();
    function Nested() {
      const [inner, setInner] = useState(false);
      return (
        <Dialog title="Outer" onClose={outerClose}>
          <button onClick={() => setInner(true)}>Open inner</button>
          {inner && (
            <Dialog title="Inner" onClose={innerClose}>
              <input aria-label="Inner input" />
            </Dialog>
          )}
        </Dialog>
      );
    }
    render(<Nested />);
    fireEvent.click(screen.getByRole('button', { name: 'Open inner' }));
    const input = screen.getByRole('textbox', { name: 'Inner input' });
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
    const outer = screen.getByRole('dialog', { name: 'Outer' }),
      inner = screen.getByRole('dialog', { name: 'Inner' });
    outer.querySelector('button')!.focus();
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(inner.contains(document.activeElement)).toBe(true);
  });
  it('suspends nested scopes without closing business state or stealing login focus', () => {
    const close = vi.fn();
    const page = (active: boolean) => (
      <>
        <input aria-label="Login" />
        <DialogScope active={active}>
          <DialogScope active>
            <Dialog title="Retained form" onClose={close}>
              <input aria-label="Draft" defaultValue="keep me" />
            </Dialog>
          </DialogScope>
        </DialogScope>
      </>
    );
    const view = render(page(true)),
      dialog = screen.getByRole('dialog') as HTMLDialogElement;
    const draft = screen.getByLabelText('Draft');
    fireEvent.change(draft, { target: { value: 'edited' } });
    const login = screen.getByLabelText('Login');
    login.focus();
    view.rerender(page(false));
    expect(dialog.open).toBe(false);
    expect(document.activeElement).toBe(login);
    expect(close).not.toHaveBeenCalled();
    expect(fireEvent.keyDown(login, { key: 'Tab' })).toBe(true);
    fireEvent.keyDown(login, { key: 'Escape' });
    expect(close).not.toHaveBeenCalled();
    view.rerender(page(true));
    expect(dialog.open).toBe(true);
    expect(screen.getByLabelText('Draft')).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe('edited');
  });
  it('restores native and keyboard layer order through nested mount, suspension and StrictMode cleanup', () => {
    const nativeLayers: HTMLDialogElement[] = [];
    HTMLDialogElement.prototype.showModal = function () {
      expect(nativeLayers).not.toContain(this);
      this.open = true;
      nativeLayers.push(this);
    };
    HTMLDialogElement.prototype.close = function () {
      this.open = false;
      const index = nativeLayers.indexOf(this);
      if (index >= 0) nativeLayers.splice(index, 1);
    };
    const outerClose = vi.fn(),
      innerClose = vi.fn();
    const page = (active: boolean, inner = true) => (
      <StrictMode>
        <DialogScope active={active}>
          <Dialog title="Outer" onClose={outerClose}>
            <button>Outer input</button>
            {inner && (
              <Dialog title="Inner" onClose={innerClose}>
                <input aria-label="Inner input" />
              </Dialog>
            )}
          </Dialog>
        </DialogScope>
      </StrictMode>
    );
    const view = render(page(true)),
      outer = screen.getByRole('dialog', { name: 'Outer' }) as HTMLDialogElement,
      inner = screen.getByRole('dialog', { name: 'Inner' }) as HTMLDialogElement;
    expect(nativeLayers).toEqual([outer, inner]);
    view.rerender(page(false));
    expect(nativeLayers).toEqual([]);
    view.rerender(page(true));
    expect(nativeLayers).toEqual([outer, inner]);
    fireEvent.keyDown(screen.getByLabelText('Inner input'), { key: 'Escape' });
    expect(innerClose).toHaveBeenCalledOnce();
    expect(outerClose).not.toHaveBeenCalled();
    view.rerender(page(true, false));
    expect(nativeLayers).toEqual([outer]);
    fireEvent.keyDown(screen.getByRole('button', { name: 'Outer input' }), { key: 'Escape' });
    expect(outerClose).toHaveBeenCalledOnce();
    view.unmount();
    expect(nativeLayers).toEqual([]);
    expect(fireEvent.keyDown(document.body, { key: 'Tab' })).toBe(true);
  });
  it('does not return focus to hidden opening controls or hidden fallbacks', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<button class="sidebar-account">opener</button>';
    document.body.append(wrapper);
    const opener = wrapper.querySelector('button')!;
    opener.focus();
    const view = render(
      <Dialog title="Dialog" onClose={vi.fn()}>
        Body
      </Dialog>,
    );
    const focus = vi.spyOn(opener, 'focus');
    wrapper.hidden = true;
    view.unmount();
    expect(focus).not.toHaveBeenCalled();
    wrapper.remove();
  });
});
