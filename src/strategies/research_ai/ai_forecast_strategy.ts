import { BaseStrategy } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { ClaudeAnalyzer } from './claude_analyzer';
import { consoleLog } from '../../reporting/console_log';
import { logger } from '../../reporting/logs';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PolyPatronBot AI Forecast Strategy — Active Trading
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   Strategy flow:
   1. Filter markets by volume, liquidity, spread, price range
   2. Quant factors pre-screen for directional signal
   3. Claude AI estimates TRUE probability vs market price
   4. BUY when Claude finds mispricing with confidence
   5. Position management: trailing TP, tight SL, time exit
   6. Prediction markets resolve $0/$1 — let winners ride

   Position management uses the wallet's live position data,
   NOT phantom fills from order acceptance.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

/* ── Market filters ── */
const MIN_VOLUME = 1_000;
const MIN_LIQUIDITY = 500;
const MIN_HISTORY = 3;          // low to reduce cold-start time (3 polls × 2 min = 6 min)
const MAX_HISTORY = 60;
const PRICE_FLOOR = 0.15;
const PRICE_CEILING = 0.85;
const MAX_SPREAD = 0.05;       // skip markets with > 5¢ spread (500bps)
const MAX_POSITIONS = 10;

/* ── Position sizing ── */
const RISK_PCT = 0.08;          // risk 8% of capital per trade
const MIN_SHARES = 8;
const MAX_SHARES = 30;

/* ── Exit thresholds ── */
const TAKE_PROFIT_PCT = 0.30;   // take profit at +30% (let winners ride in binary markets)
const STOP_LOSS_PCT = 0.15;     // cut losses at -15% (tight — prediction markets can gap)
const TRAILING_ACTIVATION = 0.15; // activate trailing stop after +15%
const TRAILING_DISTANCE = 0.08;  // trail 8% below high water mark
const TIME_EXIT_MS = 24 * 3600_000; // exit after 24h if not meaningfully profitable
const FEE_PCT = 0.02;           // Polymarket ~2% fee per trade

/* ── Claude thresholds ── */
const MIN_CONFIDENCE = 0.30;    // Claude is often conservative; 0.30 lets viable signals through
const MIN_EDGE = 0.015;         // 1.5% edge minimum (covers fees)

type Regime = 'trending' | 'ranging' | 'volatile';

interface FactorResult {
  direction: 'YES' | 'NO' | 'NEUTRAL';
  strength: number;
  name: string;
}

interface EntryRecord {
  marketId: string;
  conditionId?: string;
  outcome: 'YES' | 'NO';
  entryPrice: number;
  entryTime: number;
  exitSubmittedAt?: number;
  /** High water mark for trailing stop (percentage gain from entry) */
  highWaterMark: number;
}

const ENTRY_RECORDS_FILE = join(process.cwd(), 'entry-records.json');

export class AiForecastStrategy extends BaseStrategy {
  readonly name = 'ai_forecast';
  protected override cooldownMs = 300_000; // 5 min per-market cooldown

  private priceHistory = new Map<string, number[]>();
  private volumeHistory = new Map<string, number[]>();
  private claude = new ClaudeAnalyzer();
  private pendingAnalysis = new Map<string, Promise<void>>();

  private orderCooldowns = new Map<string, number>();
  private openOrderMarkets = new Set<string>();
  private lastGlobalOrderTime = 0;
  private globalCooldownMs = 180_000; // 3 min between BUY orders
  private entryRecords = new Map<string, EntryRecord>();
  private pendingSells = new Set<string>();
  private failedSells = new Set<string>();
  private conditionToGammaId = new Map<string, string>();

  constructor() {
    super();
    this.loadEntryRecords();
  }

  private loadEntryRecords(): void {
    try {
      const raw = readFileSync(ENTRY_RECORDS_FILE, 'utf-8');
      const data = JSON.parse(raw) as { entries: Array<[string, EntryRecord]>; condMap: Array<[string, string]> };
      this.entryRecords = new Map(data.entries);
      this.conditionToGammaId = new Map(data.condMap);
      logger.info({ count: this.entryRecords.size }, 'Loaded persisted entry records');
    } catch {
      // No file or parse error — start fresh
    }
  }

