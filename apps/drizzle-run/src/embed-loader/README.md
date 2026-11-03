# Drizzle Run embed loader

The Drizzle Run embed loader is an ESM-only, framework-independent click-to-load loader. The loader is one self-contained module and does not load an iframe, application code, editor, execution runtime, or database assets before activation.

Every Drizzle Run app serves the loader as an ES module at `<origin>/embed/index.js`. The Share dialog's embed code imports it from there:

```html
<div id="drizzle-playground"></div>
<script type="module">
  import { mountPlayground } from "https://run.example.com/embed/index.js";

  const mount = mountPlayground(document.querySelector("#drizzle-playground"), {
    snapshotId: "3f2b8c1e-6d4a-4e9b-9c7f-1a2b3c4d5e6f",
    baseUrl: "https://run.example.com",
    height: 600,
    theme: "dark",
    preview: {
      title: "Users by name",
      description: "Find users whose name starts with a letter.",
      runtime: [{ drizzleOrm: "0.45.4", database: "SQLite" }],
      author: "octocat",
    },
  });

  // Call mount.dispose() from the host framework's unmount hook.
</script>
```

Before the click, the embed is a cover of the playground's size: the playground's title, description and byline on a dotted backdrop, over a **Load playground** card that shows the Drizzle ORM version and database. On the click, the playground takes the cover's place at the same height.

The loader lives in `apps/drizzle-run/src/embed-loader` and is built independently of the application UI.

The host page must be served over HTTP(S). A `file://` page, or a sandboxed frame without `allow-same-origin`, has an opaque (`"null"`) origin that the playground cannot answer. The loader checks its own page when the visitor clicks **Load playground**: on such a page it loads no frame, shows a card that says so, and reports the `unsupported_host` error.

## Host events

The returned handle is an `EventTarget`. It dispatches four `CustomEvent`s, and `mountPlayground` takes a matching callback for each, called with the event's `detail` before the listeners:

| Event         | Callback       | `detail`                                                                                            | When                                                                    |
| ------------- | -------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `capability`  | `onCapability` | `{ status: "available" \| "recorded" \| "embedding_context_unsupported" \| "browser_unsupported" }` | The frame reports what it can do in this page.                          |
| `ready`       | `onReady`      | `{ mode: "live" \| "recorded" }`                                                                    | The playground shows: it runs live, or shows its recorded run.          |
| `error`       | `onError`      | `{ code }`, one of the codes below                                                                  | The playground could not load.                                          |
| `run-settled` | `onRunSettled` | `{ outcome, side?, error?, displays, truncated }`, described below                                  | A run in the playground settled: it succeeded, failed or was cancelled. |

The `error` codes:

| Code               | Reported by | Meaning                                                                                                     | Retry |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------- | ----- |
| `application_load` | Frame       | The playground could not load, such as on a network failure.                                                | Yes   |
| `initialization`   | Frame       | The runtime could not initialize in this page.                                                              | Yes   |
| `internal`         | Frame       | An unexpected error in the frame after the playground loaded.                                               | Yes   |
| `not_found`        | Frame       | The shared link, example or guide step does not exist. The card says the playground no longer exists.       | No    |
| `unopenable`       | Frame       | The playground exists, but this Drizzle Run cannot open it in an embed. The card links to the full page.    | No    |
| `unsupported_host` | Both        | The host page has an opaque (`"null"`) origin, so the frame cannot answer it. Serve the page over HTTP(S).  | No    |
| `frame_load`       | Loader      | The browser reported that the iframe failed to load. Browsers rarely do for a network failure.              | Yes   |
| `timeout`          | Loader      | The frame was not ready in 30 s. A frame that never loads, such as on a network failure, usually ends here. | Yes   |

```ts
const playground = mountPlayground(element, {
  snapshotId: "3f2b8c1e-6d4a-4e9b-9c7f-1a2b3c4d5e6f",
  baseUrl: "https://run.example.com",
  preview: {
    title: "Users by name",
    description: "Find users whose name starts with a letter.",
  },
  onReady: ({ mode }) => analytics.track("playground-ready", { mode }),
  onRunSettled: ({ outcome, displays }) => analytics.track("playground-run", { outcome, displays: displays.length }),
});

playground.addEventListener("error", (event) => {
  console.warn("Drizzle Run could not load", event.detail.code);
});
```

