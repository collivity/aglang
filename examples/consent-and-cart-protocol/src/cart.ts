export enum CartPhase {
  Empty = 'Empty',
  SingleItem = 'SingleItem',
  MultiItem = 'MultiItem',
}

export interface SharedCart {
  phase: CartPhase;
}

export function addFirstItem(cart: SharedCart): void {
  if (cart.phase === CartPhase.Empty) {
    cart.phase = CartPhase.SingleItem;
  }
}

export function addAnotherItem(cart: SharedCart): void {
  if (cart.phase === CartPhase.SingleItem) {
    cart.phase = CartPhase.MultiItem;
  }
}
