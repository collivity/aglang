// Bad: reaches the API without going through the Compliance component.
import { callApi } from './api';

export async function checkout(): Promise<unknown> {
  return callApi('/checkout');
}
