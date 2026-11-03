import type { ReactNode } from "react";
import { useId } from "react";

import { COMMUNITY_REUSE_NOTE, SIGN_IN_PURPOSE } from "../auth/account-copy";
import { useAuth } from "../auth/auth-provider";
import { Button } from "../components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui/dialog";
import { AutoHeight } from "../ui/auto-height";
import { CLOUD_FREE_NOTE, CLOUD_LIMIT_NOTE } from "./cloud-labels";
import type { CloudSync } from "./cloud-sync";
import { CloudSyncProblems, CloudUsageBars, isCloudSyncActive } from "./cloud-usage";

function SettingsSection({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();

  return (
    <section className="flex flex-col gap-2" aria-labelledby={id}>
      <h3 id={id} className="m-0 text-[12px] font-medium text-muted">
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Settings, from the account menu or the usage strip's Details
 *
 * The account and what it is for, then Cloud: usage against the limits, and its status with what did not save.
 */
export function SettingsDialog({ cloudSync }: { cloudSync: CloudSync }) {
  const auth = useAuth();
  const user = auth.user;

  return (
    <Dialog open={cloudSync.settingsOpen} onOpenChange={cloudSync.setSettingsOpen}>
      <DialogContent className="max-h-[calc(100dvh-32px)] overflow-y-auto">
        <AutoHeight className="flex flex-col gap-5">
          <DialogHeader>
            <DialogTitle>Settings</DialogTitle>
          </DialogHeader>
          <SettingsSection title="Account">
            {user === null ? (
              <p className="m-0 text-[13px]">Not signed in.</p>
            ) : (
              <div className="flex items-center gap-2.5">
                <img
                  src={user.avatarUrl}
                  alt=""
                  referrerPolicy="no-referrer"
                  className="size-7 rounded-full border border-border object-cover"
                />
                <span className="font-medium">@{user.login}</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => {
                    cloudSync.setSettingsOpen(false);
                    cloudSync.signOut();
                  }}
                >
                  Sign out
                </Button>
              </div>
            )}
            <p className="m-0 text-[13px] text-muted">{SIGN_IN_PURPOSE}</p>
            <p className="m-0 text-[13px] text-muted">{COMMUNITY_REUSE_NOTE}</p>
          </SettingsSection>
          <SettingsSection title="Cloud">
            {isCloudSyncActive(cloudSync) ? (
              <>
                <CloudUsageBars cloudSync={cloudSync} />
                <CloudSyncProblems cloudSync={cloudSync} />
                <p className="m-0 text-[13px] text-muted">{CLOUD_LIMIT_NOTE}</p>
              </>
            ) : cloudSync.status === "unavailable" ? (
              <p className="m-0 text-[13px]">Cloud is not set up on this deployment.</p>
            ) : cloudSync.error !== "" ? (
              <CloudSyncProblems cloudSync={cloudSync} />
            ) : (
              <p className="m-0 text-[13px]">
                Sign in with GitHub to keep projects in Cloud and open them on any machine.
              </p>
            )}
            <p className="m-0 text-[13px] text-muted">{CLOUD_FREE_NOTE}</p>
          </SettingsSection>
        </AutoHeight>
      </DialogContent>
    </Dialog>
  );
}
