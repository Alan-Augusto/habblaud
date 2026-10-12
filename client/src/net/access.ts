// O que esta página pode fazer, segundo o servidor (GET /api/access, ver AccessInfo). Lido uma vez antes de conectar.
// Sem resposta (servidor antigo, rede), cai na regra de antes: só a página aberta pelo próprio computador age.
import type { AccessInfo } from '../../../shared/types';

let current: AccessInfo | null = null;

/** Hostname do próprio computador (localhost, *.localhost, 127.x, ::1). */
export function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return name === 'localhost' || name.endsWith('.localhost') || name === '::1' || /^127(?:\.\d{1,3}){3}$/.test(name);
}

export function fallbackAccess(hostname: string): AccessInfo {
  const local = isLoopbackHostname(hostname);
  return { remote: false, local, permissions: local, messages: local, terminal: local };
}

function isAccessInfo(v: unknown): v is AccessInfo {
  const a = v as Partial<AccessInfo> | null;
  return !!a && ['remote', 'local', 'permissions', 'messages', 'terminal'].every((k) => typeof a[k as keyof AccessInfo] === 'boolean');
}

/** Acesso desta página (o do servidor, quando já chegou). */
export function access(): AccessInfo {
  return current ?? fallbackAccess(typeof location === 'undefined' ? '' : location.hostname);
}

export async function loadAccess(fetchImpl: typeof fetch = fetch): Promise<AccessInfo> {
  try {
    const res = await fetchImpl('/api/access', { credentials: 'same-origin', cache: 'no-store' });
    if (res.ok) {
      const body: unknown = await res.json();
      if (isAccessInfo(body)) current = body;
    }
  } catch {
    // fica a regra antiga (fallbackAccess)
  }
  return access();
}

/** Só para testes. */
export function setAccess(a: AccessInfo | null): void {
  current = a;
}
