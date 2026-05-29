public enum OrderStatus
{
    Created,
    Pending,
    Processing,
    Fulfilled,
    Cancelled,
    Refunded
}

public sealed class Order
{
    public string Id { get; set; } = "";
    public OrderStatus Status { get; set; }
}

public sealed class OrderService
{
    public void Cancel(Order order)
    {
        if (order.Status == OrderStatus.Processing)
        {
            order.Status = OrderStatus.Cancelled;
        }
    }
}
