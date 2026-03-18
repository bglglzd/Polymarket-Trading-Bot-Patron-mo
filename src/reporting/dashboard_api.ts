import { WalletState, TradeRecord } from '../types';

export interface PerformanceSnapshot {
  walletId: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpeLike: number;
  totalTrades: number;
}

export interface WalletDashboardEntry {
  walletId: string;
  displayName: string;
  mode: 'LIVE' | 'PAPER';
  strategy: string;
  capitalAllocated: number;
  portfolioValue: number;
  availableBalance: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  paused: boolean;
  openPositions: Array<{
    marketId: string;
    outcome: 'YES' | 'NO';
    size: number;
    avgPrice: number;
    realizedPnl: number;
    unrealizedPnl: number;
  }>;
  riskLimits: {
    maxPositionSize: number;
    maxExposurePerMarket: number;
    maxDailyLoss: number;
    maxOpenTrades: number;
    maxDrawdown: number;
  };
  performance: PerformanceSnapshot;
}

export interface DashboardPayload {
  generatedAt: string;
  totalCapital: number;
  totalPnl: number;
  totalRealizedPnl: number;
  totalUnrealizedPnl: number;
  activeWallets: number;
  wallets: WalletDashboardEntry[];
}

export function computePerformance(
  wallet: WalletState,
  trades: TradeRecord[],
  unrealizedPnl: number,
  filteredRealizedPnl?: number,
): PerformanceSnapshot {
  // Compute real win rate from actual trades
  const wins = trades.filter((t) => t.realizedPnl > 0);
  const losses = trades.filter((t) => t.realizedPnl < 0);
  const closedTrades = wins.length + losses.length;
  const winRate = closedTrades > 0 ? wins.length / closedTrades : 0;

  const totalWinPnl = wins.reduce((s, t) => s + t.realizedPnl, 0);
  const totalLossPnl = losses.reduce((s, t) => s + t.realizedPnl, 0);
  const avgWin = wins.length > 0 ? totalWinPnl / wins.length : 0;
  const avgLoss = losses.length > 0 ? totalLossPnl / losses.length : 0;
  const profitFactor =
    losses.length > 0 && totalLossPnl !== 0
      ? Math.abs(totalWinPnl / totalLossPnl)
      : wins.length > 0
        ? Infinity
        : 0;

  // Use filtered realized PnL if provided (inception date filtering)
  const realizedPnl = filteredRealizedPnl ?? wallet.realizedPnl;
  const totalPnl = realizedPnl + unrealizedPnl;
  const sharpeLike = Number(
    (totalPnl / Math.max(1, wallet.capitalAllocated)).toFixed(4),
  );

  return {
    walletId: wallet.walletId,
    realizedPnl,
    unrealizedPnl,
    totalPnl,
    winRate: Number(winRate.toFixed(4)),
    winCount: wins.length,
    lossCount: losses.length,
    avgWin: Number(avgWin.toFixed(4)),
    avgLoss: Number(avgLoss.toFixed(4)),
    profitFactor: profitFactor === Infinity ? 999 : Number(profitFactor.toFixed(4)),
    sharpeLike,
    totalTrades: trades.length,
  };
}

