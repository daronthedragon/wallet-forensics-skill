# Methodology

How each number is produced, and where it breaks. Read this before defending a figure to a user.

## Cost basis inference

**The problem.** On-chain PnL is easy to compute and hard to value. The accounting is simple weighted-average cost; the difficulty is knowing what anything was worth at the moment it moved. Fetching a historical price for every token on every day is thousands of API calls, and most long-tail tokens have no price history at all — they were never listed anywhere that records one.

**The approach.** Value is inferred from the transaction itself. A swap has two sides. If either side is a stablecoin or the chain's native asset, that side reveals the dollar value of the whole trade, and it is attributed to the other side.

```
-1,000 USDC  →  +100 WIF        basis for 100 WIF is $1,000
-50 WIF      →  +200 USDC       proceeds $200 against $500 of released basis = -$300 realized
```

This needs **one price lookup per day** rather than one per token per day, and it covers the overwhelming majority of real trades, because almost everything is ultimately bought with dollars or the native asset.

**Where it fails.**

- A token-for-token swap with no stable and no native leg cannot be valued. These are counted and surfaced in `warnings`, never estimated.
- Airdrops arrive with no counter-leg, so they get a zero cost basis. Selling one shows the full proceeds as gain, which is correct for PnL but wrong for tax.
- Transfers between the user's own wallets look like a disposal on one side and an unexplained acquisition on the other.
- Bridged assets appear from nowhere. Same problem.
- Multi-hop routes split the anchor value evenly across legs, which is an approximation.

**Never present these numbers as tax-ready.** Say "inferred" when it matters.

## Exit liquidity

**The problem.** Every portfolio tracker computes `balance × spot price`. Spot price is the last trade. For an illiquid token the last trade may have been $40 against a pool holding $3,000, so the number is fiction at any meaningful size.

**The approach.** Simulate the actual sale.

- **EVM** — `quoteExactInputSingle` against Uniswap V3's QuoterV2, probing the 0.05% / 0.3% / 1% fee tiers and keeping the best execution. This is a real routing simulation via `eth_call`, not a formula.
- **Solana** — Jupiter's quote API, which routes across every DEX it knows.

Price impact is `1 - (proceeds / nominal)`. A `liquidityRatio` below ~0.9 means the tracker is lying.

**Where it fails.**

- Uniswap V3 only. A token whose liquidity lives on Curve, Balancer, a V2 pair, or an L2-native DEX will read as illiquid when it is not. Treat "no route found" as *this tool found no route*, not *this token is worthless*.
- Ignores CEX depth entirely. A token can be perfectly sellable on Binance and look dead on-chain.
- It is a point-in-time quote. It moves with the market and will not reproduce tomorrow.
- Quotes ignore gas, which matters for small positions on mainnet.

## Sandwich detection

**The structural signature.** A sandwich is narrow enough to detect reliably: the same address appears immediately before *and* after the victim in the same block, and all three transactions touch a common pool. The shared-pool check is what separates a real sandwich from two unrelated transactions that happen to sit nearby.

**Valuing it.** The attacker enters a position in the front-run and exits it in the back-run, so their net gain in wrapped-native or a stablecoin across the pair is what they extracted. This avoids modelling pool math entirely — it just reads their token flow.

When flow cannot be measured, the event is reported with the value left blank rather than estimated.

**Confidence, reported on every event.**

| Level | Meaning |
| --- | --- |
| `high` | Directly adjacent both sides, shared pool, measurable profit or a known MEV actor |
| `medium` | Directly adjacent both sides and shared pool, profit not measurable |
| `low` | Same-block bracketing but not directly adjacent |

**Where it fails.**

- Only finds sandwiches. JIT liquidity, backrun-only extraction, and cross-domain MEV are invisible.
- Block reads are expensive, so only the most recent swap blocks are inspected. Older sandwiches are missed, and the report says so.
- On Solana, detection is structural only — attributing profit requires modelling each DEX's pool state, so the dollar value is not reported.

## Approval risk

**What is scored.** Not the allowance in isolation — what could be taken *right now*, which is the smaller of the allowance and the current balance. An unlimited approval on an empty wallet risks nothing today. The same approval on a main position is critical. Both are worth mentioning, for different reasons.

**Two scan paths, and why it matters.**

1. **Log scan** (preferred) — `eth_getLogs` for `Approval` events with the owner as topic 1, from genesis. Catches approvals granted indirectly through routers and batchers.
2. **History fallback** — decodes `approve()` and `increaseAllowance()` calldata straight from the fetched transaction history. Costs no extra requests, but only catches approvals the user made directly.

Most public RPCs reject an unbounded `eth_getLogs`, which forces the fallback. The report flags this in `warnings`. **A degraded scan finding nothing is not a clean bill of health** — say so.

**Solana** has no ERC-20-style allowance. The equivalent standing risk is a token account **delegate**: an address permitted to move tokens out of that specific account, persisting until explicitly revoked. Most users have no idea these exist.

## Fees

Two figures, answering different questions:

- `totalUsdHistorical` — what it cost at the prices actually paid
- native float × current price — what that currency would be worth today

The gap is usually the more interesting number. Someone who burned 4 ETH on gas in 2021 spent roughly $12k at the time and gave up an asset worth something quite different now.

Fees on reverted transactions are tracked separately. The network charges for the attempt either way.

## Data sources

| Source | Used for | Notes |
| --- | --- | --- |
| Etherscan V2 | EVM transaction and token-transfer history | One key, all chains, selected by `chainid` |
| JSON-RPC | Balances, allowances, logs, quoter calls | Batched; public endpoints impose limits |
| CoinGecko | Spot and historical pricing | Day-resolution cache; free tier is rate limited |
| Jupiter | Solana routing quotes | No key required |

## Why zero dependencies

The script runs wherever Node 20+ exists, with no install step — which is what makes it usable as a skill rather than a project.

The one cost is ABI encoding. Function selectors are Keccak-256 hashes, and Node's `crypto` ships NIST SHA-3, which produces different output. Selectors therefore cannot be computed at runtime and are hardcoded with their signatures written alongside. This is safe: they are permanent constants of the ERC-20 and Uniswap interfaces and cannot change.
