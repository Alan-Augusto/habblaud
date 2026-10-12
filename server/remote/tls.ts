// HTTPS da porta remota: uma autoridade certificadora (CA) local, criada uma vez por instalação, e o certificado do
// servidor assinado por ela. O celular confia na CA uma vez (instalando o ca.crt) e daí em diante a conexão é
// cifrada e sem aviso. Gerado com o `openssl` do sistema (macOS, Linux e o Ubuntu do WSL já trazem).
//
// Pastas (padrão ~/.habblaud/remote-tls, permissão 700):
//   ca/ca.key, ca/ca.crt            a CA: a chave NUNCA sai daqui (não vai para o container)
//   server/server.key, server.crt   o certificado do servidor (o docker-up monta SÓ esta pasta, somente leitura)
//   server/ca.crt                   cópia pública da CA, servida em /remote/ca.crt para instalar no celular
//
// O certificado do servidor vale 397 dias (o limite que a Apple aceita) e cobre localhost, <nome>.local e os IPs da
// rede local; ensureServerCert o refaz quando falta um nome/IP (o IP do Wi-Fi mudou) ou quando faltam 30 dias.
import { spawnSync } from 'node:child_process';
import { randomBytes, X509Certificate } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';

export const CA_DAYS = 3650;
export const SERVER_DAYS = 397;
export const RENEW_BEFORE_DAYS = 30;

export interface TlsPaths {
  base: string;
  caDir: string;
  caKey: string;
  caCert: string;
  serverDir: string;
  serverKey: string;
  serverCert: string;
  publicCa: string;
}

export function tlsPaths(base: string): TlsPaths {
  const caDir = join(base, 'ca');
  const serverDir = join(base, 'server');
  return {
    base,
    caDir,
    caKey: join(caDir, 'ca.key'),
    caCert: join(caDir, 'ca.crt'),
    serverDir,
    serverKey: join(serverDir, 'server.key'),
    serverCert: join(serverDir, 'server.crt'),
    publicCa: join(serverDir, 'ca.crt'),
  };
}

/** IPv4 da rede local (sem loopback nem link-local 169.254). */
export function lanAddresses(ifaces = networkInterfaces()): string[] {
  const out = new Set<string>();
  for (const list of Object.values(ifaces)) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.add(a.address);
    }
  }
  return [...out].sort();
}

/** Nome mDNS do computador (<nome>.local), que o celular acha mesmo quando o IP muda. */
export function localDnsName(run = spawnSync): string | undefined {
  if (process.platform === 'darwin') {
    const r = run('scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' });
    const name = typeof r.stdout === 'string' ? r.stdout.trim() : '';
    if (r.status === 0 && /^[A-Za-z0-9-]{1,63}$/.test(name)) return `${name.toLowerCase()}.local`;
  }
  const short = hostname().split('.')[0];
  return /^[A-Za-z0-9-]{1,63}$/.test(short) ? `${short.toLowerCase()}.local` : undefined;
}

export interface CertTargets {
  dns: string[];
  ips: string[];
}

export function defaultTargets(): CertTargets {
  const dns = ['localhost'];
  const local = localDnsName();
  if (local) dns.push(local);
  return { dns, ips: ['127.0.0.1', ...lanAddresses()] };
}

/** Nomes e IPs (subjectAltName) de um certificado PEM. */
export function certTargets(pem: string | Buffer): CertTargets {
  const san = new X509Certificate(pem).subjectAltName ?? '';
  const dns: string[] = [];
  const ips: string[] = [];
  for (const part of san.split(',')) {
    const [kind, ...rest] = part.trim().split(':');
    const value = rest.join(':');
    if (kind === 'DNS') dns.push(value.toLowerCase());
    else if (kind === 'IP Address') ips.push(value);
  }
  return { dns, ips };
}

export type CertStatus = { ok: true; expiresAt: Date } | { ok: false; reason: string };

