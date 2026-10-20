import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

import { describe, expect, it } from '@jest/globals';

import {
  ensureApiApp,
  ensureAppKey,
  ensureHumanUser,
  ensureOidcApp,
  ensureProject,
  oidcConfigMatches,
  toPkcs8Pem,
  type ApiApp,
  type ApiAppConfig,
  type AppKey,
  type NewHumanUser,
  type OidcApp,
  type OidcAppConfig,
  type ZitadelApi,
} from './zitadel';

const desired: OidcAppConfig = {
  redirectUris: ['http://dashboard.localtest.me:3000/auth/callback'],
  postLogoutRedirectUris: ['http://dashboard.localtest.me:3000/'],
  responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
  grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
  appType: 'OIDC_APP_TYPE_WEB',
  authMethodType: 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT',
  accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
  idTokenUserinfoAssertion: true,
  // What `webAppConfig` gives a plain-HTTP app URL; an https one gets `devMode: false`.
  devMode: true,
  backChannelLogoutUri: 'http://dashboard.localtest.me:3000/auth/backchannel-logout',
};

/** In-memory Zitadel: enough state to tell a find from a create, and a log of every write. */
class FakeZitadel implements ZitadelApi {
  readonly writes: string[] = [];
  readonly projects = new Map<string, string>();
  readonly apps = new Map<string, OidcApp>();
  readonly apiApps = new Map<string, ApiApp>();
  readonly keys = new Map<string, { id: string }[]>();
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

  findApiAppByName(projectId: string, name: string): Promise<ApiApp | undefined> {
    return Promise.resolve(this.apiApps.get(`${projectId}/${name}`));
  }

  createApiApp(projectId: string, name: string, config: ApiAppConfig): Promise<ApiApp> {
    const app = { appId: this.id(), clientId: `client-${this.id()}`, config };
    this.apiApps.set(`${projectId}/${name}`, app);
    this.writes.push(`createApiApp ${name}`);
    return Promise.resolve(app);
  }

  updateApiAppConfig(projectId: string, appId: string, config: ApiAppConfig): Promise<void> {
    for (const [key, app] of this.apiApps) {
      if (key.startsWith(`${projectId}/`) && app.appId === appId) {
        this.apiApps.set(key, { ...app, config });
      }
    }
    this.writes.push(`updateApiAppConfig ${appId}`);
    return Promise.resolve();
  }

  listAppKeys(projectId: string, appId: string): Promise<{ id: string }[]> {
    return Promise.resolve([...(this.keys.get(`${projectId}/${appId}`) ?? [])]);
  }

  addAppKey(projectId: string, appId: string): Promise<AppKey> {
    const id = this.id();
    this.keys.set(`${projectId}/${appId}`, [
      ...(this.keys.get(`${projectId}/${appId}`) ?? []),
      { id },
    ]);
    this.writes.push(`addAppKey ${appId}`);
    return Promise.resolve({ keyId: id, privateKeyPem: `pem-${id}` });
  }

