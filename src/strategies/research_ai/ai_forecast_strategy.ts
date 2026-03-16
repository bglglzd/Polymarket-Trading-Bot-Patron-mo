import { BaseStrategy } from '../strategy_interface';
import { Signal, MarketData, OrderRequest } from '../../types';
import { ClaudeAnalyzer } from './claude_analyzer';
import { consoleLog } from '../../reporting/console_log';

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   PolyPatronBot AI Forecast Strategy — Claude-Enhanced
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

   A hybrid strategy combining:
   1. Quantitative factor model (6 factors, regime detection)
   2. Claude AI deep analysis for market context understanding

   Flow:
   - Quant factors run first as a fast filter
   - Markets passing quant filter are sent to Claude for analysis
   - Claude provides direction, confidence, and reasoning
   - Combined score determines final signal

   When ANTHROPIC_API_KEY is not set, falls back to quant-only mode.
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

const MIN_VOLUME = 1_500;
const MIN_LIQUIDITY = 300;
const MIN_HISTORY = 10;
const MAX_HISTORY = 60;
const PRICE_FLOOR = 0.06;
const PRICE_CEILING = 0.94;
const MAX_POSITIONS = 10;
const MAX_CONFIDENCE = 0.90;

type Regime = 'trending' | 'ranging' | 'volatile';

interface FactorResult {
  direction: 'YES' | 'NO' | 'NEUTRAL';
  strength: number;
  name: string;
}

interface ManagedPosition {
  marketId: string;
  outcome: 'YES' | 'NO';
  side: 'BUY' | 'SELL';
  entryPrice: number;
  size: number;
  originalSize: number;
  entryTime: number;
  peakBps: number;
  regime: Regime;
  factorCount: number;
  partialTaken: boolean;
  claudeReasoning?: string;
}

export class AiForecastStrategy extends BaseStrategy {
  readonly name = 'ai_forecast';
  protected override cooldownMs = 150_000; // 2.5 min

  private priceHistory = new Map<string, number[]>();
  private volumeHistory = new Map<string, number[]>();
  private positions: ManagedPosition[] = [];
  private claude = new ClaudeAnalyzer();
  private pendingAnalysis = new Map<string, Promise<void>>();

  /* ── Market update ──────────────────────────────────────────── */
  override onMarketUpdate(data: MarketData): void {
    super.onMarketUpdate(data);

    const prices = this.priceHistory.get(data.marketId) ?? [];
    prices.push(data.midPrice);
    if (prices.length > MAX_HISTORY) prices.shift();
    this.priceHistory.set(data.marketId, prices);

    const vols = this.volumeHistory.get(data.marketId) ?? [];
    vols.push(data.volume24h);
    if (vols.length > MAX_HISTORY) vols.shift();
    this.volumeHistory.set(data.marketId, vols);
  }

  /* ── Timer: trigger Claude analysis for promising markets ──── */
  override onTimer(): void {
    if (!this.claude.isEnabled()) return;
    if (this.positions.length >= MAX_POSITIONS) return;

    // Find markets that pass quant filters and have some signal
    for (const [marketId, market] of this.markets) {
      if (this.pendingAnalysis.has(marketId)) continue;
      if (!this.passesFilters(market)) continue;

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;

      const regime = this.detectRegime(prices);
      const factors = this.runFactors(marketId, market, prices, volumes, regime);

      // Only send to Claude if there's some directional signal (2+ factors agree)
      const yesCount = factors.filter((f) => f.direction === 'YES').length;
      const noCount = factors.filter((f) => f.direction === 'NO').length;
      if (Math.max(yesCount, noCount) < 2) continue;

      // Fire-and-forget Claude analysis (results cached for generateSignals)
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
        .then(() => {
          this.pendingAnalysis.delete(marketId);
        })
        .catch(() => {
          this.pendingAnalysis.delete(marketId);
        });

      this.pendingAnalysis.set(marketId, promise);
    }
  }

