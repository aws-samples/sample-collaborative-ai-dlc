// Retry a write rejected by a competing transaction on the same item. A
// failed condition or an ambiguous response must go back to the caller.
const TRANSACTION_CONFLICT_ATTEMPTS = 5;
export const isTransactionConflict = (error) =>
  error?.name === 'TransactionConflictException' ||
  (error?.name === 'TransactionCanceledException' &&
    Boolean(error.CancellationReasons?.some((reason) => reason?.Code === 'TransactionConflict')) &&
    error.CancellationReasons.every((reason) =>
      ['None', 'TransactionConflict'].includes(reason?.Code ?? 'None'),
    ));
const conflictBackoffMs = (attempt) => 10 * 2 ** (attempt - 1) * (1 + Math.random());
export const retryTransactionConflicts = (client) => ({
  send: async (command, ...rest) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await client.send(command, ...rest);
      } catch (error) {
        if (!isTransactionConflict(error) || attempt >= TRANSACTION_CONFLICT_ATTEMPTS) throw error;
        await new Promise((resolve) => setTimeout(resolve, conflictBackoffMs(attempt)));
      }
    }
  },
});
