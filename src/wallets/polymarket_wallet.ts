import { ClobClient, Side, OrderType, AssetType, SignatureType } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { WalletConfig, WalletState, TradeRecord, Position } from '../types';
import { logger } from '../reporting/logs';
import { PositionRedeemer } from './redeemer';

export class PolymarketWallet {
  private state: WalletState;
  private readonly trades: TradeRecord[] = [];
  private clob: ClobClient | null = null;
  private ready = false;
  private displayName = '';
  private syncedTradeIds = new Set<string>();
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private redeemer: PositionRedeemer | null = null;
  private redeemTimer: ReturnType<typeof setInterval> | null = null;
  /** Flag set after first sync completes — used by Telegram startup */
  firstSyncDone = false;
  /** Condition IDs we already checked for resolution (avoid repeat API calls) */
  private resolvedMarkets = new Map<string, { won: boolean; payout: number }>();
  /** Map position key (market|outcome) → CLOB asset_id (token ID) for resolution checks */
  private positionAssetIds = new Map<string, string>();
  /** Condition ID → human-readable market name (e.g. "Solana Up or Down...") */
  private marketNames = new Map<string, string>();
  /** Original deposit from config — used as baseline for balance estimation */
  private readonly initialDeposit: number;

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
    this.initialDeposit = config.capital;
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

      // The funder address is the Polymarket proxy wallet that holds the USDC.
      // Without it, orders fail with "not enough balance / allowance".
      const funderAddress = process.env.POLYMARKET_PROXY_ADDRESS || undefined;

      // When using a proxy wallet (funderAddress), orders must use POLY_PROXY
      // signature type (1) so the CLOB verifies the EOA as authorized signer
      // for the proxy contract. Without this, all orders fail "invalid signature".
      const sigType = funderAddress ? SignatureType.POLY_PROXY : undefined;

      this.clob = new ClobClient(
        host,
        chainId,
        signer,
        { key: apiKey, secret: apiSecret, passphrase },
        sigType,
        funderAddress,
      );

      this.ready = true;
      logger.info(
        { walletId: this.state.walletId, address: signer.address },
        'Polymarket LIVE wallet initialized',
      );

      // Set USDC allowance for the CTF Exchange so orders don't fail with
      // "not enough balance / allowance"
      try {
        await this.clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        logger.info({ walletId: this.state.walletId }, 'USDC balance allowance updated');
      } catch (allowErr: any) {
        logger.warn(
          { error: allowErr.message, walletId: this.state.walletId },
          'Failed to update balance allowance (orders may fail)',
        );
      }

      // Sync existing trades from CLOB on startup
      await this.syncTradesFromClob();
      this.firstSyncDone = true;

      // Periodically sync trades every 60s
      this.syncTimer = setInterval(() => this.syncTradesFromClob(), 60_000);

