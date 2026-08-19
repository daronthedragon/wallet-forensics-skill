#!/usr/bin/env node
/**
 * wallet-forensics — zero-dependency wallet analyzer.
 *
 * Deliberately has no package dependencies so it runs anywhere Node 20+ is
 * available, with no install step. Everything goes over built-in `fetch`:
 * Etherscan V2 for EVM history, raw JSON-RPC for chain state, CoinGecko for
 * prices, Jupiter for Solana routing.
 *
 * The one cost of having no dependencies is ABI encoding. Function selectors
 * are Keccak-256 hashes, and Node's crypto ships NIST SHA-3 rather than
 * Keccak, so selectors cannot be computed at runtime. They are hardcoded below
 * with their signatures written out, which is safe because they are permanent
 * constants of the ERC-20 and Uniswap interfaces.
 */

import { pathToFileURL } from 'node:url';

import {
  collectRegrets,
  computePositions,
  estimateMevProfit,
  isSwapShaped,
  poolsTouched,
  short,
  usd,
  wrap,
} from '../core/analysis.mjs';
import { FOREVER, createCache } from '../core/cache.mjs';
import { fetchLlamaTokenPrices } from '../core/prices.mjs';

/* ═══════════════════════════════════════════════════════════ chain config */

const NATIVE = 'native';

const UNISWAP_QUOTER_V2 = '0x61fFE014bA17989E743c5F6cB21bF9697530B21e';

export const EVM_CHAINS = {
  ethereum: {
    label: 'Ethereum',
    chainId: 1,
    rpc: () => env('ETH_RPC_URL', 'https://ethereum-rpc.publicnode.com'),
    symbol: 'ETH',
    decimals: 18,
    cgId: 'ethereum',
    cgPlatform: 'ethereum',
    llama: 'ethereum',
    quoter: UNISWAP_QUOTER_V2,
    wrapped: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    stables: {
      '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 6,
      '0xdac17f958d2ee523a2206206994597c13d831ec7': 6,
      '0x6b175474e89094c44da98b954eedeac495271d0f': 18,
    },
    blockscout: 'https://eth.blockscout.com/api',
    explorer: 'https://etherscan.io',
  },
  base: {
    label: 'Base',
    chainId: 8453,
    rpc: () => env('BASE_RPC_URL', 'https://base-rpc.publicnode.com'),
    symbol: 'ETH',
    decimals: 18,
    cgId: 'ethereum',
    cgPlatform: 'base',
    llama: 'base',
    quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    wrapped: '0x4200000000000000000000000000000000000006',
    stables: {
      '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 6,
      '0x50c5725949a6f0c72e6c4a641f24049a917db0cb': 18,
    },
    // Base's Blockscout instance intermittently errors on txlist; with no
    // Etherscan key, history on this chain may be unavailable.
    blockscout: 'https://base.blockscout.com/api',
    explorer: 'https://basescan.org',
  },
  arbitrum: {
    label: 'Arbitrum',
    chainId: 42161,
    rpc: () => env('ARBITRUM_RPC_URL', 'https://arbitrum-one-rpc.publicnode.com'),
    symbol: 'ETH',
    decimals: 18,
    cgId: 'ethereum',
    cgPlatform: 'arbitrum-one',
    llama: 'arbitrum',
    quoter: UNISWAP_QUOTER_V2,
    wrapped: '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    stables: {
      '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 6,
      '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 6,
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18,
    },
    blockscout: 'https://arbitrum.blockscout.com/api',
    explorer: 'https://arbiscan.io',
  },
  optimism: {
    label: 'Optimism',
    chainId: 10,
    rpc: () => env('OPTIMISM_RPC_URL', 'https://optimism-rpc.publicnode.com'),
    symbol: 'ETH',
    decimals: 18,
    cgId: 'ethereum',
    cgPlatform: 'optimistic-ethereum',
    llama: 'optimism',
    quoter: UNISWAP_QUOTER_V2,
    wrapped: '0x4200000000000000000000000000000000000006',
    stables: {
      '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 6,
      '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 6,
      '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1': 18,
    },
    blockscout: 'https://optimism.blockscout.com/api',
    explorer: 'https://optimistic.etherscan.io',
  },
  polygon: {
    label: 'Polygon',
    chainId: 137,
    rpc: () => env('POLYGON_RPC_URL', 'https://polygon-bor-rpc.publicnode.com'),
    symbol: 'POL',
    decimals: 18,
    cgId: 'matic-network',
    cgPlatform: 'polygon-pos',
    llama: 'polygon',
    quoter: UNISWAP_QUOTER_V2,
    wrapped: '0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270',
    stables: {
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 6,
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 6,
      '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063': 18,
    },
    blockscout: 'https://polygon.blockscout.com/api',
    explorer: 'https://polygonscan.com',
  },
};

