import type { Logger } from '@cobble/core';

/** Outbound email transport. Phase 0 ships the console transport; SMTP is later. */
export interface EmailSender {
  sendMagicLink(email: string, link: string): Promise<void>;
}

/**
 * Dev transport: logs the magic link instead of sending it. Lets the full
 * magic-link flow be exercised offline (the link is copied from the server log).
 */
export class ConsoleEmailSender implements EmailSender {
  constructor(private readonly logger: Logger) {}

  async sendMagicLink(email: string, link: string): Promise<void> {
    this.logger.info('magic link issued', { email, link });
  }
}
