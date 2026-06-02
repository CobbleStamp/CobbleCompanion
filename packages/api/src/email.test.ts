import type { Logger } from '@cobble/core';
import { describe, expect, it, vi } from 'vitest';
import { ConsoleEmailSender } from './email.js';

describe('ConsoleEmailSender', () => {
  it('logs the magic link', async () => {
    const info = vi.fn();
    const logger: Logger = { error: vi.fn(), info };
    const sender = new ConsoleEmailSender(logger);

    await sender.sendMagicLink('ada@example.com', 'https://app/verify?token=x');

    expect(info).toHaveBeenCalledWith('magic link issued', {
      email: 'ada@example.com',
      link: 'https://app/verify?token=x',
    });
  });
});
