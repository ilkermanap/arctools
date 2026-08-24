import { ponder } from "ponder:registry";
import { and, asc, eq } from "ponder";
import {
  erc20MarkerLookup,
  isUnmatchableErc20Event,
  movementFromNativeEvent,
} from "arc-index-ponder";
import { usdcMovement } from "ponder:schema";

/**
 * The native system emitter records every USDC movement, so this is the only
 * handler that creates rows. Double-counting is structurally impossible.
 */
ponder.on("ArcUsdcNative:Transfer", async ({ event, context }) => {
  await context.db.insert(usdcMovement).values(movementFromNativeEvent(event));
});

/**
 * The ERC-20 emitter adds no movements — it only tells us a movement went
 * through the token interface. Arc emits the native log first, so the row we
 * need already exists.
 */
ponder.on("ArcUsdcErc20:Transfer", async ({ event, context }) => {
  // Zero-value and self-transfers are logged by the token but never by the
  // native emitter, so no row will ever match them.
  if (isUnmatchableErc20Event(event)) return;

  const lookup = erc20MarkerLookup(event);

  // Take the earliest still-unmarked duplicate, so repeated identical transfers
  // in one transaction pair up in log order.
  const [target] = await context.db.sql
    .select({ id: usdcMovement.id })
    .from(usdcMovement)
    .where(
      and(
        eq(usdcMovement.txHash, lookup.txHash),
        eq(usdcMovement.from, lookup.from),
        eq(usdcMovement.to, lookup.to),
        eq(usdcMovement.value, lookup.value),
        eq(usdcMovement.via, lookup.via),
      ),
    )
    .orderBy(asc(usdcMovement.logIndex))
    .limit(1);

  if (!target) {
    // The native emitter is meant to record every real movement. Reaching here
    // means the start block clipped it, or the chain diverged from spec.
    console.warn(
      `unmatched ERC-20 Transfer in ${lookup.txHash}: ${lookup.from} -> ${lookup.to} ${lookup.value}`,
    );
    return;
  }

  await context.db.update(usdcMovement, { id: target.id }).set({ via: "erc20" });
});
