import { screen, waitFor } from '@testing-library/react';
import { expect } from 'vitest';

/** Async recovery transactions can leave a visible control busy until durable completion. */
export async function enabledButton(options: Parameters<typeof screen.findByRole>[1]) {
  const button = await screen.findByRole('button', options);
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  return button;
}
