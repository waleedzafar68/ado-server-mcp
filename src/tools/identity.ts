import type { AdoClient, Target } from '../ado/ado-client.js';
import { AdoError } from '../ado/errors.js';
import { baseVersion, preview } from './common.js';

export interface Me {
  id: string;
  displayName?: string;
  uniqueName?: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function whoAmI(client: AdoClient, target: Target): Promise<Me> {
  const base = { serverUrl: target.serverUrl, collection: target.collection };
  const version = preview(baseVersion(await client.version(base, 'core')));
  const data = await client.get<{
    authenticatedUser?: { id?: string; providerDisplayName?: string; properties?: { Account?: { $value?: string } } };
  }>({ ...base, path: '_apis/connectionData', area: 'core', apiVersion: version });
  const user = data.authenticatedUser;
  if (!user?.id) throw new AdoError('auth', `Azure DevOps Server did not return the signed-in user for ${target.collection}.`);
  return { id: user.id, displayName: user.providerDisplayName, uniqueName: user.properties?.Account?.$value };
}

export async function resolveIdentityId(client: AdoClient, target: Target, value: string): Promise<string> {
  if (GUID.test(value)) return value;
  const base = { serverUrl: target.serverUrl, collection: target.collection };
  const data = await client.get<{ value?: Array<{ id: string }> }>({
    ...base,
    path: '_apis/identities',
    area: 'core',
    query: { searchFilter: 'General', filterValue: value, queryMembership: 'None' },
    apiVersion: baseVersion(await client.version(base, 'core')),
  });
  const matches = data.value ?? [];
  const first = matches[0];
  if (!first) throw new AdoError('not_found', `No Azure DevOps identity matches "${value}".`);
  if (matches.length > 1) {
    throw new AdoError('bad_request', `"${value}" matches ${matches.length} identities. Use the exact domain account (DOMAIN\\user), email or identity id.`);
  }
  return first.id;
}