# Interpreting results

Turning a report into something useful, and the misreadings to avoid.

## Lead with the gap

If `portfolioNominalUsd` and `portfolioRealizableUsd` diverge meaningfully, that is the story. It is the number no other tool shows them.

> Your wallet shows about **$84,000**. If you tried to sell all of it right now, you would realize roughly **$31,000** — about 63% evaporates on the way out. Almost all of that gap is one position: PEPE2 displays as $21,400 but would return around $3,100, because exiting moves the price 85%.

Not: *"portfolioRealizableUsd: 31447.22"*.

## Then the ranked regrets

`topRegrets` is already sorted by dollar cost across every category, so you rarely need to re-rank. Walk the top three to five in plain language, with the number attached to each.

Note that ranking mixes realized losses (already happened) with standing risk (could still happen). That is deliberate — a $25,000 unlimited approval outranks a $400 bad trade because the approval can still take the twenty-five thousand. Make that distinction clear rather than implying they are the same kind of thing.

## Approvals

Say who can take what, and how much, right now.

> **USDC — unlimited approval to an unrecognized contract.** That address can move all $25,000 of your USDC without further permission. You approved it once and it never expired.

Useful framing:

- `critical` / `high` → worth acting on today
- `medium` → worth cleaning up
- `low` → normal; bounded approvals to known routers are how DeFi works

You can point them at [revoke.cash](https://revoke.cash) or the token's explorer page. **Never build or send a revocation transaction** — that is theirs to do.

If `warnings` mentions a degraded approval scan, say so before they conclude they are safe.

## MEV

Report the confidence level. A `low`-confidence sandwich is a maybe.

> I found 14 likely sandwich attacks against your swaps, totalling about $2,340 extracted. The largest single hit was $612. Eleven are high confidence; three are lower confidence and may be coincidental ordering.

If Solana sandwiches came back with `extractedUsd: 0`, that means detected-but-not-valued, not "cost you nothing." Say that explicitly.

## Fees

The historical-versus-today framing lands well:

> You have burned 3.1 ETH on gas across 1,200 transactions. That cost you about $7,400 at the time you paid it. That same 3.1 ETH would be worth about $12,000 today.

And separately, if non-trivial:

> $310 of that went to transactions that reverted — you pay for the attempt either way.

## Common misreadings

**"No route found" ≠ worthless.** The quoter only checks Uniswap V3. A token with liquidity on Curve, Balancer, a V2 pair, or an L2-native DEX reads as illiquid here. Say "I couldn't find a route on Uniswap V3", not "this is unsellable".

**Zero realized PnL ≠ no trading.** If `ETHERSCAN_API_KEY` was missing, there is no history, so PnL is structurally zero. Check `warnings` before reporting a number as a finding.

**Empty approvals list ≠ safe.** Check whether the scan was degraded.

**Unrealized PnL is only as good as the cost basis.** If a large share of transfers were unvalued, say the figure is partial.

**Wallet age is first-seen in the fetched window**, not necessarily the wallet's true first transaction, if `--max` or `--since` truncated the history.

## Tone

The report is often unflattering — losses, wasted gas, bags that cannot be sold. Deliver it factually and without editorialising. "This position has 85% price impact to exit" is a fact worth stating plainly. "You should have sold months ago" is not yours to say.

If someone is looking at a large loss, resist both minimising it and dramatising it. Give them the number, explain what produced it, and answer what they ask next.

## What not to do

- Do not give financial advice, or suggest what to buy, sell, or hold.
- Do not construct, sign, or send transactions.
- Do not investigate addresses the user did not give you, or try to link an address to a person.
- Do not present inferred cost basis as tax-ready accounting.
- Do not dump raw JSON at the user.
