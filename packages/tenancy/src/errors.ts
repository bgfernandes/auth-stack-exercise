export type TenancyErrorCode =
  /** The organization does not exist, or the caller may not know that it does (§6.5: no existence leak). */
  | 'not_found'
  /** The caller may view the organization but not do this. */
  | 'forbidden'
  /** Membership is not managed on a personal organization (§5.1); convert it first. */
  | 'personal_organization';

/** One error type for the service; the API maps `code` to a status (ticket 16). */
export class TenancyError extends Error {
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenancyError';
  }
}
