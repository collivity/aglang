import { Order, OrderStatus } from "../backend/api/orders";

export function enqueueFulfillment(order: Order): void {
  if (order.status === OrderStatus.Paid) {
    order.status = OrderStatus.FulfillmentQueued;
  }
}

export function markFulfilled(order: Order): void {
  if (order.status === OrderStatus.FulfillmentQueued) {
    order.status = OrderStatus.Fulfilled;
  }
}
