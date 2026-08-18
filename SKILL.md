---
name: wallet-forensics
description: Forensic analysis of any Ethereum, Base, Arbitrum, Optimism, Polygon, or Solana wallet address. Reports realized and unrealized PnL, lifetime gas/fee costs, MEV sandwich attacks committed against the wallet, risky token approvals and delegates, and exit liquidity — how much a position would actually sell for versus what a portfolio tracker claims it is worth. Use when the user asks to analyze, audit, review, or investigate a wallet or address; asks what a wallet holds or is worth; asks how much they lost to gas, MEV, sandwiches, or bad trades; asks whether their approvals are safe or whether they should revoke; asks whether a token position can actually be sold or is illiquid; or pastes a raw 0x or base58 address and wants to know about it.
---

# Wallet forensics

Analyze a blockchain address and report what it actually holds, what it lost, and what still puts it at risk.

## When to use this

Trigger on requests like:

- "Analyze this wallet: 0x…" / "What's in this address?"
- "How much have I spent on gas?"
- "Have I been sandwiched?" / "How much have I lost to MEV?"
- "Are any of my approvals dangerous?" / "What should I revoke?"
- "Can I actually sell this token?" / "Is this position liquid?"
- "What's my PnL on this wallet?"
- A bare address pasted with any question about it

## The core insight

Every portfolio tracker computes `balance × spot price` and calls it your net worth. For anything outside the top few hundred tokens that number is **fiction**. Spot price comes from the last trade, which may have been $40 against a pool holding $3,000. Selling a "$50,000" position into that pool does not yield $50,000.

This skill route-quotes the real sale and reports the gap. That gap is usually the most valuable thing in the report — lead with it.

## Running it

```bash
node scripts/forensics.mjs <address> [options]
```

Requires **Node 20+**. No dependencies, no install step.

| Option | Effect |
| --- | --- |
| `--chain <list>` | Comma-separated: `ethereum,base,arbitrum,optimism,polygon,solana`. Defaults to `ethereum` for `0x…`, `solana` for base58 |
| `--all-evm` | Analyze across every supported EVM chain |
| `--text` | Human-readable summary instead of JSON |
| `--max <n>` | Cap transactions fetched (default 2000) |
| `--no-mev` | Skip sandwich detection — much faster |
| `--no-liquidity` | Skip exit-liquidity routing quotes |

Output is JSON on stdout by default. Read it and explain it in prose; do not dump raw JSON at the user.

### Environment

Everything has a working public default. Two optional variables meaningfully improve results:

- `ETHERSCAN_API_KEY` — **required for EVM transaction history**, which means PnL, fee totals, and MEV detection. One key covers all EVM chains (their V2 API is unified). Free tier is sufficient. Without it, only balances and approvals are reported.
- `SOLANA_RPC_URL` — the public endpoint is heavily rate limited and will be slow or fail on active wallets. A Helius/Triton/QuickNode URL fixes this.
- `COINGECKO_API_KEY` — optional, raises pricing rate limits.

If a run comes back with warnings about missing keys, say so plainly rather than presenting a partial report as complete.

## Reading the output

The JSON has this shape:

```
{
  "chains": [{ "chain", "activity", "fees", "positions", "approvals", "mev", "liquidity", "regrets", "warnings" }],
  "totals": { "realizedPnlUsd", "unrealizedPnlUsd", "feesUsd", "mevExtractedUsd",
              "portfolioNominalUsd", "portfolioRealizableUsd" },
  "topRegrets": [{ "kind", "title", "detail", "costUsd" }]
}
```

**Lead with `topRegrets`.** It is already ranked by dollar cost across every category, and it is what the user actually wants to know.

**The headline number** is `portfolioNominalUsd` vs `portfolioRealizableUsd`. If they diverge by more than a few percent, that gap is the story: *"Your tracker says $84,000. You could actually get about $31,000 out."*

**Approvals** are ranked `critical` / `high` / `medium` / `low` by what could be taken **right now** — the smaller of the allowance and the current balance. An unlimited approval on an empty wallet is not urgent; the same approval on their main bag is.

**MEV events** carry a `confidence` field of `high` / `medium` / `low`. Report it. A `low`-confidence sandwich is a maybe, not a fact.

## Interpreting responsibly

- **Cost basis is inferred, not authoritative.** Value is derived from each trade's stablecoin or native leg. Trades with neither are counted in `warnings` and excluded from PnL. Never present these numbers as tax-ready.
- **Exit liquidity is a point-in-time quote.** It moves with the market and ignores CEX depth entirely. A token may be perfectly sellable on Binance while looking illiquid on-chain.
- **Absence of evidence is not evidence of absence.** If approval scanning was degraded (public RPCs reject unbounded log queries), the report says so in `warnings`. Do not tell someone their approvals are clean when the scan was partial.
- **Do not give financial advice.** Report what the data shows. "This position has 85% price impact to exit" is a fact. "You should sell" is not yours to say.
- **Revoking is the user's action.** You can explain which approvals are risky and link to revoke.cash or the relevant explorer. Never construct or send a transaction.

## Privacy

An address is pseudonymous but not anonymous. Analyze the address the user gives you. Do not go looking for other addresses belonging to the same person, and do not cross-reference an address against identity sources.

## Deeper detail

Load these only when the specific question calls for it:

- `references/methodology.md` — how cost basis inference, sandwich detection, and exit-liquidity simulation actually work, and where each breaks down
- `references/interpreting-results.md` — worked examples of turning a report into a useful explanation, with common misreadings to avoid
