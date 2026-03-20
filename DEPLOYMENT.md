# PolyPatronBot — Deployment Guide

## What is this

AI-powered trading bot for [Polymarket](https://polymarket.com) prediction markets.
Uses Claude AI (via CLI) to analyze markets, estimate true probabilities, and trade when it finds mispricing.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌────────────┐
│  Gamma API  │────▶│  Engine      │────▶│ CLOB API   │
│ (market data)│    │  (5s ticks)  │     │ (orders)   │
└─────────────┘     └──────┬───────┘     └────────────┘
                           │
                    ┌──────▼───────┐
                    │ AI Forecast  │
                    │  Strategy    │
                    └──────┬───────┘
                           │
                    ┌──────▼───────┐
                    │ Claude CLI   │
                    │ (analysis)   │
                    └──────────────┘
```

**Signal pipeline:** Gamma markets → filters → price history → Claude AI analysis → signal → size → risk check → CLOB order

**Position management:** Trailing stop (+15% activation, 8% trail), take profit (+30%), stop loss (-15%), time exit (24h)

## Server Requirements

- Ubuntu 22.04+ (or any Linux with systemd)
- Node.js 20+
- 2GB+ RAM
- Claude Code CLI (authenticated with Claude Max subscription)
- Caddy (reverse proxy for dashboard HTTPS)

## Files & Secrets

| File | Location on server | Description |
|------|-------------------|-------------|
| `.env` | `/opt/polypatronbot-new/.env` | API keys, private keys, tokens |
| `config.yaml` | `/opt/polypatronbot-new/config.yaml` | Trading parameters, risk limits |
| `.credentials.json` | `/root/.claude/.credentials.json` | Claude CLI OAuth token (expires ~24h, auto-refreshes) |
| `entry-records.json` | `/opt/polypatronbot-new/entry-records.json` | Persisted position tracking (auto-created) |

### Environment Variables (.env)

| Variable | Description |
|----------|-------------|
| `ENABLE_LIVE_TRADING` | Must be `true` for real trades (also needs `enable_live_trading: true` in config.yaml) |
| `PK_PRIVATE_KEY` | Ethereum private key for Polymarket wallet |
| `CLOB_API_KEY` | Polymarket CLOB API key |
| `CLOB_SECRET` | Polymarket CLOB API secret |
| `CLOB_PASSPHRASE` | Polymarket CLOB API passphrase |
| `POLYMARKET_PROXY_ADDRESS` | Polymarket proxy wallet address |
| `DASHBOARD_PORT` | Dashboard HTTP port (default: 3000) |
| `DASHBOARD_ORIGIN` | Dashboard URL for CORS (e.g., `https://poly.qzx.digital`) |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token for notifications |
| `TELEGRAM_CHAT_ID` | Telegram chat ID for notifications |

### Trading Config (config.yaml)

Key parameters:
- `capital: 99.36` — starting capital for ROI calculation
- `max_position_size: 25` — max $ per single position
- `max_open_trades: 25` — max simultaneous positions (includes manual pre-existing)
- `max_daily_loss: 15` — stop trading after $15 daily loss
- `max_drawdown: 0.15` — 15% drawdown circuit breaker
- `refresh_minutes: 15` — how often strategy re-evaluates markets

### Strategy Constants (in source: `src/strategies/research_ai/ai_forecast_strategy.ts`)

- `MIN_HISTORY = 3` — minimum price data points before analyzing (3 polls × 2min = 6min cold start)
- `MIN_CONFIDENCE = 0.30` — minimum Claude confidence to generate signal
- `MIN_EDGE = 0.015` — minimum 1.5% edge (covers ~2% fees)
- `MAX_POSITIONS = 10` — max positions the strategy itself will open
- `TAKE_PROFIT_PCT = 0.30` — take profit at +30%
- `STOP_LOSS_PCT = 0.15` — stop loss at -15%
- `TRAILING_ACTIVATION = 0.15` — trailing stop activates at +15%
- `TRAILING_DISTANCE = 0.08` — trail 8% below peak

## Fresh Server Setup

```bash
# 1. On your local machine: copy project to new server
scp -r /path/to/polypatronbot-new root@NEW_IP:/opt/polypatronbot-new

# 2. SSH to server and run setup
ssh root@NEW_IP
bash /opt/polypatronbot-new/deploy/setup.sh

# 3. Copy Claude credentials from your local machine
scp ~/.claude/.credentials.json root@NEW_IP:/root/.claude/.credentials.json

# 4. Point DNS: poly.qzx.digital → NEW_IP (A record)

# 5. Open firewall
ufw allow 22,80,443/tcp
ufw --force enable

# 6. Verify
systemctl status polypatronbot-new
journalctl -u polypatronbot-new -f
```

## Quick Deploy (code updates only)

```bash
# From your local machine:
bash deploy/deploy.sh root@SERVER_IP
```

Or manually:
```bash
scp -r src/ root@SERVER_IP:/opt/polypatronbot-new/src/
scp config.yaml root@SERVER_IP:/opt/polypatronbot-new/config.yaml
ssh root@SERVER_IP "cd /opt/polypatronbot-new && npx tsc && rm -rf dist/src && systemctl restart polypatronbot-new"
```

## Operations

### View logs
```bash
journalctl -u polypatronbot-new -f                    # live tail
journalctl -u polypatronbot-new --since '1 hour ago'  # recent
journalctl -u polypatronbot-new | grep 'Signal funnel' | tail -5  # signal pipeline
journalctl -u polypatronbot-new | grep 'Placing\|Executed\|rejected' | tail -10  # orders
```

### Restart
```bash
systemctl restart polypatronbot-new
```

### Dashboard
- URL: https://poly.qzx.digital/dashboard
- Auth: session-based (set via DASHBOARD_ORIGIN)

### Claude credentials renewal
The OAuth token expires every ~24h. Claude CLI auto-refreshes it when it has internet access.
If the token expires while offline:
```bash
# On your local machine (where Claude is logged in):
scp ~/.claude/.credentials.json root@SERVER_IP:/root/.claude/.credentials.json
systemctl restart polypatronbot-new
```

## Known Issues & Mitigations

### Cloudflare Rate Limiting (CLOB API)
Polymarket's CLOB API is behind Cloudflare. Aggressive POST /order requests trigger 429 bans.
- Bot has exponential backoff: 2h → 4h after rate limit detection
- Keep CLOB_MIN_INTERVAL at 2s+ between API calls
- Don't restart rapidly after 429 errors — each retry during a ban extends it

### Cold Start
After restart, price history is empty. Takes ~6 minutes (3 polls × 2min) before any market qualifies for Claude analysis.

### Claude CLI Failures
If Claude fails 5 times consecutively, it auto-disables for 10 minutes then retries.
Common causes: token expiry, network issues, Claude service outage.

## Wallet

- **Address:** 0x564f396622AEc4a6A630CdDfB6300ECc5C94E1C5
- **Proxy:** 0xe1418b66a53D03C28524e8C64377C8EaeB69F93a
- **Chain:** Polygon (Polymarket uses USDC on Polygon)
- Capital is held as USDC in the proxy wallet
