import { ConsentStatus } from '../compliance';

export interface UserSession {
  consent: ConsentStatus;
}

/** Violation: skips Presented — blocked by ConsentLifecycle (unguarded target). */
export function acceptWithoutBanner(session: UserSession): void {
  session.consent = ConsentStatus.Accepted;
}
