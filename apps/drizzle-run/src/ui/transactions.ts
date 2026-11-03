import type { RunTransaction } from "@drizzle-run/core/contracts";

/** A run's transactions by the transaction they nest in, for walking savepoints. */
export type TransactionChildren = ReadonlyMap<number, readonly RunTransaction[]>;

/** Index savepoints under the transaction they belong to. */
export function getTransactionChildren(transactions: readonly RunTransaction[]): TransactionChildren {
  const children = new Map<number, RunTransaction[]>();

  for (const transaction of transactions) {
    if (transaction.parent !== undefined) {
      children.set(transaction.parent, [...(children.get(transaction.parent) ?? []), transaction]);
    }
  }

  return children;
}

/** Writes in the database after the run: the transaction's own and its kept savepoints', when it was kept. */
export function countKeptWrites(transaction: RunTransaction, children: TransactionChildren): number {
  if (transaction.writes === "undone") {
    return 0;
  }

  const own = transaction.statements.filter((statement) => statement.role === "write").length;

  return (children.get(transaction.id) ?? []).reduce((total, child) => total + countKeptWrites(child, children), own);
}

/** The reads and writes a transaction sent, its savepoints' included; begin, commit and savepoint statements aside. */
export function countDataStatements(transaction: RunTransaction, children: TransactionChildren): number {
  const own = transaction.statements.filter((statement) => statement.role === "read" || statement.role === "write");

  return (children.get(transaction.id) ?? []).reduce(
    (total, child) => total + countDataStatements(child, children),
    own.length,
  );
}