      // Auto-claim: initialize redeemer and scan every 5 minutes
      const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
      const pk = process.env.PK_PRIVATE_KEY;
      if (pk && proxyAddr) {
        this.redeemer = new PositionRedeemer(pk, proxyAddr);
        // First scan after 30s (let trade sync settle)
        setTimeout(() => this.runRedeemScan(), 30_000);
        this.redeemTimer = setInterval(() => this.runRedeemScan(), 5 * 60_000);
      }
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to initialize Polymarket CLOB client');
    }
  }

  /** Scan for redeemable positions and auto-claim them */
  private async runRedeemScan(): Promise<void> {
    if (!this.redeemer) return;
    try {
      const results = await this.redeemer.scanAndRedeemAll();
      const claimed = results.filter((r) => r.success);
      if (claimed.length > 0) {
        const totalClaimed = claimed.reduce((s, r) => s + (r.usdcRedeemed ?? 0), 0);
        logger.info(
          { claimed: claimed.length, totalUSDC: totalClaimed.toFixed(2) },
          'Auto-claimed winning positions',
        );
        // Re-sync after claim to update balances
        await this.syncTradesFromClob();
      }
    } catch (err) {
      logger.warn({ err }, 'Redeem scan failed');
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

  /** Get cached market name for a condition ID */
  getMarketName(conditionId: string): string | undefined {
    return this.marketNames.get(conditionId);
  }

  updateBalance(delta: number): void {
    this.state.availableBalance += delta;
  }

  updateRiskLimits(limits: Partial<WalletState['riskLimits']>): void {
    Object.assign(this.state.riskLimits, limits);
  }

  /**
   * Check if a market has resolved via the CLOB getMarket() API.
   * Caches results keyed by condition ID (not outcome-specific).
   */
  private async checkMarketResolution(
    conditionId: string,
    assetId: string,
  ): Promise<{ resolved: boolean; won: boolean; payout: number }> {
    const cacheKey = conditionId + '|' + assetId;
    const cached = this.resolvedMarkets.get(cacheKey);
    if (cached) return { resolved: true, ...cached };

    if (!this.clob) return { resolved: false, won: false, payout: 0 };

    try {
      const market = await this.clob.getMarket(conditionId);
      if (!market) return { resolved: false, won: false, payout: 0 };

      // Cache market name
      if ((market as any).question) {
        this.marketNames.set(conditionId, (market as any).question);
      }

      if (!market.closed) return { resolved: false, won: false, payout: 0 };

      // Market is closed. tokens[] has { token_id, outcome, winner, price }.
      const tokens = (market as any).tokens ?? [];
      let won = false;

      for (const tok of tokens) {
        // Match by token_id (asset_id from trade) for precision
        if (tok.token_id === assetId && tok.winner === true) {
          won = true;
          break;
        }
      }

      const payout = won ? 1 : 0;
      this.resolvedMarkets.set(cacheKey, { won, payout });
      return { resolved: true, won, payout };
    } catch {
      return { resolved: false, won: false, payout: 0 };
    }
  }

  /**
   * Fetch confirmed trades from the CLOB API and rebuild all financial state
   * (positions, PnL, balance) from scratch.
   */
  private async syncTradesFromClob(): Promise<void> {
    if (!this.clob || !this.ready) return;

    try {
      const clobTrades = await this.clob.getTrades();

      // Sort chronologically
      const sorted = [...clobTrades].sort(
        (a, b) => parseInt(a.match_time, 10) - parseInt(b.match_time, 10),
      );

      // Rebuild everything from scratch
      this.trades.length = 0;
      this.syncedTradeIds.clear();
      this.state.openPositions = [];
      this.state.realizedPnl = 0;
      this.positionAssetIds.clear();

      let totalBuyCost = 0;

      for (const ct of sorted) {
        const price = parseFloat(ct.price);
        const size = parseFloat(ct.size);
        const cost = price * size;
        const side = ct.side === 'BUY' ? ('BUY' as const) : ('SELL' as const);
        // Map outcome: Polymarket outcomes can be "Up", "Down", "Yes", "No", etc.
        // Our type requires 'YES' | 'NO'. Map: "Yes"/"Up"/first-outcome → YES, else → NO.
        const rawOutcome = (ct.outcome ?? '').toLowerCase();
        const outcome: 'YES' | 'NO' =
          rawOutcome === 'yes' || rawOutcome === 'up' ? 'YES' : 'NO';

        // Track asset_id for resolution checks
        const posKey = ct.market + '|' + outcome;
        if (ct.asset_id) {
          this.positionAssetIds.set(posKey, ct.asset_id);
        }

        let tradePnl = 0;

        if (side === 'BUY') {
          totalBuyCost += cost;
          // Add to position
          const existing = this.state.openPositions.find(
            (p) => p.marketId === ct.market && p.outcome === outcome,
          );
          if (existing) {
            const totalPositionCost =
              existing.avgPrice * existing.size + price * size;
            existing.size += size;
            existing.avgPrice = totalPositionCost / existing.size;
          } else {
            this.state.openPositions.push({
              marketId: ct.market,
              outcome,
              size,
              avgPrice: price,
              realizedPnl: 0,
            });
          }
        } else {
          // SELL — match against position
          const pos = this.state.openPositions.find(
            (p) => p.marketId === ct.market && p.outcome === outcome,
          );
          if (pos) {
            tradePnl = (price - pos.avgPrice) * size;
            this.state.realizedPnl += tradePnl;
            pos.realizedPnl += tradePnl;
            pos.size -= size;
            if (pos.size <= 0.001) {
              this.state.openPositions = this.state.openPositions.filter(
                (p2) => p2 !== pos,
              );
            }
          } else {
            // Sell without matching buy — cost basis unknown, skip PnL
            tradePnl = 0;
          }
        }

        const trade: TradeRecord = {
          orderId: ct.taker_order_id || ct.id,
          walletId: this.state.walletId,
          marketId: ct.market,
          outcome,
          side,
          price,
          size,
          cost,
          realizedPnl: tradePnl,
          cumulativePnl: this.state.realizedPnl,
          balanceAfter: 0, // Updated after resolution check
          timestamp: ct.match_time
            ? parseInt(ct.match_time, 10) * 1000
            : Date.now(),
        };
        this.trades.push(trade);
        this.syncedTradeIds.add(ct.id);
      }

      // Check for resolved markets and close those positions
      const positionsToRemove: Position[] = [];
      for (const pos of this.state.openPositions) {
        const posKey = pos.marketId + '|' + pos.outcome;
        const assetId = this.positionAssetIds.get(posKey) ?? '';
        if (!assetId) continue; // Can't check without asset_id

        const resolution = await this.checkMarketResolution(pos.marketId, assetId);

        if (resolution.resolved) {
          const exitPrice = resolution.won ? 1 : 0;
          const pnl = (exitPrice - pos.avgPrice) * pos.size;
          this.state.realizedPnl += pnl;

          // Add resolution as a synthetic trade
          this.trades.push({
            orderId: `resolution-${pos.marketId}`,
            walletId: this.state.walletId,
            marketId: pos.marketId,
            outcome: pos.outcome,
            side: 'SELL',
            price: exitPrice,
            size: pos.size,
            cost: exitPrice * pos.size,
            realizedPnl: pnl,
            cumulativePnl: this.state.realizedPnl,
            balanceAfter: 0,
            timestamp: Date.now(),
          });

          positionsToRemove.push(pos);

          logger.info(
            {
              marketId: pos.marketId,
              outcome: pos.outcome,
              won: resolution.won,
              pnl: pnl.toFixed(2),
              shares: pos.size.toFixed(2),
              avgPrice: pos.avgPrice.toFixed(2),
            },
            `Market resolved: ${resolution.won ? 'WIN' : 'LOSS'}`,
          );
        }
      }

      // Remove resolved positions
      if (positionsToRemove.length > 0) {
        this.state.openPositions = this.state.openPositions.filter(
          (p) => !positionsToRemove.includes(p),
        );
      }

      // Compute real financial state
      // Try to fetch actual USDC balance from Etherscan (proxy wallet)
      let usdcBalance = 0;
      const proxyAddr = process.env.POLYMARKET_PROXY_ADDRESS;
      const etherscanKey = process.env.ETHERSCAN_API_KEY;
      if (proxyAddr && etherscanKey) {
        try {
          const url =
            `https://api.etherscan.io/v2/api?chainid=137&module=account` +
            `&action=tokenbalance&contractaddress=0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` +
            `&address=${proxyAddr}&tag=latest&apikey=${etherscanKey}`;
          const resp = await fetch(url);
          const data = (await resp.json()) as { status: string; result: string };
          if (data.status === '1') {
            usdcBalance = parseInt(data.result, 10) / 1e6;
          }
        } catch {
          // Fallback below
        }
      }

      // Fallback: estimate from trade history if Etherscan didn't work
      if (usdcBalance < 0.01) {
        const totalSellProceeds = this.trades
          .filter((t) => t.side === 'SELL')
          .reduce((s, t) => s + t.cost, 0);
        usdcBalance = Math.max(
          0,
          this.initialDeposit + totalSellProceeds - totalBuyCost,
        );
      }

      // Fetch REAL positions from Polymarket data API
      // CLOB trade reconstruction often inflates sizes — trust the data API instead
      let realPositionValue = 0;
      if (proxyAddr) {
        try {
          const posResp = await fetch(
            `https://data-api.polymarket.com/positions?user=${proxyAddr}`,
          );
          if (posResp.ok) {
            const posData = (await posResp.json()) as Array<{
              market?: string; conditionId?: string;
              outcome?: string; size?: number; avgPrice?: number;
              curPrice?: number; currentValue?: number;
              initialValue?: number;
            }>;
            // Rebuild openPositions from real data
            this.state.openPositions = [];
            for (const p of posData) {
              if (!p.size || p.size < 0.001) continue;
              const outcome: 'YES' | 'NO' =
                (p.outcome ?? '').toUpperCase() === 'YES' ? 'YES' : 'NO';
              this.state.openPositions.push({
                marketId: p.conditionId ?? p.market ?? '',
                outcome,
                size: p.size,
                avgPrice: p.avgPrice ?? 0,
                realizedPnl: 0,
              });
              realPositionValue += p.currentValue ?? (p.curPrice ?? p.avgPrice ?? 0) * p.size;
            }
          }
        } catch {
          // Fallback to CLOB reconstruction below
        }
      }

      // Fallback: use CLOB-reconstructed positions if data API didn't work
      const positionCost = realPositionValue > 0.01
        ? realPositionValue
        : this.state.openPositions.reduce(
            (sum, p) => sum + p.avgPrice * p.size,
            0,
          );

      this.state.availableBalance = usdcBalance;
      // Capital = money in positions + available cash
      this.state.capitalAllocated = positionCost + usdcBalance;

      // Real PnL = (current value of everything) - initial deposit
      this.state.realizedPnl = usdcBalance + positionCost - this.initialDeposit;

      // Recompute per-trade PnL for resolution trades using cost basis
      const resolutionTrades = this.trades.filter((t) =>
        t.orderId.startsWith('resolution-'),
      );
      for (const t of resolutionTrades) {
        const buyTrades = this.trades.filter(
          (b) =>
            b.marketId === t.marketId &&
            b.outcome === t.outcome &&
            b.side === 'BUY',
        );
        const totalBuySpent = buyTrades.reduce((s, b) => s + b.cost, 0);
        t.realizedPnl = t.price === 1
          ? t.cost - totalBuySpent  // WIN: payout - cost
          : -totalBuySpent;          // LOSS: lost everything
      }

      // Recompute cumulative PnL and running balance for all trades
      let cumPnl = 0;
      let runBalance = this.initialDeposit;
      for (const t of this.trades) {
        if (t.side === 'BUY') {
          runBalance -= t.cost;
        } else {
          runBalance += t.cost;
        }
        cumPnl += t.realizedPnl;
        t.cumulativePnl = cumPnl;
        t.balanceAfter = Math.max(0, runBalance);
      }

      // Sort trades by timestamp (resolutions may have been appended at end)
      this.trades.sort((a, b) => a.timestamp - b.timestamp);

      // Resolve market names for any markets not yet in cache
      const unknownMarkets = [
        ...new Set(this.trades.map((t) => t.marketId)),
      ].filter((id) => !this.marketNames.has(id));
      for (const conditionId of unknownMarkets) {
        try {
          const market = await this.clob!.getMarket(conditionId);
          if ((market as any)?.question) {
            this.marketNames.set(conditionId, (market as any).question);
          }
        } catch {
          // Skip — will try again next sync
        }
      }

      logger.info(
        {
          walletId: this.state.walletId,
          trades: this.trades.length,
          openPositions: this.state.openPositions.length,
          resolvedPositions: positionsToRemove.length,
          realizedPnl: this.state.realizedPnl.toFixed(2),
          availableBalance: usdcBalance.toFixed(2),
          positionCost: positionCost.toFixed(2),
          totalCapital: this.state.capitalAllocated.toFixed(2),
        },
        'CLOB trade sync complete',
      );
    } catch (err: any) {
      logger.warn(
        { error: err.message, walletId: this.state.walletId },
        'Failed to sync trades from CLOB',
      );
    }
  }

  async placeOrder(request: {
    marketId: string;
    tokenId?: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    size: number;
  }): Promise<void> {
    if (!this.clob || !this.ready) {
      logger.warn({ walletId: this.state.walletId }, 'CLOB client not ready, skipping order');
      return;
    }

    // The CLOB API requires the actual token ID (one per outcome), not the Gamma market/condition ID.
    const tokenID = request.tokenId ?? request.marketId;
    if (!request.tokenId) {
      logger.warn(
        { walletId: this.state.walletId, marketId: request.marketId },
        'No tokenId provided — using marketId as fallback (may fail)',
      );
    }
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

      // The CLOB client may return an error object or a response with orderID
      const orderID = (resp as any)?.orderID ?? (resp as any)?.id;
      const hasError = (resp as any)?.success === false || (resp as any)?.error || !orderID;
      if (resp && !hasError) {
        const orderId = orderID;
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
