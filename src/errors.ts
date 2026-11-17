export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  unauthorized: () => new AppError(401, 'unauthorized', 'Missing or invalid API key.'),
  forbidden: () => new AppError(403, 'forbidden', 'This API key is not allowed to perform this action.'),
  notFound: (what: string) => new AppError(404, 'not_found', `${what} not found.`),
  insufficientFunds: (accountId: string, available: number, required: number) =>
    new AppError(422, 'insufficient_funds', 'The account does not have enough available balance.', {
      account_id: accountId,
      available,
      required,
    }),
  currencyMismatch: () =>
    new AppError(422, 'currency_mismatch', 'All accounts in a transaction must use the same currency.'),
  accountFrozen: (accountId: string) =>
    new AppError(423, 'account_frozen', 'The account is frozen and cannot be debited.', { account_id: accountId }),
  invalidState: (message: string) => new AppError(409, 'invalid_state', message),
};
