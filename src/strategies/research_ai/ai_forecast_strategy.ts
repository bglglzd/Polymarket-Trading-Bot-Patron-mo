import { BaseStrategy } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { ClaudeAnalyzer } from './claude_analyzer';
import { consoleLog } from '../../reporting/console_log';
import { logger } from '../../reporting/logs';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PolyPatronBot AI Forecast Strategy — Active Trading
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Strategy flow:
   1. Claude AI analyzes markets for mispricing
   2. BUY shares when Claude finds a high-confidence edge
   3. Monitor positions using REAL wallet data (from CLOB sync)
   4. SELL when profitable (take profit) or cut losses (stop loss)
   5. Repeat — continuous buy/sell cycling

   Position management uses the wallet's live position data,
   NOT phantom fills from order acceptance.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ── Tuning constants ── */
const MIN_VOLUME = 5_000;
const MIN_LIQUIDITY = 3_000;
const MIN_HISTORY = 8;
const MAX_HISTORY = 60;
const PRICE_FLOOR = 0.15;
const PRICE_CEILING = 0.85;
const MAX_POSITIONS = 5;

/* ── Exit thresholds (account for ~2% Polymarket fee + spread) ── */
const TAKE_PROFIT_PCT = 0.12;     // sell when up 12% — ensures profit after 2% fee + spread
const STOP_LOSS_PCT = 0.25;       // sell when down 25% — cut losses but don't panic on noise
const TIME_EXIT_MS = 48 * 3600_000; // sell after 48 hours if stagnant
const FEE_PCT = 0.02;             // Polymarket takes ~2% fee on trades

type Regime = 'trending' | 'ranging' | 'volatile';

interface FactorResult {
  direction: 'YES' | 'NO' | 'NEUTRAL';
  strength: number;
  name: string;
}

/** Track when we bought something so we know when to apply time exit */
interface EntryRecord {
  marketId: string;
  conditionId?: string; // hex condition ID for matching wallet positions after CLOB sync
  outcome: 'YES' | 'NO';
  entryPrice: number;
  entryTime: number;
  exitSubmittedAt?: number; // timestamp when we submitted a sell order
}

export class AiForecastStrategy extends BaseStrategy {
  readonly name = 'ai_forecast';
  protected override cooldownMs = 300_000; // 5 min per-market cooldown

  private priceHistory = new Map<string, number[]>();
  private volumeHistory = new Map<string, number[]>();
  private claude = new ClaudeAnalyzer();
  private pendingAnalysis = new Map<string, Promise<void>>();

  /** Track when we last placed a BUY order for each market */
  private orderCooldowns = new Map<string, number>();
  /** Markets that have a pending (unfilled) BUY order */
  private openOrderMarkets = new Set<string>();
  /** Global cooldown — time of last BUY order on ANY market */
  private lastGlobalOrderTime = 0;
  /** Minimum time between any two BUY orders (3 minutes) */
  private globalCooldownMs = 180_000;
  /** Entry records for positions we opened (for time-based exits) */
  private entryRecords = new Map<string, EntryRecord>();
  /** Markets where we already submitted a SELL (avoid double-sell) */
  private pendingSells = new Set<string>();
  /** Markets where a SELL failed (phantom position — don't try again) */
  private failedSells = new Set<string>();
  /** Reverse lookup: hex conditionId → gamma marketId (for matching wallet positions) */
  private conditionToGammaId = new Map<string, string>();

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    // Only store markets that pass basic filters (saves ~36,000 map entries)
    if (!this.passesFilters(data) && !this.entryRecords.has(data.marketId)) return;

    super.onMarketUpdate(data);

    // Build conditionId ↔ gamma ID mapping for position matching
    if (data.conditionId) {
      this.conditionToGammaId.set(data.conditionId, data.marketId);
    }

