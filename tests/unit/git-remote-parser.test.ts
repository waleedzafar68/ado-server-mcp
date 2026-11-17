import { describe, expect, it } from 'vitest';
import { parseGitRemoteUrl } from '../../src/context/git-remote-parser.js';

describe('parseGitRemoteUrl', () => {
  it.each([
    ['https://devops.example.com/tfs/DemoCollection/DemoProject/_git/ado-server-mcp',
      { serverUrl: 'https://devops.example.com/tfs', collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' }],
    ['https://demo.user@devops.example.com/tfs/DemoCollection/_git/DemoProject',
      { serverUrl: 'https://devops.example.com/tfs', collection: 'DemoCollection', project: 'DemoProject', repository: 'DemoProject' }],
    ['https://ado25.corp.local/DefaultCollection/MyProject/_git/my-repo',
      { serverUrl: 'https://ado25.corp.local', collection: 'DefaultCollection', project: 'MyProject', repository: 'my-repo' }],
    ['https://ado25.corp.local:8443/tfs/DemoCollection/Demo%20Product/_git/product-api',
      { serverUrl: 'https://ado25.corp.local:8443/tfs', collection: 'DemoCollection', project: 'Demo Product', repository: 'product-api' }],
    ['ssh://devops.example.com:22/tfs/DemoCollection/DemoProject/_ssh/ado-server-mcp',
      { serverUrl: undefined, sshHost: 'devops.example.com', collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' }],
    ['https://ado.corp.local/devops/Coll/Proj/_git/repo',
      { serverUrl: 'https://ado.corp.local/devops', collection: 'Coll', project: 'Proj', repository: 'repo' }],
    ['http://legacy-devops:8080/tfs/DemoCollection/DemoProject/_git/ado-server-mcp',
      { serverUrl: 'http://legacy-devops:8080/tfs', collection: 'DemoCollection', project: 'DemoProject', repository: 'ado-server-mcp' }],
  ])('parses %s', (remote, expected) => {
    expect(parseGitRemoteUrl(remote)).toStrictEqual(expected);
  });

  it('uses known collections to read a custom virtual directory', () => {
    expect(parseGitRemoteUrl('https://ado.corp.local/devops/Coll/_git/repo', ['coll'])).toStrictEqual({
      serverUrl: 'https://ado.corp.local/devops', collection: 'Coll', project: 'repo', repository: 'repo',
    });
  });

  it.each([
    'https://github.com/org/repo.git',
    'https://dev.azure.com/org/proj/_git/repo',
    'https://org.visualstudio.com/proj/_git/repo',
    'git@github.com:org/repo.git',
    'https://devops.example.com/tfs/_git/repo',
    '',
  ])('ignores non on-prem remote %s', (remote) => {
    expect(parseGitRemoteUrl(remote)).toBeUndefined();
  });
});