# wallet-forensics skill

An agent skill for forensic analysis of blockchain wallets. Give an agent an address, get back what it actually holds, what it lost, and what still puts it at risk.

Works on **Ethereum, Base, Arbitrum, Optimism, Polygon, and Solana**. Zero dependencies — Node 20+ and nothing else.

## What it reports

| | |
|---|---|
| **Exit liquidity** | What a position would *actually* sell for, route-quoted through Uniswap V3 and Jupiter — versus what a portfolio tracker claims |
| **Realized & unrealized PnL** | Weighted-average cost basis reconstructed from history |
| **Approval risk** | Outstanding allowances on EVM, token-account delegates on Solana, scored by what could be taken right now |
| **MEV extraction** | Sandwich attacks against the wallet's swaps, with confidence levels |
| **Fee archaeology** | Lifetime fees, what they cost then, what that currency is worth now, and how much went to reverted transactions |
| **Ranked regrets** | Everything above, sorted by dollar cost |

## The point

Every portfolio tracker computes `balance × spot price` and calls it your net worth. For anything outside the top few hundred tokens that number is fiction — spot price comes from the last trade, which may have been $40 against a pool holding $3,000.

This skill route-quotes the real sale and reports the gap:

```
Portfolio (nominal)      $84,210
Portfolio (realizable)   $31,447    62.7% evaporates on exit
```

## Install

Drop the folder into your agent's skills directory:

```bash
git clone https://github.com/daronthedragon/wallet-forensics-skill ~/.claude/skills/wallet-forensics
```

The agent picks it up from `SKILL.md`. No build, no `npm install`.

## Use it directly

The script works fine as a standalone CLI:

```bash
node scripts/forensics.mjs 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --text
```

```bash
node scripts/forensics.mjs 0xd8dA... --all-evm --json > report.json
```

| Flag | Effect |
|---|---|
| `--chain <list>` | `ethereum,base,arbitrum,optimism,polygon,solana` |
| `--all-evm` | Every supported EVM chain |
| `--text` | Human-readable summary instead of JSON |
| `--max <n>` | Cap transactions fetched (default 2000) |
| `--since <date>` | Only activity from this date |
| `--no-liquidity` | Skip routing quotes |
| `--no-mev` | Skip sandwich detection |

## Configuration

Everything has a working public default. Two variables meaningfully improve results:

| Variable | Needed for | Notes |
|---|---|---|
| `ETHERSCAN_API_KEY` | EVM history → PnL, fees, MEV | One key covers every EVM chain (V2 API is unified). Free tier is enough. Without it, only balances and approvals are reported. |
| `SOLANA_RPC_URL` | Anything Solana | The public endpoint is heavily rate limited and will 429 on active wallets. Helius/Triton/QuickNode recommended. |
| `COINGECKO_API_KEY` | Faster pricing | Optional. |

## Layout

```
SKILL.md                              trigger description + agent instructions
scripts/forensics.mjs                 the analyzer — zero dependencies
references/methodology.md             how each number is produced, and where it breaks
references/interpreting-results.md    turning a report into a useful explanation
```

`SKILL.md` stays short on purpose. The references load only when a question actually calls for them.

## Design notes

**Zero dependencies** is the constraint that makes this usable as a skill rather than a project. Everything goes over Node's built-in `fetch`.

The one cost is ABI encoding. Function selectors are Keccak-256 hashes, and Node's `crypto` ships NIST SHA-3 — a different algorithm producing different output. Selectors are therefore hardcoded alongside their signatures. They are permanent constants of the ERC-20 and Uniswap interfaces, so this is safe.

**Every stage degrades independently.** If approval scanning fails because the RPC rejects unbounded log queries, you still get PnL, fees, and liquidity — plus a warning saying exactly what is missing and why. Nothing is silently dropped, and the skill instructs the agent never to present a degraded scan as a clean bill of health.

## Limitations

Stated plainly, because a forensics tool that oversells itself is worse than none:

- **Cost basis is inferred, not authoritative.** Trades with no stablecoin or native leg are excluded from PnL rather than guessed at. Not tax-ready.
- **Exit liquidity checks Uniswap V3 and Jupiter only.** A token with liquidity elsewhere reads as illiquid. "No route found" means *this tool found no route*.
- **MEV detection finds sandwiches**, not JIT liquidity, backrun-only extraction, or cross-domain MEV.
- **Solana MEV value is not attributed** — detection is structural; profit attribution needs per-DEX pool modelling.
- **CEX depth is invisible.** A token can be perfectly sellable on Binance and look dead on-chain.

## Related

The full TypeScript implementation, with a test suite and HTML report output, lives at [wallet-forensics](https://github.com/daronthedragon/wallet-forensics). This repo is the agent-facing skill: same methodology, no dependencies, packaged for an agent to invoke.

## License

MIT
