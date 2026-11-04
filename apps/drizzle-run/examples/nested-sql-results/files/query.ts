import { db } from "@drizzle-run/runtime/context";
import { eq } from "drizzle-orm";

import { comments, files, fileTags, tags } from "./schema";

const joined = await db.select({
  file: files.name,
  commentId: comments.id,
  text: comments.text,
  tag: tags.name,
}).from(files)
  .leftJoin(comments, eq(comments.fileId, files.id))
  .leftJoin(fileTags, eq(fileTags.fileId, files.id))
  .leftJoin(tags, eq(tags.id, fileTags.tagId))
  .orderBy(files.id, comments.id, tags.id);

$.display("Joined rows", joined);
