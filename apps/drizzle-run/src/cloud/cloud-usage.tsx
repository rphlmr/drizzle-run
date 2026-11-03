import { useAuth } from "../auth/auth-provider";
import { Button } from "../components/ui/button";
import { Progress } from "../components/ui/progress";
import { cn } from "../lib/utils";
import { formatBytes } from "../ui/run-report";
import { getCloudStatusLabel } from "./cloud-labels";
import type { CloudSync } from "./cloud-sync";

const MIB = 1024 * 1024;

const toneClass = { ok: "bg-ok", busy: "bg-faint", warn: "bg-warn" } as const;
const inlineButtonClass = cn("relative min-h-0 p-0 text-[13px] after:absolute after:-inset-x-1 after:-inset-y-3");

/** Whether Cloud runs in this tab: signed in, whatever the last cycle said. */
export function isCloudSyncActive(cloudSync: CloudSync): boolean {
  return ["synced", "syncing", "offline"].includes(cloudSync.status);
}

function formatStorage(usage: NonNullable<CloudSync["usage"]>) {
  return `${formatBytes(usage.bytes)} of ${Math.round(usage.maxBytes / MIB)} MB`;
}

function StatusDot({ cloudSync }: { cloudSync: CloudSync }) {
  const { label, tone } = getCloudStatusLabel(cloudSync.status, {
    failedProjects: cloudSync.failures.length,
    heldUntilMs: cloudSync.heldUntilMs,
  });

  return (
    <span className="inline-flex items-center gap-1.5" data-testid="cloud-sync-status">
      <span className={cn("size-1.75 rounded-full", toneClass[tone])} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * The line under the My projects title
 *
 * Signed in, it shows storage and project counts against the limits with the status, and opens Settings. Signed out
 * it offers sign-in. Nothing while sign-in loads or on a deployment without it.
 */
export function CloudUsageStrip({ cloudSync }: { cloudSync: CloudSync }) {
  const auth = useAuth();

  if (auth.status === "signedOut") {
    return (
      <p className="m-0 text-[13px] text-muted">
        <Button variant="link" className={inlineButtonClass} onClick={auth.signIn}>
          Sign in with GitHub
        </Button>{" "}
        to keep projects in Cloud across machines.
      </p>
    );
  }

  if (!isCloudSyncActive(cloudSync)) {
    return null;
  }

  const usage = cloudSync.usage;

  return (
    <fieldset
      className="flex min-w-auto flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-muted"
      aria-label="Cloud"
    >
      <span>Cloud</span>
      {usage !== null && (
        <>
          <Progress
            className="w-22.5"
            value={Math.min(100, (usage.bytes / usage.maxBytes) * 100)}
            aria-label="Cloud storage used"
          />
          <span className="text-text">{formatStorage(usage)}</span>
          <span aria-hidden="true">·</span>
          <span className="text-text">
            {usage.projects} of {usage.maxProjects} projects
          </span>
          <span aria-hidden="true">·</span>
        </>
      )}
      <StatusDot cloudSync={cloudSync} />
      <Button
        variant="link"
        className={cn(inlineButtonClass, "ml-auto max-phone:ml-0")}
        onClick={() => cloudSync.setSettingsOpen(true)}
      >
        Details
      </Button>
    </fieldset>
  );
}

/**
 * Why Cloud stopped, and which projects did not save, for the Settings dialog
 *
 * Nothing when Cloud runs and every project saved.
 */
export function CloudSyncProblems({ cloudSync }: { cloudSync: CloudSync }) {
  if (cloudSync.error === "" && cloudSync.failures.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5 text-[13px]" data-testid="cloud-sync-problems">
      {cloudSync.error !== "" && <p className="m-0 text-err">{cloudSync.error}</p>}
      {cloudSync.failures.length > 0 && (
        <>
          <p className="m-0">
            These projects did not save to Cloud. They stay in this browser, and saving tries them again.
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {cloudSync.failures.map((failure) => (
              <li key={failure.id}>
                <span className="font-medium">{failure.name}</span>
                <span className="text-err">: {failure.message}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Both bars and the status, for the Settings dialog. */
export function CloudUsageBars({ cloudSync }: { cloudSync: CloudSync }) {
  const usage = cloudSync.usage;

  return (
    <div className="flex flex-col gap-2 text-[13px]">
      {usage !== null && (
        <>
          <div className="flex items-center gap-2.5">
            <Progress
              className="w-35"
              value={Math.min(100, (usage.bytes / usage.maxBytes) * 100)}
              aria-label="Cloud storage used"
            />
            <span>{formatStorage(usage)}</span>
          </div>
          <div className="flex items-center gap-2.5">
            <Progress
              className="w-35"
              value={Math.min(100, (usage.projects / usage.maxProjects) * 100)}
              aria-label="Cloud projects used"
            />
            <span>
              {usage.projects} of {usage.maxProjects} projects
            </span>
          </div>
        </>
      )}
      <p className="m-0 flex flex-wrap items-center gap-1.5">
        <StatusDot cloudSync={cloudSync} />
        {usage !== null && (
          <span className="text-muted">Up to {Math.round(usage.maxProjectBytes / MIB)} MB per project.</span>
        )}
      </p>
    </div>
  );
}
