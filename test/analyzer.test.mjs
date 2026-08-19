import assert from 'node:assert/strict';
import { test, describe } from 'node:test';

import {
  EVM_CHAINS,
  QUOTE_REASONS,
  collectRegrets,
  computePositions,
  estimateMevProfit,
  isSwapShaped,
  poolsTouched,
  wrap,
} from '../scripts/forensics.mjs';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WIF = '0x1111111111111111111111111111111111111111';
const eth = EVM_CHAINS.ethereum;

const tx = (o) => ({ failed: false, transfers: [], ts: new Date('2024-01-01'), ...o });

/* ────────────────────────────────────────────────── cost basis inference */

describe('cost basis', () => {
  test('anchors a swap on its stablecoin leg', () => {
    // 1000 USDC in for 100 WIF, then half sold back for 200 USDC.
    // Half the $1000 basis is released against $200 of proceeds = -$300.
    const result = {
      cfg: eth,
      balances: [{ asset: WIF, decimals: 18, amount: 50n * 10n ** 18n, valueUsd: 200 }],
      txs: [
        tx({
          ts: new Date('2024-01-01'),
          transfers: [
            { asset: USDC, decimals: 6, amount: -1_000_000_000n },
            { asset: WIF, symbol: 'WIF', decimals: 18, amount: 100n * 10n ** 18n },
          ],
        }),
        tx({
          ts: new Date('2024-02-01'),
          transfers: [
            { asset: WIF, symbol: 'WIF', decimals: 18, amount: -50n * 10n ** 18n },
            { asset: USDC, decimals: 6, amount: 200_000_000n },
          ],
        }),
      ],
    };

    const { positions } = computePositions(result, new Map());
    const wif = positions.find((p) => p.asset === WIF);

    assert.ok(wif, 'expected a WIF position');
    assert.equal(Math.round(wif.realizedPnlUsd), -300);
    assert.equal(wif.buys, 1);
    assert.equal(wif.sells, 1);
  });

  test('anchors on the native leg when no stablecoin is present', () => {
    const result = {
      cfg: eth,
      balances: [],
      txs: [
        tx({
          ts: new Date('2024-03-01'),
          transfers: [
            { asset: 'native', decimals: 18, amount: -1n * 10n ** 18n },
            { asset: WIF, decimals: 18, amount: 10n * 10n ** 18n },
          ],
        }),
      ],
    };

    const { positions } = computePositions(result, new Map([['2024-03-01', 2000]]));
    assert.equal(Math.round(positions.find((p) => p.asset === WIF).costBasisUsd), 2000);
  });

  test('counts transfers it cannot value instead of inventing a basis', () => {
    const result = {
      cfg: eth,
      balances: [],
      txs: [tx({ transfers: [{ asset: WIF, decimals: 18, amount: 500n * 10n ** 18n }] })],
    };

    const { positions, unvalued } = computePositions(result, new Map());
    assert.equal(unvalued, 1);
    assert.equal(positions.find((p) => p.asset === WIF).costBasisUsd, 0);
  });

  test('does not erase positions when balance data is missing entirely', () => {
    // A failed balance fetch yields an empty array. Treating that as "holds
    // nothing" would silently wipe every reconstructed position.
    const result = {
      cfg: eth,
      balances: [],
      txs: [
        tx({
          transfers: [
            { asset: USDC, decimals: 6, amount: -500_000_000n },
            { asset: WIF, decimals: 18, amount: 5n * 10n ** 18n },
          ],
        }),
      ],
    };

    const { positions } = computePositions(result, new Map());
    const wif = positions.find((p) => p.asset === WIF);
    assert.ok(wif, 'position must survive an empty balances array');
    assert.ok(wif.openAmount > 0n, 'holding must not be zeroed');
  });

  test('treats stablecoins as the numeraire, not as a position', () => {
    const result = {
      cfg: eth,
      balances: [],
      txs: [
        tx({
          transfers: [
            { asset: USDC, decimals: 6, amount: -500_000_000n },
            { asset: WIF, decimals: 18, amount: 1n * 10n ** 18n },
          ],
        }),
      ],
    };
    const { positions } = computePositions(result, new Map());
    assert.equal(positions.find((p) => p.asset === USDC), undefined);
  });
});

/* ──────────────────────────────────────────────────── exit liquidity */

