import { getNextPage } from "./pagination";

const first = await getNextPage();

$.display("Cursor page 1", first);

if (first.nextCursor) {
  const second = await getNextPage({ after: first.nextCursor });
  $.display("Cursor page 2", second);

  if (second.nextCursor) {
    $.display("Cursor page 3", await getNextPage({ after: second.nextCursor }));
  }
}