/** O certificado do servidor serve como está? (existe, foi assinado por esta CA, cobre tudo e não está perto de vencer) */
export function serverCertStatus(paths: TlsPaths, wanted: CertTargets, now = new Date()): CertStatus {
  if (!existsSync(paths.serverCert) || !existsSync(paths.serverKey)) return { ok: false, reason: 'certificado do servidor ainda não existe' };
  if (!existsSync(paths.caCert)) return { ok: false, reason: 'a CA local não existe' };
  let cert: X509Certificate;
  let ca: X509Certificate;
  try {
    cert = new X509Certificate(readFileSync(paths.serverCert));
    ca = new X509Certificate(readFileSync(paths.caCert));
  } catch {
    return { ok: false, reason: 'certificado ilegível' };
  }
  if (!cert.verify(ca.publicKey)) return { ok: false, reason: 'certificado não foi assinado pela CA atual' };
  const expiresAt = new Date(cert.validTo);
  if (expiresAt.getTime() - now.getTime() < RENEW_BEFORE_DAYS * 86_400_000) return { ok: false, reason: 'certificado perto de vencer' };
  const have = certTargets(readFileSync(paths.serverCert));
  const missing = [...wanted.dns.filter((d) => !have.dns.includes(d.toLowerCase())), ...wanted.ips.filter((ip) => !have.ips.includes(ip))];
  if (missing.length) return { ok: false, reason: `faltam no certificado: ${missing.join(', ')}` };
  return { ok: true, expiresAt };
}

type Run = typeof spawnSync;

function openssl(run: Run, args: string[]): void {
  const r = run('openssl', args, { encoding: 'utf8' });
  if (r.error) throw new Error(`não achei o openssl (${r.error.message}); instale-o e rode de novo`);
  if (r.status !== 0) throw new Error(`openssl ${args[0]} falhou: ${String(r.stderr).trim().split('\n').slice(-2).join(' ')}`);
}

function ensureDir(dir: string, mode: number): void {
  mkdirSync(dir, { recursive: true, mode });
  chmodSync(dir, mode);
}

