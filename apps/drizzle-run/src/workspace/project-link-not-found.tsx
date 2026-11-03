import { UnlinkIcon } from "lucide-react";
import { Link } from "react-router";

import { Button } from "../components/ui/button";
import { cn } from "../lib/utils";
import { SiteHeader } from "../shell/site-header";
import { useWorkspace } from "./context";

const linkButtonClass = cn("h-10 rounded-md px-4 text-[14px] font-semibold");

/**
 * The page a `/p/` link opens in another browser
 *
 * A `/p/` address requires the project to be available in this browser. Offer a Share link or the original browser
 * as ways to find it. With `deleted`, explain that a previously visible project was removed here or in another tab.
 */
export function ProjectLinkNotFound({ deleted = false }: { deleted?: boolean }) {
  const workspace = useWorkspace();

  return (
    <>
      <SiteHeader />
      {workspace.banners}
      <main className="flex min-h-0 flex-1 items-center justify-center bg-bg bg-[radial-gradient(var(--border)_1px,transparent_1.2px)] bg-size-[18px_18px] px-6 py-6 max-phone:px-4">
        <section
          aria-labelledby="project-link-not-found"
          className="flex w-140 max-w-full flex-col gap-4 rounded-[18px] border-[1.5px] border-card-border bg-surface p-7 shadow-sticker-card max-phone:p-5"
        >
          <span
            className="grid size-11 place-items-center rounded-[12px] border-[1.5px] border-run-border bg-lime text-on-lime"
            aria-hidden="true"
          >
            <UnlinkIcon className="size-5" />
          </span>
          <div className="flex flex-col gap-2">
            <h1
              id="project-link-not-found"
              className="m-0 font-display text-[32px]/[1.1] font-extrabold tracking-[-0.02em] max-phone:text-[26px]"
            >
              {deleted ? "This project was deleted" : "This link only works in the browser that made it"}
            </h1>
            <p className="m-0 text-[15px]/[1.6] text-muted">
              {deleted
                ? "It was deleted in this browser, maybe from another tab. Your other projects are still in My projects."
                : "Projects are saved in the browser that created them, so this address has nothing to open here."}
            </p>
          </div>
          {!deleted && (
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0" role="list">
              <li className="flex gap-3 rounded-[12px] bg-mark px-3.5 py-3 text-[14px]/normal max-phone:flex-col max-phone:gap-1">
                <b className="shrink-0 font-semibold">Got it from someone?</b>
                <span>Ask them for a Share link. It works for everyone.</span>
              </li>
              <li className="flex gap-3 rounded-[12px] bg-surface-2 px-3.5 py-3 text-[14px]/normal max-phone:flex-col max-phone:gap-1">
                <b className="shrink-0 font-semibold">Made it yourself?</b>
                <span>Open it in the browser you used, or sign in there to sync it.</span>
              </li>
            </ul>
          )}
          <div className="flex flex-wrap gap-2.5 pt-1">
            <Button variant="sticker" className={linkButtonClass} nativeButton={false} render={<Link to="/examples" />}>
              Browse examples
            </Button>
            <Button
              variant="outline"
              className={linkButtonClass}
              nativeButton={false}
              render={<Link to="/community" />}
            >
              Community
            </Button>
            <Button variant="outline" className={linkButtonClass} nativeButton={false} render={<Link to="/projects" />}>
              My projects
            </Button>
          </div>
        </section>
      </main>
    </>
  );
}
