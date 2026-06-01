import { callApi } from './api';

/** Compliance gate — API calls must go through this module. */
export function callApiWithConsent(session: { consent: ConsentStatus }, path: string): Promise<unknown> {
  if (session.consent !== ConsentStatus.Accepted) {
    throw new Error('consent required');
  }
  return callApi(path);
}

export enum ConsentStatus {
  Unknown = 'Unknown',
  Presented = 'Presented',
  Accepted = 'Accepted',
  Rejected = 'Rejected',
}