/** Cria a CA local se ainda não existe. Devolve true quando criou. */
export function ensureCa(paths: TlsPaths, label: string, run: Run = spawnSync): boolean {
  if (existsSync(paths.caKey) && existsSync(paths.caCert)) return false;
  ensureDir(paths.base, 0o700);
  ensureDir(paths.caDir, 0o700);
  const work = join(tmpdir(), `habblaud-ca-${randomBytes(6).toString('hex')}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const cnf = join(work, 'ca.cnf');
    writeFileSync(
      cnf,
      [
        '[req]',
        'distinguished_name = dn',
        'prompt = no',
        'x509_extensions = v3_ca',
        '[dn]',
        `CN = Habblaud local CA (${label.replace(/[^A-Za-z0-9 .-]/g, '')})`,
        'O = Habblaud',
        '[v3_ca]',
        'basicConstraints = critical,CA:TRUE,pathlen:0',
        'keyUsage = critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier = hash',
        '',
      ].join('\n'),
    );
    const key = join(work, 'ca.key');
    const crt = join(work, 'ca.crt');
    openssl(run, ['req', '-x509', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', String(CA_DAYS), '-keyout', key, '-out', crt, '-config', cnf]);
    chmodSync(key, 0o600);
    renameSync(key, paths.caKey);
    renameSync(crt, paths.caCert);
    return true;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Emite (de novo) o certificado do servidor, assinado pela CA, cobrindo `targets`. Troca os arquivos de uma vez. */
export function issueServerCert(paths: TlsPaths, targets: CertTargets, run: Run = spawnSync): void {
  if (!existsSync(paths.caKey) || !existsSync(paths.caCert)) throw new Error('a CA local não existe: rode npm run remote:setup');
  ensureDir(paths.serverDir, 0o755);
  const work = join(tmpdir(), `habblaud-cert-${randomBytes(6).toString('hex')}`);
  mkdirSync(work, { mode: 0o700 });
  try {
    const key = join(work, 'server.key');
    const csr = join(work, 'server.csr');
    const crt = join(work, 'server.crt');
    const ext = join(work, 'server.ext');
    const cn = targets.dns.find((d) => d.endsWith('.local')) ?? 'localhost';
    writeFileSync(
      ext,
      [
        'basicConstraints = critical,CA:FALSE',
        'keyUsage = critical,digitalSignature,keyEncipherment',
        'extendedKeyUsage = serverAuth',
        'subjectKeyIdentifier = hash',
        'authorityKeyIdentifier = keyid,issuer',
        `subjectAltName = ${[...targets.dns.map((d) => `DNS:${d}`), ...targets.ips.map((ip) => `IP:${ip}`)].join(',')}`,
        '',
      ].join('\n'),
    );
    openssl(run, ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-keyout', key, '-out', csr, '-subj', `/CN=${cn}/O=Habblaud`]);
    openssl(run, [
      'x509', '-req', '-in', csr, '-CA', paths.caCert, '-CAkey', paths.caKey, '-sha256', '-days', String(SERVER_DAYS),
      '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-extfile', ext, '-out', crt,
    ]);
    // Legível pelo usuário do container (a pasta-mãe, 700, é quem protege a chave no host).
    chmodSync(key, 0o644);
    chmodSync(crt, 0o644);
    // Troca atômica (rename), na ordem chave -> certificado: quem recarrega ao ver o certificado novo já acha a chave nova.
    renameSync(key, paths.serverKey);
    renameSync(crt, paths.serverCert);
    copyFileSync(paths.caCert, paths.publicCa);
    chmodSync(paths.publicCa, 0o644);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface EnsureResult {
  createdCa: boolean;
  issued: boolean;
  reason?: string;
  targets: CertTargets;
}

/** Garante a CA e um certificado de servidor válido para os nomes/IPs de agora (refaz só quando precisa). */
export function ensureServerCert(paths: TlsPaths, targets: CertTargets = defaultTargets(), opts: { force?: boolean; run?: Run } = {}): EnsureResult {
  const run = opts.run ?? spawnSync;
  const createdCa = ensureCa(paths, targets.dns.find((d) => d.endsWith('.local')) ?? 'habblaud', run);
  const status = serverCertStatus(paths, targets);
  if (!opts.force && !createdCa && status.ok) return { createdCa, issued: false, targets };
  issueServerCert(paths, targets, run);
  return { createdCa, issued: true, reason: opts.force ? 'pedido' : status.ok ? 'CA nova' : status.reason, targets };
}

/** SHA-256 da CA, para conferir no celular antes de confiar nela. */
export function caFingerprint(paths: TlsPaths): string | undefined {
  try {
    return new X509Certificate(readFileSync(paths.caCert)).fingerprint256;
  } catch {
    return undefined;
  }
}

/** Pasta das chaves do acesso remoto (~/.habblaud/remote-tls). */
export function remoteTlsBase(home: string): string {
  return join(home, '.habblaud', 'remote-tls');
}

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** Nome curto para <nome>.local (letras, números e hífen). */
export function isValidName(name: string): boolean {
  return LABEL.test(name);
}

/** Endereço próprio (ex.: meuclaude.home): 2+ partes válidas, sem ponto final nem IP. */
export function isValidDomain(domain: string): boolean {
  const parts = domain.split('.');
  return parts.length >= 2 && parts.every((p) => LABEL.test(p)) && !/^\d+$/.test(parts[parts.length - 1]);
}

/** Nomes do certificado: os padrões (localhost, <computador>.local, IPs) + <nome>.local + o endereço próprio. */
export function remoteTargets(opts: { name?: string; domain?: string }, base: CertTargets = defaultTargets()): CertTargets {
  const dns = [...base.dns];
  for (const n of [opts.name ? `${opts.name}.local` : undefined, opts.domain]) {
    const v = n?.trim().toLowerCase();
    if (v && !dns.includes(v)) dns.push(v);
  }
  return { dns, ips: [...base.ips] };
}

/** IPv4 da interface da rota padrão (o Wi-Fi/cabo de verdade); sem ela, o primeiro IP da rede local. */
export function primaryIp(platform: NodeJS.Platform = process.platform): string | undefined {
  let iface: string | undefined;
  if (platform === 'darwin') {
    const r = spawnSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' });
    iface = /interface:\s*(\S+)/.exec(String(r.stdout))?.[1];
  } else if (platform === 'linux') {
    const r = spawnSync('ip', ['route', 'show', 'default'], { encoding: 'utf8' });
    iface = /\bdev\s+(\S+)/.exec(String(r.stdout))?.[1];
  }
  const addr = iface ? networkInterfaces()[iface]?.find((a) => a.family === 'IPv4' && !a.internal)?.address : undefined;
  return addr ?? lanAddresses()[0];
}