  private saveEntryRecords(): void {
    try {
      const data = {
        entries: [...this.entryRecords.entries()],
        condMap: [...this.conditionToGammaId.entries()],
      };
      writeFileSync(ENTRY_RECORDS_FILE, JSON.stringify(data), 'utf-8');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Failed to persist entry records');
    }
  }

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    if (!this.passesFilters(data) && !this.entryRecords.has(data.marketId)) return;

    super.onMarketUpdate(data);

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
  private lastAuditTime = 0;
  private auditStats = { entered: 0, exited: 0, profitableExits: 0, totalPnl: 0, skippedSignals: 0 };

  /* ── Timer: trigger Claude analysis for promising markets ──── */
  override onTimer(): void {
    const now = Date.now();

    // Performance self-audit every 12 hours
    if (now - this.lastAuditTime > 12 * 3600_000) {
      this.lastAuditTime = now;
      const s = this.auditStats;
      const winRate = s.exited > 0 ? s.profitableExits / s.exited : 0;
      logger.info({
        periodHours: 12,
        entered: s.entered,
        exited: s.exited,
        profitableExits: s.profitableExits,
        winRate: Number(winRate.toFixed(2)),
        totalPnl: Number(s.totalPnl.toFixed(2)),
        skippedSignals: s.skippedSignals,
        openPositions: this.entryRecords.size,
        currentConfThreshold: MIN_CONFIDENCE,
        currentEdgeThreshold: MIN_EDGE,
      }, 'SELF-AUDIT: 12h performance review');
      // Reset counters for next period
      this.auditStats = { entered: 0, exited: 0, profitableExits: 0, totalPnl: 0, skippedSignals: 0 };
    }

    // Periodic GC: evict low-value markets (every 10 min)
    if (now - this.lastGcTime > 600_000) {
      this.lastGcTime = now;
      let evicted = 0;
      for (const [marketId, market] of this.markets) {
        if (this.entryRecords.has(marketId)) continue;
        if (this.conditionToGammaId.has(marketId)) continue;
        if (this.passesFilters(market)) continue;
        this.markets.delete(marketId);
        this.priceHistory.delete(marketId);
        this.volumeHistory.delete(marketId);
        evicted++;
      }
      if (evicted > 0) {
        logger.info({ evicted, remaining: this.markets.size }, 'GC: evicted low-value markets');
      }
      // Persist entry records periodically (captures HWM updates)
      if (this.entryRecords.size > 0) this.saveEntryRecords();
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

    // GC entry records for positions no longer in wallet (sold/resolved)
    const openPosIds = new Set((this.context?.wallet.openPositions ?? []).map((p) => p.marketId));
    let gcEntries = 0;
    for (const [mId, entry] of this.entryRecords) {
      const condId = entry.conditionId;
      // Keep if position still exists (by marketId or conditionId)
      if (openPosIds.has(mId)) continue;
      if (condId && openPosIds.has(condId)) continue;
      // Keep for 5 min after entry (position may not appear in sync yet)
      if (now - entry.entryTime < 300_000) continue;
      this.entryRecords.delete(mId);
      this.pendingSells.delete(mId);
      this.failedSells.delete(mId);
      gcEntries++;
    }
    if (gcEntries > 0) {
      logger.info({ gcEntries, remaining: this.entryRecords.size }, 'GC: cleaned up resolved entry records');
      this.saveEntryRecords();
    }

    if (!this.claude.isEnabled()) return;

    const ourPositionCount = this.entryRecords.size;
    if (ourPositionCount >= MAX_POSITIONS) return;

    // Send promising markets to Claude for analysis
    const MAX_PENDING_ANALYSES = 5;
    for (const [marketId, market] of this.markets) {
      if (this.pendingAnalysis.size >= MAX_PENDING_ANALYSES) break;
      if (this.pendingAnalysis.has(marketId)) continue;
      if (!this.passesFilters(market)) continue;

      // Skip already-resolved or expired markets
      if (market.endDate) {
        const endTime = new Date(market.endDate).getTime();
        if (!isNaN(endTime) && endTime < now) continue;
      }

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;

      // Send to Claude for analysis — quant factors are used for confidence boost,
      // not as a gate. Claude is the primary decision maker.
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
            regime: this.detectRegime(prices),
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

    // Global cooldown
    const cooldownRemaining = this.globalCooldownMs - (now - this.lastGlobalOrderTime);
    if (cooldownRemaining > 0) {
      if ((now % 60_000) < 5_000) {
        logger.info({ cooldownRemaining: Math.round(cooldownRemaining / 1000) }, 'Signal gen: global cooldown active');
      }
      return signals;
    }

    const ourPositionCount = this.entryRecords.size;
    if (ourPositionCount >= MAX_POSITIONS) {
      logger.info({ ourPositionCount, MAX_POSITIONS }, 'Signal gen: max own positions reached');
      return signals;
    }

    let passFilters = 0, hasHistory = 0, hasClaude = 0;
    const shouldLogFunnel = (now % 30_000) < 5_000;
    const openPositions = this.context?.wallet.openPositions ?? [];

    // Build set of markets we already have positions in
    const positionMarkets = new Set<string>();
    for (const pos of openPositions) {
      positionMarkets.add(pos.marketId);
      const gId = this.conditionToGammaId.get(pos.marketId);
      if (gId) positionMarkets.add(gId);
    }
    for (const [mId] of this.entryRecords) {
      positionMarkets.add(mId);
    }

    for (const [marketId, market] of this.markets) {
      if (!this.passesFilters(market)) continue;
      passFilters++;

      if (positionMarkets.has(marketId)) continue;
      if (this.openOrderMarkets.has(marketId)) continue;
      const lastOrder = this.orderCooldowns.get(marketId) ?? 0;
      if (now - lastOrder < this.cooldownMs) continue;

      // Skip expired markets
      if (market.endDate) {
        const endTime = new Date(market.endDate).getTime();
        if (!isNaN(endTime) && endTime < now) continue;
      }

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;
      hasHistory++;

      // Get Claude analysis via public API (no more `as any` hack)
      const claudeResult = this.claude.isEnabled()
        ? this.claude.getAnalysis(marketId)
        : null;

      if (!claudeResult || claudeResult.direction === 'SKIP') continue;

      hasClaude++;

      // Check confidence and edge thresholds
      if (claudeResult.confidence < MIN_CONFIDENCE || claudeResult.edge < MIN_EDGE) {
        this.auditStats.skippedSignals++;
        logger.info(
          { marketId, conf: claudeResult.confidence, edge: claudeResult.edge },
          `Skipped: conf=${claudeResult.confidence.toFixed(2)} edge=${claudeResult.edge.toFixed(3)} below threshold`,
        );
        continue;
      }

      let outcome: 'YES' | 'NO' = claudeResult.direction;
      let confidence: number = claudeResult.confidence;
      let edge: number = claudeResult.edge;

      // Boost confidence if 2+ quant factors agree
      const regime = this.detectRegime(prices);
      const factors = this.runFactors(marketId, market, prices, volumes, regime);
      const agreeingFactors = factors.filter((f) => f.direction === outcome);
      if (agreeingFactors.length >= 2) {
        const avgStrength = agreeingFactors.reduce((s, f) => s + f.strength, 0) / agreeingFactors.length;
        confidence = Math.min(0.90, confidence + avgStrength * 0.1);
        edge = Math.min(0.15, edge + avgStrength * 0.01);
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

    // Log funnel
    if (signals.length > 0 || (shouldLogFunnel && (passFilters > 0 || hasClaude > 0))) {
      logger.info(
        { total: this.markets.size, passFilters, hasHistory, hasClaude, signals: signals.length },
        `Signal funnel: ${this.markets.size} → ${passFilters} filters → ${hasHistory} history → ${hasClaude} Claude → ${signals.length} signals`,
      );
    }

    signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
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
      if (!market) {
        logger.info({ marketId: signal.marketId }, 'sizePositions: market not found');
        continue;
      }

      // Resolve CLOB token ID
      // YES → index 0, NO → index 1 (works for both Yes/No and named-outcome markets)
      let tokenId: string | undefined;
      if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
        const idx = signal.outcome === 'YES' ? 0 : 1;
        tokenId = market.clobTokenIds[idx];
      }

      if (!tokenId) {
        logger.info({
          marketId: signal.marketId.slice(0, 16),
          signalOutcome: signal.outcome,
          clobTokenCount: market.clobTokenIds?.length ?? 0,
        }, 'sizePositions: no token ID');
        continue;
      }

      // Price: buy at ask + 1¢ for fill certainty
      let price: number;
      if (signal.side === 'BUY') {
        const rawAsk = signal.outcome === 'YES'
          ? market.ask
          : 1 - market.bid;
        price = Number(Math.max(0.01, Math.min(0.99, rawAsk + 0.01)).toFixed(2));
      } else {
        const rawBid = signal.outcome === 'YES'
          ? market.bid
          : 1 - market.ask;
        price = Number(Math.max(0.01, Math.min(0.99, rawBid - 0.01)).toFixed(2));
      }

      // Size: risk RISK_PCT of capital per trade, clamped to MIN/MAX shares
      const maxCost = capital * RISK_PCT;
      const maxShares = Math.floor(maxCost / Math.max(price, 0.01));
      const size = Math.max(MIN_SHARES, Math.min(maxShares, MAX_SHARES));

      const orderCost = price * size;
      if (orderCost > capital * 0.15) {
        logger.info({ marketId: signal.marketId.slice(0, 16), orderCost, limit: capital * 0.15, capital }, 'sizePositions: order > 15% capital');
        continue;
      }
      if (orderCost > capital - 3) {
        logger.info({ marketId: signal.marketId.slice(0, 16), orderCost, capital }, 'sizePositions: would exceed $3 reserve');
        continue;
      }

      // Set cooldowns (prevent duplicate orders while this one is in flight)
      this.orderCooldowns.set(signal.marketId, now);
      this.openOrderMarkets.add(signal.marketId);
      this.lastGlobalOrderTime = now;

      consoleLog.success(
        'STRATEGY',
        `BUY ${signal.outcome} ×${size} @ $${price.toFixed(2)} ($${orderCost.toFixed(2)}) on ${market.question?.slice(0, 50) ?? signal.marketId.slice(0, 20)}…`,
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

  /* ── Position tracking callback (only called on successful execution) ── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    this.openOrderMarkets.add(order.marketId);

    // Create entry record for position management (only after confirmed fill)
    const market = this.markets.get(order.marketId);
    const condId = market?.conditionId;
    this.entryRecords.set(order.marketId, {
      marketId: order.marketId,
      conditionId: condId,
      outcome: order.outcome,
      entryPrice: order.price,
      entryTime: Date.now(),
      highWaterMark: 0,
    });
    if (condId) {
      this.conditionToGammaId.set(condId, order.marketId);
    }
    this.auditStats.entered++;
    this.saveEntryRecords();

    consoleLog.info(
      'STRATEGY',
      `Order filled: ${order.side} ${order.outcome} ×${order.size} @ $${order.price.toFixed(2)} on ${order.marketId.slice(0, 20)}…`,
    );
  }

  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions: trailing stop, TP, SL, time exit ────── */
  override managePositions(): void {
    const positions = this.context?.wallet.openPositions ?? [];
    if (positions.length === 0) return;

    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();

    for (const pos of positions) {
      const posKey = pos.marketId;
      const gammaId = this.conditionToGammaId.get(pos.marketId) ?? pos.marketId;

      if (this.pendingSells.has(posKey) || this.pendingSells.has(gammaId)) continue;
      if (this.failedSells.has(posKey) || this.failedSells.has(gammaId)) continue;

      // Find entry record
      let entry = this.entryRecords.get(pos.marketId);
      if (!entry) {
        const mapped = this.conditionToGammaId.get(pos.marketId);
        if (mapped) entry = this.entryRecords.get(mapped);
      }
      if (!entry) continue;

      // Don't sell within 60 seconds of entry
      if (now - entry.entryTime < 60_000) continue;

      // Get current market data
      const market = this.markets.get(gammaId) ?? this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice = pos.outcome === 'YES'
        ? (market.outcomePrices[0] ?? 0.5)
        : (market.outcomePrices[1] ?? 1 - (market.outcomePrices[0] ?? 0.5));

      const entryPrice = pos.avgPrice;
      if (entryPrice <= 0) continue;

      // Calculate P&L
      const pnlPct = (currentPrice - entryPrice) / entryPrice;
      const netPnlPct = pnlPct - FEE_PCT * 2;
      const estProfit = (currentPrice - entryPrice) * pos.size - (currentPrice * pos.size * FEE_PCT);
      const holdTime = now - entry.entryTime;

      // Update high water mark for trailing stop
      if (pnlPct > entry.highWaterMark) {
        entry.highWaterMark = pnlPct;
      }

      let shouldSell = false;
      let reason = '';

      // 1. TRAILING STOP: activated after +15%, sells if drops 8% from peak
      if (entry.highWaterMark >= TRAILING_ACTIVATION) {
        const drawdownFromPeak = entry.highWaterMark - pnlPct;
        if (drawdownFromPeak >= TRAILING_DISTANCE) {
          shouldSell = true;
          reason = `TRAILING STOP (peak +${(entry.highWaterMark * 100).toFixed(1)}%, now +${(pnlPct * 100).toFixed(1)}%, drop ${(drawdownFromPeak * 100).toFixed(1)}%)`;
        }
      }

      // 2. TAKE PROFIT: hard cap at +30%
      if (!shouldSell && pnlPct >= TAKE_PROFIT_PCT && estProfit > 0.20) {
        shouldSell = true;
        reason = `TAKE PROFIT +${(pnlPct * 100).toFixed(1)}% (net ~$${estProfit.toFixed(2)})`;
      }

      // 3. STOP LOSS: cut at -15%
      if (!shouldSell && pnlPct <= -STOP_LOSS_PCT) {
        shouldSell = true;
        reason = `STOP LOSS ${(pnlPct * 100).toFixed(1)}%`;
      }

      // 4. TIME EXIT: 24h with < 5% net profit
      if (!shouldSell && holdTime > TIME_EXIT_MS && netPnlPct < 0.05) {
        shouldSell = true;
        reason = `TIME EXIT (${Math.round(holdTime / 3600_000)}h, net ${(netPnlPct * 100).toFixed(1)}%)`;
      }

      if (!shouldSell) continue;

      // Resolve token ID: YES → index 0, NO → index 1
      let tokenId: string | undefined;
      if (market.clobTokenIds && market.clobTokenIds.length >= 2) {
        const idx = pos.outcome === 'YES' ? 0 : 1;
        tokenId = market.clobTokenIds[idx];
      }

      if (!tokenId) {
        consoleLog.info('STRATEGY', `Cannot sell ${posKey.slice(0, 12)}… — no token ID`);
        continue;
      }

      // Sell at bid - 1¢ for quick fill
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

      this.pendingSells.add(posKey);
      if (entry) entry.exitSubmittedAt = now;
      this.auditStats.exited++;
      this.auditStats.totalPnl += estProfit;
      if (estProfit > 0) this.auditStats.profitableExits++;

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
     Quantitative Factors (pre-screen for Claude + confidence boost)
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
    // Spread filter: skip illiquid markets where entry/exit costs eat the edge
    if (market.spread > MAX_SPREAD) return false;
    const yesPrice = market.outcomePrices[0] ?? 0.5;
    if (yesPrice < PRICE_FLOOR || yesPrice > PRICE_CEILING) return false;
    return true;
  }
}
