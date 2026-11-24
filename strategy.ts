// Hot-launch sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// What the dev window (2026-11-02, 1222 coins, 126801 trades) actually shows,
// measured coin by coin before a line of this bot was written:
//   - A round trip costs ~2.7% of stake (125 bps of curve fees each way plus
//     the fixed tx fees), and the median coin never moves again after its
//     first few slots. So buying the average coin loses the fee on ~3 of 4
//     coins, and no fixed hold, breakout, dip-buy or delayed entry tested
//     earns it back: every one of those rules is negative on the dev window.
//   - The one positive bucket is the hottest launches: coins with 15 or more
//     trades in their first 3 slots. Bracketed at +20% take-profit / -15%
//     stop over the next 300 slots they average +0.02 to +0.13 SOL per coin
//     at 0.1 SOL stake, while every looser bucket (10-14 trades, fewer
//     buyers, later entries) stays negative. The edge is the opening burst
//     itself: these coins either spike fast or die fast, and the bracket
//     catches the spike and cuts the death.
//   - 28 of the 35 coins that complete do so in their create slot (one
//     bundled burst, real SOL 0 -> 85 in a single slot). No bot can buy
//     those: the CreateEvent and the CompleteEvent arrive in the same batch.
//     The entry below therefore requires the curve to be alive and uncomplete
//     when it decides, and never chases a coin older than 3 slots.
//
// So this bot does one thing: it buys only launches with 15+ trades in their
// first 3 slots, one 0.4 SOL stake each (the 1%-of-reserve size cap binds
// first on small curves, so the stake only fully deploys into coins whose
// reserves already grew), and exits on the first of +20%, -15%, the creator
// selling, or 300 slots held. No adds, no pyramiding, no trailing: size goes
// in once, at the burst, and the bracket decides. A pure function of the
// batches it is fed (no clock, no randomness, no I/O), so the two grading
// runs agree byte for byte.

import { BPS, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Oldest age (slots since create) at which a first buy may still be decided. */
  maxAge: number;
  /** Trades seen on the coin before a first buy is allowed. */
  minTrades: number;
  /** Distinct non-creator buyers seen before a first buy (0 = no minimum). */
  minBuyers: number;
  /** Largest single non-creator sell, as bps of real SOL before it, tolerated. */
  maxBigSellBps: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Price now over create price, as bps, at most (skip coins that already ran). */
  maxRunupBps: number;
  /** Lamports to aim for per coin (each reply is still capped at 1% of real SOL). */
  stakeLamports: number;
  /** Smallest single buy worth paying the tx fee for (also the guardrail's round-trip floor). */
  minBuyLamports: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Exit when the position is worth this much over its cost (bps). */
  tpBps: number;
  /** Exit when it is worth this much under its cost (bps). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit when the creator sells while held. */
  exitOnDevSell: boolean;
}

export const DEFAULT_PARAMS: Params = {
  maxAge: 3,
  minTrades: 15,
  minBuyers: 0,
  maxBigSellBps: 10_000,
  maxSellRatioBps: 10_000,
  maxRunupBps: 100_000,
  stakeLamports: 400_000_000,
  minBuyLamports: 10_000_000,
  buySlippageBps: 10_000,
  tpBps: 2000,
  slBps: 1500,
  maxHold: 300,
  exitOnDevSell: true,
};

const FEE_BPS = 125n;

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devSold: boolean;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  lastTradeSlot: number;
  /** Never buy it again (exited, bought, filtered out for good, or completed). */
  done: boolean;
  /** A buy is in flight for this coin (cleared if it is rejected or fails). */
  sent: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
}

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

export interface Strategy {
  onBatch(state: BotState, batch: Batch): OrderInput[];
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Strategy {
  const P = params;
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const selling = new Set<Pubkey>();

  function readEvents(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devSold: false,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          lastTradeSlot: e.slot,
          done: false,
          sent: false,
          complete: false,
        });
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        c.lastTradeSlot = e.slot;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
      }
    }
  }

  function hasPendingBuy(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'buy') return true;
    return false;
  }

  function hasPendingSell(state: BotState, mint: Pubkey): boolean {
    for (const p of state.pending.values()) if (p.order.mint === mint && p.order.side === 'sell') return true;
    return false;
  }

  return {
    onBatch(state, batch) {
      readEvents(batch);
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, txPaid: BigInt(f.tx_fee_lamports) });
          const c = coins.get(f.mint);
          if (c !== undefined) c.done = true;
        }
        if (f.side === 'buy' && f.status !== 'filled') {
          const c = coins.get(f.mint);
          if (c !== undefined) c.sent = false;
        }
      }
      for (const mint of [...selling]) if (!hasPendingSell(state, mint)) selling.delete(mint);
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPendingBuy(state, mint)) held.delete(mint);
      }

      // Exits first: the bracket decides, nothing else.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, txPaid: tx };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(P.tpBps))) exit = true;
          else if (value * BPS <= basis * (BPS - BigInt(P.slBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= P.maxHold) exit = true;
        if (!exit && c !== undefined && P.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: only launches still in their first 3 slots whose opening tape
      // is hot (15+ trades), with the creator not yet selling. One stake each,
      // in first-seen order; the 5-position cap and cash do the rationing.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete || c.sent) continue;
        if (open >= state.hello.caps.max_open_positions) break;
        const age = state.slot - c.createSlot;
        if (age > P.maxAge) {
          c.done = true;
          continue;
        }
        if (c.trades < P.minTrades) continue;
        if (c.buyers.size < P.minBuyers) continue;
        if (c.devSold) {
          c.done = true;
          continue;
        }
        if (c.bigSellBps > BigInt(P.maxBigSellBps)) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(P.maxSellRatioBps)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup > BigInt(P.maxRunupBps)) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = BigInt(P.stakeLamports) < maxBuy ? BigInt(P.stakeLamports) : maxBuy;
        if (amount < BigInt(P.minBuyLamports) || free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: P.buySlippageBps });
        free -= amount + tx;
        c.sent = true;
        open += 1;
      }
      return orders;
    },
  };
}
