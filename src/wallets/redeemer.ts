/**
 * On-chain redemption of resolved Polymarket positions via CTF contract.
 * Ported from the Python redeemer (bot/core/redeemer.py).
 *
 * Flow: ProxyWalletFactory.proxy() → CTF.redeemPositions() or NegRiskAdapter.redeemPositions()
 */

import { Wallet } from '@ethersproject/wallet';
import { keccak256 } from '@ethersproject/keccak256';
import { toUtf8Bytes } from '@ethersproject/strings';
import { logger } from '../reporting/logs';
import { telegram } from '../reporting/telegram';

const POLYGON_RPC = 'https://polygon-bor-rpc.publicnode.com';
const CHAIN_ID = 137;

// Contracts
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

const GAMMA_API = 'https://gamma-api.polymarket.com';

// Function selectors (first 4 bytes of keccak256)
function selector(sig: string): string {
  return keccak256(toUtf8Bytes(sig)).slice(0, 10);
}

const CTF_REDEEM_SEL = selector('redeemPositions(address,bytes32,bytes32,uint256[])');
const NEG_RISK_REDEEM_SEL = selector('redeemPositions(bytes32,uint256[])');
const PAYOUT_DENOM_SEL = selector('payoutDenominator(bytes32)');
const PROXY_SEL = selector('proxy((uint8,address,uint256,bytes)[])');

function pad32(hex: string): string {
  return hex.replace('0x', '').padStart(64, '0');
}

function uint256(n: bigint | number): string {
  return BigInt(n).toString(16).padStart(64, '0');
}

const MAX_UINT256 = (1n << 256n) - 1n;

export interface RedeemResult {
  conditionId: string;
  success: boolean;
  txHash?: string;
  usdcRedeemed?: number;
  error?: string;
  marketName?: string;
}

export class PositionRedeemer {
  private readonly signer: Wallet;
  private readonly proxyWallet: string;
  /** Track already-claimed condition IDs to avoid duplicate redemptions */
  private readonly claimedIds = new Set<string>();

  constructor(privateKey: string, proxyWallet: string) {
    this.signer = new Wallet(privateKey);
    this.proxyWallet = proxyWallet;
  }

  /** Scan data API for redeemable positions and redeem them all */
  async scanAndRedeemAll(): Promise<RedeemResult[]> {
    try {
      const resp = await fetch(
        `https://data-api.polymarket.com/positions?user=${this.proxyWallet}`,
      );
      if (!resp.ok) return [];
      const positions = (await resp.json()) as Array<{
        conditionId?: string; currentValue?: number;
        redeemable?: boolean; outcome?: string; title?: string;
      }>;

      const toRedeem = new Map<string, { value: number; name: string }>();
      for (const pos of positions) {
        const val = pos.currentValue ?? 0;
        const redeemable = pos.redeemable ?? false;
        const cid = pos.conditionId ?? '';
        if (val > 0 && redeemable && cid && !this.claimedIds.has(cid)) {
          const existing = toRedeem.get(cid);
          toRedeem.set(cid, {
            value: (existing?.value ?? 0) + val,
            name: pos.title ?? cid.slice(0, 16),
          });
        }
      }

      if (toRedeem.size === 0) return [];

      const totalValue = [...toRedeem.values()].reduce((s, v) => s + v.value, 0);
      logger.info(
        { count: toRedeem.size, totalValue: totalValue.toFixed(2) },
        'Found redeemable positions',
      );

      // Check POL balance for gas
      const polBalance = await this.getPolBalance();
      if (polBalance < 0.005) {
        const err = `Insufficient POL for gas: ${polBalance.toFixed(4)} POL. Send POL to ${this.signer.address}`;
        logger.warn({ polBalance, eoa: this.signer.address }, err);
        telegram.sendText(`⚠️ *Cannot claim*: ${err}`).catch(() => {});
        return [...toRedeem.entries()].map(([cid]) => ({
          conditionId: cid, success: false, error: err,
        }));
      }

      const results: RedeemResult[] = [];
      for (const [conditionId, info] of toRedeem) {
        const result = await this.redeemPosition(conditionId, info.name);
        if (result.success) {
          result.usdcRedeemed = info.value;
          result.marketName = info.name;
          this.claimedIds.add(conditionId);
          // Notify via Telegram
          telegram.sendText(
            `💰 *Claimed* $${info.value.toFixed(2)}\n${info.name}`,
          ).catch(() => {});
        }
        results.push(result);
        // Small delay between txs to avoid nonce issues
        if (result.success) {
          await new Promise((r) => setTimeout(r, 3000));
        }
      }

      return results;
    } catch (err) {
      logger.error({ err }, 'scanAndRedeemAll failed');
      return [];
    }
  }

