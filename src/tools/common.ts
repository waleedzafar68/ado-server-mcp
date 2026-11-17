import { z } from 'zod';
import type { Target } from '../ado/ado-client.js';
import { AdoError } from '../ado/errors.js';
import { safeSegment } from '../ado/http.js';
import type { ResolvedScope } from '../context/context-resolver.js';

export const collectionArg = z
  .string()
  .min(1)
  .optional()
  .describe('Azure DevOps collection, e.g. "DemoCollection". Omit to infer it from gitRemoteUrl, your configured collections or the workspace.');
export const projectArg = z.string().min(1).optional().describe('Project name or id. Omit to infer it.');
export const repositoryArg = z.string().min(1).optional().describe('Git repository name or id. Omit to infer it.');
export const gitRemoteUrlArg = z
  .string()
  .min(1)
  .optional()
  .describe("Output of `git remote get-url origin` in the user's terminal. Lets the server infer collection, project and repository.");

export const topArg = (fallback: number, max: number) =>
  z.number().int().min(1).max(max).default(fallback).describe(`Maximum number of items to return (default ${fallback}, max ${max}).`);

export const scopeShape = { collection: collectionArg, project: projectArg, gitRemoteUrl: gitRemoteUrlArg };
export const repoShape = { ...scopeShape, repository: repositoryArg };

// Project-scoped URL: {collection}/{project}/_apis/...
export function targetOf(scope: ResolvedScope): Target {
  return { serverUrl: scope.serverUrl, collection: scope.collection, project: scope.project };
}

// Collection-scoped URL: {collection}/_apis/... (projects, work items by id, identities, attachments)
export function collectionOf(scope: ResolvedScope): Target {
  return { serverUrl: scope.serverUrl, collection: scope.collection };
}

export function at<T = unknown>(value: unknown, ...path: string[]): T | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current as T | undefined;
}

export const seg = safeSegment;

export interface IdentitySummary {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

export function identity(ref: unknown): IdentitySummary | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const value = ref as { id?: string; displayName?: string; uniqueName?: string };
  return { id: value.id, displayName: value.displayName, uniqueName: value.uniqueName };
}

export const shortRef = (ref: string | undefined): string | undefined => ref?.replace(/^refs\/heads\//, '');
export const toRef = (branch: string): string => (branch.startsWith('refs/') ? branch : `refs/heads/${branch}`);
export const baseVersion = (version: string): string => version.split('-')[0] ?? version;
export const preview = (version: string): string => (version.includes('-preview') ? version : `${version}-preview`);
export const previewRevision = (version: string, revision: number): string => `${baseVersion(version)}-preview.${revision}`;

export function requireValue<T>(value: T | undefined, what: string): T {
  if (value === undefined || value === null || value === '') throw new AdoError('bad_request', `${what} is required.`);
  return value;
}