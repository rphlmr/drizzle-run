import { db } from "@drizzle-run/runtime/context";
import { sql } from "drizzle-orm";

import { jsonbBuildObject } from "./helpers";

const profiles = await db.query.users.findMany({
  columns: {},
  extras: {
    profile: (user) => jsonbBuildObject({ id: user.id, displayName: user.name, bio: user.bio, active: user.active }),
  },
  orderBy: { id: "asc" },
});

$.display("Profiles", profiles);

const cards = await db.query.posts.findMany({
  columns: { id: true, title: true },
  extras: { titleLength: (post) => sql<number>`length(${post.title})` },
  with: {
    author: {
      columns: {},
      extras: {
        profile: (user) => jsonbBuildObject({ id: user.id, displayName: user.name, bio: user.bio, active: user.active }),
      },
    },
  },
  orderBy: { id: "asc" },
});

$.display("Post cards", cards);
