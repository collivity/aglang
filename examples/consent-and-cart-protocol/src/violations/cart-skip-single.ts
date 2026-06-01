import { CartPhase, type SharedCart } from '../cart';

/** Violation: skips SingleItem — blocked by CartProtocol. */
export function jumpToMultiItem(cart: SharedCart): void {
  cart.phase = CartPhase.MultiItem;
}
