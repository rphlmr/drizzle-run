import { db } from "@drizzle-run/runtime/context";
import { authors, books } from "./schema";

await db.insert(authors).values([
  { id: 1, name: "Ursula K. Le Guin" },
  { id: 2, name: "Octavia E. Butler" },
  { id: 3, name: "Italo Calvino" },
  { id: 4, name: "Toni Morrison" },
]);

await db.insert(books).values([
  { authorId: 1, title: "The Left Hand of Darkness", genre: "Science fiction", year: 1969 },
  { authorId: 1, title: "A Wizard of Earthsea", genre: "Fantasy", year: 1968 },
  { authorId: 2, title: "Kindred", genre: "Science fiction", year: 1979 },
  { authorId: 2, title: "Parable of the Sower", genre: "Science fiction", year: 1993 },
  { authorId: 3, title: "Invisible Cities", genre: "Fiction", year: 1972 },
  { authorId: null, title: "Beowulf", genre: "Poetry", year: 1000 },
]);
