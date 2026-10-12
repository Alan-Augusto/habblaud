import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { createApiHandler, sendJson } from './app';
import { createRequestGuard, isLoopbackHost } from './guard';
import {
  COOKIE,
  createRemoteGate,
  isRemoteRequest,
  loadSecret,
  LoginThrottle,
  parseAllow,
  parseRemoteConfig,
  readCookie,
  RemoteSessions,
  SESSION_MS,
  type RemoteFeature,
} from './remote';
import { Hub } from './sse';
import { hashPassword, parsePasswordHash } from '../remote/password';

setQuiet(true);

const SECRET = Buffer.alloc(32, 7);
const PASSWORD = 'correct horse battery';
// logN 10: rápido nos testes (o setup usa 15).
const HASH_TEXT = await hashPassword(PASSWORD, 10);
const CFG = { user: 'ana', passwordHash: parsePasswordHash(HASH_TEXT)!, passwordHashText: HASH_TEXT };
const CREDS = { user: 'ana', password: PASSWORD };
const TLS_FILES = (p: string) => p.endsWith('server.key') || p.endsWith('server.crt');

describe('parseRemoteConfig', () => {
  const base = { HABBLAUD_REMOTE_USER: 'ana', HABBLAUD_REMOTE_PASSWORD_HASH: HASH_TEXT };
  it('fica desligado sem as variáveis', () => {
    expect(parseRemoteConfig({}, false)).toEqual({});
  });
  it('recusa senha em texto puro e hash ausente ou inválido', () => {
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a', HABBLAUD_REMOTE_PASSWORD: '12345678' }, false).warning).toMatch(/texto puro/);
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a' }, false).warning).toMatch(/remote:setup/);
    expect(parseRemoteConfig({ HABBLAUD_REMOTE_USER: 'a', HABBLAUD_REMOTE_PASSWORD_HASH: 'scrypt:1:2' }, false, TLS_FILES).warning).toMatch(/inválido/);
  });
  it('exige HTTPS: sem certificado não sobe, a menos de HABBLAUD_REMOTE_INSECURE_HTTP=1', () => {
    expect(parseRemoteConfig(base, false, () => false).warning).toMatch(/HTTPS é obrigatório/);
    const insecure = parseRemoteConfig({ ...base, HABBLAUD_REMOTE_INSECURE_HTTP: '1' }, false, () => false).config;
    expect(insecure?.tls).toBeUndefined();
  });
  it('liga com padrões: porta 4748, só permissões, certificado da pasta padrão', () => {
    const { config } = parseRemoteConfig({ ...base, HOME: '/h' }, false, TLS_FILES);
    expect(config).toMatchObject({ port: 4748, host: '0.0.0.0', user: 'ana' });
    expect(config?.tls?.certFile).toBe('/h/.habblaud/remote-tls/server/server.crt');
    expect([...config!.allow]).toEqual(['permissions']);
  });
  it('no Docker ignora porta e host (o container escuta sempre em 0.0.0.0:4748) e lê o certificado de /remote-tls', () => {
    const env = { ...base, HABBLAUD_REMOTE_PORT: '9999', HABBLAUD_REMOTE_HOST: '10.0.0.1' };
    const docker = parseRemoteConfig(env, true, TLS_FILES).config;
    expect(docker).toMatchObject({ port: 4748, host: '0.0.0.0' });
    expect(docker?.tls?.dir).toBe('/remote-tls');
    expect(parseRemoteConfig(env, false, TLS_FILES).config).toMatchObject({ port: 9999, host: '10.0.0.1' });
  });
  it('HABBLAUD_REMOTE_ALLOW: lista, ignora nomes desconhecidos, "none" = só ver', () => {
    expect([...parseAllow('messages, Terminal, bogus')]).toEqual(['messages', 'terminal']);
    expect([...parseAllow('none')]).toEqual([]);
    expect([...parseAllow('')]).toEqual(['permissions']);
  });
});

