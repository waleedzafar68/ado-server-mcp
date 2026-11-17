import { describe, expect, it } from 'vitest';
import { replay, requestKey, Scrubber, type ContractFixture } from '../contracts/contract-format.js';

describe('contract fixtures', () => {
  it('scrubs secrets, people, accounts, emails and the real host', () => {
    const scrubber = new Scrubber('devops.example.com', ['secret-pat-123']);
    const body = JSON.stringify({
      authenticatedUser: { id: 'u-1', providerDisplayName: 'Jordan Example', properties: { Account: { $value: 'CORPTEST\\demo.user' } } },
      createdBy: { displayName: 'Jordan Example', uniqueName: 'demo.user@example.com' },
      reviewer: { displayName: 'Jordan Example' },
      remoteUrl: 'https://devops.example.com/tfs/DemoCollection/_git/x',
      comment: 'token secret-pat-123 leaked by CORPTEST\\someone',
    });
    const out = JSON.parse(scrubber.body(body, 'application/json; charset=utf-8'));
    expect(out.authenticatedUser).toEqual({ id: 'u-1', providerDisplayName: 'User 1', properties: { Account: { $value: 'DOMAIN\\user' } } });
    expect(out.createdBy).toEqual({ displayName: 'User 1', uniqueName: 'User 2' });
    expect(out.reviewer.displayName).toBe('User 1');
    expect(out.remoteUrl).toBe('https://ado.example/tfs/DemoCollection/_git/x');
    expect(out.comment).toBe('token *** leaked by DOMAIN\\user');
    expect(scrubber.body('##[error] demo.user@example.com secret-pat-123', 'text/plain')).toBe('##[error] user@example.invalid ***');

    const commit = JSON.parse(scrubber.body(JSON.stringify({
      value: [{ author: { name: 'Jordan Example', email: 'demo.user@example.com', date: '2026-11-16' }, comment: 'Bump to 16.0.0.0' }],
      workerName: 'DEMO-WORKER-07',
      log: 'C:\\Users\\demo.user\\agent\\_work on 10.20.30.40 and /home/demouser/x',
    }), 'application/json'));
    expect(commit.value[0]).toEqual({ author: { name: 'User 1', email: 'user@example.invalid', date: '2026-11-16' }, comment: 'Bump to 16.0.0.0' });
    expect(commit.workerName).toBe('Agent 1');
    expect(commit.log).toBe('C:\\Users\\user\\agent\\_work on 192.0.2.1 and /home/user/x');

    expect(scrubber.text('corptest\\demo.user ran D:\\agent\\corptest\\x on 127.0.0.1, 169.254.10.2, 100.100.1.1; keep 100.1.2.3 and 16.0.0.0')).toBe(
      'DOMAIN\\user ran D:\\agent\\corptest\\x on 192.0.2.1, 192.0.2.1, 192.0.2.1; keep 100.1.2.3 and 16.0.0.0',
    );
  });

  it('keys requests by the path below the server URL and the sorted query', () => {
    const url = new URL('https://ado.example/tfs/DemoCollection/DemoProject/_apis/build/builds/5/logs/7?endLine=20&api-version=6.0&startLine=1');
    expect(requestKey(url, 'https://ado.example/tfs')).toEqual({
      path: '/DemoCollection/DemoProject/_apis/build/builds/5/logs/7',
      query: 'api-version=6.0&endLine=20&startLine=1',
    });
  });

  it('replays recorded responses in order, then repeats the last, and reports misses', async () => {
    const exchange = (count: number) => ({
      method: 'GET', path: '/DemoCollection/_apis/projects', query: 'api-version=6.0', status: 200, contentType: 'application/json', body: JSON.stringify({ count }),
    });
    const fixture: ContractFixture = {
      flavor: 'server-2020', recordedAt: '', serverUrl: 'https://ado.example/tfs', collections: ['DemoCollection'], calls: [], facts: {}, exchanges: [exchange(1), exchange(2)],
    };
    const recorded = replay(fixture);
    const url = 'https://ado.example/tfs/DemoCollection/_apis/projects?api-version=6.0';
    expect(await (await recorded.fetch(url)).json()).toEqual({ count: 1 });
    expect(await (await recorded.fetch(url)).json()).toEqual({ count: 2 });
    expect(await (await recorded.fetch(url)).json()).toEqual({ count: 2 });
    await expect(recorded.fetch('https://ado.example/tfs/DemoCollection/_apis/teams?api-version=6.0')).rejects.toThrow(/no recorded response/);
    expect(recorded.misses).toEqual(['GET /DemoCollection/_apis/teams?api-version=6.0']);
  });
});

