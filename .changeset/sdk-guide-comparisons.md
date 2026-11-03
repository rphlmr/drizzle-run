---
"@drizzle-run/runtime": minor
"@drizzle-run/react": minor
---

Run guided comparisons through the SDK coordinator and wait for both sides' cleanup. Leaving a guide step cancels
the comparison as a whole. `runWithRuntime` and `GuideProvider.runtime` require both `createRun` and
`createComparison`. Pass the browser or Node runtime, or provide `services.run` for custom guide execution.
