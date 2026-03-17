import { execFile, exec, spawn } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

function buildPrompt(ctx: MarketContext): string {
  const priceHistoryStr = ctx.priceHistory
    .slice(-10)
    .map((p) => p.toFixed(4))
    .join(', ');

  return `You are a Polymarket prediction market trading analyst. Analyze this market and respond with ONLY a JSON object, no markdown, no explanation.

Market: ${ctx.question}
YES=$${ctx.currentYesPrice.toFixed(2)} NO=$${ctx.currentNoPrice.toFixed(2)} Spread=${ctx.spread.toFixed(0)}bps
Volume24h=$${ctx.volume24h.toLocaleString()} Liquidity=$${ctx.liquidity.toLocaleString()}
1d change: ${(ctx.oneDayPriceChange ?? 0).toFixed(2)}% | 1w change: ${(ctx.oneWeekPriceChange ?? 0).toFixed(2)}%
End: ${ctx.endDate ?? 'unknown'}
Prices: [${priceHistoryStr}]
Signals: momentum=${ctx.quantSignals.momentum} mean_rev=${ctx.quantSignals.meanReversion} vol_div=${ctx.quantSignals.volumeDivergence} regime=${ctx.quantSignals.regime} accel=${ctx.quantSignals.acceleration} liq=${ctx.quantSignals.liquidityQuality}

Rules: SKIP only if truly 50-50 with no informational edge. If you have a directional lean, give YES or NO with your honest confidence. We profit from price movement, not just resolution. Look for mispricing based on real-world knowledge.
Respond ONLY: {"direction":"YES"|"NO"|"SKIP","confidence":0.0-1.0,"edge":0.0-0.10,"reasoning":"1-2 sentences","factors":["f1","f2"]}`;
}

function runClaude(prompt: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Write prompt to temp file and pipe to claude via stdin
    // This avoids shell escaping issues with $ signs in market data
    const tmpFile = join(tmpdir(), `claude-prompt-${Date.now()}.txt`);
    writeFileSync(tmpFile, prompt);

    exec(
      `cat ${tmpFile} | claude -p - --output-format text`,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, cwd: '/tmp' },
      (error, stdout, stderr) => {
        try { unlinkSync(tmpFile); } catch {}
        const output = stdout.trim();

        if (error && !output) {
          reject(new Error(`claude failed: ${error.message}${stderr ? ' | stderr: ' + stderr.slice(0, 200) : ''}`));
          return;
        }
        resolve(output);
      },
    );
  });
}

export class ClaudeAnalyzer {
  private enabled = false;
  private lastCallTime = 0;
  private minIntervalMs = 10_000; // 10s between calls
  private consecutiveFailures = 0;
  private maxConsecutiveFailures = 5; // disable after 5 failures in a row
  private cache = new Map<string, { analysis: MarketAnalysis; timestamp: number }>();
  private cacheTtlMs = 600_000; // 10 min cache
  private callTimeoutMs = 45_000; // 45s timeout

  constructor() {
    // Check if claude CLI is available
    execFile('claude', ['--version'], { timeout: 5000 }, (error) => {
      if (error) {
        logger.warn('Claude CLI not found — AI analysis disabled, using quant-only mode');
        this.enabled = false;
      } else {
        logger.info('AI Analyzer initialized (Claude CLI)');
        this.enabled = true;
      }
    });
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  async analyzeMarket(marketId: string, ctx: MarketContext): Promise<MarketAnalysis | null> {
    if (!this.enabled) return null;

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
      const prompt = buildPrompt(ctx);
      const output = await runClaude(prompt, this.callTimeoutMs);
      const analysis = this.parseResponse(output);

      if (analysis) {
        this.consecutiveFailures = 0; // reset on success
        this.cache.set(marketId, { analysis, timestamp: Date.now() });
        logger.info(
          {
            marketId,
            direction: analysis.direction,
            confidence: analysis.confidence,
            edge: analysis.edge,
            reasoning: analysis.reasoning,
          },
          'AI analysis complete (Claude)',
        );
      }
      return analysis;
    } catch (err: any) {
      this.consecutiveFailures++;
      logger.error(
        { error: err.message, marketId, failures: this.consecutiveFailures },
        'Claude analysis failed',
      );

      // Disable after too many consecutive failures to stop wasting resources
      if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
        logger.warn(
          { failures: this.consecutiveFailures },
          'Too many consecutive Claude failures — disabling AI analysis, quant-only mode',
        );
        this.enabled = false;
      }

      return null;
    }
  }

  private parseResponse(text: string): MarketAnalysis | null {
    try {
      // Extract JSON from response (claude may include extra text)
      const jsonMatch = text.match(/\{[\s\S]*?\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);

      if (!parsed.direction || !['YES', 'NO', 'SKIP'].includes(parsed.direction)) {
        return null;
      }

      return {
        direction: parsed.direction as 'YES' | 'NO' | 'SKIP',
        confidence: Math.min(1, Math.max(0, Number(parsed.confidence) || 0)),
        edge: Math.min(0.15, Math.max(0, Number(parsed.edge) || 0)),
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
