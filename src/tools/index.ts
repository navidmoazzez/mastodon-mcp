/** Every tool, in the order they appear in the README. */

import type { AnyToolSpec } from "./kit.js";

import { accountTools } from "./accounts.js";
import { statusTools } from "./statuses.js";
import { engageTools } from "./engage.js";
import { timelineTools } from "./timelines.js";
import { discoverTools } from "./discover.js";
import { graphTools } from "./graph.js";
import { notificationTools } from "./notifications.js";

export const ALL_TOOLS: AnyToolSpec[] = [
  ...accountTools,
  ...statusTools,
  ...engageTools,
  ...timelineTools,
  ...discoverTools,
  ...graphTools,
  ...notificationTools,
];
