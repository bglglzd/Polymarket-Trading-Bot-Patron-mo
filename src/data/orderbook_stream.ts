import { EventEmitter } from 'events';
import { MarketData } from '../types';
import { MarketFetcher } from './market_fetcher';
import { logger } from '../reporting/logs';
import { consoleLog } from '../reporting/console_log';

/**
 * Polls the Polymarket Gamma API at a configurable interval and emits
 * real MarketData updates for every tracked market.
 */
export class OrderbookStream extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private readonly fetcher: MarketFetcher;
  private readonly pollMs: number;
  /** Cache of latest data keyed by marketId so strategies see history */
  private readonly cache = new Map<string, MarketData>();
  private pollCount = 0;
  /** Max markets to keep in cache (top by volume); prevents unbounded memory growth */
  private static readonly MAX_CACHE_SIZE = 2000;

  constructor(gammaApi?: string, pollMs = 120_000) {
    super();
    this.fetcher = new MarketFetcher(gammaApi, 1000);
    this.pollMs = pollMs;
  }

  /** Start polling. First poll fires immediately. */
  start(): void {
    if (this.timer) return;
    // Fire immediately, then at interval
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    logger.info({ pollMs: this.pollMs }, 'OrderbookStream started (live Gamma polling)');
    consoleLog.success('SCAN', `OrderbookStream started — polling Gamma every ${this.pollMs / 1000}s`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
      logger.info('OrderbookStream stopped');
      consoleLog.warn('SCAN', 'OrderbookStream stopped');
    }
  }

  getMarket(marketId: string): MarketData | undefined {
    return this.cache.get(marketId);
  }

  getAllMarkets(): MarketData[] {
    return [...this.cache.values()];
  }

  private async poll(): Promise<void> {
    try {
      const markets = await this.fetcher.fetchSnapshot();
      const prevSize = this.cache.size;
      for (const m of markets) {
        this.cache.set(m.marketId, m);
        this.emit('update', m);
      }
      this.pollCount++;
      const newMarkets = this.cache.size - prevSize;

      // Evict stale markets that weren't refreshed in this poll (no longer active/open)
      // Keep fresh IDs from this poll to determine what's stale
      const freshIds = new Set(markets.map((m) => m.marketId));
      if (this.cache.size > OrderbookStream.MAX_CACHE_SIZE) {
        let evicted = 0;
        for (const [id] of this.cache) {
          if (!freshIds.has(id)) {
            this.cache.delete(id);
            evicted++;
          }
          if (this.cache.size <= OrderbookStream.MAX_CACHE_SIZE) break;
        }
        if (evicted > 0) {
          logger.info({ evicted, remaining: this.cache.size }, 'OrderbookStream: evicted stale markets');
        }
      }

      consoleLog.info('SCAN', `Poll #${this.pollCount} complete — ${markets.length} markets fetched, ${this.cache.size} cached${newMarkets > 0 ? `, ${newMarkets} new` : ''}`, {
        pollNumber: this.pollCount,
        fetched: markets.length,
        cached: this.cache.size,
        newMarkets,
      });
    } catch (error) {
      logger.error({ error }, 'OrderbookStream poll failed');
      const msg = error instanceof Error ? error.message : String(error);
      consoleLog.error('SCAN', `Poll failed: ${msg}`, { error: msg });
    }
  }
}
