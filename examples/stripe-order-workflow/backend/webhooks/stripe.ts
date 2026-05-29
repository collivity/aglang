import { Order, OrderStatus } from "../api/orders";

export function handlePaymentSucceeded(order: Order): void {
  if (order.status === OrderStatus.PendingPayment) {
    order.status = OrderStatus.Paid;
  }
}

export function handleRefund(order: Order): void {
  if (order.status === OrderStatus.Paid) {
    order.status = OrderStatus.Refunded;
  }
}
