// Flags a source as the maintainer's curated holdout, or clears the flag
// (BACKEND_DESIGN.md §1.2.28). The export carries `holdout` on every row;
// turnip-ml evaluates on flagged sources and never trains on them.
//
//   bun run sources:holdout <video_id>
//   bun run sources:holdout <video_id> --clear

import { sourceHoldoutCli } from "../src/holdout";
import { runCli } from "./run";

await runCli(sourceHoldoutCli);
