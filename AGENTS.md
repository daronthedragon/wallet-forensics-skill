# Wallet forensics — agent instructions

Vendor-neutral instructions for any coding agent. `SKILL.md` is the same
content in Claude's skill format; this file is for everything else.

Three ways to use this, in order of how little the agent needs to know:

| Integration | Best for |
| --- | --- |
| **MCP server** (`mcp/server.mjs`) | Cursor, Windsurf, Zed, Continue, VS Code, or any MCP client |
| **CLI** (`scripts/forensics.mjs`) | Any agent that can run a shell command |
| **Skill file** (`SKILL.md`) | Claude Code and Claude Desktop |

All three run the same analyzer. Node 20+, no dependencies, no install step.

## What it does

Analyzes an Ethereum, Base, Arbitrum, Optimism, Polygon or Solana address and
reports realized and unrealized PnL, lifetime fees, MEV sandwich attacks
committed against the wallet, risky token approvals, and **exit liquidity** —
what a position would actually sell for versus what a portfolio tracker claims.

That last one is usually the most valuable thing in the report. Every tracker
computes `balance × spot price`; for anything outside the top few hundred
tokens that number is fiction, because spot price comes from the last trade,
which may have been $40 against a pool holding $3,000. This route-quotes the
real sale and reports the gap.

## When to invoke it

- "Analyze this wallet: 0x…" / "What's in this address?"
- "How much have I spent on gas?"
- "Have I been sandwiched?" / "How much have I lost to MEV?"
- "Are any of my approvals dangerous?" / "What should I revoke?"
- "Can I actually sell this token?" / "Is this position liquid?"
- A bare address pasted with any question about it

## Running it

```bash
node scripts/forensics.mjs <address> [options]
```

| Option | Effect |
| --- | --- |
| `--chain <list>` | `ethereum,base,arbitrum,optimism,polygon,solana` |
| `--all-evm` | Every supported EVM chain |
| `--text` | Human-readable summary instead of JSON |
| `--max <n>` | Cap transactions fetched (default 2000) |
| `--since <date>` | Only activity from this date |
| `--no-cache` | Ignore the on-disk price cache |
| `--no-mev` | Skip sandwich detection (much faster; it reads full blocks) |
| `--no-liquidity` | Skip exit-liquidity routing quotes |

JSON on stdout by default. Read it and explain it in prose — do not paste raw
JSON at the user.

### Environment

Everything has a working default and no key is required.

- `ETHERSCAN_API_KEY` — optional. Without it, EVM history comes from
  Blockscout. With it, Etherscan is more complete and more reliable; one key
  covers every EVM chain.
- `SOLANA_RPC_URL` — the public endpoint is heavily rate limited and will fail
  on active wallets. A dedicated provider fixes this.
- `COINGECKO_API_KEY` — optional, raises pricing rate limits.

## Reading the output

```
{
  "chains": [{ "chain", "activity", "fees", "positions", "approvals",
               "mev", "liquidity", "regrets", "warnings" }],
  "totals": { "realizedPnlUsd", "unrealizedPnlUsd", "feesUsd",
              "mevExtractedUsd", "portfolioNominalUsd", "portfolioRealizableUsd" },
  "topRegrets": [{ "kind", "title", "detail", "costUsd" }]
}
```

**Read `warnings` first.** They say which numbers are trustworthy. A run can
succeed partially — history truncated by `--max`, token balances lost to a rate
limit, an approval scan degraded by an RPC that refuses unbounded log queries.
Each makes some headline figure a floor rather than a total.

**Lead with `topRegrets`.** Already ranked by dollar cost across every
category, and it is what the user actually wants to know.

**The headline number** is `portfolioNominalUsd` versus
`portfolioRealizableUsd`. If they diverge by more than a few percent, that gap
is the story.

**Approvals** are ranked by what could be taken *right now* — the smaller of
the allowance and the current balance. An unlimited approval on an empty wallet
is not urgent; the same approval on a main position is.

**MEV events** carry a `confidence` of `high` / `medium` / `low`. Report it.
Sandwich detection is EVM-only and reads full blocks, which public RPCs often
refuse — if `warnings` says blocks could not be read, an empty MEV list means
*not checked*, not *not sandwiched*.

## Interpreting responsibly

- **Cost basis is inferred, not authoritative.** Value comes from each trade's
  stablecoin or native leg; trades with neither are counted in `warnings` and
  excluded. Never present these as tax-ready.
- **Exit liquidity is a point-in-time quote** that ignores centralised exchange
  depth entirely. A token can be perfectly sellable on Binance and look dead
  on-chain.
- **Absence of evidence is not evidence of absence.** Do not tell someone their
  approvals are clean when the scan was partial.
- **No financial advice.** "This position has 85% price impact to exit" is a
  fact. "You should sell" is not yours to say.
- **Revoking is the user's action.** Explain which approvals are risky and
  point at a revocation tool. Never construct or send a transaction.

## Privacy

An address is pseudonymous but not anonymous. Analyze the address you were
given. Do not go looking for other addresses belonging to the same person, and
do not cross-reference an address against identity sources.

## Deeper detail

Load only when a specific question calls for it:

- `references/methodology.md` — how each number is produced and where it breaks
- `references/interpreting-results.md` — worked examples and common misreadings