  /** Redeem a single resolved position */
  async redeemPosition(conditionId: string, name?: string): Promise<RedeemResult> {
    const cid = conditionId.replace('0x', '').padStart(64, '0');

    // 1. Check if resolved on-chain
    const resolved = await this.checkResolved(cid);
    if (!resolved) {
      return { conditionId, success: false, error: 'not_resolved_on_chain' };
    }

    // 2. Check neg_risk
    const negRisk = await this.checkNegRisk(conditionId);

    // 3. Encode redeem call
    let redeemData: string;
    let targetContract: string;
    if (negRisk) {
      redeemData = this.encodeNegRiskRedeem(cid);
      targetContract = NEG_RISK_ADAPTER;
    } else {
      redeemData = this.encodeCtfRedeem(cid);
      targetContract = CTF_ADDRESS;
    }

    // 4. Wrap in proxy call
    const proxyData = this.encodeProxyCall(targetContract, redeemData);

    // 5. Send transaction
    try {
      const txHash = await this.sendTransaction(PROXY_FACTORY, proxyData);
      logger.info({ conditionId: conditionId.slice(0, 16), txHash, negRisk }, 'Redeem tx sent');

      // 6. Wait for receipt
      const receipt = await this.waitForReceipt(txHash);
      const success = receipt?.status === '0x1';

      if (success) {
        logger.info({ conditionId: conditionId.slice(0, 16), txHash }, 'Redeem success');
        return { conditionId, success: true, txHash, marketName: name };
      } else {
        logger.warn({ conditionId: conditionId.slice(0, 16), txHash }, 'Redeem reverted');
        return { conditionId, success: false, txHash, error: 'tx_reverted' };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ conditionId: conditionId.slice(0, 16), error: msg }, 'Redeem failed');
      return { conditionId, success: false, error: msg };
    }
  }

  /* ── On-chain checks ─────────────────────────────────────────── */

  private async checkResolved(cidHex: string): Promise<boolean> {
    const calldata = PAYOUT_DENOM_SEL + cidHex;
    const resp = await this.rpcCall('eth_call', [
      { to: CTF_ADDRESS, data: calldata },
      'latest',
    ]);
    if (resp?.result) {
      return BigInt(resp.result) > 0n;
    }
    return false;
  }

  private async checkNegRisk(conditionId: string): Promise<boolean> {
    try {
      const resp = await fetch(
        `${GAMMA_API}/markets?condition_id=${conditionId}`,
      );
      if (!resp.ok) return false;
      const markets = (await resp.json()) as Array<{ neg_risk?: boolean }>;
      return markets?.[0]?.neg_risk ?? false;
    } catch {
      return false;
    }
  }

  private async getPolBalance(): Promise<number> {
    const resp = await this.rpcCall('eth_getBalance', [
      this.signer.address,
      'latest',
    ]);
    if (resp?.result) {
      return Number(BigInt(resp.result)) / 1e18;
    }
    return 0;
  }

  /* ── ABI Encoding ────────────────────────────────────────────── */

  private encodeCtfRedeem(cidHex: string): string {
    // redeemPositions(address, bytes32, bytes32, uint256[])
    return (
      CTF_REDEEM_SEL +
      pad32(USDC_ADDRESS) +       // collateralToken
      uint256(0n) +                // parentCollectionId = 0
      cidHex +                     // conditionId
      uint256(128n) +              // offset to indexSets array
      uint256(2n) +                // array length = 2
      uint256(1n) +                // indexSet[0] = 1 (Yes)
      uint256(2n)                  // indexSet[1] = 2 (No)
    );
  }

  private encodeNegRiskRedeem(cidHex: string): string {
    // redeemPositions(bytes32, uint256[])
    return (
      NEG_RISK_REDEEM_SEL +
      cidHex +                     // conditionId
      uint256(64n) +               // offset to amounts array
      uint256(2n) +                // array length = 2
      uint256(MAX_UINT256) +       // amounts[0] = max
      uint256(MAX_UINT256)         // amounts[1] = max
    );
  }

  private encodeProxyCall(target: string, innerCalldata: string): string {
    // proxy((uint8,address,uint256,bytes)[])
    const innerHex = innerCalldata.replace('0x', '');
    const innerByteLen = innerHex.length / 2;
    // Pad inner data to 32-byte boundary
    const padLen = (32 - (innerByteLen % 32)) % 32;
    const innerPadded = innerHex + '00'.repeat(padLen);

    // Tuple: (uint8 typeCode, address to, uint256 value, bytes data)
    const tupleHead =
      uint256(1n) +                // typeCode = 1
      pad32(target) +              // to
      uint256(0n) +                // value = 0
      uint256(128n);               // offset to bytes = 4 * 32

    const tupleTail = uint256(BigInt(innerByteLen)) + innerPadded;

    return (
      PROXY_SEL +
      uint256(32n) +               // offset to array
      uint256(1n) +                // array length = 1
      uint256(32n) +               // offset to element[0]
      tupleHead +
      tupleTail
    );
  }

  /* ── RPC Helpers ─────────────────────────────────────────────── */

  private async rpcCall(
    method: string,
    params: unknown[],
  ): Promise<{ result?: string; error?: { message: string } } | null> {
    try {
      const resp = await fetch(POLYGON_RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
      });
      return (await resp.json()) as { result?: string; error?: { message: string } };
    } catch (err) {
      logger.error({ err, method }, 'RPC call failed');
      return null;
    }
  }

  private async sendTransaction(to: string, calldata: string): Promise<string> {
    const eoa = this.signer.address;

    // Get nonce
    const nonceResp = await this.rpcCall('eth_getTransactionCount', [eoa, 'latest']);
    if (!nonceResp?.result) throw new Error('failed to get nonce');
    const nonce = Number(BigInt(nonceResp.result));

    // Get gas price
    const gasPriceResp = await this.rpcCall('eth_gasPrice', []);
    if (!gasPriceResp?.result) throw new Error('failed to get gas price');
    const gasPrice = BigInt(gasPriceResp.result) * 120n / 100n; // +20% buffer

    // Estimate gas
    const estimateResp = await this.rpcCall('eth_estimateGas', [{
      from: eoa, to, data: '0x' + calldata.replace('0x', ''), value: '0x0',
    }]);
    if (!estimateResp?.result) {
      const errMsg = estimateResp?.error?.message ?? 'unknown';
      throw new Error(`gas estimate failed: ${errMsg}`);
    }
    const gasLimit = Number(BigInt(estimateResp.result) * 130n / 100n); // +30% buffer

    // Sign transaction
    const tx = {
      nonce,
      gasPrice: Number(gasPrice),
      gasLimit,
      to,
      value: 0,
      data: '0x' + calldata.replace('0x', ''),
      chainId: CHAIN_ID,
    };
    const signedTx = await this.signer.signTransaction(tx);

    // Send
    const sendResp = await this.rpcCall('eth_sendRawTransaction', [signedTx]);
    if (sendResp?.error) throw new Error(`tx rejected: ${sendResp.error.message}`);
    if (sendResp?.result) return sendResp.result;
    throw new Error('unexpected RPC response');
  }

  private async waitForReceipt(
    txHash: string,
    timeoutMs = 60_000,
    pollMs = 3_000,
  ): Promise<{ status: string } | null> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const resp = await this.rpcCall('eth_getTransactionReceipt', [txHash]);
      if (resp?.result) return resp.result as unknown as { status: string };
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return null;
  }
}
