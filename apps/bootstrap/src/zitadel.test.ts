import { describe, expect, it } from '@jest/globals';

import {
  ensureHumanUser,
  ensureOidcApp,
  ensureProject,
  oidcConfigMatches,
  type NewHumanUser,
  type OidcApp,
  type OidcAppConfig,
  type ZitadelApi,
} from './zitadel.js';

const desired: OidcAppConfig = {
  redirectUris: ['http://dashboard.localtest.me:3000/auth/callback'],
  postLogoutRedirectUris: ['http://dashboard.localtest.me:3000/'],
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
  appType: 'OIDC_APP_TYPE_WEB',
  authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
  accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
  idTokenUserinfoAssertion: true,
  devMode: true,
  backChannelLogoutUri: 'http://dashboard.localtest.me:3000/auth/backchannel-logout',
};

/** In-memory Zitadel: enough state to tell a find from a create, and a log of every write. */
class FakeZitadel implements ZitadelApi {
  readonly writes: string[] = [];
  readonly projects = new Map<string, string>();
  readonly apps = new Map<string, OidcApp>();
  readonly users = new Map<string, string>();
  private nextId = 1;

  findProjectByName(name: string): Promise<{ id: string } | undefined> {
    const id = this.projects.get(name);
    return Promise.resolve(id ? { id } : undefined);
  }

  createProject(name: string): Promise<{ id: string }> {
    const id = this.id();
    this.projects.set(name, id);
    this.writes.push(`createProject ${name}`);
    return Promise.resolve({ id });
  }

  findOidcAppByName(projectId: string, name: string): Promise<OidcApp | undefined> {
    return Promise.resolve(this.apps.get(`${projectId}/${name}`));
  }

  createOidcApp(projectId: string, name: string, config: OidcAppConfig): Promise<OidcApp> {
    const app = { appId: this.id(), clientId: `client-${this.id()}`, config };
    this.apps.set(`${projectId}/${name}`, app);
    this.writes.push(`createOidcApp ${name}`);
    return Promise.resolve(app);
  }

  updateOidcAppConfig(projectId: string, appId: string, config: OidcAppConfig): Promise<void> {
    for (const [key, app] of this.apps) {
      if (key.startsWith(`${projectId}/`) && app.appId === appId) {
        this.apps.set(key, { ...app, config });
      }
    }
    this.writes.push(`updateOidcAppConfig ${appId}`);
    return Promise.resolve();
  }

  findUserByUsername(username: string): Promise<{ id: string } | undefined> {
    const id = this.users.get(username);
    return Promise.resolve(id ? { id } : undefined);
  }

  createHumanUser(user: NewHumanUser): Promise<{ id: string }> {
    const id = this.id();
    this.users.set(user.username, id);
    this.writes.push(`createHumanUser ${user.username}`);
    return Promise.resolve({ id });
  }

  private id(): string {
    return String(this.nextId++);
  }
}

describe('ensureProject', () => {
  it('creates a missing project and finds it on the next run', async () => {
    const api = new FakeZitadel();
    const first = await ensureProject(api, 'auth-stack-exercise');
    const second = await ensureProject(api, 'auth-stack-exercise');
    expect(first.action).toBe('created');
    expect(second).toEqual({ id: first.id, action: 'exists' });
    expect(api.writes).toEqual(['createProject auth-stack-exercise']);
  });
});

describe('ensureOidcApp', () => {
  it('creates a missing application and leaves it alone when the settings match', async () => {
    const api = new FakeZitadel();
    const first = await ensureOidcApp(api, 'p1', 'dashboard-web', desired);
    const second = await ensureOidcApp(api, 'p1', 'dashboard-web', desired);
    expect(first.action).toBe('created');
    expect(second).toEqual({ appId: first.appId, clientId: first.clientId, action: 'unchanged' });
    expect(api.writes).toEqual(['createOidcApp dashboard-web']);
  });

  it('updates an existing application whose settings differ and keeps its client ID', async () => {
    const api = new FakeZitadel();
    const created = await ensureOidcApp(api, 'p1', 'dashboard-web', desired);
    const changed = {
      ...desired,
      backChannelLogoutUri: 'http://dashboard.localtest.me:3000/auth/backchannel',
    };
    const updated = await ensureOidcApp(api, 'p1', 'dashboard-web', changed);
    const again = await ensureOidcApp(api, 'p1', 'dashboard-web', changed);
    expect(updated).toEqual({
      appId: created.appId,
      clientId: created.clientId,
      action: 'updated',
    });
    expect(again.action).toBe('unchanged');
    expect(api.writes).toEqual([
      'createOidcApp dashboard-web',
      `updateOidcAppConfig ${created.appId}`,
    ]);
  });
});

describe('oidcConfigMatches', () => {
  it('treats fields the API omits as their protobuf zero values', () => {
    const asReturnedByZitadel: Partial<OidcAppConfig> = {
      redirectUris: desired.redirectUris,
      postLogoutRedirectUris: desired.postLogoutRedirectUris,
      responseTypes: desired.responseTypes,
      grantTypes: [...desired.grantTypes].reverse(),
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
      idTokenUserinfoAssertion: true,
      devMode: true,
      backChannelLogoutUri: desired.backChannelLogoutUri,
    };
    expect(oidcConfigMatches(asReturnedByZitadel, desired)).toBe(true);
    expect(oidcConfigMatches({}, { ...desired, devMode: false, backChannelLogoutUri: '' })).toBe(
      false,
    );
  });

  it('reports a missing or extra URI as a difference', () => {
    expect(oidcConfigMatches({ ...desired, redirectUris: [] }, desired)).toBe(false);
    expect(
      oidcConfigMatches(
        { ...desired, redirectUris: [...desired.redirectUris, 'http://other/cb'] },
        desired,
      ),
    ).toBe(false);
  });
});

describe('ensureHumanUser', () => {
  const alice: NewHumanUser = {
    username: 'alice@example.com',
    email: 'alice@example.com',
    givenName: 'Alice',
    familyName: 'Adams',
    password: 'Password1!',
  };

  it('creates a missing user and skips an existing one', async () => {
    const api = new FakeZitadel();
    const first = await ensureHumanUser(api, alice);
    const second = await ensureHumanUser(api, alice);
    expect(first.action).toBe('created');
    expect(second).toEqual({ id: first.id, action: 'exists' });
    expect(api.writes).toEqual(['createHumanUser alice@example.com']);
  });
});