    const prices = this.priceHistory.get(data.marketId) ?? [];
    prices.push(data.midPrice);
    if (prices.length > MAX_HISTORY) prices.shift();
    this.priceHistory.set(data.marketId, prices);

    const vols = this.volumeHistory.get(data.marketId) ?? [];
    vols.push(data.volume24h);
    if (vols.length > MAX_HISTORY) vols.shift();
    this.volumeHistory.set(data.marketId, vols);
  }

  private lastGcTime = 0;

  /* ── Timer: trigger Claude analysis for promising markets ──── */
  override onTimer(): void {
    const now = Date.now();

    // Periodic GC: evict low-value markets to prevent OOM (every 10 min)
    if (now - this.lastGcTime > 600_000) {
      this.lastGcTime = now;
      let evicted = 0;
      for (const [marketId, market] of this.markets) {
        // Keep markets we have positions in or entry records for
        if (this.entryRecords.has(marketId)) continue;
        if (this.conditionToGammaId.has(marketId)) continue;
        // Keep markets that pass filters (tradeable)
        if (this.passesFilters(market)) continue;
        // Evict low-value markets
        this.markets.delete(marketId);
        this.priceHistory.delete(marketId);
        this.volumeHistory.delete(marketId);
        evicted++;
      }
      if (evicted > 0) {
        logger.info({ evicted, remaining: this.markets.size }, 'GC: evicted low-value markets');
      }
    }

    // Clean up stale open-order markers (5 min expiry)
    for (const marketId of this.openOrderMarkets) {
      const orderTime = this.orderCooldowns.get(marketId) ?? 0;
      if (now - orderTime > 300_000) {
        this.openOrderMarkets.delete(marketId);
      }
    }

    // Clean up stale pending-sell markers (3 min expiry)
    for (const key of this.pendingSells) {
      const entry = this.entryRecords.get(key);
      if (entry?.exitSubmittedAt && now - entry.exitSubmittedAt > 180_000) {
        this.pendingSells.delete(key);
      }
    }

    if (!this.claude.isEnabled()) return;

    // Count OUR positions (ones we placed this session, not legacy wallet positions)
    // Capital protection is handled in sizePositions() — this limit is for diversification
    const ourPositionCount = this.entryRecords.size;
    if (ourPositionCount >= MAX_POSITIONS) return;

    // Find markets that pass filters and send to Claude for analysis
    const MAX_PENDING_ANALYSES = 3;
    for (const [marketId, market] of this.markets) {
      if (this.pendingAnalysis.size >= MAX_PENDING_ANALYSES) break;
      if (this.pendingAnalysis.has(marketId)) continue;
      if (!this.passesFilters(market)) continue;

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;

      const regime = this.detectRegime(prices);
      const factors = this.runFactors(marketId, market, prices, volumes, regime);

      // Send to Claude if there's any directional signal (1+ factors)
      const yesCount = factors.filter((f) => f.direction === 'YES').length;
      const noCount = factors.filter((f) => f.direction === 'NO').length;
      if (Math.max(yesCount, noCount) < 1) continue;

      const promise = this.claude
        .analyzeMarket(marketId, {
          question: market.question ?? market.slug ?? marketId,
          currentYesPrice: market.outcomePrices[0] ?? 0.5,
          currentNoPrice: market.outcomePrices[1] ?? 0.5,
          spread: market.spread * 10_000,
          volume24h: market.volume24h,
          liquidity: market.liquidity,
          oneDayPriceChange: market.oneDayPriceChange,
          oneWeekPriceChange: market.oneWeekPriceChange,
          endDate: market.endDate,
          priceHistory: prices,
          quantSignals: {
            momentum: this.factorMomentum(prices).direction,
            meanReversion: this.factorMeanReversion(prices).direction,
            volumeDivergence: this.factorVolumePriceDivergence(prices, volumes).direction,
            regime,
            acceleration: this.factorAcceleration(prices).direction,
            liquidityQuality: this.factorLiquidity(market).direction,
          },
        })
        .then(() => { this.pendingAnalysis.delete(marketId); })
        .catch(() => { this.pendingAnalysis.delete(marketId); });

      this.pendingAnalysis.set(marketId, promise);
    }
  }

  /* ── Signal generation ──────────────────────────────────────── */
  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    const now = Date.now();

    // Global cooldown — wait between BUY orders
    const cooldownRemaining = this.globalCooldownMs - (now - this.lastGlobalOrderTime);
    if (cooldownRemaining > 0) {
      if ((now % 60_000) < 5_000) { // log once per ~60s
        logger.info({ cooldownRemaining: Math.round(cooldownRemaining / 1000) }, 'Signal gen: global cooldown active');
      }
      return signals;
    }

    // Count OUR positions (entries we placed), not total wallet positions
    // Legacy positions from spam era shouldn't block new trading
    const ourPositionCount = this.entryRecords.size;
    if (ourPositionCount >= MAX_POSITIONS) {
      logger.info({ ourPositionCount, MAX_POSITIONS }, 'Signal gen: max own positions reached');
      return signals;
    }

    // Count how many markets pass each filter stage
    let passFilters = 0, hasHistory = 0, hasClaude = 0;
    const shouldLogFunnel = (now % 30_000) < 5_000; // log every ~30s
    const openPositions = this.context?.wallet.openPositions ?? [];

    // Markets we already have a position in (from wallet)
    // Include both raw position IDs AND reverse-mapped gamma IDs
    const positionMarkets = new Set<string>();
    for (const pos of openPositions) {
      positionMarkets.add(pos.marketId);
      const gId = this.conditionToGammaId.get(pos.marketId);
      if (gId) positionMarkets.add(gId);
    }
    // Also add all markets we have entry records for
    for (const [mId] of this.entryRecords) {
      positionMarkets.add(mId);
    }

    for (const [marketId, market] of this.markets) {
      if (!this.passesFilters(market)) continue;
      passFilters++;

      // Skip markets where we already have a position or pending order
      if (positionMarkets.has(marketId)) continue;
      if (this.openOrderMarkets.has(marketId)) continue;
      const lastOrder = this.orderCooldowns.get(marketId) ?? 0;
      if (now - lastOrder < this.cooldownMs) continue;

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;
      hasHistory++;

      // REQUIRE Claude AI analysis
      const claudeResult = this.claude.isEnabled()
        ? (this.claude as any).cache?.get(marketId)?.analysis ?? null
        : null;

      if (!claudeResult || claudeResult.direction === 'SKIP') continue;

      hasClaude++;

      // Claude alone can trigger a trade if confident enough
      if (claudeResult.confidence < 0.55 || claudeResult.edge < 0.02) {
        logger.info(
          { marketId, conf: claudeResult.confidence, edge: claudeResult.edge },
          `Skipped: conf=${claudeResult.confidence.toFixed(2)} edge=${claudeResult.edge.toFixed(3)} below threshold`,
        );
        continue;
      }

      let outcome: 'YES' | 'NO' = claudeResult.direction;
      let confidence: number = claudeResult.confidence;
      let edge: number = claudeResult.edge;

      // Boost confidence if quant factors agree
      const regime = this.detectRegime(prices);
      const factors = this.runFactors(marketId, market, prices, volumes, regime);
      const agreeingFactors = factors.filter((f) => f.direction === outcome);
      if (agreeingFactors.length >= 2) {
        const avgStrength = agreeingFactors.reduce((s, f) => s + f.strength, 0) / agreeingFactors.length;
        confidence = Math.min(0.90, confidence + avgStrength * 0.1);
        edge = Math.min(0.10, edge + avgStrength * 0.01);
      }

      consoleLog.info(
        'STRATEGY',
        `AI signal: ${outcome} on ${market.question?.slice(0, 60)}… ` +
          `(conf=${confidence.toFixed(2)}, edge=${edge.toFixed(3)}) — ${claudeResult.reasoning}`,
      );

      signals.push({
        marketId,
        outcome,
        side: 'BUY',
        confidence,
        edge,
      });
    }

    // Log funnel periodically (~30s) or when there are signals
    if (signals.length > 0 || (shouldLogFunnel && (passFilters > 0 || hasClaude > 0))) {
      logger.info(
        { total: this.markets.size, passFilters, hasHistory, hasClaude, signals: signals.length },
        `Signal funnel: ${this.markets.size} → ${passFilters} filters → ${hasHistory} history → ${hasClaude} Claude → ${signals.length} signals`,
      );
    }

    signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
    // Only trade the single best opportunity per cycle
    return signals.slice(0, 1);
  }

  /* ── Sizing ────────────────────────────────────────────────── */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    const capital = this.context?.wallet.availableBalance ?? 100;
    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();
    const orders: OrderRequest[] = [];

    for (const signal of signals) {
      const market = this.markets.get(signal.marketId);
      if (!market) continue;

      // Resolve the CLOB token ID for this outcome
      let tokenId: string | undefined;
      if (market.clobTokenIds && market.outcomes) {
        const outcomeIdx = market.outcomes.findIndex(
          (o) => o.toUpperCase() === signal.outcome,
        );
        if (outcomeIdx >= 0 && outcomeIdx < market.clobTokenIds.length) {
          tokenId = market.clobTokenIds[outcomeIdx];
        }
      }

      if (!tokenId) {
        consoleLog.info('STRATEGY', `Skipping ${signal.marketId.slice(0, 12)}… — no token ID`);
        continue;
      }

      // Price: buy at the ask + 1¢ premium for fill certainty
      // market.bid/ask are YES-only from Gamma API
      // For NO outcome: NO ask ≈ 1 - YES_bid
      let price: number;
      if (signal.side === 'BUY') {
        const rawAsk = signal.outcome === 'YES'
          ? market.ask
          : 1 - market.bid; // NO ask ≈ complement of YES bid
        price = Number(Math.max(0.01, Math.min(0.99, rawAsk + 0.01)).toFixed(2));
      } else {
        const rawBid = signal.outcome === 'YES'
          ? market.bid
          : 1 - market.ask; // NO bid ≈ complement of YES ask
        price = Number(Math.max(0.01, Math.min(0.99, rawBid - 0.01)).toFixed(2));
      }

      // Size: 5-10 shares, capped at 5% of capital
      const maxCost = capital * 0.05;
      const maxShares = Math.floor(maxCost / Math.max(price, 0.01));
      const size = Math.max(5, Math.min(maxShares, 10));

      const orderCost = price * size;
      if (orderCost > capital * 0.10) continue; // safety: don't spend >10% in one order
      if (orderCost > capital - 5) continue; // keep $5 reserve

      // Record cooldowns
      this.orderCooldowns.set(signal.marketId, now);
      this.openOrderMarkets.add(signal.marketId);
      this.lastGlobalOrderTime = now;

      // Record entry for position management
      const condId = market.conditionId;
      this.entryRecords.set(signal.marketId, {
        marketId: signal.marketId,
        conditionId: condId,
        outcome: signal.outcome,
        entryPrice: price,
        entryTime: now,
      });
      // Reverse mapping so managePositions can find entries after CLOB sync
      // (wallet positions use hex conditionId, entry records use gamma numericId)
      if (condId) {
        this.conditionToGammaId.set(condId, signal.marketId);
      }

      consoleLog.success(
        'STRATEGY',
        `BUY ${signal.outcome} ×${size} @ $${price.toFixed(2)} on ${market.question?.slice(0, 50) ?? signal.marketId.slice(0, 20)}…`,
      );

      orders.push({
        walletId,
        marketId: signal.marketId,
        tokenId,
        outcome: signal.outcome,
        side: signal.side,
        price,
        size,
        strategy: this.name,
      });
    }

    return orders;
  }

  /* ── Position tracking via engine callback ──────────────────── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    // Just mark as having an open order — real fill detection is via wallet sync
    this.openOrderMarkets.add(order.marketId);
    consoleLog.info(
      'STRATEGY',
      `Order accepted: ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(2)} on ${order.marketId.slice(0, 20)}…`,
    );
  }

  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions: SELL when profitable or cut losses ──── */
  override managePositions(): void {
    const positions = this.context?.wallet.openPositions ?? [];
    if (positions.length === 0) return;

    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();

    for (const pos of positions) {
      const posKey = pos.marketId;
      // Also get the gamma ID for market cache lookups
      const gammaId = this.conditionToGammaId.get(pos.marketId) ?? pos.marketId;

      // Skip if we already submitted a sell or a previous sell failed (phantom position)
      if (this.pendingSells.has(posKey) || this.pendingSells.has(gammaId)) continue;
      if (this.failedSells.has(posKey) || this.failedSells.has(gammaId)) continue;

      // Only manage positions we actually bought (have an entry record)
      // Wallet positions may use hex conditionId (after CLOB sync) or gamma numericId (right after buy)
      let entry = this.entryRecords.get(pos.marketId);
      if (!entry) {
        // Try reverse lookup: conditionId → gamma ID
        const gammaId = this.conditionToGammaId.get(pos.marketId);
        if (gammaId) entry = this.entryRecords.get(gammaId);
      }
      if (!entry) continue;

      // Don't sell a position we bought in the last 60 seconds (let it settle)
      if (now - entry.entryTime < 60_000) continue;

      // Get current market data (try gamma ID first, then position's ID)
      const market = this.markets.get(gammaId) ?? this.markets.get(pos.marketId);
      if (!market) continue;

      // Get the current mid price for this outcome
      const currentPrice = pos.outcome === 'YES'
        ? (market.outcomePrices[0] ?? 0.5)
        : (market.outcomePrices[1] ?? 1 - (market.outcomePrices[0] ?? 0.5));

      const entryPrice = pos.avgPrice;
      if (entryPrice <= 0) continue;

      // Calculate unrealized P&L percentage (gross, before fees)
      const pnlPct = (currentPrice - entryPrice) / entryPrice;
      // Net P&L after fees on both entry and exit (~2% each side)
      const netPnlPct = pnlPct - FEE_PCT * 2;
      // Estimated dollar profit if we sell now
      const estProfit = (currentPrice - entryPrice) * pos.size - (currentPrice * pos.size * FEE_PCT);

      // Hold time for time-based exit
      const holdTime = now - entry.entryTime;

      let shouldSell = false;
      let reason = '';

      // Take profit: sell when up 12%+ (net profit after fees is ~8%)
      if (pnlPct >= TAKE_PROFIT_PCT && estProfit > 0.10) {
        shouldSell = true;
        reason = `TAKE PROFIT +${(pnlPct * 100).toFixed(1)}% (net ~$${estProfit.toFixed(2)})`;
      }
      // Stop loss: sell when down 25%+
      else if (pnlPct <= -STOP_LOSS_PCT) {
        shouldSell = true;
        reason = `STOP LOSS ${(pnlPct * 100).toFixed(1)}%`;
      }
      // Time exit: sell after 48 hours if not meaningfully profitable
      else if (holdTime > TIME_EXIT_MS && netPnlPct < 0.05) {
        shouldSell = true;
        reason = `TIME EXIT (${Math.round(holdTime / 3600_000)}h, net ${(netPnlPct * 100).toFixed(1)}%)`;
      }

      if (!shouldSell) continue;

      // Resolve token ID for the sell order
      let tokenId: string | undefined;
      if (market.clobTokenIds && market.outcomes) {
        const outcomeIdx = market.outcomes.findIndex(
          (o) => o.toUpperCase() === pos.outcome,
        );
        if (outcomeIdx >= 0 && outcomeIdx < market.clobTokenIds.length) {
          tokenId = market.clobTokenIds[outcomeIdx];
        }
      }

      if (!tokenId) {
        consoleLog.info('STRATEGY', `Cannot sell ${posKey.slice(0, 12)}… — no token ID`);
        continue;
      }

      // Sell at the bid price - 1¢ for quick execution
      // For NO outcome: NO bid ≈ 1 - YES_ask
      const rawBid = pos.outcome === 'YES'
        ? market.bid
        : 1 - market.ask;
      const sellPrice = Number(Math.max(0.01, Math.min(0.99, rawBid - 0.01)).toFixed(2));
      const sellSize = pos.size;

      consoleLog.warn(
        'STRATEGY',
        `${reason}: SELL ${pos.outcome} ×${sellSize} @ $${sellPrice.toFixed(2)} ` +
          `(entry $${entryPrice.toFixed(2)}) on ${market.question?.slice(0, 50) ?? pos.marketId.slice(0, 20)}…`,
      );

      // Mark as pending sell to avoid duplicate exits
      this.pendingSells.add(posKey);
      if (entry) entry.exitSubmittedAt = now;

      this.pendingExits.push({
        walletId,
        marketId: pos.marketId,
        tokenId,
        outcome: pos.outcome,
        side: 'SELL',
        price: sellPrice,
        size: sellSize,
        strategy: this.name,
      });
    }
  }

  /* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
     Quantitative Factors (used for Claude context + signal boost)
     ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

  private factorMomentum(prices: number[]): FactorResult {
    const emaShort = this.ema(prices, 5);
    const emaLong = this.ema(prices, 15);
    if (emaShort.length < 2 || emaLong.length < 2) {
      return { direction: 'NEUTRAL', strength: 0, name: 'momentum' };
    }
    const currentDiff = emaShort[emaShort.length - 1] - emaLong[emaLong.length - 1];
    const prevDiff = emaShort[emaShort.length - 2] - emaLong[emaLong.length - 2];
    const strength = Math.min(1, Math.abs(currentDiff) * 30);
    if (currentDiff > 0.001 && currentDiff > prevDiff) {
      return { direction: 'YES', strength, name: 'momentum' };
    } else if (currentDiff < -0.001 && currentDiff < prevDiff) {
      return { direction: 'NO', strength, name: 'momentum' };
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'momentum' };
  }

  private factorMeanReversion(prices: number[]): FactorResult {
    const lookback = Math.min(prices.length, 30);
    const recent = prices.slice(-lookback);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, p) => s + (p - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);
    if (stdDev < 0.002) return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
    const zScore = (prices[prices.length - 1] - mean) / stdDev;
    const strength = Math.min(1, Math.max(0, (Math.abs(zScore) - 1) / 2));
    if (zScore > 1.5) return { direction: 'NO', strength, name: 'mean_reversion' };
    if (zScore < -1.5) return { direction: 'YES', strength, name: 'mean_reversion' };
    return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
  }

  private factorVolumePriceDivergence(prices: number[], volumes: number[]): FactorResult {
    if (prices.length < 5 || volumes.length < 5) {
      return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
    }
    const recentPrices = prices.slice(-5);
    const recentVols = volumes.slice(-5);
    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    const volStart = recentVols[0];
    const volEnd = recentVols[recentVols.length - 1];
    const volChange = volStart > 0 ? (volEnd - volStart) / volStart : 0;
    if (volChange > 0.15 && Math.abs(priceChange) < 0.005) {
      const lastMove = prices[prices.length - 1] - prices[prices.length - 2];
      const strength = Math.min(1, volChange * 2);
      if (lastMove > 0) return { direction: 'YES', strength, name: 'vol_price_div' };
      if (lastMove < 0) return { direction: 'NO', strength, name: 'vol_price_div' };
    }
    if (volChange < -0.1 && Math.abs(priceChange) > 0.01) {
      const strength = Math.min(1, Math.abs(priceChange) * 20);
      return { direction: priceChange > 0 ? 'NO' : 'YES', strength: strength * 0.7, name: 'vol_price_div' };
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
  }

  private factorVolatility(prices: number[], regime: Regime): FactorResult {
    if (regime === 'volatile') {
      const recent = prices.slice(-5);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const dev = prices[prices.length - 1] - avg;
      if (Math.abs(dev) > 0.01) {
        return { direction: dev > 0 ? 'NO' : 'YES', strength: Math.min(1, Math.abs(dev) * 20) * 0.6, name: 'volatility' };
      }
    }
    if (regime === 'trending') {
      const trend = prices[prices.length - 1] - prices[Math.max(0, prices.length - 10)];
      if (Math.abs(trend) > 0.005) {
        return { direction: trend > 0 ? 'YES' : 'NO', strength: Math.min(1, Math.abs(trend) * 20) * 0.5, name: 'volatility' };
      }
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'volatility' };
  }

  private factorAcceleration(prices: number[]): FactorResult {
    if (prices.length < 6) return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    const v1 = prices[prices.length - 1] - prices[prices.length - 3];
    const v2 = prices[prices.length - 3] - prices[prices.length - 5];
    const acceleration = v1 - v2;
    if (Math.abs(acceleration) < 0.002) return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    return { direction: acceleration > 0 ? 'YES' : 'NO', strength: Math.min(1, Math.abs(acceleration) * 50), name: 'acceleration' };
  }

  private factorLiquidity(market: MarketData): FactorResult {
    const bidDist = market.midPrice - market.bid;
    const askDist = market.ask - market.midPrice;
    if (bidDist === 0 || askDist === 0) return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
    const ratio = bidDist / askDist;
    if (ratio < 0.7) return { direction: 'YES', strength: Math.min(1, (1 - ratio) * 2), name: 'liquidity' };
    if (ratio > 1.4) return { direction: 'NO', strength: Math.min(1, (ratio - 1) * 2), name: 'liquidity' };
    return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
  }

  private runFactors(_marketId: string, market: MarketData, prices: number[], volumes: number[], regime: Regime): FactorResult[] {
    return [
      this.factorMomentum(prices),
      this.factorMeanReversion(prices),
      this.factorVolumePriceDivergence(prices, volumes),
      this.factorVolatility(prices, regime),
      this.factorAcceleration(prices),
      this.factorLiquidity(market),
    ];
  }

  private detectRegime(prices: number[]): Regime {
    if (prices.length < 10) return 'ranging';
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      returns.push((prices[i] - prices[i - 1]) / Math.max(prices[i - 1], 0.01));
    }
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
    const vol = Math.sqrt(variance);
    const cumReturn = (prices[prices.length - 1] - prices[0]) / Math.max(prices[0], 0.01);
    if (vol > 0.015) return 'volatile';
    if (Math.abs(cumReturn) > 0.02 && vol < 0.01) return 'trending';
    return 'ranging';
  }

  private ema(prices: number[], period: number): number[] {
    if (prices.length < period) return [];
    const k = 2 / (period + 1);
    const result: number[] = [];
    let sum = 0;
    for (let i = 0; i < period; i++) sum += prices[i];
    let prev = sum / period;
    result.push(prev);
    for (let i = period; i < prices.length; i++) {
      const val = prices[i] * k + prev * (1 - k);
      result.push(val);
      prev = val;
    }
    return result;
  }

  private passesFilters(market: MarketData): boolean {
    if (market.volume24h < MIN_VOLUME) return false;
    if (market.liquidity < MIN_LIQUIDITY) return false;
    const yesPrice = market.outcomePrices[0] ?? 0.5;
    if (yesPrice < PRICE_FLOOR || yesPrice > PRICE_CEILING) return false;
    return true;
  }
}