export function buildDashboardPayload(
  wallets: WalletState[],
  tradesByWallet: Map<string, TradeRecord[]>,
  marketPrices?: Map<string, number>,
  pausedWallets?: Set<string>,
  displayNames?: Map<string, string>,
  inceptionDates?: Map<string, string>,
): DashboardPayload {
  const entries: WalletDashboardEntry[] = wallets.map((w) => {
    const allTrades = tradesByWallet.get(w.walletId) ?? [];

    // Apply inception date filter for trade history/stats only
    const cutoff = inceptionDates?.get(w.walletId)
      ? new Date(inceptionDates.get(w.walletId)!).getTime()
      : 0;
    // Exclude resolution trades for pre-existing/manual positions:
    // 1) Markets with NO non-resolution BUY trades → entirely pre-existing positions
    // 2) Markets with any single BUY order > maxExposurePerMarket → manual trades
    const postInception = cutoff > 0 ? allTrades.filter((t) => t.timestamp >= cutoff) : allTrades;
    const manualThreshold = w.riskLimits.maxExposurePerMarket;
    const botBuyMarkets = new Set<string>();
    const oversizedBuyMarkets = new Set<string>();
    for (const t of postInception) {
      if (t.side === 'BUY' && !t.orderId.startsWith('resolution-')) {
        botBuyMarkets.add(t.marketId);
        if (t.cost > manualThreshold) oversizedBuyMarkets.add(t.marketId);
      }
    }
    const trades = postInception
      .filter((t) => {
        if (!t.orderId.startsWith('resolution-')) return true;
        return botBuyMarkets.has(t.marketId) && !oversizedBuyMarkets.has(t.marketId);
      });

    // Compute unrealized PnL from ALL positions (not filtered — they all affect portfolio value)
    // Use data API curPrice (outcome-aware) over orderbook midPrice (YES-only)
    let walletUnrealizedPnl = 0;
    const positions = w.openPositions
      .filter((p) => p.size > 0)
      .map((p) => {
        const currentPrice = p.curPrice ?? marketPrices?.get(p.marketId) ?? p.avgPrice;
        const unrealizedPnl =
          p.size > 0 && p.avgPrice > 0
            ? (currentPrice - p.avgPrice) * p.size
            : 0;
        walletUnrealizedPnl += unrealizedPnl;
        return {
          marketId: p.marketId,
          outcome: p.outcome,
          size: Number(p.size.toFixed(4)),
          avgPrice: Number(p.avgPrice.toFixed(4)),
          realizedPnl: Number(p.realizedPnl.toFixed(4)),
          unrealizedPnl: Number(unrealizedPnl.toFixed(4)),
        };
      });

    // Ground-truth total PnL: portfolio value - initial deposit (matches Polymarket)
    const positionMarketValue = w.openPositions
      .filter((p) => p.size > 0)
      .reduce((s, p) => s + (p.curPrice ?? marketPrices?.get(p.marketId) ?? p.avgPrice) * p.size, 0);
    const totalPortfolioValue = w.availableBalance + positionMarketValue;
    const totalPnl = totalPortfolioValue - w.capitalAllocated;
    // Realized = total - unrealized (ensures realized + unrealized = total exactly)
    const realizedPnl = totalPnl - walletUnrealizedPnl;

    return {
      walletId: w.walletId,
      displayName: displayNames?.get(w.walletId) ?? w.walletId,
      mode: w.mode,
      strategy: w.assignedStrategy,
      capitalAllocated: w.capitalAllocated,
      portfolioValue: Number(totalPortfolioValue.toFixed(4)),
      availableBalance: Number(w.availableBalance.toFixed(4)),
      realizedPnl: Number(realizedPnl.toFixed(4)),
      unrealizedPnl: Number(walletUnrealizedPnl.toFixed(4)),
      totalPnl: Number(totalPnl.toFixed(4)),
      paused: pausedWallets?.has(w.walletId) ?? false,
      openPositions: positions,
      riskLimits: w.riskLimits,
      performance: computePerformance(w, trades, walletUnrealizedPnl, realizedPnl),
    };
  });

  const totalRealizedPnl = entries.reduce((s, e) => s + e.realizedPnl, 0);
  const totalUnrealizedPnl = entries.reduce((s, e) => s + e.unrealizedPnl, 0);

  return {
    generatedAt: new Date().toISOString(),
    totalCapital: entries.reduce((s, e) => s + e.capitalAllocated, 0),
    totalPnl: Number((totalRealizedPnl + totalUnrealizedPnl).toFixed(4)),
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
    totalUnrealizedPnl: Number(totalUnrealizedPnl.toFixed(4)),
    activeWallets: entries.length,
    wallets: entries,
  };
}
