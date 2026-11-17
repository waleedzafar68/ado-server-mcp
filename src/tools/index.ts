import { boardTools } from './board-tools.js';
import { buildTools } from './build-tools.js';
import { contextTools } from './context-tools.js';
import { projectTools } from './project-tools.js';
import { pullRequestTools } from './pullrequest-tools.js';
import { queryTools } from './query-tools.js';
import { releaseTools } from './release-tools.js';
import type { AnyTool } from './registry.js';
import { repositoryTools } from './repository-tools.js';
import { workItemTools } from './workitem-tools.js';
import { wikiTools } from './wiki-tools.js';
import { tfvcTools } from './tfvc-tools.js';

export const ALL_TOOLS: AnyTool[] = [
  ...contextTools,
  ...projectTools,
  ...workItemTools,
  ...queryTools,
  ...boardTools,
  ...repositoryTools,
  ...pullRequestTools,
  ...buildTools,
  ...releaseTools,
  ...wikiTools,
  ...tfvcTools,
];
