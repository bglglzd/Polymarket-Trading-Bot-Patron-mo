import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../reporting/logs';

export interface MarketAnalysis {
  direction: 'YES' | 'NO' | 'SKIP';
  confidence: number; // 0-1
  edge: number; // estimated edge in decimal
  reasoning: string;
  factors: string[];
}

interface MarketContext {
  question: string;
  currentYesPrice: number;
  currentNoPrice: number;
  spread: number;
  volume24h: number;
  liquidity: number;
  oneDayPriceChange?: number;
  oneWeekPriceChange?: number;
  endDate?: string;
  priceHistory: number[];
  quantSignals: {
    momentum: string;
    meanReversion: string;
    volumeDivergence: string;
    regime: string;
    acceleration: string;
    liquidityQuality: string;
  };
}

const ANALYSIS_PROMPT = `You are PolyPatronBot's AI trading analyst for Polymarket prediction markets. Your job is to analyze a specific market and provide a trading recommendation.

MARKET DATA:
- Question: {question}
- Current YES price: ${'{yesPrice}'} (probability the market resolves YES)
- Current NO price: ${'{noPrice}'}
- Bid-Ask Spread: {spread} bps
- 24h Volume: ${'{volume}'}
- Liquidity: ${'{liquidity}'}
- 1-Day Price Change: {dayChange}%
- 1-Week Price Change: {weekChange}%
- End Date: {endDate}
- Recent price trend (last 10 data points): {priceHistory}

QUANTITATIVE SIGNALS (from our factor model):
- Momentum: {momentum}
- Mean Reversion: {meanReversion}
- Volume-Price Divergence: {volumeDivergence}
- Market Regime: {regime}
- Price Acceleration: {acceleration}
- Liquidity Quality: {liquidityQuality}

ANALYSIS INSTRUCTIONS:
1. Assess the market question — is the outcome becoming more or less likely based on available context?
2. Analyze the price action — is the current price over/undervalued relative to true probability?
3. Consider the quantitative signals — do they align with a clear direction?
4. Evaluate risk — how close to resolution, how wide is the spread, is there enough liquidity?

RULES:
- Only recommend a trade when you have genuine conviction (confidence > 0.5)
- If the market is too uncertain, too close to 50/50, or signals conflict, recommend SKIP
- Be conservative — a SKIP is always better than a losing trade
- Edge should reflect how far the price is from true probability
- Markets near resolution (< 1 day) with clear trends are higher confidence
- Wide spreads (> 300 bps) reduce confidence
- Low volume (< $1000) means SKIP

Respond in EXACTLY this JSON format (no markdown, no explanation outside JSON):
{
  "direction": "YES" | "NO" | "SKIP",
  "confidence": <0.0 to 1.0>,
  "edge": <0.0 to 0.10>,
  "reasoning": "<1-2 sentence explanation>",
  "factors": ["<factor1>", "<factor2>", "<factor3>"]
}`;

export class ClaudeAnalyzer {
  private client: Anthropic | null = null;
  private lastCallTime = 0;
  private minIntervalMs = 5000; // Rate limit: max 1 call per 5 seconds
  private cache = new Map<string, { analysis: MarketAnalysis; timestamp: number }>();
  private cacheTtlMs = 300_000; // Cache results for 5 minutes

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
      logger.info('ClaudeAnalyzer initialized with API key');
    } else {
      logger.warn('ANTHROPIC_API_KEY not set — Claude AI analysis disabled, using quant-only mode');
    }
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  async analyzeMarket(marketId: string, ctx: MarketContext): Promise<MarketAnalysis | null> {
    if (!this.client) return null;

    // Check cache
    const cached = this.cache.get(marketId);
    if (cached && Date.now() - cached.timestamp < this.cacheTtlMs) {
      return cached.analysis;
    }

    // Rate limiting
    const now = Date.now();
    const elapsed = now - this.lastCallTime;
    if (elapsed < this.minIntervalMs) {
      return null; // Skip this call, will try next tick
    }
    this.lastCallTime = now;

    try {
      const prompt = this.buildPrompt(ctx);

      const response = await this.client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [{ role: 'user', content: prompt }],
      });

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('');

      const analysis = this.parseResponse(text);
      if (analysis) {
        this.cache.set(marketId, { analysis, timestamp: Date.now() });
        logger.info(
          {
            marketId,
            direction: analysis.direction,
            confidence: analysis.confidence,
            edge: analysis.edge,
            reasoning: analysis.reasoning,
          },
          'Claude analysis complete',
        );
      }
      return analysis;
    } catch (err: any) {
      logger.error({ error: err.message, marketId }, 'Claude analysis failed');
      return null;
    }
  }

  private buildPrompt(ctx: MarketContext): string {
    const priceHistoryStr = ctx.priceHistory
      .slice(-10)
      .map((p) => p.toFixed(4))
      .join(', ');

    return ANALYSIS_PROMPT
      .replace('{question}', ctx.question)
      .replace('{yesPrice}', `$${ctx.currentYesPrice.toFixed(2)}`)
      .replace('{noPrice}', `$${ctx.currentNoPrice.toFixed(2)}`)
      .replace('{spread}', ctx.spread.toFixed(0))
      .replace('{volume}', `$${ctx.volume24h.toLocaleString()}`)
      .replace('{liquidity}', `$${ctx.liquidity.toLocaleString()}`)
      .replace('{dayChange}', (ctx.oneDayPriceChange ?? 0).toFixed(2))
      .replace('{weekChange}', (ctx.oneWeekPriceChange ?? 0).toFixed(2))
      .replace('{endDate}', ctx.endDate ?? 'unknown')
      .replace('{priceHistory}', priceHistoryStr)
      .replace('{momentum}', ctx.quantSignals.momentum)
      .replace('{meanReversion}', ctx.quantSignals.meanReversion)
      .replace('{volumeDivergence}', ctx.quantSignals.volumeDivergence)
      .replace('{regime}', ctx.quantSignals.regime)
      .replace('{acceleration}', ctx.quantSignals.acceleration)
      .replace('{liquidityQuality}', ctx.quantSignals.liquidityQuality);
  }

  private parseResponse(text: string): MarketAnalysis | null {
    try {
      // Try to extract JSON from the response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      if (!parsed.direction || !['YES', 'NO', 'SKIP'].includes(parsed.direction)) {
        return null;
      }

      return {
        direction: parsed.direction as 'YES' | 'NO' | 'SKIP',
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
        edge: Math.min(0.1, Math.max(0, Number(parsed.edge) || 0)),
        reasoning: String(parsed.reasoning || ''),
        factors: Array.isArray(parsed.factors) ? parsed.factors.map(String) : [],
      };
    } catch {
      logger.warn({ text: text.slice(0, 200) }, 'Failed to parse Claude response');
      return null;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
