import OpenAI from 'openai';
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

const SYSTEM_PROMPT = `You are PolyPatronBot's AI trading analyst for Polymarket prediction markets.
You analyze markets and return ONLY a JSON trading recommendation. No markdown, no explanation outside JSON.

RULES:
- Only recommend a trade when you have genuine conviction (confidence > 0.5)
- If the market is too uncertain, too close to 50/50, or signals conflict, recommend SKIP
- Be conservative — a SKIP is always better than a losing trade
- Edge should reflect how far the price is from true probability (0.0 to 0.10)
- Markets near resolution (< 1 day) with clear trends are higher confidence
- Wide spreads (> 300 bps) reduce confidence
- Low volume (< $1000) means SKIP

Response format (ONLY this JSON, nothing else):
{"direction":"YES"|"NO"|"SKIP","confidence":0.0-1.0,"edge":0.0-0.10,"reasoning":"1-2 sentences","factors":["factor1","factor2"]}`;

function buildUserPrompt(ctx: MarketContext): string {
  const priceHistoryStr = ctx.priceHistory
    .slice(-10)
    .map((p) => p.toFixed(4))
    .join(', ');

  return `Analyze this Polymarket market:

Question: ${ctx.question}
YES price: $${ctx.currentYesPrice.toFixed(2)} | NO price: $${ctx.currentNoPrice.toFixed(2)}
Spread: ${ctx.spread.toFixed(0)} bps | Volume 24h: $${ctx.volume24h.toLocaleString()} | Liquidity: $${ctx.liquidity.toLocaleString()}
1-Day change: ${(ctx.oneDayPriceChange ?? 0).toFixed(2)}% | 1-Week change: ${(ctx.oneWeekPriceChange ?? 0).toFixed(2)}%
End date: ${ctx.endDate ?? 'unknown'}
Price history (last 10): [${priceHistoryStr}]

Quant signals: momentum=${ctx.quantSignals.momentum}, mean_reversion=${ctx.quantSignals.meanReversion}, vol_divergence=${ctx.quantSignals.volumeDivergence}, regime=${ctx.quantSignals.regime}, acceleration=${ctx.quantSignals.acceleration}, liquidity=${ctx.quantSignals.liquidityQuality}`;
}

export class ClaudeAnalyzer {
  private client: OpenAI | null = null;
  private lastCallTime = 0;
  private minIntervalMs = 5000;
  private cache = new Map<string, { analysis: MarketAnalysis; timestamp: number }>();
  private cacheTtlMs = 300_000; // 5 min cache

  constructor() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey) {
      this.client = new OpenAI({ apiKey });
      logger.info('AI Analyzer initialized (OpenAI GPT-4o-mini)');
    } else {
      logger.warn('OPENAI_API_KEY not set — AI analysis disabled, using quant-only mode');
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
    if (now - this.lastCallTime < this.minIntervalMs) {
      return null;
    }
    this.lastCallTime = now;

    try {
      const response = await this.client.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(ctx) },
        ],
      });

      const text = response.choices[0]?.message?.content ?? '';
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
          'AI analysis complete',
        );
      }
      return analysis;
    } catch (err: any) {
      logger.error({ error: err.message, marketId }, 'AI analysis failed');
      return null;
    }
  }

  private parseResponse(text: string): MarketAnalysis | null {
    try {
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
      logger.warn({ text: text.slice(0, 200) }, 'Failed to parse AI response');
      return null;
    }
  }

  clearCache(): void {
    this.cache.clear();
  }
}
