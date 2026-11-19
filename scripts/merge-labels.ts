// Merges two vocabulary tricks (BACKEND_DESIGN.md §1.2.29): every name of
// the trick <name> names resolves to <same_as>'s canonical from a new
// taxonomy version on, and the candidates the merge settles are dropped.
// The app picks the merge up from GET /api/taxonomy/current.
//
//   bun run labels:merge <name> <same_as>

import { mergeLabelsCli } from "../src/labels";
import { runCli } from "./run";

await runCli(mergeLabelsCli);