  /* ── Signal generation ──────────────────────────────────────── */
  generateSignals(): Signal[] {
    const signals: Signal[] = [];
    if (this.positions.length >= MAX_POSITIONS) return signals;

    for (const [marketId, market] of this.markets) {
      if (!this.passesFilters(market)) continue;

      const prices = this.priceHistory.get(marketId) ?? [];
      const volumes = this.volumeHistory.get(marketId) ?? [];
      if (prices.length < MIN_HISTORY) continue;

      const regime = this.detectRegime(prices);
      const factors = this.runFactors(marketId, market, prices, volumes, regime);

      const yesFactors = factors.filter((f) => f.direction === 'YES');
      const noFactors = factors.filter((f) => f.direction === 'NO');

      const yesStrength = yesFactors.reduce((s, f) => s + f.strength, 0);
      const noStrength = noFactors.reduce((s, f) => s + f.strength, 0);

      // Factor agreement gate
      const minFactorCount = regime === 'volatile' ? 4 : 3;

      let quantOutcome: 'YES' | 'NO' | undefined;
      let factorCount: number = 0;
      let totalStrength: number = 0;

      if (yesFactors.length >= minFactorCount && yesStrength > noStrength * 1.3) {
        quantOutcome = 'YES';
        factorCount = yesFactors.length;
        totalStrength = yesStrength;
      } else if (noFactors.length >= minFactorCount && noStrength > yesStrength * 1.3) {
        quantOutcome = 'NO';
        factorCount = noFactors.length;
        totalStrength = noStrength;
      }

      // If Claude analysis is available, combine with quant signal
      const claudeResult = this.claude.isEnabled()
        ? (this.claude as any).cache?.get(marketId)?.analysis ?? null
        : null;

      let outcome: 'YES' | 'NO';
      let confidence: number;
      let edge: number;

      if (claudeResult && claudeResult.direction !== 'SKIP') {
        // Claude has an opinion
        if (quantOutcome && quantOutcome === claudeResult.direction) {
          // Quant and Claude AGREE — highest confidence
          const agreementRatio = factorCount / factors.length;
          const avgStrength = totalStrength / factorCount;
          const quantConf = 0.3 + agreementRatio * 0.3 + avgStrength * 0.2;
          confidence = Math.min(MAX_CONFIDENCE, (quantConf + claudeResult.confidence) / 2 + 0.1);
          edge = Math.min(0.08, (claudeResult.edge + avgStrength * agreementRatio * 0.1) / 2);
          outcome = quantOutcome;

          consoleLog.success(
            'STRATEGY',
            `AI+Quant AGREE: ${outcome} on ${market.question?.slice(0, 50)}... ` +
              `(conf=${confidence.toFixed(2)}, edge=${edge.toFixed(4)}) — ${claudeResult.reasoning}`,
          );
        } else if (claudeResult.confidence >= 0.65) {
          // Claude is confident enough to override quant (or quant is indecisive)
          outcome = claudeResult.direction;
          confidence = Math.min(MAX_CONFIDENCE, claudeResult.confidence * 0.85);
          edge = claudeResult.edge * 0.8;

          consoleLog.info(
            'STRATEGY',
            `AI override: ${outcome} on ${market.question?.slice(0, 50)}... ` +
              `(conf=${confidence.toFixed(2)}) — ${claudeResult.reasoning}`,
          );
        } else if (quantOutcome) {
          // Claude is uncertain, go with quant
          const agreementRatio = factorCount / factors.length;
          const avgStrength = totalStrength / factorCount;
          const regimeBonus = regime === 'trending' ? 0.1 : regime === 'ranging' ? 0.05 : -0.05;
          confidence = Math.min(MAX_CONFIDENCE, 0.3 + agreementRatio * 0.3 + avgStrength * 0.2 + regimeBonus);
          edge = Math.min(0.06, avgStrength * agreementRatio * 0.1);
          outcome = quantOutcome;
        } else {
          continue; // Both Claude and quant are uncertain
        }
      } else if (quantOutcome) {
        // No Claude analysis — quant-only mode
        const agreementRatio = factorCount / factors.length;
        const avgStrength = totalStrength / factorCount;
        const regimeBonus = regime === 'trending' ? 0.1 : regime === 'ranging' ? 0.05 : -0.05;
        confidence = Math.min(MAX_CONFIDENCE, 0.3 + agreementRatio * 0.3 + avgStrength * 0.2 + regimeBonus);
        edge = Math.min(0.06, avgStrength * agreementRatio * 0.1);
        outcome = quantOutcome;
      } else {
        continue;
      }

      signals.push({
        marketId,
        outcome,
        side: 'BUY',
        confidence,
        edge,
      });
    }

    signals.sort((a, b) => b.confidence * b.edge - a.confidence * a.edge);
    return signals.slice(0, MAX_POSITIONS - this.positions.length);
  }

