// Confirmed dip: a selective capitulation buyer for cbBTC/USDC on 1-minute
// bars, third in the line after "Dip Snap-Back" (v1: dev +10.25 USDC, live
// -16.40) and "Deep Dip, Let It Run" (v2: seven-window backtest +1.86 USDC,
// but -3.43 on THIS race's dev window, which fails the dev gate).
//
// This race's dev window is a -2.79% day: a -2.1% crash in the first two
// hours, a bounce and a recovery leg mid-day, then a slow bleed into the
// close. What the replays showed about that shape:
//   - v2's 150-bar reference cannot act early: its warm-up plus the depth
//     of dip it demands (1.00% under a slow average) leave the opening
//     crash - the day's one real dislocation - outside its reach, and its
//     single late trade exits at breakeven on price and pays the round
//     trip: -3.43, gate failed. v1 does worse (-20.14); buy-and-hold
//     grades -31.63 and momentum -23.87 on the same window.
//   - A fast reference (40-bar SMA) with a deep required dip (1.15%) and
//     one extra condition - the entry bar must not itself be a down close
//     (wait for the first close that stops falling) - catches the
//     confirmed bounce instead of the falling knife.
//   - The same rule set replayed over the seven earlier windows (the
//     first race's dev and live windows plus five Binance days) sums to
//     +41.19 USDC with no losing window - but on only four round trips in
//     total, one of them (+35.0 on the bounce day) carrying most of the
//     sum. The sample is thin and the parameter surface around this point
//     is jagged; treat the numbers as "defensive and so far unbloodied",
//     not as proven edge.
//
// The rules (all comparisons are cross-multiplied integer arithmetic on
// the bars' raw prices - no floats in the decision path):
//   - Reference: SMA of the last 40 closes.
//   - Entry: close at least 1.15% under the SMA AND not below the previous
//     bar's close (the confirmation), with all the cash the weight cap
//     allows. Blocked while the SMA itself has fallen more than 1.5% over
//     the last 120 bars (crash guard), during the 30-bar cooldown after a
//     stop-out, and once the brake (below) has tripped.
//   - Exit, the whole position, first reason that fires:
//       stop:  close 1.00% under the position's average cost (the fill's
//              booked cost, fees included, read back from the account);
//       trail: once the close is at least 0.50% over cost, the exit arms
//              and fires when the close falls 0.40% under the highest close
//              since entry, never below cost + 0.10%;
//       time:  900 bars held.
//   - Brake: realized PnL is booked exactly from cash deltas at each exit
//     (proceeds vs notional, all fees and impact inside). When cumulative
//     realized PnL reaches -150 bps of traded notional (about one
//     stop-out), no new entries are taken for the rest of the window.
//
// It trades rarely by design - in a window with no deep, confirmed dip it
// never trades at all, which also means it can finish a race window
// tradeless. That is the honest price of the selectivity.
//
// vendor/makefun-bars.ts is a byte-identical copy of the kit's SDK shim.

import { runBars, type OrderInput } from './vendor/makefun-bars.ts';

const SMA_BARS = 40;
/** Buy a deep dip: close at least this far under the SMA. */
const DIP_BPS = 115n;
/** Hard stop under the position's average cost. */
const STOP_BPS = 100n;
/** Gain over cost that arms the trailing exit. */
const ARM_BPS = 50n;
/** Trailing exit distance under the peak close since entry. */
const TRAIL_BPS = 40n;
/** The trailing exit never fires below cost + this. */
const FLOOR_BPS = 10n;
/** Time stop: give a position back after this many of the symbol's bars. */
const MAX_HOLD_BARS = 900;
/** Bars to sit out after a stop-out. */
const COOLDOWN_BARS = 30;
/** Crash guard: SMA lookback and the fall over it that blocks entries. */
const CRASH_LOOKBACK = 120;
const CRASH_BPS = 150n;
/** Brake: halt entries once realized PnL reaches this (negative bps). */
const BRAKE_BPS = -150n;
/** Orders refuse a fill further than this from the close they were decided on. */
const MAX_SLIPPAGE_BPS = 150;

interface Sym {
  closes: bigint[];
  sum: bigint;
  sums: (bigint | null)[];
  bars: number;
  /** The live position's average cost price (stop/arm reference). */
  entryRef: bigint | null;
  /** The close a just-sent buy was decided on, until its fill shows up. */
  candidate: bigint | null;
  /** Highest close since entry (trailing exit reference). */
  peak: bigint | null;
  /** The trailing exit has armed (close reached cost + ARM_BPS once). */
  trailArmed: boolean;
  barsHeld: number;
  stopExitPending: boolean;
  cooldownUntil: number;
  /** Cash just before the live entry's buy filled, and just after. */
  cashBeforeBuy: bigint | null;
  cashAfterBuy: bigint | null;
  /** Cumulative realized PnL in bps of notional, booked at each exit. */
  realizedBps: bigint;
  /** Entries are halted for the rest of the window once the brake trips. */
  braked: boolean;
}

const syms = new Map<string, Sym>();

