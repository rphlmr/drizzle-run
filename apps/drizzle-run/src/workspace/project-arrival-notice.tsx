import { CloudIcon, LinkIcon, MonitorIcon, ShareIcon } from "lucide-react";
import { useId, useState } from "react";
import {
  Link,
  useFetcher,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import * as z from "zod/mini";

import { appServicesContext } from "../app-services";
import type { ProjectLocation } from "../cloud/project-location";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Dialog, DialogContent, DialogTitle } from "../components/ui/dialog";
import { Toast } from "../ui/toast";
import {
  getArrivalNotice,
  PROJECT_INTRO_SETTING,
  readProjectIntroState,
  type ProjectArrival,
  type ProjectIntroState,
} from "./project-arrival";

/** Load how this browser left the intro; a read that fails counts as never shown. */
export async function loadProjectIntro({ context }: LoaderFunctionArgs): Promise<{ intro: ProjectIntroState }> {
  const { settings } = context.get(appServicesContext);
  const stored = await settings.readSetting(PROJECT_INTRO_SETTING).catch(() => undefined);

  return { intro: readProjectIntroState(stored) };
}

/**
 * Skip the project page's reads on the same project
 *
 * The notice keeps what it picked as it opened, and the URL names a file once one is chosen, so a search change or the
 * arrival state the page clears has nothing to reload.
 */
export function shouldReloadProjectIntro({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (currentUrl.pathname === nextUrl.pathname) {
    return false;
  }

  return defaultShouldRevalidate;
}

const IntroFormSchema = z.object({
  intro: z.enum(["seen", "muted"] as const satisfies readonly ProjectIntroState[]),
});

/** Store how the posted `intro` was closed: for the next new project ("seen") or for good ("muted"). */
export async function saveProjectIntro({ request, context }: ActionFunctionArgs): Promise<null> {
  const { settings } = context.get(appServicesContext);
  const form = IntroFormSchema.safeParse(Object.fromEntries(await request.formData()));

  if (form.success) {
    await settings.writeSetting(PROJECT_INTRO_SETTING, form.data.intro).catch(() => undefined);
  }

  return null;
}

export interface ProjectArrivalNoticeProps {
  arrival: ProjectArrival;
  /** The opened project's name, which the Duplicate toast names. */
  projectName: string;
  /** How this browser left the intro when the project opened. */
  intro: ProjectIntroState;
  /** Where the project is kept, which the intro describes. */
  location: ProjectLocation;
}

/**
 * What a project opens with after a create, a Duplicate or a Fork
 *
 * `getArrivalNotice` chooses a storage intro or a toast linking back to the original project.
 * Keep that choice until the notice closes, even if closing the intro updates the stored state.
 */
export function ProjectArrivalNotice({ arrival, projectName, intro, location }: ProjectArrivalNoticeProps) {
  const save = useFetcher<typeof saveProjectIntro>();
  const [shown, setShown] = useState(() => getArrivalNotice(arrival, intro));

  if (shown === "intro") {
    return (
      <ProjectIntroDialog
        location={location}
        onClose={(closed) => {
          setShown("none");
          void save.submit({ intro: closed }, { method: "post", defaultShouldRevalidate: false });
        }}
      />
    );
  }

  if (shown === "toast" && arrival.kind !== "created") {
    return <ArrivalToast arrival={arrival} projectName={projectName} onDismiss={() => setShown("none")} />;
  }

  return null;
}

interface ArrivalToastProps {
  arrival: Exclude<ProjectArrival, { kind: "created" }>;
  projectName: string;
  onDismiss: () => void;
}

/** The toast after Duplicate or Fork, with the way back to the original. */
function ArrivalToast({ arrival, projectName, onDismiss }: ArrivalToastProps) {
  return (
    <Toast
      action={
        <Link
          to={arrival.originalHref}
          className="relative shrink-0 font-semibold whitespace-nowrap text-accent-text underline underline-offset-2 after:absolute after:-inset-x-1 after:-inset-y-2.5"
        >
          Open the original
        </Link>
      }
      onDismiss={onDismiss}
    >
      {arrival.kind === "duplicated" ? (
        <>
          Duplicated as <b className="font-semibold">{projectName}</b>
        </>
      ) : (
        "Forked to My projects."
      )}
    </Toast>
  );
}

const sharePoint = {
  icon: ShareIcon,
  text: (
    <>
      To send it to someone, press <b className="font-semibold">Share</b>. That link works for everyone.
    </>
  ),
};

const introCopy = {
  local: {
    title: "Your project lives in this browser",
    points: [
      { icon: MonitorIcon, text: <>It saves here as you type. No account needed.</> },
      { icon: LinkIcon, text: <>The address bar link only opens it in this browser.</> },
      sharePoint,
    ],
  },
  cloud: {
    title: "Your project is in your Cloud",
    points: [
      { icon: CloudIcon, text: <>It saves to your account as you type.</> },
      { icon: LinkIcon, text: <>The address bar link opens it in any browser you sign in to.</> },
      sharePoint,
    ],
  },
} as const;

/** Explain project storage and let the user opt out of future introductions. */
function ProjectIntroDialog({
  location,
  onClose,
}: {
  location: ProjectLocation;
  onClose: (intro: "seen" | "muted") => void;
}) {
  const copy = introCopy[location];
  const [introChoice, setIntroChoice] = useState<"seen" | "muted">("seen");
  const muteId = useId();

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose(introChoice);
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex max-w-110 flex-col gap-4 rounded-[18px] p-6 shadow-sticker-lg"
        data-slot="project-intro"
      >
        <DialogTitle className="m-0 font-display text-[24px]/[1.15] font-extrabold tracking-[-0.02em]">
          {copy.title}
        </DialogTitle>
        <ul className="m-0 flex list-none flex-col gap-3 p-0" role="list">
          {copy.points.map(({ icon: Icon, text }, index) => (
            <li key={index} className="flex items-start gap-3">
              <span
                className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-surface-2 text-text"
                aria-hidden="true"
              >
                <Icon className="size-4" />
              </span>
              <span className="pt-1.5 text-[14px]/normal text-text">{text}</span>
            </li>
          ))}
        </ul>
        <div className="flex items-center justify-between gap-3 pt-1">
          <label
            htmlFor={muteId}
            className="inline-flex min-h-9 cursor-pointer items-center gap-2 text-[13px] text-muted max-phone:min-h-touch"
          >
            <Checkbox
              id={muteId}
              checked={introChoice === "muted"}
              onCheckedChange={(checked) => setIntroChoice(checked ? "muted" : "seen")}
            />
            Don't show this again
          </label>
          <Button variant="sticker" className="h-9 font-bold max-phone:h-touch" onClick={() => onClose(introChoice)}>
            Got it
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
