import { CheckIcon, ChevronDownIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { cn } from "../lib/utils";
import { KindBadge } from "../ui/kind-badge";
import { PHONE_QUERY, useMediaQuery } from "../ui/use-media-query";
import { formatProjectDialects, type ProjectRecord } from "./projects";

function getDialectLabel(project: ProjectRecord) {
  return formatProjectDialects(project.manifest);
}

const itemClass = cn(
  "flex min-h-10 w-full items-center gap-2.5 rounded-sm border-0 bg-transparent px-2.5 py-2 text-left text-text hover:bg-surface-2 aria-[current=true]:bg-mark",
);
const itemNameClass = cn("min-w-0 flex-1 truncate font-medium");
const itemMetaClass = cn("text-[12px] text-muted");
const separatorClass = cn("mx-1 my-1.5 h-px bg-border");
const actionClass = cn(
  "min-h-[34px] flex-1 rounded-sm border-0 bg-transparent text-[13px] text-text hover:bg-surface-2",
);

export interface ProjectSwitcherProps {
  projects: readonly ProjectRecord[];
  current: ProjectRecord | undefined;
  disabled?: boolean;
  /** The short save state, shown under the name on phones where the status bar is gone. */
  saveLabel?: string;
  onSelect: (project: ProjectRecord) => void;
  onCreate: () => void;
  onRename: () => void;
  onDuplicate: () => void;
  onExport: () => void;
  onDelete: () => void;
}

/** The current project's name, opening a menu to switch, create, rename, duplicate, export or delete projects. */
export function ProjectSwitcher({
  projects,
  current,
  disabled = false,
  saveLabel,
  onSelect,
  onCreate,
  onRename,
  onDuplicate,
  onExport,
  onDelete,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const phone = useMediaQuery(PHONE_QUERY);
  const needle = query.trim().toLocaleLowerCase();
  const visible =
    needle === "" ? projects : projects.filter((project) => project.name.toLocaleLowerCase().includes(needle));
  // Close first so focus returns to the trigger before the action opens a dialog.
  const run = (action: () => void) => () => {
    setOpen(false);
    action();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);

        if (!next) {
          setQuery("");
        }
      }}
    >
      <PopoverTrigger
        className={cn(
          "flex h-9 max-w-70 items-center gap-2 rounded-base border border-border bg-surface pr-2.5 pl-3 text-text hover:bg-surface-2 max-phone:h-touch max-phone:w-full max-phone:max-w-none [&_svg]:size-3 [&_svg]:shrink-0 [&_svg]:text-muted",
          "max-phone:group-data-playground/header:relative max-phone:group-data-playground/header:h-9 max-phone:group-data-playground/header:border-transparent max-phone:group-data-playground/header:bg-transparent max-phone:group-data-playground/header:px-1.5 max-phone:group-data-playground/header:after:absolute max-phone:group-data-playground/header:after:inset-x-0 max-phone:group-data-playground/header:after:-inset-y-1.25",
        )}
        aria-label="Switch project"
        disabled={disabled}
      >
        {phone && current && saveLabel !== undefined ? (
          <span className="flex min-w-0 flex-col items-start text-left leading-[1.2]">
            <span className="max-w-full truncate text-[14px] font-semibold group-data-playground/header:font-[650]">
              {current.name}
            </span>
            <output className="max-w-full truncate text-[12px] text-muted group-data-playground/header:sr-only">
              {getDialectLabel(current)} · {saveLabel}
            </output>
          </span>
        ) : (
          <span className="truncate font-semibold">{current?.name ?? "Projects"}</span>
        )}
        <ChevronDownIcon className="max-phone:ml-auto max-phone:group-data-playground/header:ml-0" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent className="flex w-[min(340px,calc(100vw-24px))] flex-col gap-0.5 p-2" aria-label="Your projects">
        <PopoverTitle className="sr-only">Your projects</PopoverTitle>
        <input
          className="mb-1.5 h-9 w-full rounded-base border border-border bg-bg px-2.5 text-text focus-visible:border-accent-text focus-visible:outline-transparent"
          type="search"
          placeholder="Search projects"
          aria-label="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="px-2.5 pt-1.5 pb-1 text-[12px] text-muted">Your projects</div>
        <div className="flex max-h-70 flex-col gap-0.5 overflow-y-auto">
          {visible.length === 0 && (
            <p className="mx-2.5 my-1.5 text-[13px] text-muted">No project matches “{query}”.</p>
          )}
          {visible.map((project) => (
            <button
              key={project.id}
              type="button"
              className={itemClass}
              aria-current={project.id === current?.id ? "true" : undefined}
              onClick={run(() => onSelect(project))}
            >
              <span className={itemNameClass}>{project.name}</span>
              <span className={itemMetaClass}>{getDialectLabel(project)}</span>
              <span className="inline-flex w-4 text-accent-text" aria-hidden="true">
                {project.id === current?.id && <CheckIcon />}
              </span>
            </button>
          ))}
        </div>
        <div className={separatorClass} />
        <button type="button" className={itemClass} onClick={run(onCreate)}>
          <PlusIcon aria-hidden="true" /> New project
        </button>
        <Link to="/projects" className={itemClass} onClick={() => setOpen(false)}>
          <span className={itemNameClass}>My projects</span>
          <span className={itemMetaClass}>{projects.length}</span>
        </Link>
        <Link to="/examples" className={itemClass} onClick={() => setOpen(false)}>
          <span className={itemNameClass}>Browse examples</span>
          <KindBadge tone="lime">Official</KindBadge>
        </Link>
        {current && (
          <>
            <div className={separatorClass} />
            <fieldset className="flex min-w-auto gap-1 px-0.5" aria-label={`Actions for ${current.name}`}>
              <button type="button" className={actionClass} onClick={run(onRename)}>
                Rename
              </button>
              <button type="button" className={actionClass} onClick={run(onDuplicate)}>
                Duplicate
              </button>
              <button type="button" className={actionClass} onClick={run(onExport)}>
                Export
              </button>
              <button type="button" className={cn(actionClass, "text-err")} onClick={run(onDelete)}>
                Delete
              </button>
            </fieldset>
          </>
        )}
        <p className="mx-2.5 mt-2 mb-0.5 text-[12px] leading-normal text-muted">
          Stored in this browser. Export JSON to keep a backup.
        </p>
      </PopoverContent>
    </Popover>
  );
}
