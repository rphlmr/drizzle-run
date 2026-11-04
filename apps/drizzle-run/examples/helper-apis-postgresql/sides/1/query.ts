import { db } from "@drizzle-run/runtime/context";
import { eq, sql } from "drizzle-orm";

import { jsonbBuildObject } from "./helpers";
import { posts, users } from "./schema";

const profiles = await db.select({
  profile: jsonbBuildObject({ id: users.id, displayName: users.name, bio: users.bio, active: users.active }),
}).from(users).orderBy(users.id);

$.display("Profiles", profiles);

const cards = await db.select({
  id: posts.id,
  title: posts.title,
  titleLength: sql<number>`length(${posts.title})`,
  author: {
    profile: jsonbBuildObject({ id: users.id, displayName: users.name, bio: users.bio, active: users.active }),
  },
}).from(posts).innerJoin(users, eq(posts.authorId, users.id)).orderBy(posts.id);

$.display("Post cards", cards);
