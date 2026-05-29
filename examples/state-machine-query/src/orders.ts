export enum OrderStatus {
  Created,
  Pending,
  Processing,
  Fulfilled,
  Cancelled,
  Refunded,
}

export interface Order {
  id: string;
  status: OrderStatus;
}

export function startProcessing(order: Order): void {
  if (order.status === OrderStatus.Pending) {
    order.status = OrderStatus.Processing;
  }
}

export function fulfillDirectly(order: Order): void {
  if (order.status === OrderStatus.Pending) {
    order.status = OrderStatus.Fulfilled;
  }
}
