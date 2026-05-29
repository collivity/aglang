export enum OrderStatus {
  Created,
  PendingPayment,
  Paid,
  FulfillmentQueued,
  Fulfilled,
  Cancelled,
  Refunded,
}

export interface Order {
  id: string;
  status: OrderStatus;
  stripe_payment_intent_id?: string;
}

export function createCheckout(order: Order, paymentIntentId: string): void {
  if (order.status === OrderStatus.Created) {
    order.stripe_payment_intent_id = paymentIntentId;
    order.status = OrderStatus.PendingPayment;
  }
}

export function cancelBeforePayment(order: Order): void {
  if (order.status === OrderStatus.PendingPayment) {
    order.status = OrderStatus.Cancelled;
  }
}
