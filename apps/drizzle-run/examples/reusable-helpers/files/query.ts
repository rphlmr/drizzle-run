import { db } from "@drizzle-run/runtime/context";
import { sql } from "drizzle-orm";

import { users } from "./schema";

type Profile = {
  id: number;
  displayName: string;
  bio: string | null;
  active: boolean;
};

const profiles = await db.select({
  profile: sql<Profile>`jsonb_build_object(
    'id', ${users.id},
    'displayName', ${users.name},
    'bio', ${users.bio},
    'active', ${users.active}
  )`,
}).from(users).orderBy(users.id);

$.display("Profiles", profiles);