describe('exit liquidity', () => {
  const baseChain = {
    positions: [],
    mev: { events: [], totalExtractedUsd: 0 },
    approvals: [],
    fees: { wastedOnFailedUsd: 0 },
    activity: { failedTxs: 0 },
  };

  test('an unanswered quote is never ranked as a loss', () => {
    // Regression: a refused quote once produced realizableUsd 0 and was
    // reported as "this position may be unsellable" — telling a user their
    // holding is worthless when the endpoint merely declined to answer.
    const regrets = collectRegrets({
      ...baseChain,
      liquidity: [
        {
          asset: WIF,
          symbol: 'WIF',
          quoted: false,
          nominalUsd: 50_000,
          realizableUsd: undefined,
          liquidityRatio: undefined,
          error: QUOTE_REASONS.refused,
        },
      ],
    });

    assert.equal(
      regrets.filter((r) => r.kind === 'illiquid-bag').length,
      0,
      'a quote that was refused is unknown, not a loss',
    );
  });

  test('a genuine absence of route is still reported as a loss', () => {
    const regrets = collectRegrets({
      ...baseChain,
      liquidity: [
        {
          asset: WIF,
          symbol: 'WIF',
          quoted: false,
          nominalUsd: 50_000,
          realizableUsd: 0,
          fullExitImpact: 1,
          liquidityRatio: 0,
          error: QUOTE_REASONS['no-route'],
        },
      ],
    });

    const bag = regrets.find((r) => r.kind === 'illiquid-bag');
    assert.ok(bag, 'no route found is a real finding');
    assert.equal(Math.round(bag.costUsd), 50_000);
  });

  test('every failure reason has human-readable text', () => {
    for (const key of ['no-route', 'refused', 'unpriced', 'unsupported']) {
      assert.ok(QUOTE_REASONS[key]?.length > 10, `${key} needs an explanation`);
    }
    // The two must not read alike; conflating them is the bug above.
    assert.notEqual(QUOTE_REASONS['no-route'], QUOTE_REASONS.refused);
  });
});

/* ───────────────────────────────────────────────────── MEV detection */

describe('sandwich detection', () => {
  test('a swap moves value both directions', () => {
    assert.equal(
      isSwapShaped({ transfers: [{ amount: -1n }, { amount: 5n }] }),
      true,
    );
    assert.equal(isSwapShaped({ transfers: [{ amount: 5n }] }), false, 'inbound only is not a swap');
    assert.equal(isSwapShaped({ transfers: [] }), false);
  });

  test('pools touched are the counterparties of the actor', () => {
    const pools = poolsTouched(
      [
        { token: 't', from: '0xme', to: '0xpool', value: 1n },
        { token: 't', from: '0xpool', to: '0xme', value: 2n },
        { token: 't', from: '0xother', to: '0xelsewhere', value: 3n },
      ],
      '0xme',
    );
    assert.ok(pools.has('0xpool'));
    assert.equal(pools.has('0xelsewhere'), false, 'unrelated transfers are not the actor’s pools');
  });

  test('profit is the attacker net gain in wrapped native', () => {
    const w = eth.wrapped.toLowerCase();
    const profit = estimateMevProfit(
      [{ token: w, from: '0xbot', to: '0xpool', value: 10n ** 18n }], // spends 1
      [{ token: w, from: '0xpool', to: '0xbot', value: 3n * 10n ** 18n }], // recovers 3
      '0xbot',
      eth,
      2000,
    );
    assert.equal(Math.round(profit), 4000, 'net +2 wrapped native at $2000');
  });

  test('unmeasurable flow reports zero rather than a guess', () => {
    const profit = estimateMevProfit([], [], '0xbot', eth, 2000);
    assert.equal(profit, 0);
  });
});

/* ─────────────────────────────────────────────────────── formatting */

describe('formatting', () => {
  test('long notes wrap so they stay readable in a terminal', () => {
    const long = 'word '.repeat(80).trim();
    const lines = wrap(long, 4).split('\n');
    assert.ok(lines.length > 1, 'must actually wrap');
    for (const l of lines) {
      assert.ok(l.length <= 80, `line too long: ${l.length}`);
      assert.match(l, /^ {4}\S/, 'every line keeps the indent');
    }
  });

  test('short text is left alone', () => {
    assert.equal(wrap('hello there', 2), '  hello there');
  });
});

/* ───────────────────────────────────────────────────── chain table */

describe('chain table', () => {
  test('every EVM chain is fully specified', () => {
    for (const [key, cfg] of Object.entries(EVM_CHAINS)) {
      assert.ok(cfg.chainId > 0, `${key}: chain id`);
      assert.ok(cfg.label, `${key}: label`);
      assert.ok(cfg.symbol, `${key}: native symbol`);
      assert.ok(cfg.decimals > 0, `${key}: native decimals`);
      assert.ok(cfg.cgId && cfg.cgPlatform, `${key}: coingecko ids`);
      assert.match(cfg.wrapped, /^0x[0-9a-f]{40}$/i, `${key}: wrapped native`);
      assert.ok(cfg.blockscout?.startsWith('http'), `${key}: blockscout base`);
      assert.ok(Object.keys(cfg.stables).length > 0, `${key}: needs a numeraire`);
    }
  });

  test('chain ids are unique', () => {
    const ids = Object.values(EVM_CHAINS).map((c) => c.chainId);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('stablecoin keys are lowercased so lookups match', () => {
    // Cost basis looks these up lowercased; a mixed-case key silently fails to
    // match and drops the trade from PnL.
    for (const [key, cfg] of Object.entries(EVM_CHAINS)) {
      for (const addr of Object.keys(cfg.stables)) {
        assert.equal(addr, addr.toLowerCase(), `${key}: ${addr}`);
      }
    }
  });
});
