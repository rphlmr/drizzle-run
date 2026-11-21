# @drizzle-run/app

## 0.3.2

### Patch Changes

- 34a5a55: Link to the official Drizzle Batch API reference from the Pipeline, batch, and parallel and Bulk insert and update guides.

## 0.3.1

### Patch Changes

- 4cedf63: Add an interactive PostgreSQL guide to bulk inserts, updates by composite key, and per-chunk commits.

## 0.3.0

### Minor Changes

- cefe614: Add the Drizzle ORM and Kit 1.0.0-rc.6 pair with optional Effect support. Use the Drizzle PostgreSQL driver for the RC6 runtime and expose PostgreSQL command tags in SQL events and recordings. Move the guides and examples to RC6, update the Effect examples to use the Drizzle driver, and add a guide to pipeline, batch, parallel execution, and partial failures.

### Patch Changes

- Updated dependencies [cefe614]
  - @drizzle-run/core@0.4.0
  - @drizzle-run/runtime@0.4.0
  - @drizzle-run/orchestration@0.2.3
  - @drizzle-run/react@0.2.3

## 0.2.1

### Patch Changes

- Updated dependencies
  - @drizzle-run/core@0.3.1
  - @drizzle-run/runtime@0.3.1
  - @drizzle-run/orchestration@0.2.2
  - @drizzle-run/react@0.2.2

## 0.2.0

### Minor Changes

- 7347326: Restyle the app as white panels on a gray frame, with lime kept for Run. Every page starts its content at the same distance from the top, the site nav stays in place between pages and turns into icons when the editor header is narrow, and the read-only editor bar no longer blends into the frame. On phones a menu button opens the site sections and the About links from every header, a project's included, the workspace switches Code and Output with tabs drawn like the desktop's and keeps the run status beside them, the output keeps its desktop bar with its views, history and settings, a side by side switches sides on a quiet segmented track, the guide sheet floats over the code and output like a modal sheet and folds into one step row, sheets rise from the bottom edge, the gallery scrolls only its cards and picks the database from a menu, Community moves its database and sort into a filter sheet, and My projects lists each project with its database logo and its actions. The recorded embed colors its code again and puts the code beside the output when it is wide.

### Patch Changes

- Updated dependencies [7347326]
  - @drizzle-run/core@0.3.0
  - @drizzle-run/runtime@0.3.0
  - @drizzle-run/orchestration@0.2.1
  - @drizzle-run/react@0.2.1

## 0.1.0

### Minor Changes

- 81438d5: Rebuild the examples gallery around sections. PostgreSQL and SQLite versions of the same example share one card, a card opens its example directly, and Quick look shows the steps and query without leaving the page. Search matches titles, steps and code, guides in progress come back first, and Back returns to the same scroll position.
- 81438d5: Simplify sharing around one question, who can see it. A first share starts in Community and one click publishes and lists it, or Link only makes a link to send. The shared link drops its tabs: the link, the same Community or Link only choice, whether it shows the latest code, the embed code on demand, and Stop sharing in view. Push changes is now Update share, and the header button says In Community or Shared.

## 0.0.2

### Patch Changes

- d72a8dc: Fix mobile guide editor scrolling by keeping the code above the guide sheet. Add a labeled Show/Hide guide steps control with swipe gestures to expand and collapse the sheet, and keep its expanded height stable when results change.

## 0.0.1

### Patch Changes

- f782ec1: Preserve local projects when a cloud copy changes after Keep theirs was approved, and ask again for the new revision. Keep pending AI edits recoverable after a failed storage save.
- d91b647: Refresh the app's navigation and neutral theme while keeping the editor's layout and branded controls. Improve example discovery with stable filters, syntax-highlighted previews, and clearer related links. Make theme selection available from the account menu and increase the default editor font size.
- 080f2e0: Add AI crawler opt-outs to non-production deployments while preserving production indexing and preview noindex headers.

  Match the side-by-side guide panel's rounded border and outer spacing to the other guides.

- f335b62: Track page views with One Dollar Stats only on the production site. Local development, previews, and next.drizzle.run do not initialize analytics.
- d1e3d33: Improve example and guide code readability with clearer spacing between logical blocks. Let long lines in example previews scroll horizontally instead of wrapping.
- e69bea6: Improve light and dark theme contrast across the app, editor, and embedded playgrounds. Refresh the examples and guides library with clearer comparison labels, saved progress, and stable filter layouts. Add a visible Open action to each project table row.
- Updated dependencies [f782ec1]
- Updated dependencies [f782ec1]
- Updated dependencies [f782ec1]
  - @drizzle-run/core@0.2.0
  - @drizzle-run/runtime@0.2.0
  - @drizzle-run/orchestration@0.2.0
  - @drizzle-run/react@0.2.0
