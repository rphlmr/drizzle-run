---
"@drizzle-run/app": patch
"@drizzle-run/core": patch
"@drizzle-run/runtime": patch
---

Link PostgreSQL pipeline and parallel results to their executed SQL when the runtime can identify it. Show nearby statements as context for grouped results without a link and keep unrelated SQL off text-only result cards.

Show each statement of a result's SQL on its own row with its own params, command tag and duration, and frame `begin`/`commit`/`rollback` as a transaction instead of counting them as queries.
