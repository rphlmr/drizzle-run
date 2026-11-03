---
"@drizzle-run/runtime": patch
---

Preserve SQL text and parameters for SQLite client batch tuples so successful queries do not fail runtime event validation.

Keep SQLite transaction `closed` state accurate after executing statements, including SQL that commits or rolls back the transaction.