const SOLANA = {
  label: 'Solana',
  rpc: () => env('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
  symbol: 'SOL',
  decimals: 9,
  cgId: 'solana',
  cgPlatform: 'solana',
  llama: 'solana',
  explorer: 'https://solscan.io',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  stables: {
    EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,
    Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,
  },
  tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
};

const KNOWN_SPENDERS = {
  '0x7a250d5630b4cf539739df2c5dacb4c659f2488d': 'Uniswap V2 Router',
  '0xe592427a0aece92de3edee1f18e0157c05861564': 'Uniswap V3 Router',
  '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45': 'Uniswap V3 Router 2',
  '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router',
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router 2',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 Router (Base)',
  '0x000000000022d473030f116ddee9f6b43ac78ba3': 'Permit2',
  '0x1111111254eeb25477b68fb85ed929f73a960582': '1inch Router V5',
  '0x111111125421ca6dc452d289314280a0f8842a65': '1inch Router V6',
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': '0x Exchange Proxy',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap Router',
  '0x881d40237659c251811cea9c664eef2e7ff4a7de': 'MetaMask Swap Router',
};

/* ══════════════════════════════════════════════════════ ABI, hand-rolled */

/*
 * Function selectors and event topics. These are Keccak-256 hashes of the
 * signatures in the comments. Node cannot compute Keccak (its 'sha3-256' is
 * the NIST variant, which produces different output), so they are hardcoded.
 * They are permanent constants of the ERC-20 / Uniswap interfaces.
 */
const SEL = {
  balanceOf: '0x70a08231', // balanceOf(address)
  allowance: '0xdd62ed3e', // allowance(address,address)
  decimals: '0x313ce567', // decimals()
  symbol: '0x95d89b41', // symbol()
  approve: '0x095ea7b3', // approve(address,uint256)
  increaseAllowance: '0x39509351', // increaseAllowance(address,uint256)
  quoteExactInputSingle: '0xc6a5026a', // quoteExactInputSingle((address,address,uint256,uint24,uint160))
};

const TOPIC_APPROVAL = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

// Transfer(address,address,uint256). ERC-721 shares this topic0 but carries a
// fourth indexed topic, so a topic-count check filters NFT transfers out.
const TOPIC_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Reading full blocks is the slowest thing here. Keep it bounded. */
const MAX_MEV_BLOCKS = 60;

/** Known MEV bots and builders. Presence raises detector confidence. */
const KNOWN_MEV_ACTORS = new Set([
  '0xae2fc483527b8ef99eb5d9b44875f005ba1fae13',
  '0x6b75d8af000000e20b7a7ddf000ba900b4009a80',
  '0x00000000003b3cc22af3ae1eac0440bcee416b40',
  '0xa69babef1ca67a37ffaf7a485dfff3382056e78c',
  '0x000000000dfde7deaf24138722987c9a6991e2d4',
]);

/** Left-pad a hex value to a 32-byte ABI word. */
function word(value) {
  const hex = typeof value === 'bigint' ? value.toString(16) : String(value).replace(/^0x/, '');
  return hex.toLowerCase().padStart(64, '0');
}

function encodeAddress(addr) {
  return word(addr.replace(/^0x/, ''));
}

function decodeUint(hex) {
  const clean = (hex || '0x').replace(/^0x/, '');
  return clean ? BigInt(`0x${clean.slice(0, 64) || '0'}`) : 0n;
}

/** Decode an ABI-encoded dynamic string. Returns null if it doesn't look like one. */
function decodeString(hex) {
  const clean = (hex || '').replace(/^0x/, '');
  if (clean.length < 128) return null;
  try {
    const length = Number(BigInt(`0x${clean.slice(64, 128)}`));
    if (!Number.isFinite(length) || length === 0 || length > 128) return null;
    const bytes = clean.slice(128, 128 + length * 2);
    const text = Buffer.from(bytes, 'hex').toString('utf8').replace(/\0/g, '').trim();
    return text || null;
  } catch {
    return null;
  }
}

/* ══════════════════════════════════════════════════════════════ transport */

function env(key, fallback = '') {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Deadline for every outbound request. Public explorers and RPCs stall rather
 * than refuse often enough that an unbounded fetch can hang a run
 * indefinitely, producing no output and no explanation.
 */
const FETCH_TIMEOUT_MS = Number(env('FETCH_TIMEOUT_MS', '20000'));
const deadline = () => ({ signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

/**
 * JSON-RPC call. Accepts a single {method, params} or an array of them, in
 * which case it uses a batch request — one round trip for N reads, which is
 * what makes reading hundreds of balances tolerable without multicall.
 */
async function rpc(url, calls) {
  const batch = Array.isArray(calls);
  const list = batch ? calls : [calls];
  if (list.length === 0) return [];

  const body = list.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));

  const res = await fetch(url, {
    ...deadline(),
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(batch ? body : body[0]),
  });
  if (!res.ok) throw new Error(`RPC ${res.status} ${res.statusText}`);

  const json = await res.json();
  const arr = Array.isArray(json) ? json : [json];

  // Batch responses are not guaranteed to come back in order.
  const byId = new Map(arr.map((r) => [r.id, r]));
  const results = list.map((_, i) => {
    const r = byId.get(i);
    if (!r) return { error: 'missing response' };
    return r.error ? { error: r.error.message ?? 'rpc error' } : { result: r.result };
  });

  return batch ? results : results[0];
}

/** Split a list into chunks; batch RPC requests get rejected above ~100 items. */
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/* ════════════════════════════════════════════════════════════════ pricing */

class Prices {
  #current = new Map();
  #historical = new Map();
  #missing = new Set();
  #last = 0;

  constructor(opts = {}) {
    this.key = env('COINGECKO_API_KEY');
    this.base = this.key ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
    this.interval = this.key ? 120 : 2200;
    // Only historical daily prices go to disk. They are facts about a day that
    // has already ended, so they can never become wrong.
    this.cache = createCache('prices', { disabled: opts.noCache });
  }

  async #get(url) {
    const wait = this.interval - (Date.now() - this.#last);
    if (wait > 0) await sleep(wait);
    this.#last = Date.now();

    const headers = { accept: 'application/json' };
    if (this.key) headers['x-cg-pro-api-key'] = this.key;

    let res = await fetch(url, { headers, ...deadline() });
    if (res.status === 429) {
      await sleep(3000);
      res = await fetch(url, { headers, ...deadline() });
    }
    if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
    return res.json();
  }

  async byId(id) {
    if (this.#current.has(`id:${id}`)) return this.#current.get(`id:${id}`);
    if (this.#missing.has(`id:${id}`)) return undefined;
    try {
      const json = await this.#get(`${this.base}/simple/price?ids=${id}&vs_currencies=usd`);
      const price = json?.[id]?.usd;
      if (typeof price === 'number') {
        this.#current.set(`id:${id}`, price);
        return price;
      }
    } catch {
      /* fall through */
    }
    this.#missing.add(`id:${id}`);
    return undefined;
  }

  /** Historical native price, cached by day — thousands of fees collapse to a few hundred lookups. */
  async onDay(id, date) {
    const day = date.toISOString().slice(0, 10);
    const key = `${id}:${day}`;
    if (this.#historical.has(key)) return this.#historical.get(key);
    if (this.#missing.has(key)) return undefined;

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      // A recorded absence is cached too: re-asking costs a full request and
      // CoinGecko will not have grown history for a day it never had.
      if (cached === null) {
        this.#missing.add(key);
        return undefined;
      }
      this.#historical.set(key, cached);
      return cached;
    }

    const [y, m, d] = day.split('-');
    try {
      const json = await this.#get(`${this.base}/coins/${id}/history?date=${d}-${m}-${y}&localization=false`);
      const price = json?.market_data?.current_price?.usd;
      if (typeof price === 'number') {
        this.#historical.set(key, price);
        this.cache.set(key, price, FOREVER);
        return price;
      }
      // A day with no data stays absent; remember that for a week in case it
      // is ever backfilled.
      this.cache.set(key, null, 7 * 24 * 60 * 60 * 1000);
    } catch {
      /* a request that failed may succeed later, so it is not recorded */
    }
    this.#missing.add(key);
    return undefined;
  }

  /** Token prices by contract address, batched 100 at a time. */
  /**
   * Current USD prices for a set of tokens.
   *
   * DefiLlama first, because it takes a hundred addresses per request and needs
   * no key. CoinGecko's unkeyed tier rejects any request carrying more than one
   * address, so pricing an airdrop-stuffed wallet through it alone means one
   * throttled request per token — thousands of them, hours of wall clock.
   *
   * Whatever DefiLlama could not price falls through to CoinGecko only while
   * the remainder is small enough to be worth the throttle. Beyond that the
   * tokens stay unpriced, which callers already treat as unknown rather than
   * zero.
   */
  async tokens(chainCfg, addresses) {
    const platform = chainCfg.cgPlatform;
    const out = new Map();
    const need = [];
    for (const a of addresses) {
      const key = `${platform}:${a.toLowerCase()}`;
      if (this.#current.has(key)) out.set(a, this.#current.get(key));
      else if (!this.#missing.has(key)) need.push(a);
    }
    if (need.length === 0) return out;

    const remaining = [];
    if (chainCfg.llama) {
      const priced = await fetchLlamaTokenPrices(chainCfg.llama, need);
      for (const a of need) {
        const hit = priced.get(a);
        if (hit) {
          this.#current.set(`${platform}:${a.toLowerCase()}`, hit.price);
          out.set(a, hit.price);
        } else {
          remaining.push(a);
        }
      }
    } else {
      remaining.push(...need);
    }

    // One CoinGecko request per token on the free tier, so this is only worth
    // doing for a handful. A long tail of unpriceable spam is not worth an hour.
    const FALLBACK_LIMIT = this.key ? 500 : 25;
    const batchSize = this.key ? 100 : 1;

    for (const group of chunk(remaining.slice(0, FALLBACK_LIMIT), batchSize)) {
      try {
        const json = await this.#get(
          `${this.base}/simple/token_price/${platform}` +
            `?contract_addresses=${encodeURIComponent(group.join(','))}&vs_currencies=usd`,
        );
        for (const a of group) {
          const hit = json?.[a] ?? json?.[a.toLowerCase()];
          const key = `${platform}:${a.toLowerCase()}`;
          if (hit?.usd !== undefined) {
            this.#current.set(key, hit.usd);
            out.set(a, hit.usd);
          } else this.#missing.add(key);
        }
      } catch {
        for (const a of group) this.#missing.add(`${platform}:${a.toLowerCase()}`);
      }
    }

    for (const a of remaining.slice(FALLBACK_LIMIT)) {
      this.#missing.add(`${platform}:${a.toLowerCase()}`);
    }

    return out;
  }
}

/* ══════════════════════════════════════════════════════════ EVM analysis */

/**
 * Which explorer supplies account history.
 *
 * Etherscan is more complete but needs a key. Blockscout needs none, which is
 * what lets this skill produce a full report with zero configuration — the
 * response shapes match, so everything downstream is unaffected.
 */
function historySource() {
  return env('ETHERSCAN_API_KEY') ? 'etherscan' : 'blockscout';
}

async function explorer(cfg, action, address) {
  const key = env('ETHERSCAN_API_KEY');
  const url = key
    ? `https://api.etherscan.io/v2/api?chainid=${cfg.chainId}` +
      `&module=account&action=${action}&address=${address}` +
      `&startblock=0&endblock=99999999&sort=desc&apikey=${key}`
    : `${cfg.blockscout}?module=account&action=${action}` +
      `&address=${address}&startblock=0&endblock=99999999&sort=desc`;

  const res = await fetch(url, deadline());
  if (!res.ok) throw new Error(`${historySource()} ${res.status} on ${action}`);
  const json = await res.json();

  // Both explorers report "nothing found" with the same status they use for
  // real errors, so an empty result has to be recognised first.
  if (json.status !== '1') {
    if (Array.isArray(json.result) && json.result.length === 0) return [];
    const detail = typeof json.result === 'string' ? json.result : '';
    if (/no transactions found|not found|no records/i.test(`${json.message} ${detail}`)) return [];
    throw new Error(`${historySource()} ${action}: ${json.message ?? 'error'}`);
  }
  return json.result ?? [];
}

/**
 * Current token holdings from Blockscout.
 *
 * Deriving candidates from transfer history only sees the explorer's most
 * recent page, so anything bought earlier and simply held goes unnoticed —
 * precisely the long-tail position that exit-liquidity analysis exists to
 * price. Etherscan puts the equivalent endpoint behind a paid plan, so the
 * keyed path keeps using transfer history.
 */
async function blockscoutHoldings(cfg, address) {
  const res = await fetch(
    `${cfg.blockscout}?module=account&action=tokenlist&address=${address}`,
    deadline(),
  );
  if (!res.ok) return [];
  const json = await res.json();
  if (json.status !== '1' || !Array.isArray(json.result)) return [];

  return json.result
    .filter((t) => t.type === 'ERC-20' && BigInt(t.balance || '0') > 0n)
    .map((t) => ({
      address: (t.contractAddress ?? '').toLowerCase(),
      symbol: t.symbol,
      decimals: Number(t.decimals ?? 18),
      // The balance is already here. Re-reading it over RPC means one eth_call
      // per token, and an airdrop-stuffed wallet holds thousands — which is
      // exactly the batch public endpoints reject outright.
      balance: BigInt(t.balance || '0'),
    }))
    .filter((t) => t.address);
}

async function analyzeEvm(chainKey, address, prices, opts) {
  const cfg = EVM_CHAINS[chainKey];
  const url = cfg.rpc();
  const owner = address.toLowerCase();
  const warnings = [];

  /* ---- history ---- */
  let txs = [];
  let haveHistory = false;
  try {
    const [normal, tokens] = await Promise.all([
      explorer(cfg, 'txlist', address),
      explorer(cfg, 'tokentx', address),
    ]);
    haveHistory = true;

    const byHash = new Map();
    for (const t of normal) {
      const outgoing = t.from?.toLowerCase() === owner;
      const tx = {
        id: t.hash,
        ts: new Date(Number(t.timeStamp) * 1000),
        block: Number(t.blockNumber),
        outgoing,
        fee: outgoing ? BigInt(t.gasUsed || 0) * BigInt(t.gasPrice || 0) : 0n,
        failed: t.isError === '1' || t.txreceipt_status === '0',
        to: t.to,
        input: t.input,
        label: labelFor(t),
        transfers: [],
      };
      const value = BigInt(t.value || 0);
      if (value > 0n) {
        tx.transfers.push({
          asset: NATIVE,
          symbol: cfg.symbol,
          decimals: cfg.decimals,
          amount: outgoing ? -value : value,
        });
      }
      byHash.set(t.hash, tx);
    }

    for (const t of tokens) {
      let tx = byHash.get(t.hash);
      if (!tx) {
        tx = {
          id: t.hash,
          ts: new Date(Number(t.timeStamp) * 1000),
          block: Number(t.blockNumber),
          outgoing: false,
          fee: 0n,
          failed: false,
          transfers: [],
          label: undefined,
        };
        byHash.set(t.hash, tx);
      }
      const outgoing = t.from?.toLowerCase() === owner;
      const raw = BigInt(t.value || 0);
      if (raw === 0n) continue;
      tx.transfers.push({
        asset: (t.contractAddress ?? '').toLowerCase(),
        symbol: t.tokenSymbol,
        decimals: Number(t.tokenDecimal ?? 18),
        amount: outgoing ? -raw : raw,
      });
    }

    const all = [...byHash.values()].sort((a, b) => b.block - a.block);
    txs = all.slice(0, opts.max);
    if (all.length > opts.max) {
      warnings.push(
        `History truncated to the ${opts.max} most recent of ${all.length} transactions (--max). ` +
          `Wallet age, first-seen and lifetime fee totals are therefore floors, not true values, ` +
          `and older positions may be missing from cost basis.`,
      );
    }
    if (opts.since) txs = txs.filter((t) => t.ts >= opts.since);

    // Fee pricing, one lookup per distinct day.
    const days = new Map();
    for (const t of txs) if (t.fee > 0n) days.set(t.ts.toISOString().slice(0, 10), t.ts);
    const priceByDay = new Map();
    for (const [day, when] of days) priceByDay.set(day, await prices.onDay(cfg.cgId, when));
    for (const t of txs) {
      if (t.fee === 0n) continue;
      const p = priceByDay.get(t.ts.toISOString().slice(0, 10));
      if (p !== undefined) t.feeUsd = Number(t.fee) / 10 ** cfg.decimals * p;
    }
  } catch (e) {
    warnings.push(
      `History unavailable from ${historySource()}: ${e.message}. ` +
        `PnL, fee totals and MEV detection are omitted; balances and approvals are still reported.` +
        (historySource() === 'blockscout'
          ? ' Setting ETHERSCAN_API_KEY switches to Etherscan, which is more complete.'
          : ''),
    );
  }

  /* ---- balances ---- */
  const balances = [];
  try {
    const [nativeRes] = await rpc(url, [{ method: 'eth_getBalance', params: [address, 'latest'] }]);
    if (nativeRes?.error) throw new Error(nativeRes.error);
    const nativeRaw = nativeRes?.result ? BigInt(nativeRes.result) : 0n;
    const nativePrice = await prices.byId(cfg.cgId);
    balances.push({
      asset: NATIVE,
      symbol: cfg.symbol,
      decimals: cfg.decimals,
      amount: nativeRaw,
      priceUsd: nativePrice,
      valueUsd: nativePrice ? (Number(nativeRaw) / 10 ** cfg.decimals) * nativePrice : undefined,
    });

    // There is no "list my tokens" RPC. Blockscout exposes the real holdings,
    // which catches long-held positions that never appear in recent transfers;
    // otherwise fall back to whatever the history touched.
    const seen = new Map();
    if (historySource() === 'blockscout') {
      try {
        for (const t of await blockscoutHoldings(cfg, address)) seen.set(t.address, t);
      } catch {
        // Fall through to the history-derived candidates below.
      }
    }
    for (const t of txs) {
      for (const tr of t.transfers) {
        if (tr.asset === NATIVE || !tr.asset) continue;
        if (!seen.has(tr.asset)) {
          seen.set(tr.asset, { address: tr.asset, symbol: tr.symbol, decimals: tr.decimals ?? 18 });
        }
      }
    }

    const candidates = [...seen.values()];

    const held = [];
    // Where the explorer already reported a balance, that is the answer.
    // Re-reading those over RPC is one eth_call per token, and an
    // airdrop-stuffed wallet holds thousands — the batch public endpoints
    // reject outright. Only tokens without a known balance get swept.
    const needSweep = [];
    for (const c of candidates) {
      if (c.balance !== undefined && c.balance > 0n) held.push({ ...c, amount: c.balance });
      else needSweep.push(c);
    }

    for (const group of chunk(needSweep, 80)) {
      const results = await rpc(
        url,
        group.map((c) => ({
          method: 'eth_call',
          params: [{ to: c.address, data: SEL.balanceOf + encodeAddress(address) }, 'latest'],
        })),
      );
      results.forEach((r, i) => {
        if (r.error || !r.result || r.result === '0x') return;
        const amount = decodeUint(r.result);
        if (amount > 0n) held.push({ ...group[i], amount });
      });
    }

    if (held.length) {
      const priceMap = await prices.tokens(cfg, held.map((h) => h.address));
      for (const h of held) {
        const p = priceMap.get(h.address);
        balances.push({
          asset: h.address,
          symbol: h.symbol,
          decimals: h.decimals,
          amount: h.amount,
          priceUsd: p,
          valueUsd: p ? (Number(h.amount) / 10 ** h.decimals) * p : undefined,
        });
      }
    }
    balances.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));
  } catch (e) {
    // The native balance is pushed before the token sweep runs, so a failure
    // here may still leave a partial result. Say which, rather than implying
    // the whole portfolio reads as empty.
    warnings.push(
      balances.length > 0
        ? `Token balances unavailable: ${e.message}. The native balance below is correct, ` +
            `but token holdings are missing, so portfolio and exit-liquidity totals are floors, not totals.`
        : `Balances unavailable: ${e.message}`,
    );
  }

  /* ---- approvals ---- */
  const approvals = [];
  try {
    const { pairs, degraded } = await collectApprovals(url, address, txs);
    if (degraded && pairs.length === 0) {
      warnings.push(
        'Approval scan was degraded: this RPC rejects unbounded eth_getLogs and no approve() calls ' +
          'were found in the fetched history. Coverage is incomplete — use an Alchemy/Infura endpoint ' +
          'for a full scan. Do not read this as "no risky approvals".',
      );
    } else if (degraded) {
      warnings.push(
        'Approval scan used the history fallback (this RPC rejects unbounded eth_getLogs). ' +
          'Approvals granted indirectly, through routers or batchers, may be missing.',
      );
    }

    if (pairs.length) {
      const live = [];
      for (const group of chunk(pairs, 60)) {
        const [allow, bal] = await Promise.all([
          rpc(url, group.map((p) => ({
            method: 'eth_call',
            params: [
              { to: p.token, data: SEL.allowance + encodeAddress(address) + encodeAddress(p.spender) },
              'latest',
            ],
          }))),
          rpc(url, group.map((p) => ({
            method: 'eth_call',
            params: [{ to: p.token, data: SEL.balanceOf + encodeAddress(address) }, 'latest'],
          }))),
        ]);
        group.forEach((p, i) => {
          if (allow[i]?.error || !allow[i]?.result) return;
          const allowance = decodeUint(allow[i].result);
          if (allowance === 0n) return; // already revoked
          const balance = bal[i]?.result ? decodeUint(bal[i].result) : 0n;
          live.push({ ...p, allowance, balance });
        });
      }

      if (live.length) {
        // Symbol + decimals for the tokens that matter.
        const meta = await rpc(
          url,
          live.flatMap((l) => [
            { method: 'eth_call', params: [{ to: l.token, data: SEL.symbol }, 'latest'] },
            { method: 'eth_call', params: [{ to: l.token, data: SEL.decimals }, 'latest'] },
          ]),
        );
        const priceMap = await prices.tokens(cfg, live.map((l) => l.token));

        live.forEach((l, i) => {
          const symbol = decodeString(meta[i * 2]?.result) ?? undefined;
          const decimals = meta[i * 2 + 1]?.result ? Number(decodeUint(meta[i * 2 + 1].result)) : 18;
          const unlimited = l.allowance >= 1n << 255n;
          const price = priceMap.get(l.token);

          // What could be taken right now: the smaller of allowance and balance.
          const exposed = unlimited ? l.balance : l.allowance < l.balance ? l.allowance : l.balance;
          const atRiskUsd = price ? (Number(exposed) / 10 ** decimals) * price : undefined;

          const known = KNOWN_SPENDERS[l.spender.toLowerCase()];
          const reasons = [];
          if (unlimited) reasons.push('Unlimited allowance');
          if (!known) reasons.push('Spender is not a recognized protocol');
          if ((atRiskUsd ?? 0) > 10_000) {
            reasons.push(`$${Math.round(atRiskUsd).toLocaleString()} currently exposed`);
          }

          let risk = 'low';
          const v = atRiskUsd ?? 0;
          if (unlimited && !known && v > 1000) risk = 'critical';
          else if (unlimited && v > 1000) risk = 'high';
          else if (!known && v > 100) risk = 'high';
          else if (unlimited || v > 1000) risk = 'medium';

          approvals.push({
            asset: l.token,
            symbol,
            spender: l.spender,
            spenderLabel: known,
            allowance: unlimited ? null : l.allowance.toString(),
            atRiskUsd,
            risk,
            riskReasons: reasons.length ? reasons : ['Bounded allowance to a known protocol'],
          });
        });
        approvals.sort((a, b) => (b.atRiskUsd ?? 0) - (a.atRiskUsd ?? 0));
      }
    }
  } catch (e) {
    warnings.push(`Approval scan failed: ${e.message}`);
  }

  /* ---- exit liquidity ---- */
  const liquidity = [];
  if (!opts.skipLiquidity) {
    for (const b of balances.filter((x) => (x.valueUsd ?? 0) >= 25).slice(0, 12)) {
      if (b.asset === NATIVE) {
        liquidity.push({
          asset: b.asset,
          symbol: b.symbol,
          nominalUsd: b.valueUsd,
          realizableUsd: b.valueUsd,
          fullExitImpact: 0,
          liquidityRatio: 1,
        });
        continue;
      }
      const q = await quoteEvmSell(url, cfg, b, prices);
      liquidity.push(
        q.quoted
          ? q
          : {
              quoted: false,
              asset: b.asset,
              symbol: b.symbol,
              nominalUsd: b.valueUsd,
              // Unknown, not zero — only a genuine absence of route is a loss.
              realizableUsd: q.reason === 'no-route' ? 0 : undefined,
              fullExitImpact: q.reason === 'no-route' ? 1 : undefined,
              liquidityRatio: q.reason === 'no-route' ? 0 : undefined,
              error: QUOTE_REASONS[q.reason],
            },
      );
    }
    liquidity.sort((a, b) => (a.liquidityRatio ?? 1) - (b.liquidityRatio ?? 1));
  }

  /* ---- MEV ---- */
  let mev = [];
  if (!opts.skipMev && txs.length) {
    try {
      const r = await detectSandwiches(url, cfg, address, txs, prices);
      mev = r.events;
      if (r.unreadable > 0) {
        warnings.push(
          `Sandwich detection could not read ${r.unreadable} of ${r.unreadable + r.inspected} ` +
            `candidate blocks (RPC rejected or pruned them). A result of zero sandwiches here ` +
            `means 'could not check', not 'none found'. A dedicated RPC endpoint fixes this.`,
        );
      }
      if (r.totalBlocks > r.inspected + r.unreadable) {
        warnings.push(
          `Sandwich detection covered the ${r.inspected + r.unreadable} most recent swap blocks ` +
            `of ${r.totalBlocks}. Older sandwiches are not counted, so MEV totals are floors.`,
        );
      }
    } catch (e) {
      warnings.push(`Sandwich detection failed: ${e.message}`);
    }
  }

  return {
    chain: chainKey,
    label: cfg.label,
    address,
    haveHistory,
    txs,
    balances,
    approvals,
    liquidity,
    mev,
    warnings,
    cfg,
  };
}

/**
 * Find (token, spender) pairs that may still have a live allowance.
 *
 * Preferred path is an Approval log scan, which catches approvals granted
 * indirectly. Most public RPCs reject an unbounded eth_getLogs, so there is a
 * fallback that decodes approve() calldata straight from the history we
 * already have. `degraded` reports which path ran so the caller can be honest
 * about coverage.
 */
async function collectApprovals(url, address, txs) {
  const found = new Map();
  const ownerTopic = `0x${encodeAddress(address)}`;

  try {
    const [res] = await rpc(url, [
      {
        method: 'eth_getLogs',
        params: [{ fromBlock: '0x0', toBlock: 'latest', topics: [TOPIC_APPROVAL, ownerTopic] }],
      },
    ]);
    if (res?.error) throw new Error(res.error);

    for (const log of res.result ?? []) {
      const spenderTopic = log.topics?.[2];
      if (!spenderTopic) continue;
      const token = log.address.toLowerCase();
      const spender = `0x${spenderTopic.slice(-40)}`.toLowerCase();
      found.set(`${token}:${spender}`, { token, spender });
    }
    return { pairs: [...found.values()], degraded: false };
  } catch {
    // Fall through to the history-derived path.
  }

  for (const tx of txs) {
    if (!tx.outgoing || tx.failed || !tx.input || !tx.to) continue;
    const sel = tx.input.slice(0, 10).toLowerCase();
    if (sel !== SEL.approve && sel !== SEL.increaseAllowance) continue;
    if (tx.input.length < 74) continue;
    const token = tx.to.toLowerCase();
    const spender = `0x${tx.input.slice(34, 74)}`.toLowerCase();
    found.set(`${token}:${spender}`, { token, spender });
  }
  return { pairs: [...found.values()], degraded: true };
}

/** Simulate selling a position through Uniswap V3, probing each fee tier. */
/**
 * Simulate selling a position through Uniswap V3.
 *
 * Returns `{ quoted: false, reason }` rather than a bare null. The distinction
 * matters: "no pool exists" means the position genuinely cannot be sold, while
 * "the RPC refused" means we could not ask. Collapsing both into zero tells a
 * user their holding is worthless when it may be perfectly liquid.
 */
export async function quoteEvmSell(url, cfg, balance, prices) {
  if (!cfg.quoter) return { quoted: false, reason: 'unsupported' };
  if (balance.asset === cfg.wrapped) {
    return {
      asset: balance.asset,
      symbol: balance.symbol,
      nominalUsd: balance.valueUsd,
      realizableUsd: balance.valueUsd,
      fullExitImpact: 0,
      liquidityRatio: 1,
    };
  }

  const nativePrice = await prices.byId(cfg.cgId);
  if (!nativePrice || !balance.valueUsd) return { quoted: false, reason: 'unpriced' };

  let best = 0n;
  let refused = 0;
  for (const fee of [500, 3000, 10000]) {
    const data =
      SEL.quoteExactInputSingle +
      encodeAddress(balance.asset) +
      encodeAddress(cfg.wrapped) +
      word(balance.amount) +
      word(BigInt(fee)) +
      word(0n);
    try {
      const [r] = await rpc(url, [
        { method: 'eth_call', params: [{ to: cfg.quoter, data }, 'latest'] },
      ]);
      if (r?.error) {
        refused++;
        continue;
      }
      if (!r?.result || r.result === '0x') continue; // no pool at this tier
      const out = decodeUint(r.result);
      if (out > best) best = out;
    } catch {
      refused++;
    }
  }

  // Every tier erroring is an unanswered question, not an empty market.
  if (best === 0n) {
    return { quoted: false, reason: refused === 3 ? 'refused' : 'no-route' };
  }

  const realizableUsd = (Number(best) / 10 ** cfg.decimals) * nativePrice;
  const impact = balance.valueUsd > 0 ? Math.max(0, 1 - realizableUsd / balance.valueUsd) : 0;

  return {
    quoted: true,
    asset: balance.asset,
    symbol: balance.symbol,
    nominalUsd: balance.valueUsd,
    realizableUsd,
    fullExitImpact: impact,
    liquidityRatio: balance.valueUsd > 0 ? realizableUsd / balance.valueUsd : 0,
  };
}

function labelFor(t) {
  const known = KNOWN_SPENDERS[(t.to ?? '').toLowerCase()];
  const fn = t.functionName?.split('(')[0]?.trim();
  if (known && fn) return `${known}: ${fn}`;
  return known || fn || undefined;
}

export const QUOTE_REASONS = {
  'no-route': 'No route found — this position may genuinely be unsellable',
  refused: 'Quote unavailable — the endpoint refused the request, so this is unknown, not zero',
  unpriced: 'No spot price available, so price impact cannot be computed',
  unsupported: 'No Uniswap V3 deployment on this chain to quote against',
};

/* ═════════════════════════════════════════════════════════ MEV detection */



const sharesAny = (a, b) => [...a].some((x) => b.has(x));


/**
 * Detect sandwich attacks against the subject's swaps.
 *
 * The structural signature is narrow enough to detect reliably: the same
 * sender appears immediately before *and* after the victim in the same block,
 * and all three transactions touch a common pool. The shared-pool check is
 * what separates a real sandwich from unrelated transactions sitting nearby.
 *
 * Confidence is reported honestly:
 *   high   — adjacent both sides, shared pool, measurable profit or known bot
 *   medium — adjacent both sides and shared pool, profit not measurable
 *   low    — same-block bracketing but not directly adjacent
 */
async function detectSandwiches(url, cfg, victim, txs, prices) {
  const swaps = txs.filter((t) => !t.failed && isSwapShaped(t));
  if (!swaps.length) return { events: [], inspected: 0, totalBlocks: 0 };

  const allBlocks = [...new Set(swaps.map((s) => s.block))].sort((a, b) => b - a);
  const blocks = allBlocks.slice(0, MAX_MEV_BLOCKS);

  const events = [];
  const nativePrice = await prices.byId(cfg.cgId);
  const victimLc = victim.toLowerCase();
  let unreadable = 0;

  for (const bn of blocks) {
    const hex = '0x' + bn.toString(16);
    let blockRes, logRes;
    try {
      [blockRes, logRes] = await rpc(url, [
        { method: 'eth_getBlockByNumber', params: [hex, true] },
        { method: 'eth_getLogs', params: [{ fromBlock: hex, toBlock: hex, topics: [TOPIC_TRANSFER] }] },
      ]);
    } catch {
      unreadable++; // pruned block or RPC hiccup
      continue;
    }
    if (blockRes?.error || logRes?.error) {
      unreadable++;
      continue;
    }

    const blockTxs = (blockRes.result?.transactions ?? []).map((t, i) => ({
      hash: (t.hash ?? '').toLowerCase(),
      from: (t.from ?? '').toLowerCase(),
      index: t.transactionIndex != null ? Number(t.transactionIndex) : i,
    }));

    const byTx = new Map();
    for (const log of logRes.result ?? []) {
      if (!log.topics || log.topics.length !== 3) continue; // exclude ERC-721
      const key = (log.transactionHash ?? '').toLowerCase();
      const entry = {
        token: (log.address ?? '').toLowerCase(),
        from: ('0x' + log.topics[1].slice(-40)).toLowerCase(),
        to: ('0x' + log.topics[2].slice(-40)).toLowerCase(),
        value: log.data && log.data !== '0x' ? BigInt(log.data.slice(0, 66)) : 0n,
      };
      if (!byTx.has(key)) byTx.set(key, []);
      byTx.get(key).push(entry);
    }

    for (const vtx of swaps.filter((s) => s.block === bn)) {
      const vHash = vtx.id.toLowerCase();
      const vEntry = blockTxs.find((t) => t.hash === vHash);
      if (!vEntry) continue;

      const victimPools = poolsTouched(byTx.get(vHash) ?? [], victimLc);
      if (!victimPools.size) continue;

      const before = blockTxs.filter((t) => t.index < vEntry.index).sort((a, b) => b.index - a.index).slice(0, 3);
      const after = blockTxs.filter((t) => t.index > vEntry.index).sort((a, b) => a.index - b.index).slice(0, 3);

      let match = null;
      for (const f of before) {
        if (f.from === victimLc) continue;
        if (!sharesAny(poolsTouched(byTx.get(f.hash) ?? [], f.from), victimPools)) continue;
        for (const b of after) {
          if (b.from !== f.from) continue;
          if (!sharesAny(poolsTouched(byTx.get(b.hash) ?? [], b.from), victimPools)) continue;
          match = { attacker: f.from, front: f.hash, back: b.hash, adjacent: before[0] === f && after[0] === b };
          break;
        }
        if (match) break;
      }
      if (!match) continue;

      const profit = estimateMevProfit(
        byTx.get(match.front) ?? [],
        byTx.get(match.back) ?? [],
        match.attacker,
        { wrappedNative: cfg.wrapped, nativeDecimals: cfg.decimals, stables: cfg.stables },
        nativePrice,
      );
      const known = KNOWN_MEV_ACTORS.has(match.attacker);

      events.push({
        victimTx: vtx.id,
        block: bn,
        timestamp: vtx.ts.toISOString(),
        kind: 'sandwich',
        attacker: match.attacker,
        frontTx: match.front,
        backTx: match.back,
        extractedUsd: profit,
        confidence: !match.adjacent ? 'low' : profit > 0 || known ? 'high' : 'medium',
      });
    }
  }

  events.sort((a, b) => b.extractedUsd - a.extractedUsd);
  // `unreadable` matters: without it, a run where every block read failed is
  // indistinguishable from a run that genuinely found no sandwiches.
  return { events, inspected: blocks.length - unreadable, unreadable, totalBlocks: allBlocks.length };
}

/* ═══════════════════════════════════════════════════════ Solana analysis */

async function analyzeSolana(address, prices, opts) {
  const url = SOLANA.rpc();
  const warnings = [];
  let txs = [];
  let haveHistory = false;

  /* ---- history ---- */
  try {
    const sigs = [];
    let before;
    for (let page = 0; page < 5 && sigs.length < opts.max; page++) {
      const [r] = await rpc(url, [
        { method: 'getSignaturesForAddress', params: [address, { limit: 1000, before }] },
      ]);
      if (r?.error) throw new Error(r.error);
      const batch = r.result ?? [];
      if (!batch.length) break;
      sigs.push(...batch);
      before = batch[batch.length - 1]?.signature;
      if (batch.length < 1000) break;
    }

    const wanted = sigs.slice(0, opts.max);
    if (sigs.length > opts.max) {
      warnings.push(
        `History truncated to the ${opts.max} most recent of ${sigs.length}+ signatures (--max). ` +
          `Wallet age and lifetime fee totals are floors, not true values.`,
      );
    }
    for (const group of chunk(wanted, 50)) {
      const results = await rpc(
        url,
        group.map((s) => ({
          method: 'getTransaction',
          params: [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }],
        })),
      );
      results.forEach((r, i) => {
        if (r.error || !r.result) return;
        txs.push(normalizeSolanaTx(r.result, group[i], address));
      });
    }
    haveHistory = true;

    if (opts.since) txs = txs.filter((t) => t.ts >= opts.since);

    const days = new Map();
    for (const t of txs) if (t.fee > 0n && t.ts.getTime() > 0) days.set(t.ts.toISOString().slice(0, 10), t.ts);
    const priceByDay = new Map();
    for (const [day, when] of days) priceByDay.set(day, await prices.onDay(SOLANA.cgId, when));
    for (const t of txs) {
      if (t.fee === 0n) continue;
      const p = priceByDay.get(t.ts.toISOString().slice(0, 10));
      if (p !== undefined) t.feeUsd = (Number(t.fee) / 10 ** SOLANA.decimals) * p;
    }
  } catch (e) {
    warnings.push(
      `Solana history unavailable: ${e.message}. The public endpoint is heavily rate limited — ` +
        `set SOLANA_RPC_URL to a dedicated provider (Helius, Triton, QuickNode).`,
    );
  }

  /* ---- balances + delegates ---- */
  const balances = [];
  const approvals = [];
  try {
    const [balRes, classic, t22] = await rpc(url, [
      { method: 'getBalance', params: [address] },
      {
        method: 'getTokenAccountsByOwner',
        params: [address, { programId: SOLANA.tokenProgram }, { encoding: 'jsonParsed' }],
      },
      {
        method: 'getTokenAccountsByOwner',
        params: [address, { programId: SOLANA.token2022 }, { encoding: 'jsonParsed' }],
      },
    ]);

    const lamports = BigInt(balRes?.result?.value ?? 0);
    const solPrice = await prices.byId(SOLANA.cgId);
    balances.push({
      asset: NATIVE,
      symbol: 'SOL',
      decimals: 9,
      amount: lamports,
      priceUsd: solPrice,
      valueUsd: solPrice ? (Number(lamports) / 1e9) * solPrice : undefined,
    });

    const accounts = [...(classic?.result?.value ?? []), ...(t22?.result?.value ?? [])];
    const holdings = new Map();

    for (const acc of accounts) {
      const info = acc?.account?.data?.parsed?.info;
      if (!info) continue;
      const amount = BigInt(info.tokenAmount?.amount ?? 0);
      const decimals = info.tokenAmount?.decimals ?? 0;
      if (amount > 0n) {
        const prev = holdings.get(info.mint);
        holdings.set(info.mint, { amount: (prev?.amount ?? 0n) + amount, decimals });
      }

      // A delegate is Solana's equivalent of a standing approval.
      if (info.delegate) {
        approvals.push({
          asset: info.mint,
          spender: info.delegate,
          allowance: info.delegatedAmount?.amount ?? '0',
          _balance: amount,
          _decimals: decimals,
        });
      }
    }

    if (holdings.size) {
      const priceMap = await prices.tokens(SOLANA, [...holdings.keys()]);
      for (const [mint, h] of holdings) {
        const p = priceMap.get(mint);
        balances.push({
          asset: mint,
          decimals: h.decimals,
          amount: h.amount,
          priceUsd: p,
          valueUsd: p ? (Number(h.amount) / 10 ** h.decimals) * p : undefined,
        });
      }
    }
    balances.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

    if (approvals.length) {
      const priceMap = await prices.tokens(SOLANA, approvals.map((a) => a.asset));
      for (const a of approvals) {
        const p = priceMap.get(a.asset);
        const delegated = BigInt(a.allowance);
        const exposed = delegated < a._balance ? delegated : a._balance;
        a.atRiskUsd = p ? (Number(exposed) / 10 ** a._decimals) * p : undefined;

        const v = a.atRiskUsd ?? 0;
        a.risk = v > 10_000 ? 'critical' : v > 1000 ? 'high' : v > 50 ? 'medium' : 'low';
        a.riskReasons = ['Token account has an active delegate'];
        if (delegated >= a._balance) a.riskReasons.push('Delegate can move the entire balance');
        delete a._balance;
        delete a._decimals;
      }
      approvals.sort((x, y) => (y.atRiskUsd ?? 0) - (x.atRiskUsd ?? 0));
    }
  } catch (e) {
    warnings.push(`Solana balances unavailable: ${e.message}`);
  }

  /* ---- exit liquidity via Jupiter ---- */
  const liquidity = [];
  if (!opts.skipLiquidity) {
    for (const b of balances.filter((x) => (x.valueUsd ?? 0) >= 25).slice(0, 12)) {
      if (b.asset === NATIVE || b.asset === SOLANA.usdc) {
        liquidity.push({
          asset: b.asset,
          symbol: b.symbol,
          nominalUsd: b.valueUsd,
          realizableUsd: b.valueUsd,
          fullExitImpact: 0,
          liquidityRatio: 1,
        });
        continue;
      }
      const q = await quoteJupiter(b);
      liquidity.push(
        q.quoted
          ? q
          : {
              quoted: false,
              asset: b.asset,
              symbol: b.symbol,
              nominalUsd: b.valueUsd,
              realizableUsd: q.reason === 'no-route' ? 0 : undefined,
              fullExitImpact: q.reason === 'no-route' ? 1 : undefined,
              liquidityRatio: q.reason === 'no-route' ? 0 : undefined,
              error: QUOTE_REASONS[q.reason],
            },
      );
    }
    liquidity.sort((a, b) => (a.liquidityRatio ?? 1) - (b.liquidityRatio ?? 1));
  }

  return {
    chain: 'solana',
    label: 'Solana',
    address,
    haveHistory,
    txs,
    balances,
    approvals,
    liquidity,
    mev: [],
    warnings,
    cfg: SOLANA,
  };
}

function normalizeSolanaTx(tx, sig, owner) {
  const meta = tx.meta;
  const keys = (tx.transaction?.message?.accountKeys ?? []).map((k) =>
    typeof k === 'string' ? k : k.pubkey,
  );
  const idx = keys.indexOf(owner);
  const paidFee = keys[0] === owner;
  const transfers = [];

  if (idx >= 0 && meta) {
    const pre = BigInt(meta.preBalances?.[idx] ?? 0);
    const post = BigInt(meta.postBalances?.[idx] ?? 0);
    let delta = post - pre;
    if (paidFee) delta += BigInt(meta.fee ?? 0); // isolate the economic movement
    if (delta !== 0n) transfers.push({ asset: NATIVE, symbol: 'SOL', decimals: 9, amount: delta });
  }

  if (meta?.preTokenBalances && meta?.postTokenBalances) {
    const pre = new Map();
    const dec = new Map();
    for (const b of meta.preTokenBalances) {
      if (b.owner !== owner) continue;
      pre.set(`${b.accountIndex}:${b.mint}`, BigInt(b.uiTokenAmount.amount));
      dec.set(b.mint, b.uiTokenAmount.decimals);
    }
    const net = new Map();
    for (const b of meta.postTokenBalances) {
      if (b.owner !== owner) continue;
      const key = `${b.accountIndex}:${b.mint}`;
      const before = pre.get(key) ?? 0n;
      dec.set(b.mint, b.uiTokenAmount.decimals);
      net.set(b.mint, (net.get(b.mint) ?? 0n) + (BigInt(b.uiTokenAmount.amount) - before));
      pre.delete(key);
    }
    for (const [key, before] of pre) {
      const mint = key.split(':')[1];
      net.set(mint, (net.get(mint) ?? 0n) - before);
    }
    for (const [mint, amount] of net) {
      if (amount !== 0n) transfers.push({ asset: mint, decimals: dec.get(mint) ?? 0, amount });
    }
  }

  return {
    id: sig.signature,
    ts: new Date((sig.blockTime ?? 0) * 1000),
    block: sig.slot,
    outgoing: paidFee,
    fee: paidFee ? BigInt(meta?.fee ?? 0) : 0n,
    failed: sig.err !== null || meta?.err != null,
    transfers,
    label: undefined,
  };
}

export async function quoteJupiter(balance) {
  const url =
    `${env('JUPITER_QUOTE_URL', 'https://lite-api.jup.ag/swap/v1/quote')}` +
    `?inputMint=${balance.asset}&outputMint=${SOLANA.usdc}` +
    `&amount=${balance.amount.toString()}&slippageBps=50`;
  try {
    const res = await fetch(url, deadline());
    if (!res.ok) return { quoted: false, reason: 'refused' };
    const json = await res.json();
    if (!json.outAmount) return { quoted: false, reason: 'no-route' };
    const realizableUsd = Number(json.outAmount) / 1e6;
    return {
      quoted: true,
      asset: balance.asset,
      symbol: balance.symbol,
      nominalUsd: balance.valueUsd,
      realizableUsd,
      fullExitImpact: Number(json.priceImpactPct ?? 0),
      liquidityRatio: balance.valueUsd > 0 ? realizableUsd / balance.valueUsd : 0,
    };
  } catch {
    return { quoted: false, reason: 'refused' };
  }
}

/* ══════════════════════════════════════════════════════ shared analysis */


function summarize(result) {
  const txs = result.txs;
  const cfg = result.cfg;

  let totalNative = 0n;
  let totalUsd = 0;
  let priced = 0;
  let wasted = 0;
  for (const t of txs) {
    if (t.fee === 0n) continue;
    totalNative += t.fee;
    if (t.feeUsd !== undefined) {
      totalUsd += t.feeUsd;
      priced++;
      if (t.failed) wasted += t.feeUsd;
    }
  }

  const times = txs.map((t) => t.ts.getTime()).filter((t) => t > 0);
  const firstSeen = times.length ? new Date(Math.min(...times)) : undefined;
  const protocols = new Map();
  for (const t of txs) {
    if (!t.label) continue;
    const p = t.label.split(':')[0].trim();
    protocols.set(p, (protocols.get(p) ?? 0) + 1);
  }

  return {
    activity: {
      totalTxs: txs.length,
      failedTxs: txs.filter((t) => t.failed).length,
      firstSeen: firstSeen?.toISOString(),
      ageDays: firstSeen ? Math.floor((Date.now() - firstSeen.getTime()) / 86_400_000) : undefined,
      topProtocols: [...protocols.entries()]
        .map(([label, count]) => ({ label, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 6),
    },
    fees: {
      totalNative: totalNative.toString(),
      nativeSymbol: cfg.symbol,
      nativeFloat: Number(totalNative) / 10 ** cfg.decimals,
      totalUsdHistorical: priced ? totalUsd : undefined,
      wastedOnFailedUsd: wasted || undefined,
    },
  };
}


/* ═════════════════════════════════════════════════════════════════ output */




function renderText(report) {
  const L = [];
  const t = report.totals;
  L.push('');
  L.push('  WALLET FORENSICS');
  L.push('  ' + '─'.repeat(70));
  L.push(`  Portfolio (nominal)      ${usd(t.portfolioNominalUsd)}`);
  if (t.portfolioNominalUsd > 0 && t.portfolioRealizableUsd < t.portfolioNominalUsd * 0.99) {
    const pct = ((t.portfolioNominalUsd - t.portfolioRealizableUsd) / t.portfolioNominalUsd) * 100;
    L.push(`  Portfolio (realizable)   ${usd(t.portfolioRealizableUsd)}   ${pct.toFixed(1)}% evaporates on exit`);
  }
  L.push(`  Realized PnL             ${signed(t.realizedPnlUsd)}`);
  L.push(`  Unrealized PnL           ${signed(t.unrealizedPnlUsd)}`);
  L.push(`  Fees burned              ${usd(t.feesUsd)}`);
  if (t.mevExtractedUsd > 0) L.push(`  Lost to MEV              ${usd(t.mevExtractedUsd)}`);
  L.push('');

  if (report.topRegrets.length) {
    L.push('  WHAT COST YOU THE MOST');
    L.push('  ' + '─'.repeat(70));
    report.topRegrets.slice(0, 6).forEach((r, i) => {
      L.push(`  ${i + 1}. ${r.title}  ${r.costUsd > 0 ? usd(r.costUsd) : ''}`);
      L.push(`     ${r.detail}`);
    });
    L.push('');
  }

  if (report.cache && report.cache.hits > 0) {
    const saved = (report.cache.hits * 2.2).toFixed(0);
    L.push(`  cache: ${report.cache.hits} hits, ${report.cache.misses} misses (~${saved}s of requests skipped)`);
    L.push('');
  }

  for (const c of report.chains) {
    L.push(`  ${c.label.toUpperCase()} — ${c.address}`);
    if (c.activity.totalTxs) {
      L.push(`    ${c.activity.totalTxs} txs · ${c.activity.ageDays ?? '?'} days old · ${c.activity.failedTxs} failed`);
    }
    if (c.fees.nativeFloat > 0) {
      L.push(`    fees: ${c.fees.nativeFloat.toFixed(4)} ${c.fees.nativeSymbol}` +
        (c.fees.totalUsdHistorical ? ` (${usd(c.fees.totalUsdHistorical)})` : ''));
    }
    for (const w of c.warnings) L.push(wrap(`note: ${w}`, 4));
    L.push('');
  }
  return L.join('\n');
}

const signed = (n) => (!Number.isFinite(n) || n === 0 ? '$0' : n > 0 ? `+${usd(n)}` : `-${usd(Math.abs(n))}`);

/* ═════════════════════════════════════════════════════════════════════ CLI */

const USAGE = `
  wallet-forensics — forensic report for an EVM or Solana address

  Usage
    node scripts/forensics.mjs <address> [options]

  Options
    --chain <list>   ethereum,base,arbitrum,optimism,polygon,solana
    --all-evm        Analyze across every supported EVM chain
    --text           Human-readable summary instead of JSON
    --max <n>        Cap transactions fetched (default 2000)
    --since <date>   Only analyze activity from this date (YYYY-MM-DD)
    --no-cache       Ignore the on-disk cache of historical prices
    --no-liquidity   Skip exit-liquidity routing quotes
    --no-mev         Skip sandwich detection
    -h, --help       Show this message
`;

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) {
    process.stdout.write(USAGE);
    process.exit(argv.length ? 0 : 1);
  }

  const addresses = [];
  const chains = [];
  const opts = { max: 2000, skipLiquidity: false, skipMev: false, since: undefined, noCache: false };
  let text = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--chain') {
      for (const c of (argv[++i] ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
        if (c !== 'solana' && !EVM_CHAINS[c]) die(`unknown chain "${c}"`);
        if (!chains.includes(c)) chains.push(c);
      }
    } else if (a === '--all-evm') {
      for (const c of Object.keys(EVM_CHAINS)) if (!chains.includes(c)) chains.push(c);
    } else if (a === '--text') text = true;
    else if (a === '--max') opts.max = Math.max(1, Number(argv[++i]) || 2000);
    else if (a === '--since') {
      const d = new Date(argv[++i]);
      if (Number.isNaN(d.getTime())) die('--since needs a valid YYYY-MM-DD date');
      opts.since = d;
    } else if (a === '--no-cache') opts.noCache = true;
    else if (a === '--no-liquidity') opts.skipLiquidity = true;
    else if (a === '--no-mev') opts.skipMev = true;
    else if (a.startsWith('-')) die(`unknown option ${a}`);
    else addresses.push(a);
  }

  if (!addresses.length) die('no address provided');

  const prices = new Prices({ noCache: opts.noCache });
  const targets = [];
  for (const addr of addresses) {
    const isEvm = /^0x[0-9a-fA-F]{40}$/.test(addr);
    const isSol = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr);
    if (!isEvm && !isSol) die(`"${addr}" is not a recognizable EVM or Solana address`);

    const picked = chains.length ? chains.filter((c) => (c === 'solana') !== isEvm) : [isEvm ? 'ethereum' : 'solana'];
    if (!picked.length) die(`"${addr}" does not match any requested chain`);
    for (const c of picked) targets.push({ chain: c, address: addr });
  }

  const chainReports = [];
  for (const { chain, address } of targets) {
    const raw =
      chain === 'solana'
        ? await analyzeSolana(address, prices, opts)
        : await analyzeEvm(chain, address, prices, opts);

    // Cost basis needs one native price per distinct day.
    const days = new Map();
    for (const t of raw.txs) if (t.ts.getTime() > 0) days.set(t.ts.toISOString().slice(0, 10), t.ts);
    const nativeByDay = new Map();
    for (const [day, when] of days) {
      const p = await prices.onDay(raw.cfg.cgId, when);
      if (p !== undefined) nativeByDay.set(day, p);
    }

    const { positions, unvalued } = computePositions(
      { txs: raw.txs, balances: raw.balances, stables: raw.cfg.stables },
      nativeByDay,
    );
    const { activity, fees } = summarize(raw);

    const report = {
      chain: raw.chain,
      label: raw.label,
      address: raw.address,
      activity,
      fees,
      positions,
      balances: raw.balances,
      approvals: raw.approvals,
      liquidity: raw.liquidity,
      mev: {
        events: raw.mev,
        totalExtractedUsd: raw.mev.reduce((a, e) => a + (e.extractedUsd || 0), 0),
      },
      warnings: [...raw.warnings],
    };
    if (unvalued > 0) {
      report.warnings.push(
        `${unvalued} transfers could not be valued (no stablecoin or native leg to anchor against) ` +
          `and are excluded from PnL rather than estimated.`,
      );
    }
    report.regrets = collectRegrets(report);
    chainReports.push(report);
  }

  const sum = (fn) => chainReports.reduce((a, c) => a + (fn(c) || 0), 0);
  // Only positions with an actual quote contribute a realizable figure.
  const quoted = (c) =>
    new Map(
      c.liquidity
        .filter((l) => l.realizableUsd !== undefined)
        .map((l) => [l.asset, l.realizableUsd]),
    );

  const report = {
    generatedAt: new Date().toISOString(),
    chains: chainReports,
    totals: {
      realizedPnlUsd: sum((c) => c.positions.reduce((a, p) => a + p.realizedPnlUsd, 0)),
      unrealizedPnlUsd: sum((c) => c.positions.reduce((a, p) => a + p.unrealizedPnlUsd, 0)),
      feesUsd: sum((c) => c.fees.totalUsdHistorical ?? 0),
      mevExtractedUsd: sum((c) => c.mev.totalExtractedUsd),
      portfolioNominalUsd: sum((c) => c.balances.reduce((a, b) => a + (b.valueUsd ?? 0), 0)),
      portfolioRealizableUsd: sum((c) => {
        const q = quoted(c);
        // Where a quote could not be obtained, fall back to nominal rather than
        // booking the position at zero.
        return c.balances.reduce((a, b) => a + (q.get(b.asset) ?? b.valueUsd ?? 0), 0);
      }),
    },
    topRegrets: chainReports.flatMap((c) => c.regrets).sort((a, b) => b.costUsd - a.costUsd).slice(0, 10),
  };

  prices.cache.flush();

  const cacheStats = prices.cache.stats();
  if (!cacheStats.disabled && cacheStats.hits + cacheStats.misses > 0) {
    // Each hit is a request not made, and the unkeyed CoinGecko tier allows
    // roughly one every 2.2 seconds.
    report.cache = {
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      entries: cacheStats.size,
    };
  }

  process.stdout.write(
    text
      ? `${renderText(report)}\n`
      : `${JSON.stringify(report, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`,
  );
}

function die(msg) {
  process.stderr.write(`\nerror: ${msg}\n${USAGE}`);
  process.exit(1);
}

// Run the CLI only when this file is executed directly, so tests can import
// the pure functions above without the whole program firing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write(`\nunexpected error: ${e?.stack ?? e}\n`);
    process.exit(1);
  });
}
