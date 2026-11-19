// Lists the open synonym candidates (BACKEND_DESIGN.md §1.2.29): pairs of
// names app users marked as one trick, with how many accounts sent each,
// most first. Candidates expire 30 days after submission.
//
//   bun run labels:synonyms [--min N]

import { labelSynonymsCli } from "../src/labels";
import { runCli } from "./run";

await runCli(labelSynonymsCli);
