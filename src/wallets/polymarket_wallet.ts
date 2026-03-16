import { ClobClient, Side, OrderType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { WalletConfig, WalletState, TradeRecord, Position } from '../types';
import { logger } from '../reporting/logs';

export class PolymarketWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private clob: ClobClient | null = null;
  private ready = false;
  private displayName = '';

  constructor(config: WalletConfig, assignedStrategy: string) {
    this.state = {
      walletId: config.id,
      mode: 'LIVE',
      assignedStrategy,
      capitalAllocated: config.capital,
      availableBalance: config.capital,
      openPositions: [],
      realizedPnl: 0,
      riskLimits: {
        maxPositionSize: config.riskLimits?.maxPositionSize ?? 100,
        maxExposurePerMarket: config.riskLimits?.maxExposurePerMarket ?? 200,
        maxDailyLoss: config.riskLimits?.maxDailyLoss ?? 100,
        maxOpenTrades: config.riskLimits?.maxOpenTrades ?? 5,
        maxDrawdown: config.riskLimits?.maxDrawdown ?? 0.2,
      },
    };
    this.displayName = config.id;
    this.initClob();
  }

  private async initClob(): Promise<void> {
    const privateKey = process.env.PK_PRIVATE_KEY;
    const apiKey = process.env.CLOB_API_KEY;
    const apiSecret = process.env.CLOB_SECRET;
    const passphrase = process.env.CLOB_PASSPHRASE;

    if (!privateKey || !apiKey || !apiSecret || !passphrase) {
      logger.error(
        'Missing Polymarket credentials (PK_PRIVATE_KEY, CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE)',
      );
      return;
    }

    try {
      const host = 'https://clob.polymarket.com';
      const chainId = 137; // Polygon mainnet
      const signer = new Wallet(privateKey);

      this.clob = new ClobClient(host, chainId, signer, {
        key: apiKey,
        secret: apiSecret,
        passphrase,
      });

      this.ready = true;
      logger.info(
        { walletId: this.state.walletId, address: signer.address },
        'Polymarket LIVE wallet initialized',
      );
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to initialize Polymarket CLOB client');
    }
  }

  getState(): WalletState {
    return { ...this.state, openPositions: [...this.state.openPositions] };
  }

  getTradeHistory(): TradeRecord[] {
    return [...this.trades];
  }

  getDisplayName(): string {
    return this.displayName;
  }

  setDisplayName(name: string): void {
    this.displayName = name;
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  updateRiskLimits(limits: Partial<WalletState['riskLimits']>): void {
    Object.assign(this.state.riskLimits, limits);
  }

  async placeOrder(request: {
    marketId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void> {
    if (!this.clob || !this.ready) {
      logger.warn({ walletId: this.state.walletId }, 'CLOB client not ready, skipping order');
      return;
    }

    // The marketId from the engine is a conditionId. We need the tokenId.
    // In Polymarket, each market has two token IDs: one for YES, one for NO.
    // The engine passes the market's clobTokenIds via MarketData.
    // For now, we use marketId as the tokenID directly (engine should pass tokenId).
    const tokenID = request.marketId;
    const side = request.side === 'BUY' ? Side.BUY : Side.SELL;

    try {
      // Get tick size for this token
      let tickSize = '0.01'; // default
      try {
        tickSize = await this.clob.getTickSize(tokenID);
      } catch {
        // Use default
      }

      logger.info(
        {
          walletId: this.state.walletId,
          tokenID,
          outcome: request.outcome,
          side: request.side,
          price: request.price,
          size: request.size,
          tickSize,
        },
        'Placing LIVE order on Polymarket',
      );

      const resp = await this.clob.createAndPostOrder(
        {
          tokenID,
          price: request.price,
          size: request.size,
          side,
        },
        { tickSize: tickSize as any },
        OrderType.GTC,
      );

      if (resp && (resp as any).success !== false) {
        const orderId = (resp as any).orderID ?? (resp as any).id ?? `live-${Date.now()}`;
        const cost = request.price * request.size;

        // Track the trade
        const trade: TradeRecord = {
          orderId,
          walletId: this.state.walletId,
          marketId: request.marketId,
          outcome: request.outcome,
          side: request.side,
          price: request.price,
          size: request.size,
          cost,
          realizedPnl: 0,
          cumulativePnl: this.state.realizedPnl,
          balanceAfter: this.state.availableBalance - (request.side === 'BUY' ? cost : -cost),
          timestamp: Date.now(),
        };
        this.trades.push(trade);

        // Update balance
        if (request.side === 'BUY') {
          this.state.availableBalance -= cost;
          // Add/update position
          const existing = this.state.openPositions.find(
            (p) => p.marketId === request.marketId && p.outcome === request.outcome,
          );
          if (existing) {
            const totalCost = existing.avgPrice * existing.size + request.price * request.size;
            existing.size += request.size;
            existing.avgPrice = totalCost / existing.size;
          } else {
            this.state.openPositions.push({
              marketId: request.marketId,
              outcome: request.outcome,
              size: request.size,
              avgPrice: request.price,
              realizedPnl: 0,
            });
          }
        } else {
          // SELL — close position
          this.state.availableBalance += cost;
          const pos = this.state.openPositions.find(
            (p) => p.marketId === request.marketId && p.outcome === request.outcome,
          );
          if (pos) {
            const pnl = (request.price - pos.avgPrice) * request.size;
            this.state.realizedPnl += pnl;
            trade.realizedPnl = pnl;
            trade.cumulativePnl = this.state.realizedPnl;
            pos.size -= request.size;
            if (pos.size <= 0) {
              this.state.openPositions = this.state.openPositions.filter((p) => p !== pos);
            }
          }
        }

        logger.info(
          {
            orderId,
            side: request.side,
            outcome: request.outcome,
            price: request.price,
            size: request.size,
          },
          'LIVE order placed successfully',
        );
      } else {
        logger.error({ response: resp }, 'Polymarket order rejected');
      }
    } catch (err: any) {
      logger.error(
        {
          error: err.message,
          marketId: request.marketId,
          side: request.side,
          price: request.price,
          size: request.size,
        },
        'LIVE order failed',
      );
    }
  }
}