A recorded run dispatches `capability` with `recorded`, then `ready` with `recorded`. An unsupported page dispatches `capability` and shows its fallback panel, without `ready`. After an `error` with a retry, the card offers one, so `ready` can still follow; after `not_found` it offers only "Browse examples", and after `unopenable` or `unsupported_host` only "Open in Drizzle Run". Nothing is dispatched after `dispose()`. A listener or callback that throws is reported like any event listener and does not stop the loader. There is no custom element: the loader stays a function the host calls.

### Settled runs

Each time a run settles in the playground, `run-settled` reports a small summary. A recorded run shown where the page cannot run it reports nothing. The `detail`:

- `outcome`: `"succeeded"`, `"failed"` or `"cancelled"`.
- `side`: in a side-by-side share, the side that ran, `0` or `1` in the order of its sides. Run both settles each side on its own, so it reports twice. Absent for a one-version playground.
- `error`: why a failed run failed, up to 1000 characters. Absent unless `outcome` is `"failed"`.
- `displays`: each `$.display` call as `{ label, values }`, in order. The values are in Drizzle Run's serialized JSON form, such as `{ "type": "primitive", "value": 1 }`, `{ "type": "array", "value": [...] }` or `{ "type": "object", "value": { ... } }`.
- `truncated`: `true` when displays past 64 KiB of JSON were dropped. The displays before them are kept whole.

## Targets

Pass `example` instead of `snapshotId` for an official example, with `step` for one step of its guide, by step id. Example slugs and step ids are lowercase words joined by hyphens:

```ts
mountPlayground(document.querySelector("#playground")!, {
  example: "transactions",
  baseUrl: "https://run.example.com",
  preview: {
    title: "Transactions and savepoints",
    description: "Drizzle ORM 1.0.0-rc.5 on PostgreSQL",
  },
});
```

The `baseUrl` must be an absolute HTTP(S) origin. The loader creates `/embed/:snapshotId`, `/embed/examples/:example` or `/embed/examples/:example/:step` only after the visitor clicks **Load playground**. The iframe route must initialize the workspace without automatically running shared code. If the share carries the author's recorded run, or the target is an official example with Drizzle Run's recording, and the page or browser cannot run it, the iframe reports the `recorded` capability and the loader keeps it shown with that run. Otherwise, if the page's embedding context cannot provide the required isolation, the loader offers `/s/:snapshotId` (or `/examples/:example`, with `?step=:step`) in a new tab. If the browser itself lacks required features, it explains that Drizzle Run cannot run there and does not imply that a new tab will help. Firefox and Safari run the iframe inline only when the host page is cross-origin isolated; see [Where an embed runs inline](#where-an-embed-runs-inline) for the two headers and their trade-off.

Every mount requires `preview`, which the cover shows before the click, without contacting the app:

| Field         | Shows                                                                                              |
| ------------- | -------------------------------------------------------------------------------------------------- |
| `title`       | The heading. Required.                                                                             |
| `description` | A line under the title. Optional.                                                                  |
| `runtime`     | One `{ drizzleOrm, database }`, or two for a side-by-side playground, as chips on the load card.   |
| `author`      | A GitHub login, shown as "by @login". An official example shows "Official example" and ignores it. |

Drizzle Run's Share dialog writes all four into the embed code, with the signed-in author's login. The loader renders every field as text only. A malformed preview throws a `TypeError` before the mount element is changed: a missing title, a text that is empty, blank, or longer than `EMBED_PREVIEW_LIMITS` (title 160 characters, description 140, each runtime text 40), a runtime that is not one or two sides, or an author that is not a GitHub login. `EMBED_PREVIEW_LIMITS` is shared through `protocol.ts`. A `height` that is not a positive whole number throws the same way.