  removeAppKey(projectId: string, appId: string, keyId: string): Promise<void> {
    this.keys.set(
      `${projectId}/${appId}`,
      (this.keys.get(`${projectId}/${appId}`) ?? []).filter(({ id }) => id !== keyId),
    );
    this.writes.push(`removeAppKey ${appId} ${keyId}`);
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

describe('ensureAppKey', () => {
  it('issues a key to an application without one, and keeps it while the app still holds it', async () => {
    const api = new FakeZitadel();
    const first = await ensureAppKey(api, 'p1', 'app-1', undefined);
    expect(first).toEqual({
      key: { keyId: '1', privateKeyPem: 'pem-1' },
      action: 'created',
      removed: 0,
    });
    const second = await ensureAppKey(api, 'p1', 'app-1', first.key);
    expect(second).toEqual({ key: first.key, action: 'unchanged', removed: 0 });
    expect(api.writes).toEqual(['addAppKey app-1']);
  });

  it('replaces a held key Zitadel no longer lists, and removes every other key', async () => {
    // Fresh volumes with .local/ kept: the handoff names a key of the previous instance.
    const api = new FakeZitadel();
    await api.addAppKey('p1', 'app-1');
    await api.addAppKey('p1', 'app-1');
    api.writes.length = 0;
    const result = await ensureAppKey(api, 'p1', 'app-1', {
      keyId: 'gone',
      privateKeyPem: 'pem-gone',
    });
    expect(result).toEqual({
      key: { keyId: '3', privateKeyPem: 'pem-3' },
      action: 'created',
      removed: 2,
    });
    expect(await api.listAppKeys('p1', 'app-1')).toEqual([{ id: '3' }]);
    expect(api.writes).toEqual(['addAppKey app-1', 'removeAppKey app-1 1', 'removeAppKey app-1 2']);
  });

  it('with no handoff file, issues a new key and removes the ones of earlier runs', async () => {
    // .local/ deleted with the volumes kept: the registered key's private half is lost.
    const api = new FakeZitadel();
    await api.addAppKey('p1', 'app-1');
    api.writes.length = 0;
    const result = await ensureAppKey(api, 'p1', 'app-1', undefined);
    expect(result).toEqual({
      key: { keyId: '2', privateKeyPem: 'pem-2' },
      action: 'created',
      removed: 1,
    });
    expect(api.writes).toEqual(['addAppKey app-1', 'removeAppKey app-1 1']);
  });

  it('keeps a held key and still removes the others', async () => {
    const api = new FakeZitadel();
    const held = await api.addAppKey('p1', 'app-1');
    await api.addAppKey('p1', 'app-1');
    api.writes.length = 0;
    const result = await ensureAppKey(api, 'p1', 'app-1', held);
    expect(result).toEqual({ key: held, action: 'unchanged', removed: 1 });
    expect(api.writes).toEqual(['removeAppKey app-1 2']);
  });
});

describe('toPkcs8Pem', () => {
  it('converts the PKCS#1 PEM Zitadel issues to a PKCS#8 one of the same key', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    // No PEM header literals here, so the secret scanner has nothing to match: the input is PKCS#1 by its
    // generation options, and the output is PKCS#8 when exporting it as PKCS#8 again reproduces it.
    const pkcs8 = toPkcs8Pem(privateKey);
    expect(pkcs8).not.toBe(privateKey);
    expect(createPrivateKey(pkcs8).export({ type: 'pkcs8', format: 'pem' })).toBe(pkcs8);
    expect(createPublicKey(createPrivateKey(pkcs8)).export({ type: 'spki', format: 'pem' })).toBe(
      publicKey,
    );
  });
});

describe('ensureApiApp', () => {
  const privateKeyJwt: ApiAppConfig = { authMethodType: 'API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT' };

  it('creates a missing API application and leaves it alone on the next run', async () => {
    const api = new FakeZitadel();
    const first = await ensureApiApp(api, 'p1', 'tenancy-api', privateKeyJwt);
    const second = await ensureApiApp(api, 'p1', 'tenancy-api', privateKeyJwt);
    expect(first.action).toBe('created');
    expect(second).toEqual({ appId: first.appId, clientId: first.clientId, action: 'unchanged' });
    expect(api.writes).toEqual(['createApiApp tenancy-api']);
  });

  it('reconciles the auth method, reading an omitted one as the basic zero value', async () => {
    const api = new FakeZitadel();
    const created = await ensureApiApp(api, 'p1', 'tenancy-api', privateKeyJwt);
    api.apiApps.set('p1/tenancy-api', { ...created, config: {} });
    const updated = await ensureApiApp(api, 'p1', 'tenancy-api', privateKeyJwt);
    expect(updated).toEqual({
      appId: created.appId,
      clientId: created.clientId,
      action: 'updated',
    });
    expect(api.writes).toEqual(['createApiApp tenancy-api', `updateApiAppConfig ${created.appId}`]);
  });
});

describe('oidcConfigMatches', () => {
  it('treats fields the API omits as their protobuf zero values', () => {
    const asReturnedByZitadel: Partial<OidcAppConfig> = {
      redirectUris: desired.redirectUris,
      postLogoutRedirectUris: desired.postLogoutRedirectUris,
      responseTypes: desired.responseTypes,
      grantTypes: [...desired.grantTypes].reverse(),
      authMethodType: 'OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT',
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