describe('structured identity metadata', () => {
  it('aliases bare Account property values while preserving typed bags and stable aliases', () => {
    const scrubber = new Scrubber('server.example.invalid', []);
    const identity = {
      id: '11111111-2222-4333-8444-555555555555',
      providerDisplayName: 'Synthetic Person',
      properties: {
        Account: { $type: 'System.String', $value: 'synthetic.account' },
        ResourceId: { $type: 'System.Guid', $value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      },
    };
    const input = JSON.stringify({
      authenticatedUser: identity,
      authorizedUser: identity,
      workerName: 'synthetic-worker',
      Account: { $type: 'System.String', $value: 'ordinary-resource' },
    });
    const body = scrubber.body(input, 'application/json');
    const out = JSON.parse(body);
    expect(out.authenticatedUser).toEqual({
      id: '11111111-2222-4333-8444-555555555555',
      providerDisplayName: 'User 1',
      properties: {
        Account: { $type: 'System.String', $value: 'User 2' },
        ResourceId: { $type: 'System.Guid', $value: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
      },
    });
    expect(out.authorizedUser).toEqual(out.authenticatedUser);
    expect(out.workerName).toBe('Agent 1');
    expect(out.Account).toEqual({ $type: 'System.String', $value: 'ordinary-resource' });
    expect(body).not.toContain('synthetic.account');
    expect(scrubber.body(input, 'application/json')).toBe(body);
    expect(scrubber.body(body, 'application/json', false)).toBe(body);
    expect(scrubber.body(input, 'application/json', false)).toBe(input);
  });

  it.each([
    ['personal', 'win.', 'S-1-5-21-101-202-303-404'],
    ['service', 's2s.', 'Microsoft.TeamFoundation.ServiceIdentity;synthetic-service'],
  ])('aliases %s avatar links without rewriting ordinary hrefs or operational ids', (_kind, prefix, token) => {
    const scrubber = new Scrubber('server.example.invalid', []);
    const descriptor = `${prefix}${Buffer.from(token).toString('base64')}`;
    const avatar = `https://ado.example/tfs/_apis/GraphProfile/MemberAvatars/${descriptor}`;
    const resource = 'https://ado.example/tfs/_apis/build/builds/42';
    const identity = {
      displayName: 'Synthetic Identity',
      url: 'https://ado.example/tfs/_apis/Identities/11111111-2222-4333-8444-555555555555',
      imageUrl: avatar,
      _links: { avatar: { href: avatar }, self: { href: resource } },
      id: '11111111-2222-4333-8444-555555555555',
      uniqueName: 'synthetic-identity',
      descriptor,
    };
    const input = JSON.stringify({ value: [
      { id: 42, requestedFor: identity, requestedBy: identity, lastChangedBy: identity },
      { id: 43, requestedFor: identity, requestedBy: identity, lastChangedBy: identity },
    ], _links: { self: { href: resource } }, avatar: { href: resource } });
    const body = scrubber.body(input, 'application/json');
    const out = JSON.parse(body);
    for (const build of out.value) {
      for (const key of ['requestedFor', 'requestedBy', 'lastChangedBy']) {
        expect(build[key]).toEqual({
          displayName: 'User 1',
          url: 'https://ado.example/tfs/_apis/Identities/11111111-2222-4333-8444-555555555555',
          imageUrl: 'User 2',
          _links: { avatar: { href: 'User 2' }, self: { href: resource } },
          id: '11111111-2222-4333-8444-555555555555',
          uniqueName: 'User 3',
          descriptor: 'User 4',
        });
      }
    }
    expect(out.value.map((build: { id: number }) => build.id)).toEqual([42, 43]);
    expect(out._links).toEqual({ self: { href: resource } });
    expect(out.avatar).toEqual({ href: resource });
    expect(body).not.toContain(descriptor);
    expect(scrubber.body(input, 'application/json')).toBe(body);
    expect(scrubber.body(body, 'application/json', false)).toBe(body);
    expect(scrubber.body(input, 'application/json', false)).toBe(input);
  });
});
