import { callApiWithConsent, ConsentStatus } from './compliance';

export async function checkoutWithConsent(session: { consent: ConsentStatus }): Promise<unknown> {
  return callApiWithConsent(session, '/checkout');
}
