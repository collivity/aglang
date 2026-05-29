enum class OrderStatus {
    Created,
    PendingPayment,
    Paid,
    FulfillmentQueued,
    Fulfilled,
    Cancelled,
    Refunded
}

data class Order(
    val id: String,
    var status: OrderStatus
)

class CheckoutViewModel {
    fun optimisticFulfill(order: Order) {
        if (order.status == OrderStatus.PendingPayment) {
            order.status = OrderStatus.Fulfilled
        }
    }
}