The loader and iframe view share the versioned wire contract in `protocol.ts`. On activation, the loader puts a fresh nonce in the iframe URL fragment. The child reads it and sends a typed `hello` message without playground data. The loader accepts that message only from the current iframe window and exact app origin, then replies with `connect` to that exact origin. `connect` names the target, as `snapshotId` or as `example` with an optional `step`, and the child connects only when it names the child's own address. After connection, the child sends only `ready`, `capability`, `error`, or `run-settled`. It sends `ready` once the playground shows, never while it still loads it, so a missing playground fails without showing first. Every message contains the protocol name, version, and per-load nonce; parsers reject extra or malformed fields, and an error code they do not know, so a loader that predates a code ignores it. A `run-settled` message carries only the run's outcome, its truncated error and its displays as plain JSON, bounded to 64 KiB. The loader does not accept HTML, navigation, or execution commands. The rest of the output, such as SQL and logs, stays in the iframe.

The one message the child sends without a connection is the `unsupported_host` error, to a parent with an opaque origin. Such a parent cannot be named as a `postMessage` target, so that error goes to any origin. It holds only the code and the nonce the parent sent.

The loader renders its cover, retry, and fallback panels and the iframe inside an open shadow root, with one stylesheet of its own. It adds no CSS to the host page, and the host page's CSS (a Tailwind preflight, colliding class names) does not reach them. The mount element gets one child, `div.drizzle-run-embed[data-drizzle-run-embed]`, which host pages can target for layout such as width or margins.

The stylesheet is a constructable `CSSStyleSheet` adopted by the shadow root, so a host page whose Content Security Policy has no `'unsafe-inline'` in `style-src` still styles it. The iframe's size and border are set inline. Browsers without constructable stylesheets fall back to a `<style>` element, which such a policy blocks.

`theme: "light"` or `theme: "dark"` paints the whole embed in that theme: the cover, the loading and error panels, and the playground itself. Any other value throws a `TypeError` before the mount element is changed. The Share dialog writes the theme the author picks, dark by default.

Without `theme`, the cover is dark, the panels after the click follow the host page's `color-scheme`, and the playground follows the visitor's system setting. A page that declares `color-scheme: light dark` (or the matching `<meta name="color-scheme">`) gets dark panels when the visitor's system is dark, and a page that declares no scheme gets light ones. Browsers without the CSS `light-dark()` function follow the system setting instead.

## Where an embed runs inline

The runtime needs `SharedArrayBuffer`, which browsers expose only to cross-origin isolated pages. Chrome and Edge let
the embed isolate its own iframe with `Document-Isolation-Policy`. Firefox and Safari do not support that header, so
there the host page itself must be isolated.

| Host page                                   | Chrome, Edge | Firefox, Safari                                                  |
| ------------------------------------------- | ------------ | ---------------------------------------------------------------- |
| Any page, shared with the author's last run | Runs inline  | Shows the author's recorded run inline, with "Run in a new tab"  |
| Any page, official example or guide step    | Runs inline  | Shows Drizzle Run's recorded run inline, with "Run in a new tab" |
| Any page, shared without a run              | Runs inline  | Offers to open the playground in a new tab, where it runs        |
| Sends the two headers below                 | Runs inline  | Runs inline                                                      |

To run inline everywhere, serve the page that holds the embed with:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

With `require-corp`, every cross-origin image, script, font and iframe on that page must allow it (a
`Cross-Origin-Resource-Policy` header or CORS), or the browser blocks it. Third-party widgets such as video players,
ads and analytics often do not. Add the headers only on pages that hold embeds, and check them before you ship.

## Height

The embed takes the playground's height from the first paint: the cover, the loading state, the ready playground and every run after it keep it, like a video or CodePen embed. What does not fit, such as a long result or a side-by-side playground, scrolls inside. The page never moves, not even on the click.

- **`height` sets it**, in CSS pixels, such as `height: 600`. Without it, the playground is 585 pixels tall (`EMBED_DEFAULT_HEIGHT`).
- **A height on the container wins**, for the cover and the playground alike. Set it with any CSS, at any breakpoint, such as a media query; the embed fills it exactly.

The Share dialog's embed code offers three presets, written as `height`:

| Preset   | Option        |
| -------- | ------------- |
| Compact  | `height: 480` |
| Standard | `height: 600` |
| Tall     | `height: 800` |

## Size

`pnpm --filter @drizzle-run/app build:embed` builds the minified ESM loader and prints its raw and gzip sizes.

## Development checks

From the repository root:

```bash
pnpm --filter @drizzle-run/app test:embed
pnpm --filter @drizzle-run/app typecheck
```