describe('RemoteSessions', () => {
  it('aceita o próprio token e recusa adulterado, vencido ou de outra senha', () => {
    let now = 1_800_000_000_000;
    const sessions = new RemoteSessions(SECRET, CFG, () => now);
    const { token, maxAgeS } = sessions.issue();
    expect(maxAgeS).toBe(SESSION_MS / 1000);
    expect(sessions.verify(token)).toBe(true);
    expect(sessions.verify(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).toBe(false);
    expect(sessions.verify(token.replace(/^v1\.\d+/, `v1.${now + SESSION_MS * 2}`))).toBe(false);
    expect(new RemoteSessions(SECRET, { ...CFG, passwordHashText: 'outro-hash' }, () => now).verify(token)).toBe(false);
    expect(sessions.verify(undefined)).toBe(false);
    expect(sessions.verify('lixo')).toBe(false);
    now += SESSION_MS + 1;
    expect(sessions.verify(token)).toBe(false);
  });

  it('revoke encerra só aquele token, e a lista sobrevive a um reinício', () => {
    const now = 1_800_000_000_000;
    const tmp = tempDir();
    const file = join(tmp.dir, 'data', 'remote-revoked.json');
    const sessions = new RemoteSessions(SECRET, CFG, () => now, file);
    const phone = sessions.issue().token;
    const other = new RemoteSessions(SECRET, CFG, () => now + 1).issue().token;
    sessions.revoke(phone);
    sessions.revoke('lixo');
    expect(sessions.verify(phone)).toBe(false);
    expect(sessions.verify(other)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const restarted = new RemoteSessions(SECRET, CFG, () => now, file);
    expect(restarted.verify(phone)).toBe(false);
    expect(restarted.verify(other)).toBe(true);
    tmp.cleanup();
  });

  it('loadSecret cria o segredo com permissão 600 e o reaproveita', () => {
    const tmp = tempDir();
    const file = join(tmp.dir, 'data', 'remote-secret');
    const a = loadSecret(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8')).toBe(a.toString('hex'));
    expect(loadSecret(file).equals(a)).toBe(true);
    tmp.cleanup();
  });
});

describe('LoginThrottle', () => {
  it('libera 4 falhas, depois espera 1 s, 2 s... e zera ao acertar', () => {
    let now = 0;
    const t = new LoginThrottle(() => now);
    for (let i = 0; i < 4; i++) t.fail();
    expect(t.retryAfter()).toBe(0);
    t.fail();
    expect(t.retryAfter()).toBe(1);
    now += 1000;
    t.fail();
    expect(t.retryAfter()).toBe(2);
    t.succeed();
    expect(t.retryAfter()).toBe(0);
  });
});

describe('readCookie', () => {
  it('acha o cookie pelo nome', () => {
    expect(readCookie('a=1; habblaud_remote=v1.x.y; b=2', COOKIE)).toBe('v1.x.y');
    expect(readCookie(undefined, COOKIE)).toBeUndefined();
  });
});

interface Harness {
  hub: Hub;
  remoteBase: string;
  localBase: string;
  permissionCalls: string[];
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Uma porta local (sem login) e uma remota (com login), sobre a MESMA API, como no server/index.ts. */
async function start(allow: RemoteFeature[] = ['permissions']): Promise<Harness> {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({
    names: new NameStore(null),
    version: '9.9.9',
    startedAt: Date.now(),
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: () => undefined,
  });
  const allowSet = new Set(allow);
  // Mesma regra do server/index.ts.
  const hub = new Hub(office, {
    throttleMs: 10,
    canAnswer: (req) => (isRemoteRequest(req) ? allowSet.has('permissions') : isLoopbackHost(req.headers.host)),
  });
  hub.start();
  const permissionCalls: string[] = [];
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: true,
    terminal: true,
    permissions: (req, res, path) => {
      req.resume();
      permissionCalls.push(`${isRemoteRequest(req) ? 'remote' : 'local'} ${req.method} ${path}`);
      sendJson(res, 200, { ok: true });
    },
    messages: (req, res) => {
      req.resume();
      sendJson(res, 200, { ok: true });
    },
    renameRoom: () => 'sala',
    remote: { is: isRemoteRequest, allows: (f) => allowSet.has(f) },
  });
  const guard = createRequestGuard();
  const gate = createRemoteGate({ config: CFG, sessions: new RemoteSessions(SECRET, CFG), secure: false });
  const page = (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Habblaud</title>');
  };
  const local = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) page(req, res);
  });
  const remote = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (gate(req, res, url)) return;
    if (!api(req, res, url)) page(req, res);
  });
  await new Promise<void>((ok) => local.listen(0, '127.0.0.1', ok));
  await new Promise<void>((ok) => remote.listen(0, '127.0.0.1', ok));
  const close = async () => {
    hub.stop();
    await new Promise<void>((ok) => local.close(() => ok()));
    await new Promise<void>((ok) => remote.close(() => ok()));
    tmp.cleanup();
  };
  closers.push(close);
  return {
    hub,
    localBase: `http://127.0.0.1:${(local.address() as AddressInfo).port}`,
    remoteBase: `http://127.0.0.1:${(remote.address() as AddressInfo).port}`,
    permissionCalls,
    close,
  };
}

