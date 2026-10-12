// Avisos no celular (Web Push): quando um agente precisa de você ou entrega algo, o servidor manda uma notificação ao
// aparelho inscrito, mesmo com o Habblaud fechado (no iPhone, o app adicionado à Tela de Início). Sem dependências:
// - VAPID (RFC 8292): par de chaves P-256 criado na primeira vez e guardado em <dataDir>/push.json (permissão 600);
// - conteúdo cifrado de ponta a ponta (RFC 8291, aes128gcm): o serviço de push (Apple, Google...) só repassa bytes;
// - só endpoints dos serviços de push conhecidos (uma inscrição não faz o servidor postar em qualquer endereço);
// - inscrição que o serviço diz não existir mais (404/410) é apagada.
import { createCipheriv, createECDH, createPrivateKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type ECDH, type KeyObject } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const MAX_SUBSCRIPTIONS = 10;
const PUSH_HOSTS = [/^([a-z0-9-]+\.)*push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/, /^([a-z0-9-]+\.)*notify\.windows\.com$/];
const SUBJECT = 'https://github.com/marmottajr/habblaud';
const PAYLOAD_MAX = 3_000;

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  /** Avisos com a mesma tag substituem o anterior (ex.: o mesmo agente). */
  tag?: string;
  /** Para onde o toque leva (caminho do Habblaud, ex.: "/?agent=..."). */
  url?: string;
  urgent?: boolean;
}

interface Stored {
  vapid: { publicKey: string; privateJwk: Record<string, unknown> };
  subs: Array<PushSubscription & { at: number }>;
}

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s, 'base64url');

/** Confere uma inscrição vinda do navegador: endpoint https de um serviço de push conhecido e chaves do tamanho certo. */
export function parseSubscription(raw: unknown): PushSubscription | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const keys = r.keys && typeof r.keys === 'object' ? (r.keys as Record<string, unknown>) : {};
  if (typeof r.endpoint !== 'string' || r.endpoint.length > 1_000) return { error: 'inscrição inválida' };
  let url: URL;
  try {
    url = new URL(r.endpoint);
  } catch {
    return { error: 'inscrição inválida' };
  }
  if (url.protocol !== 'https:' || !PUSH_HOSTS.some((re) => re.test(url.hostname))) return { error: 'serviço de push desconhecido' };
  if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return { error: 'inscrição sem chaves' };
  if (fromB64u(keys.p256dh).length !== 65 || fromB64u(keys.auth).length !== 16) return { error: 'chaves da inscrição inválidas' };
  return { endpoint: r.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

/** Cifra o conteúdo para a inscrição (RFC 8291, aes128gcm, um registro). */
export function encryptPayload(payload: Buffer, sub: PushSubscription, ephemeral?: ECDH, salt = randomBytes(16)): Buffer {
  if (!ephemeral) {
    ephemeral = createECDH('prime256v1');
    ephemeral.generateKeys();
  }
  const uaPublic = fromB64u(sub.keys.p256dh);
  const authSecret = fromB64u(sub.keys.auth);
  const asPublic = ephemeral.getPublicKey();
  const ecdhSecret = ephemeral.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** JWT do VAPID (ES256) para a origem do endpoint. */
export function vapidJwt(audience: string, key: KeyObject, now = Date.now()): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: SUBJECT })));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}

export type Sender = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: Buffer }) => Promise<{ status: number }>;

const defaultSender: Sender = async (url, init) => {
  const res = await fetch(url, { ...init, body: new Uint8Array(init.body), signal: AbortSignal.timeout(10_000) });
  return { status: res.status };
};

export class PushService {
  private data: Stored;
  private readonly key: KeyObject;

  constructor(
    private readonly file: string,
    private readonly send: Sender = defaultSender,
    private readonly now: () => number = Date.now,
  ) {
    this.data = this.load();
    this.key = createPrivateKey({ key: this.data.vapid.privateJwk as never, format: 'jwk' });
  }

  get publicKey(): string {
    return this.data.vapid.publicKey;
  }

  get count(): number {
    return this.data.subs.length;
  }

  has(endpoint: string): boolean {
    return this.data.subs.some((s) => s.endpoint === endpoint);
  }

  subscribe(raw: unknown): { ok: true } | { error: string } {
    const sub = parseSubscription(raw);
    if ('error' in sub) return sub;
    const subs = this.data.subs.filter((s) => s.endpoint !== sub.endpoint);
    subs.unshift({ ...sub, at: this.now() });
    this.data.subs = subs.slice(0, MAX_SUBSCRIPTIONS);
    this.save();
    return { ok: true };
  }

  unsubscribe(endpoint: unknown): void {
    if (typeof endpoint !== 'string') return;
    const before = this.data.subs.length;
    this.data.subs = this.data.subs.filter((s) => s.endpoint !== endpoint);
    if (this.data.subs.length !== before) this.save();
  }

  /** Manda a todos os aparelhos inscritos. Devolve quantos aceitaram. Nunca lança. */
  async notify(msg: PushMessage): Promise<number> {
    if (!this.data.subs.length) return 0;
    const payload = Buffer.from(JSON.stringify({ ...msg, body: msg.body.slice(0, 600) }).slice(0, PAYLOAD_MAX));
    let ok = 0;
    const gone: string[] = [];
    await Promise.all(
      this.data.subs.map(async (s) => {
        try {
          const aud = new URL(s.endpoint).origin;
          const r = await this.send(s.endpoint, {
            method: 'POST',
            headers: {
              TTL: msg.urgent ? '3600' : '86400',
              Urgency: msg.urgent ? 'high' : 'normal',
              'Content-Encoding': 'aes128gcm',
              'Content-Type': 'application/octet-stream',
              ...(msg.tag ? { Topic: msg.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'habblaud' } : {}),
              Authorization: `vapid t=${vapidJwt(aud, this.key, this.now())}, k=${this.publicKey}`,
            },
            body: encryptPayload(payload, s),
          });
          if (r.status >= 200 && r.status < 300) ok++;
          else if (r.status === 404 || r.status === 410) gone.push(s.endpoint);
        } catch {
          // rede fora: tenta no próximo aviso
        }
      }),
    );
    if (gone.length) {
      this.data.subs = this.data.subs.filter((s) => !gone.includes(s.endpoint));
      this.save();
    }
    return ok;
  }

  private load(): Stored {
    try {
      if (existsSync(this.file)) {
        const d = JSON.parse(readFileSync(this.file, 'utf8')) as Stored;
        if (d?.vapid?.publicKey && d.vapid.privateJwk && Array.isArray(d.subs)) return d;
      }
    } catch {
      // arquivo torto: começa de novo (as inscrições se refazem ao abrir o app)
    }
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const raw = Buffer.concat([Buffer.from([4]), fromB64u(jwk.x), fromB64u(jwk.y)]);
    const d: Stored = { vapid: { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) as Record<string, unknown> }, subs: [] };
    this.data = d;
    this.save();
    return d;
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.file);
    } catch {
      // sem disco gravável: vale só nesta execução
    }
  }
}
