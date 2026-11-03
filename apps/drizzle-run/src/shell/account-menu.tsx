import { UserRoundIcon } from "lucide-react";

import { SIGN_IN_PURPOSE } from "../auth/account-copy";
import { useAuth } from "../auth/auth-provider";
import { useOptionalCloudSync } from "../cloud/cloud-sync-provider";
import { useStandaloneSignOut } from "../cloud/standalone-sign-out";
import { Button } from "../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";

/**
 * The account menu at the header's right end
 *
 * Signs in with GitHub and out again, and opens Settings inside the workspace. Sign-in exists only to list shares in
 * Community, update your shares from any browser, and keep projects in Cloud; the menu says so.
 */
export function AccountMenu() {
  const auth = useAuth();
  const cloudSync = useOptionalCloudSync();
  const standaloneSignOut = useStandaloneSignOut();
  const user = auth.user;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="outline"
              size="icon"
              className={user === null ? "rounded-full" : "overflow-hidden rounded-full"}
              aria-label={user === null ? "Account" : `Account: signed in as @${user.login}`}
            />
          }
        >
          {user === null ? (
            <UserRoundIcon aria-hidden="true" />
          ) : (
            <img src={user.avatarUrl} alt="" referrerPolicy="no-referrer" className="size-full object-cover" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-72">
          {/* Base UI labels need a group around them. */}
          <DropdownMenuGroup>
            <DropdownMenuLabel>
              {user === null ? "Not signed in" : `Signed in as @${user.login}`}
              <span className="mt-1 block text-[12px] font-normal text-muted">{SIGN_IN_PURPOSE}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <AccountAction signOut={cloudSync === null ? standaloneSignOut.start : cloudSync.signOut} />
        </DropdownMenuContent>
      </DropdownMenu>
      {cloudSync === null && standaloneSignOut.dialog}
    </>
  );
}

function AccountAction({ signOut }: { signOut: () => void }) {
  const auth = useAuth();
  const cloudSync = useOptionalCloudSync();

  switch (auth.status) {
    case "loading":
      return <DropdownMenuItem disabled>Checking sign-in…</DropdownMenuItem>;
    case "unavailable":
      return <DropdownMenuItem disabled>Sign-in is not set up on this deployment</DropdownMenuItem>;
    case "failed":
      return <DropdownMenuItem onClick={auth.retry}>Retry checking sign-in</DropdownMenuItem>;
    case "signedOut":
      return <DropdownMenuItem onClick={auth.signIn}>Sign in with GitHub</DropdownMenuItem>;
    case "redirecting":
      return <DropdownMenuItem disabled>Opening GitHub…</DropdownMenuItem>;
    case "signedIn":
      return (
        <>
          {auth.error !== "" && (
            <DropdownMenuGroup>
              <DropdownMenuLabel role="alert" className="font-normal text-err">
                {auth.error}
              </DropdownMenuLabel>
            </DropdownMenuGroup>
          )}
          {cloudSync !== null && (
            <DropdownMenuItem onClick={() => cloudSync.setSettingsOpen(true)}>Settings…</DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={signOut}>Sign out</DropdownMenuItem>
        </>
      );
    case "signingOut":
      return <DropdownMenuItem disabled>Signing out…</DropdownMenuItem>;
  }
}
