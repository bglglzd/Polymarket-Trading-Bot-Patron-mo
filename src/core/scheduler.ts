import { logger } from '../reporting/logs';

export type TickHandler = () => Promise<void> | void;

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private readonly intervalMs: number;
  private running = false;

  constructor(intervalMs = 5000) {
    this.intervalMs = intervalMs;
  }

  start(handler: TickHandler): void {
    if (this.timer) return;
    this.timer = setInterval(async () => {
      if (this.running) return; // skip if previous tick still executing
      this.running = true;
      try {
        await handler();
      } catch (error) {
        logger.error({ error }, 'Scheduler tick failed');
      } finally {
        this.running = false;
      }
    }, this.intervalMs);
    logger.info({ intervalMs: this.intervalMs }, 'Scheduler started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('Scheduler stopped');
    }
  }
}