  /* ── Factor 1: Momentum (EMA crossover) ─────────────────────── */
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

  /* ── Factor 2: Mean-Reversion (z-score from rolling mean) ──── */
  private factorMeanReversion(prices: number[]): FactorResult {
    const lookback = Math.min(prices.length, 30);
    const recent = prices.slice(-lookback);
    const mean = recent.reduce((a, b) => a + b, 0) / recent.length;
    const variance = recent.reduce((s, p) => s + (p - mean) ** 2, 0) / recent.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev < 0.002) {
      return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
    }

    const current = prices[prices.length - 1];
    const zScore = (current - mean) / stdDev;

    const strength = Math.min(1, Math.max(0, (Math.abs(zScore) - 1) / 2));

    if (zScore > 1.5) {
      return { direction: 'NO', strength, name: 'mean_reversion' };
    } else if (zScore < -1.5) {
      return { direction: 'YES', strength, name: 'mean_reversion' };
    }
    return { direction: 'NEUTRAL', strength: 0, name: 'mean_reversion' };
  }

  /* ── Factor 3: Volume-Price Divergence ──────────────────────── */
  private factorVolumePriceDivergence(prices: number[], volumes: number[]): FactorResult {
    if (prices.length < 5 || volumes.length < 5) {
      return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
    }

    const recentPrices = prices.slice(-5);
    const recentVols = volumes.slice(-5);

    const priceChange = recentPrices[recentPrices.length - 1] - recentPrices[0];
    const priceChangeAbs = Math.abs(priceChange);

    const volStart = recentVols[0];
    const volEnd = recentVols[recentVols.length - 1];
    const volChange = volStart > 0 ? (volEnd - volStart) / volStart : 0;

    if (volChange > 0.15 && priceChangeAbs < 0.005) {
      const lastMove = prices[prices.length - 1] - prices[prices.length - 2];
      const strength = Math.min(1, volChange * 2);
      if (lastMove > 0) {
        return { direction: 'YES', strength, name: 'vol_price_div' };
      } else if (lastMove < 0) {
        return { direction: 'NO', strength, name: 'vol_price_div' };
      }
    }

    if (volChange < -0.1 && priceChangeAbs > 0.01) {
      const strength = Math.min(1, priceChangeAbs * 20);
      if (priceChange > 0) {
        return { direction: 'NO', strength: strength * 0.7, name: 'vol_price_div' };
      } else {
        return { direction: 'YES', strength: strength * 0.7, name: 'vol_price_div' };
      }
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'vol_price_div' };
  }

  /* ── Factor 4: Volatility regime filter ─────────────────────── */
  private factorVolatility(prices: number[], regime: Regime): FactorResult {
    if (regime === 'volatile') {
      const recent = prices.slice(-5);
      const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const current = prices[prices.length - 1];
      const dev = current - avg;

      if (Math.abs(dev) > 0.01) {
        const strength = Math.min(1, Math.abs(dev) * 20);
        return {
          direction: dev > 0 ? 'NO' : 'YES',
          strength: strength * 0.6,
          name: 'volatility',
        };
      }
    }

    if (regime === 'trending') {
      const trend = prices[prices.length - 1] - prices[Math.max(0, prices.length - 10)];
      if (Math.abs(trend) > 0.005) {
        return {
          direction: trend > 0 ? 'YES' : 'NO',
          strength: Math.min(1, Math.abs(trend) * 20) * 0.5,
          name: 'volatility',
        };
      }
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'volatility' };
  }

  /* ── Factor 5: Price Acceleration (sentiment proxy) ─────────── */
  private factorAcceleration(prices: number[]): FactorResult {
    if (prices.length < 6) {
      return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    }

    const v1 = prices[prices.length - 1] - prices[prices.length - 3];
    const v2 = prices[prices.length - 3] - prices[prices.length - 5];

    const acceleration = v1 - v2;
    const absAccel = Math.abs(acceleration);

    if (absAccel < 0.002) {
      return { direction: 'NEUTRAL', strength: 0, name: 'acceleration' };
    }

    const strength = Math.min(1, absAccel * 50);
    return {
      direction: acceleration > 0 ? 'YES' : 'NO',
      strength,
      name: 'acceleration',
    };
  }

  /* ── Factor 6: Liquidity Quality ────────────────────────────── */
  private factorLiquidity(market: MarketData): FactorResult {
    const bidDist = market.midPrice - market.bid;
    const askDist = market.ask - market.midPrice;

    if (bidDist === 0 || askDist === 0) {
      return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
    }

    const ratio = bidDist / askDist;

    if (ratio < 0.7) {
      return { direction: 'YES', strength: Math.min(1, (1 - ratio) * 2), name: 'liquidity' };
    } else if (ratio > 1.4) {
      return { direction: 'NO', strength: Math.min(1, (ratio - 1) * 2), name: 'liquidity' };
    }

    return { direction: 'NEUTRAL', strength: 0, name: 'liquidity' };
  }

  /* ── Run all factors ────────────────────────────────────────── */
  private runFactors(
    _marketId: string,
    market: MarketData,
    prices: number[],
    volumes: number[],
    regime: Regime,
  ): FactorResult[] {
    return [
      this.factorMomentum(prices),
      this.factorMeanReversion(prices),
      this.factorVolumePriceDivergence(prices, volumes),
      this.factorVolatility(prices, regime),
      this.factorAcceleration(prices),
      this.factorLiquidity(market),
    ];
  }

  /* ── Regime detection ───────────────────────────────────────── */
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
    const absReturn = Math.abs(cumReturn);

    if (vol > 0.015) return 'volatile';
    if (absReturn > 0.02 && vol < 0.01) return 'trending';
    return 'ranging';
  }

  /* ── Sizing: half-Kelly capped at 3% ────────────────────────── */
  override sizePositions(signals: Signal[]): OrderRequest[] {
    const capital = this.context?.wallet.availableBalance ?? 100;
    const walletId = this.context?.wallet.walletId ?? 'unknown';
    const now = Date.now();

    return signals
      .filter((s) => {
        const key = `${s.marketId}:${s.outcome}:${s.side}`;
        const last = (this as any).tradeCooldowns?.get(key) ?? 0;
        return now - last > this.cooldownMs;
      })
      .map((signal) => {
        const market = this.markets.get(signal.marketId);
        const liquidity = market?.liquidity ?? 500;
        const prices = this.priceHistory.get(signal.marketId) ?? [];
        const regime = this.detectRegime(prices);

        const winProb = 0.5 + signal.edge;
        const kellyFrac = Math.max(0, (winProb * 2 - 1)) / 2;

        const regimeMult = regime === 'trending' ? 1.0 : regime === 'ranging' ? 0.7 : 0.5;

        const maxFromCapital = capital * Math.min(kellyFrac * regimeMult, 0.03);
        const maxFromLiquidity = liquidity * 0.003;
        const size = Math.max(1, Math.floor(Math.min(maxFromCapital, maxFromLiquidity, 40)));

        const price =
          signal.side === 'BUY'
            ? Number(Math.min(0.5 + signal.edge, market?.bid ?? 0.5).toFixed(4))
            : Number(Math.max(0.5 - signal.edge, market?.ask ?? 0.5).toFixed(4));

        return {
          walletId,
          marketId: signal.marketId,
          outcome: signal.outcome,
          side: signal.side,
          price,
          size,
          strategy: this.name,
        };
      });
  }

  /* ── Position tracking via engine callback ──────────────────── */
  override notifyFill(order: OrderRequest): void {
    if (order.strategy !== this.name) return;
    const prices = this.priceHistory.get(order.marketId) ?? [];
    const regime = this.detectRegime(prices);

    this.positions.push({
      marketId: order.marketId,
      outcome: order.outcome,
      side: order.side,
      entryPrice: order.price,
      size: order.size,
      originalSize: order.size,
      entryTime: Date.now(),
      peakBps: 0,
      regime,
      factorCount: 0,
      partialTaken: false,
    });
  }

  override submitOrders(_orders: OrderRequest[]): void {
    return;
  }

  /* ── Manage positions ───────────────────────────────────────── */
  override managePositions(): void {
    const toRemove: number[] = [];

    for (let i = 0; i < this.positions.length; i++) {
      const pos = this.positions[i];
      const market = this.markets.get(pos.marketId);
      if (!market) continue;

      const currentPrice =
        pos.outcome === 'YES' ? market.outcomePrices[0] : market.outcomePrices[1];

      const edgeBps =
        pos.side === 'BUY'
          ? (currentPrice - pos.entryPrice) * 10_000
          : (pos.entryPrice - currentPrice) * 10_000;

      pos.peakBps = Math.max(pos.peakBps, edgeBps);
      const holdingMin = (Date.now() - pos.entryTime) / 60_000;

      let exitReason: string | undefined;

      // Partial profit: take 50% at +100 bps
      if (!pos.partialTaken && edgeBps >= 100) {
        const partialSize = Math.floor(pos.originalSize * 0.5);
        pos.size = pos.size - partialSize;
        pos.partialTaken = true;

        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: pos.side === 'BUY' ? 'SELL' : 'BUY',
          price: currentPrice,
          size: partialSize,
          strategy: this.name,
        });
        continue;
      }

      // Trailing stop: activates at +60 bps, trails 40 bps
      if (pos.peakBps > 60 && edgeBps < pos.peakBps - 40) {
        exitReason = 'TRAILING_STOP';
      }

      // Take profit: +150 bps
      if (!exitReason && edgeBps >= 150) {
        exitReason = 'TAKE_PROFIT';
      }

      // Stop-loss: -120 bps (wider in volatile regime)
      const stopBps = pos.regime === 'volatile' ? -150 : -120;
      if (!exitReason && edgeBps <= stopBps) {
        exitReason = 'STOP_LOSS';
      }

      // Time exit: regime-dependent
      const maxHoldMin =
        pos.regime === 'trending' ? 60 : pos.regime === 'ranging' ? 30 : 20;
      if (!exitReason && holdingMin > maxHoldMin) {
        exitReason = 'TIME_EXIT';
      }

      // Regime change exit
      if (!exitReason) {
        const prices = this.priceHistory.get(pos.marketId) ?? [];
        const currentRegime = this.detectRegime(prices);
        if (currentRegime !== pos.regime && edgeBps < 20) {
          exitReason = 'REGIME_CHANGE';
        }
      }

      if (exitReason) {
        toRemove.push(i);
        const exitSide: 'BUY' | 'SELL' = pos.side === 'BUY' ? 'SELL' : 'BUY';
        this.pendingExits.push({
          walletId: this.context?.wallet.walletId ?? 'unknown',
          marketId: pos.marketId,
          outcome: pos.outcome,
          side: exitSide,
          price: currentPrice,
          size: pos.size,
          strategy: this.name,
        });

        consoleLog.info(
          'STRATEGY',
          `Exit ${exitReason}: ${pos.outcome} on ${pos.marketId.slice(0, 20)}... ` +
            `(entry=${pos.entryPrice.toFixed(4)}, current=${currentPrice.toFixed(4)}, ` +
            `pnl=${edgeBps.toFixed(0)}bps, held=${holdingMin.toFixed(0)}m)`,
        );
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.positions.splice(toRemove[i], 1);
    }
  }

  /* ── Helpers ────────────────────────────────────────────────── */

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
