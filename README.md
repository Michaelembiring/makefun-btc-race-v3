# Confirmed Dip — a cbBTC race bot

A bot for make.fun's 24h BTC races (cbBTC/USDC, 1-minute bars, long only,
1,000 USDC paper start). Third in a line: "Dip Snap-Back" (v1) graded
+10.25 USDC on its dev window and lost −16.40 live; "Deep Dip, Let It Run"
(v2) fixed the bleed (seven-window backtest +1.86 USDC) but graded −3.43
on this race's dev window and failed its gate. This design answers that
specific failure.

## Why v2 failed this gate

This race's dev window is a −2.79% day: a −2.1% crash in the first two
hours, a bounce and recovery leg mid-day, then a slow bleed into the
close. v2's 150-bar reference warms up too slowly and demands its dip
against a slow average, so the opening crash — the day's one real
dislocation — is out of reach; its single late trade exits at breakeven
on price and pays the round trip (−3.43). On the same window v1 grades
−20.14, buy-and-hold −31.63, momentum −23.87.

## Strategy

Buy only a deep dislocation that has stopped falling:

- **Reference:** 40-bar SMA of closes.
- **Entry:** close ≥ 1.15% under the SMA **and** not below the previous
  bar's close (the confirmation — catch the bounce, not the knife),
  all-in (weight cap). Blocked by a crash guard (SMA itself down > 1.5%
  over 120 bars), by a 30-bar cooldown after a stop-out, and by the
  brake below.
- **Exit:** hard stop at −1.00% under the fill's booked average cost.
  Once the close is +0.50% over cost, a trailing exit arms: sell when
  the close falls 0.40% under the highest close since entry, never
  below cost +0.10%. Time stop at 900 bars.
- **Brake:** realized PnL is booked exactly from cash deltas at each
  exit; at −150 bps cumulative (≈ one stop-out) entries stop for the
  window.

All decisions are cross-multiplied integer arithmetic on raw bar prices —
no floats, no clock, no randomness: two executions on the same bars are
byte-identical.

## Validation (kit fill model)

This race's dev window (official `grade-local`): see below — graded on
the real kit before any submission decision.

Replayed over the seven earlier windows (first race's dev + live, five
Binance days), this rule set sums to **+41.19 USDC with no losing
window** — on only **four round trips in total**, one of them (+35.0 on
the +1.8% bounce day) carrying most of the sum:

| window | regime | v3 |
|---|---|---:|
| dev (first kit) | chop, +0.5% | 0.00 (no trade) |
| race 2026-11-17/18 | grind down, −1.0% | +6.1 |
| 2026-11-11 | flat, +0.3% | 0.00 (no trade) |
| 2026-11-13 | slide, −4.3% | 0.00 (no trade) |
| 2026-11-14 | crash, −6.2% | 0.00 (1 scratch trade) |
| 2026-11-15 | bounce, +1.8% | +35.0 |
| 2026-11-16 | drift down, −0.7% | 0.00 (no trade) |
| this race's dev | crash-bounce-bleed, −2.79% | +4.77 (sim) |

Honest weaknesses: the sample is four round trips — thin. The parameter
surface around this point is jagged (neighbouring dip depths change
single trades, and totals swing with them). The bot is defensive to a
fault: in a race window with no deep confirmed dip it makes no trade at
all and ranks below every entry that trades. What it has shown so far
is capital preservation plus a real bounce trade when the dislocation
comes — not a proven, repeatable edge.

## Layout

- `main.ts` — the bot (entry point the harness runs).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
- `LICENSE` — MIT.
