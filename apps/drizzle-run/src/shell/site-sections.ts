import { BookOpenIcon, FolderIcon, UsersIcon } from "lucide-react";

/** The site sections, in the desktop nav and the phone menu. */
export const SITE_SECTIONS = [
  { to: "/examples", label: "Examples & Guides", icon: BookOpenIcon },
  { to: "/projects", label: "My projects", icon: FolderIcon },
  { to: "/community", label: "Community", icon: UsersIcon },
] as const;
