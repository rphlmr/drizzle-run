import { db } from "@drizzle-run/runtime/context";

/** Fetch a numbered page; callers supply a positive page number and page size. */
async function getPage({ page, pageSize }: { page: number; pageSize: number }) {
  return db.query.posts.findMany({
    orderBy: { createdAt: "asc", id: "asc" },
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });
}

$.display("Offset page 1", await getPage({ page: 1, pageSize: 2 }));
$.display("Offset page 2", await getPage({ page: 2, pageSize: 2 }));
$.display("Jump to page 3", await getPage({ page: 3, pageSize: 2 }));