function sym(symbol: string): Sym {
  let s = syms.get(symbol);
  if (s === undefined) {
    s = {
      closes: [],
      sum: 0n,
      sums: [],
      bars: 0,
      entryRef: null,
      candidate: null,
      peak: null,
      trailArmed: false,
      barsHeld: 0,
      stopExitPending: false,
      cooldownUntil: 0,
      cashBeforeBuy: null,
      cashAfterBuy: null,
      realizedBps: 0n,
      braked: false,
    };
    syms.set(symbol, s);
  }
  return s;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      const s = sym(bar.symbol);
      const c = BigInt(bar.c);
      s.closes.push(c);
      s.sum += c;
      if (s.closes.length > SMA_BARS) s.sum -= s.closes.shift()!;
      s.sums.push(s.closes.length === SMA_BARS ? s.sum : null);
      s.bars += 1;
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];

    const orders: OrderInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = sym(symbol);
      const held = state.positions.get(symbol);
      const close = state.close(symbol);
      if (close === null) continue;

      // Bookkeeping: fills of orders sent on earlier batches.
      if (held !== undefined) {
        if (s.entryRef === null && s.candidate !== null) {
          const info = state.symbols.get(symbol);
          s.entryRef =
            info !== undefined && held.qty > 0n
              ? (held.cost * 10n ** BigInt(info.qty_scale + info.price_scale)) /
                (held.qty * 10n ** BigInt(state.hello.capital.quote_scale))
              : s.candidate;
          s.peak = close;
          s.trailArmed = false;
          s.barsHeld = 0;
          // The buy filled between the batch we sent it on and this one:
          // cash dropped by the notional spent.
          if (s.cashBeforeBuy !== null) s.cashAfterBuy = state.cash;
        }
        s.candidate = null;
        if (s.peak === null || close > s.peak) s.peak = close;
        s.barsHeld += 1;
      } else {
        if (s.entryRef !== null) {
          // The position is gone (an exit filled, or the window flattened
          // it). Book realized PnL from the cash delta, exactly.
          if (s.cashBeforeBuy !== null && s.cashAfterBuy !== null) {
            const notional = s.cashBeforeBuy - s.cashAfterBuy;
            if (notional > 0n) {
              const proceeds = state.cash - s.cashAfterBuy;
              s.realizedBps += ((proceeds - notional) * 10_000n) / notional;
              if (s.realizedBps <= BRAKE_BPS) s.braked = true;
            }
          }
          if (s.stopExitPending) s.cooldownUntil = s.bars + COOLDOWN_BARS;
          s.entryRef = null;
          s.peak = null;
          s.trailArmed = false;
          s.barsHeld = 0;
          s.cashBeforeBuy = null;
          s.cashAfterBuy = null;
        }
        s.stopExitPending = false;
        s.candidate = null;
      }

      if (s.closes.length < SMA_BARS) continue;
      const n = BigInt(SMA_BARS);

      if (held !== undefined && s.entryRef !== null && s.peak !== null) {
        // Arm the trailing exit once the snap-back is in hand.
        if (!s.trailArmed && close * 10_000n >= s.entryRef * (10_000n + ARM_BPS)) {
          s.trailArmed = true;
        }
        if (s.trailArmed) {
          // Exit when the close falls TRAIL_BPS under the peak, with the
          // floor at cost + FLOOR_BPS: fire when close <= max(floor, trail).
          const floor = (s.entryRef * (10_000n + FLOOR_BPS)) / 10_000n;
          const trail = (s.peak * (10_000n - TRAIL_BPS)) / 10_000n;
          const line = floor > trail ? floor : trail;
          if (close <= line || s.barsHeld >= MAX_HOLD_BARS) {
            orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
          continue;
        }
        if (close * 10_000n <= s.entryRef * (10_000n - STOP_BPS)) {
          s.stopExitPending = true;
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        } else if (s.barsHeld >= MAX_HOLD_BARS) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }

      if (held === undefined) {
        if (s.braked) continue;
        if (s.bars < s.cooldownUntil) continue;
        // Crash guard: the average itself is falling hard - no dip-buying.
        const past = s.sums[s.bars - 1 - CRASH_LOOKBACK];
        if (past !== null && past !== undefined && s.sum * 10_000n < past * (10_000n - CRASH_BPS)) continue;
        // The deep dip, confirmed: close at least DIP_BPS under the SMA,
        // and not below the previous bar's close - the fall must have
        // paused before we buy, so we catch the bounce, not the knife.
        const prevClose = s.closes[s.closes.length - 2];
        if (
          close * n * 10_000n <= s.sum * (10_000n - DIP_BPS) &&
          prevClose !== undefined &&
          close >= prevClose
        ) {
          const room = state.weightRoom(symbol);
          const notional = state.cash < room ? state.cash : room;
          if (notional > 0n && notional >= BigInt(state.hello.fees.min_notional_quote_units)) {
            s.candidate = close;
            s.cashBeforeBuy = state.cash;
            orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
          }
        }
      }
    }
    return orders;
  },
});
