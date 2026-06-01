import { ConsentStatus } from './compliance';

export interface UserSession {
  consent: ConsentStatus;
}

export function presentBanner(session: UserSession): void {
  if (session.consent === ConsentStatus.Unknown) {
    session.consent = ConsentStatus.Presented;
  }
}

export function acceptConsent(session: UserSession): void {
  if (session.consent === ConsentStatus.Presented) {
    session.consent = ConsentStatus.Accepted;
  }
}
