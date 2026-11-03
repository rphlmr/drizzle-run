import { db } from "@drizzle-run/runtime/context";
import { eq, exists, sql } from "drizzle-orm";
import { comments, files, fileTags, tags, users } from "./schema";

// sql<T> describes the result; it does not validate JSON or decode nested dates.
// These objects contain only integer IDs, text and null.
type Comment = Pick<typeof comments.$inferSelect, "id" | "text"> & {
  author: Pick<typeof users.$inferSelect, "id" | "name">;
};
type Tag = Pick<typeof tags.$inferSelect, "id" | "name">;

const commentsByFile = db
  .select({
    fileId: comments.fileId,
    comments: sql<Comment[]>`jsonb_agg(
      jsonb_build_object(
        'id', ${comments.id},
        'text', ${comments.text},
        'author', jsonb_build_object('id', ${users.id}, 'name', ${users.name})
      ) order by ${comments.id}
    )`.as("comments"),
  })
  .from(comments)
  .innerJoin(users, eq(comments.authorId, users.id))
  .groupBy(comments.fileId)
  .as("comments_by_file");

const tagsByFile = db
  .select({
    fileId: fileTags.fileId,
    tags: sql<Tag[]>`jsonb_agg(
      jsonb_build_object('id', ${tags.id}, 'name', ${tags.name})
      order by ${tags.id}
    )`.as("tags"),
  })
  .from(fileTags)
  .innerJoin(tags, eq(fileTags.tagId, tags.id))
  .groupBy(fileTags.fileId)
  .as("tags_by_file");

const selection = {
  id: files.id,
  name: files.name,
  // A missing group becomes null after the LEFT JOIN, so coalesce here.
  comments: sql<Comment[]>`coalesce(${commentsByFile.comments}, '[]'::jsonb)`,
  tags: sql<Tag[]>`coalesce(${tagsByFile.tags}, '[]'::jsonb)`,
};

const allFiles = await db.select(selection).from(files)
  .leftJoin(commentsByFile, eq(commentsByFile.fileId, files.id))
  .leftJoin(tagsByFile, eq(tagsByFile.fileId, files.id))
  .orderBy(files.id);

$.display("Files with comments and tags", allFiles);

// Filter the files by membership, without trimming the returned tag arrays.
const tagId = 1;
const matchingTag = db.select({ fileId: fileTags.fileId }).from(fileTags)
  .where(sql`${fileTags.fileId} = ${files.id} and ${fileTags.tagId} = ${tagId}`);

const matchingFiles = await db.select(selection).from(files)
  .leftJoin(commentsByFile, eq(commentsByFile.fileId, files.id))
  .leftJoin(tagsByFile, eq(tagsByFile.fileId, files.id))
  .where(exists(matchingTag))
  .orderBy(files.id);

$.display("Files tagged release, with all their tags", matchingFiles);