/** Requisição crua (o fetch do Node não deixa trocar o Host). */
function request(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const url = new URL(path, base);
  const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  return new Promise((ok, fail) => {
    const req = http.request(
      url,
      {
        method: opts.method ?? 'GET',
        headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

async function login(base: string): Promise<string> {
  const r = await request(base, '/api/remote/login', { method: 'POST', body: CREDS });
  expect(r.status).toBe(200);
  const setCookie = r.headers['set-cookie']?.[0] ?? '';
  expect(setCookie).toMatch(/HttpOnly/);
  expect(setCookie).toMatch(/SameSite=Strict/);
  return setCookie.split(';')[0];
}

describe('porta remota', () => {
  it('Sair: apaga o cookie e o mesmo token deixa de valer (mesmo guardado numa cópia)', async () => {
    const s = await start();
    const cookie = await login(s.remoteBase);
    expect((await request(s.remoteBase, '/api/access', { headers: { Cookie: cookie } })).status).toBe(200);
    expect((await request(s.remoteBase, '/api/remote/logout', { headers: { Cookie: cookie } })).status).toBe(405);
    const out = await request(s.remoteBase, '/api/remote/logout', { method: 'POST', body: {}, headers: { Cookie: cookie } });
    expect(out.status).toBe(200);
    expect(out.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/);
    expect((await request(s.remoteBase, '/api/access', { headers: { Cookie: cookie } })).status).toBe(401);
    expect((await request(s.remoteBase, '/', { headers: { Cookie: cookie } })).headers.location).toBe('/login');
  });

  it('sem login: a página vira /login e a API responde 401', async () => {
    const h = await start();
    const page = await request(h.remoteBase, '/');
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/login');
    const loginPage = await request(h.remoteBase, '/login');
    expect(loginPage.status).toBe(200);
    expect(loginPage.body).toContain('/api/remote/login');
    expect(loginPage.headers['x-frame-options']).toBe('DENY');
    expect((await request(h.remoteBase, '/api/snapshot')).status).toBe(401);
    expect((await request(h.remoteBase, '/api/stream')).status).toBe(401);
    const decision = await request(h.remoteBase, '/api/permissions/p1/decision', { method: 'POST', body: { behavior: 'allow' } });
    expect(decision.status).toBe(401);
    expect(h.permissionCalls).toEqual([]);
  });

  it('senha errada: 401 sem cookie; certa: cookie de sessão e acesso à API', async () => {
    const h = await start();
    const wrong = await request(h.remoteBase, '/api/remote/login', { method: 'POST', body: { user: 'ana', password: 'nope nope' } });
    expect(wrong.status).toBe(401);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    const cookie = await login(h.remoteBase);
    expect((await request(h.remoteBase, '/api/snapshot', { headers: { Cookie: cookie } })).status).toBe(200);
    const page = await request(h.remoteBase, '/', { headers: { Cookie: cookie } });
    expect(page.status).toBe(200);
    expect((await request(h.remoteBase, '/login', { headers: { Cookie: cookie } })).headers.location).toBe('/');
  });

  it('logado: aprova permissões (o padrão) e o health diz o que vale nesta porta', async () => {
    const h = await start();
    const cookie = await login(h.remoteBase);
    const health = JSON.parse((await request(h.remoteBase, '/api/health', { headers: { Cookie: cookie } })).body);
    expect(health).toMatchObject({ remote: true, permissions: true, messages: false, terminal: false });
    const decision = await request(h.remoteBase, '/api/permissions/p1/decision', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { behavior: 'allow' },
    });
    expect(decision.status).toBe(200);
    expect(h.permissionCalls).toEqual(['remote POST /api/permissions/p1/decision']);
  });

  it('logado com Host imitando localhost: continua sem o que não foi liberado', async () => {
    const h = await start();
    const cookie = await login(h.remoteBase);
    const headers = { Cookie: cookie, Host: 'localhost' };
    for (const [path, body] of [
      ['/api/messages', { agentId: 'x', text: 'oi' }],
      ['/api/rooms/rename', { id: 'r', name: 'n' }],
      ['/api/codex/events', {}],
    ] as const) {
      const r = await request(h.remoteBase, path, { method: 'POST', headers, body });
      expect(r.status, path).toBe(403);
      expect(JSON.parse(r.body).error).toMatch(/HABBLAUD_REMOTE_ALLOW/);
    }
    expect((await request(h.remoteBase, '/api/agents/x/terminal', { headers })).status).toBe(403);
    expect((await request(h.remoteBase, '/api/sessions/recent', { headers })).status).toBe(403);
  });

  it('HABBLAUD_REMOTE_ALLOW=messages libera mensagens e "none" tira até as permissões', async () => {
    const withMessages = await start(['messages']);
    const c1 = await login(withMessages.remoteBase);
    expect((await request(withMessages.remoteBase, '/api/messages', { method: 'POST', headers: { Cookie: c1 }, body: {} })).status).toBe(200);
    expect((await request(withMessages.remoteBase, '/api/permissions/p1/decision', { method: 'POST', headers: { Cookie: c1 }, body: {} })).status).toBe(403);
    const viewOnly = await start([]);
    const c2 = await login(viewOnly.remoteBase);
    expect((await request(viewOnly.remoteBase, '/api/permissions/p1/decision', { method: 'POST', headers: { Cookie: c2 }, body: {} })).status).toBe(403);
    expect((await request(viewOnly.remoteBase, '/api/snapshot', { headers: { Cookie: c2 } })).status).toBe(200);
  });

  it('login de outra origem é barrado pelo guard (CSRF)', async () => {
    const h = await start();
    const r = await request(h.remoteBase, '/api/remote/login', { method: 'POST', headers: { Origin: 'http://evil.example' }, body: CREDS });
    expect(r.status).toBe(403);
  });
});

describe('porta local (inalterada)', () => {
  it('sem login, vale a trava do Host local como antes', async () => {
    const h = await start();
    const ok = await request(h.localBase, '/api/permissions/p1/decision', { method: 'POST', body: { behavior: 'allow' } });
    expect(ok.status).toBe(200);
    const lanHost = await request(h.localBase, '/api/permissions/p1/decision', {
      method: 'POST',
      headers: { Host: '192.168.1.5:4747' },
      body: { behavior: 'allow' },
    });
    expect(lanHost.status).toBe(403);
    expect(JSON.parse(lanHost.body).error).toMatch(/próprio computador/);
    expect(h.permissionCalls).toEqual(['local POST /api/permissions/p1/decision']);
    const health = JSON.parse((await request(h.localBase, '/api/health')).body);
    expect(health).toMatchObject({ remote: false, permissions: true, messages: true });
  });
});

/** Abre o stream (SSE) e espera o primeiro pedaço; devolve como fechar. */
function openStream(base: string, headers: Record<string, string>): Promise<{ status: number; close: () => void }> {
  return new Promise((ok, fail) => {
    const req = http.request(new URL('/api/stream', base), { headers }, (res) => {
      res.once('data', () => ok({ status: res.statusCode ?? 0, close: () => req.destroy() }));
      if (res.statusCode !== 200) ok({ status: res.statusCode ?? 0, close: () => req.destroy() });
    });
    req.on('error', fail);
    req.end();
  });
}

describe('quem pode responder (o hook só espera se houver página que responda)', () => {
  it('celular logado com permissions conta como página que responde', async () => {
    const h = await start(['permissions']);
    const cookie = await login(h.remoteBase);
    expect(h.hub.localSize).toBe(0);
    const s = await openStream(h.remoteBase, { Cookie: cookie });
    expect(s.status).toBe(200);
    expect(h.hub.localSize).toBe(1);
    s.close();
  });

  it('celular só-ver não conta, nem imitando o Host local', async () => {
    const h = await start([]);
    const cookie = await login(h.remoteBase);
    const s = await openStream(h.remoteBase, { Cookie: cookie, Host: 'localhost' });
    expect(s.status).toBe(200);
    expect(h.hub.localSize).toBe(0);
    s.close();
  });
});

describe('GET /api/access (o que a página pode fazer)', () => {
  it('porta remota: só o liberado; porta local: tudo pelo Host local; Host da rede na local: nada', async () => {
    const h = await start(['permissions']);
    const cookie = await login(h.remoteBase);
    expect(JSON.parse((await request(h.remoteBase, '/api/access', { headers: { Cookie: cookie, Host: 'localhost' } })).body)).toEqual({
      remote: true,
      local: false,
      permissions: true,
      messages: false,
      terminal: false,
    });
    expect(JSON.parse((await request(h.localBase, '/api/access')).body)).toEqual({ remote: false, local: true, permissions: true, messages: true, terminal: false });
    expect(JSON.parse((await request(h.localBase, '/api/access', { headers: { Host: '192.168.1.5:4747' } })).body)).toMatchObject({
      local: false,
      permissions: false,
      messages: false,
    });
    expect((await request(h.remoteBase, '/api/access')).status).toBe(401);
  });
});

describe('cookie Secure e download da CA', () => {
  it('com HTTPS o cookie leva Secure; /remote/ca.crt é público e só existe com a CA', async () => {
    const tmp = tempDir();
    const caFile = join(tmp.dir, 'ca.crt');
    const gate = createRemoteGate({ config: CFG, sessions: new RemoteSessions(SECRET, CFG), secure: true, caFile });
    const server = http.createServer((req, res) => {
      if (!gate(req, res, new URL(req.url ?? '/', 'http://x'))) {
        res.writeHead(204);
        res.end();
      }
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(async () => {
      await new Promise<void>((ok) => server.close(() => ok()));
      tmp.cleanup();
    });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const r = await request(base, '/api/remote/login', { method: 'POST', body: CREDS });
    expect(r.headers['set-cookie']?.[0]).toMatch(/; Secure$/);
    expect((await request(base, '/remote/ca.crt')).status).toBe(404);
    expect((await request(base, '/login')).body).not.toContain('/remote/ca.crt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(caFile, '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n');
    const ca = await request(base, '/remote/ca.crt');
    expect(ca.status).toBe(200);
    expect(ca.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect((await request(base, '/login')).body).toContain('/remote/ca.crt');
  });
});
