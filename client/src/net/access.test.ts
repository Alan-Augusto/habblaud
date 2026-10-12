import { afterEach, describe, expect, it } from 'vitest';
import { access, fallbackAccess, loadAccess, setAccess } from './access';

afterEach(() => setAccess(null));

describe('access', () => {
  it('sem resposta do servidor: a regra antiga (só o próprio computador age)', async () => {
    expect(fallbackAccess('localhost')).toMatchObject({ local: true, permissions: true });
    expect(fallbackAccess('habblaud.localhost').permissions).toBe(true);
    expect(fallbackAccess('192.168.1.10')).toMatchObject({ local: false, permissions: false, messages: false });
    const failing = (() => Promise.reject(new Error('rede'))) as unknown as typeof fetch;
    expect((await loadAccess(failing)).remote).toBe(false);
  });
  it('com resposta: vale o que o servidor disse (celular logado aprovando)', async () => {
    const body = { remote: true, local: false, permissions: true, messages: false, terminal: false };
    const ok = (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch;
    expect(await loadAccess(ok)).toEqual(body);
    expect(access().permissions).toBe(true);
  });
  it('resposta torta é ignorada', async () => {
    const bad = (() => Promise.resolve(new Response('{"remote":"sim"}', { status: 200 }))) as unknown as typeof fetch;
    expect((await loadAccess(bad)).remote).toBe(false);
  });
});
