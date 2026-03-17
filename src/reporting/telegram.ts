import { logger } from './logs';
import type { OrderRequest, WalletState } from '../types';

/**
 * Lightweight Telegram notifier using the Bot API via native fetch.
 * No npm dependencies required.
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN   — token from @BotFather
 *   TELEGRAM_CHAT_ID     — numeric chat/user ID
 */
export class TelegramNotifier {
  private readonly token: string;
  private readonly chatId: string;
  private readonly enabled: boolean;

  /** Rate-limit: max 1 message per second (Telegram limit is 30/sec but be safe) */
  private queue: string[] = [];
  private flushing = false;
  private static readonly FLUSH_INTERVAL_MS = 350;

  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN ?? '';
    this.chatId = process.env.TELEGRAM_CHAT_ID ?? process.env.TELEGRAM_OWNER_CHAT_ID ?? '';
    this.enabled = !!(this.token && this.chatId);

    if (!this.enabled) {
      logger.warn('Telegram notifier disabled — TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    }
  }

  /* ── Public API ──────────────────────────────────────────────── */

  /** Send a startup notification with full budget info */
  async notifyStartup(runnerCount: number, wallets: WalletState[]): Promise<void> {
    const totalCapital = wallets.reduce((s, w) => s + w.capitalAllocated, 0);
    const totalBalance = wallets.reduce((s, w) => s + w.availableBalance, 0);
    const totalPositions = wallets.reduce((s, w) => s + w.openPositions.length, 0);
    const totalPnl = wallets.reduce((s, w) => s + w.realizedPnl, 0);
    const posValue = wallets.reduce(
      (s, w) => s + w.openPositions.reduce((ps, p) => ps + p.size * p.avgPrice, 0),
      0,
    );
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const lines = [
      '🟢 *Bot Started*',
      '',
      `💰 Total: *$${totalCapital.toFixed(2)}*`,
      `   USDC: $${totalBalance.toFixed(2)}`,
      `   Positions: ${totalPositions} (~$${posValue.toFixed(2)})`,
      `   PnL: ${pnlSign}$${totalPnl.toFixed(2)}`,
      '',
      `Runners: ${runnerCount} | ${wallets.map((w) => w.mode).join(', ')}`,
    ];
    await this.send(lines.join('\n'));
  }

  /** Notify on a trade fill (BUY or SELL) */
  async notifyTrade(order: OrderRequest, question?: string): Promise<void> {
    const cost = order.price * order.size;
    const emoji = order.side === 'BUY' ? '🔵' : '🟠';
    const label = question
      ? question.length > 60 ? question.slice(0, 57) + '...' : question
      : order.marketId.slice(0, 16) + '…';
    const lines = [
      `${emoji} *${order.side}* ${order.outcome}`,
      `${label}`,
      `${order.size} sh @ $${order.price.toFixed(2)} = $${cost.toFixed(2)}`,
    ];
    await this.send(lines.join('\n'));
  }

  /** Notify on exit order fill */
  async notifyExit(order: OrderRequest, pnl?: number, question?: string): Promise<void> {
    const cost = order.price * order.size;
    const emoji = pnl !== undefined && pnl >= 0 ? '✅' : '🔴';
    const pnlStr = pnl !== undefined ? ` (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)})` : '';
    const label = question
      ? question.length > 60 ? question.slice(0, 57) + '...' : question
      : order.marketId.slice(0, 16) + '…';
    const lines = [
      `${emoji} *EXIT* ${order.outcome}`,
      `${label}`,
      `${order.size} sh @ $${order.price.toFixed(2)} = $${cost.toFixed(2)}${pnlStr}`,
    ];
    await this.send(lines.join('\n'));
  }

  /** Periodic summary with full budget breakdown */
  async notifySummary(wallets: WalletState[]): Promise<void> {
    const totalCapital = wallets.reduce((s, w) => s + w.capitalAllocated, 0);
    const totalBalance = wallets.reduce((s, w) => s + w.availableBalance, 0);
    const totalPnl = wallets.reduce((s, w) => s + w.realizedPnl, 0);
    const pnlSign = totalPnl >= 0 ? '+' : '';
    const lines = ['📊 *Status Update*', ''];

    for (const w of wallets) {
      const posValue = w.openPositions.reduce((s, p) => s + p.size * p.avgPrice, 0);
      const wPnlSign = w.realizedPnl >= 0 ? '+' : '';
      lines.push(
        `*${w.walletId}* (${w.mode})`,
        `💰 Total: *$${w.capitalAllocated.toFixed(2)}*`,
        `   USDC: $${w.availableBalance.toFixed(2)}`,
        `   Positions: ${w.openPositions.length} (~$${posValue.toFixed(2)})`,
        `   PnL: ${wPnlSign}$${w.realizedPnl.toFixed(2)}`,
      );

      // Top 5 positions by value
      if (w.openPositions.length > 0) {
        const sorted = [...w.openPositions]
          .sort((a, b) => (b.size * b.avgPrice) - (a.size * a.avgPrice))
          .slice(0, 5);
        lines.push('');
        for (const p of sorted) {
          const val = p.size * p.avgPrice;
          lines.push(`   ${p.outcome} x${p.size.toFixed(0)} @ $${p.avgPrice.toFixed(2)} = $${val.toFixed(2)}`);
        }
      }
    }

    if (wallets.length > 1) {
      lines.push('', `*Overall:* $${totalCapital.toFixed(2)} | USDC: $${totalBalance.toFixed(2)} | PnL: ${pnlSign}$${totalPnl.toFixed(2)}`);
    }

    await this.send(lines.join('\n'));
  }

  /** Send a free-form text message */
  async sendText(text: string): Promise<void> {
    await this.send(text);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /* ── Internals ───────────────────────────────────────────────── */

  private async send(text: string): Promise<void> {
    if (!this.enabled) return;
    this.queue.push(text);
    this.startFlush();
  }

  private startFlush(): void {
    if (this.flushing) return;
    this.flushing = true;

    const flush = async () => {
      while (this.queue.length > 0) {
        const msg = this.queue.shift()!;
        try {
          const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
          const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: this.chatId,
              text: msg,
              parse_mode: 'Markdown',
              disable_web_page_preview: true,
            }),
          });
          if (!resp.ok) {
            const body = await resp.text().catch(() => '');
            logger.warn({ status: resp.status, body: body.slice(0, 200) }, 'Telegram send failed');
          }
        } catch (err) {
          logger.warn({ err }, 'Telegram send error');
        }
        // Rate limit
        if (this.queue.length > 0) {
          await new Promise((r) => setTimeout(r, TelegramNotifier.FLUSH_INTERVAL_MS));
        }
      }
      this.flushing = false;
    };

    flush().catch((err) => {
      logger.warn({ err }, 'Telegram flush error');
      this.flushing = false;
    });
  }
}

/** Global singleton */
export const telegram = new TelegramNotifier();
