import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { encryptPayload, parseSubscription, PushService, type PushSubscription } from './webpush';

const b64u = (b: Buffer) => b.toString('base64url');

/** Lado do navegador (RFC 8291): decifra com a chave privada da inscrição. */
function decrypt(body: Buffer, uaPrivate: ReturnType<typeof createECDH>, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const secret = uaPrivate.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), uaPrivate.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, plain.length - 1);
}

function browserSub(endpoint = 'https://web.push.apple.com/QGuQyavXutnMPNh'): { sub: PushSubscription; ua: ReturnType<typeof createECDH>; auth: Buffer } {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  return { sub: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } }, ua, auth };
}

describe('Web Push', () => {
  it('RFC 8291: o exemplo oficial cifra para os mesmos bytes', () => {
    const as = createECDH('prime256v1');
    as.setPrivateKey(Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'));
    const sub = { endpoint: 'https://push.example', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } };
    const out = encryptPayload(Buffer.from('When I grow up, I want to be a watermelon'), sub, as, Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'));
    expect(b64u(out)).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('o navegador decifra o que o servidor cifra', () => {
    const { sub, ua, auth } = browserSub();
    const msg = Buffer.from(JSON.stringify({ title: 'Habblaud', body: '✋ Kauã precisa de você' }));
    expect(decrypt(encryptPayload(msg, sub), ua, auth).toString()).toBe(msg.toString());
  });

  it('só aceita serviços de push conhecidos e chaves do tamanho certo', () => {
    const { sub } = browserSub();
    expect(parseSubscription(sub)).toEqual(sub);
    expect(parseSubscription({ ...sub, endpoint: 'https://fcm.googleapis.com/fcm/send/x' })).not.toHaveProperty('error');
    expect(parseSubscription({ ...sub, endpoint: 'https://evil.example/push' })).toEqual({ error: 'serviço de push desconhecido' });
    expect(parseSubscription({ ...sub, endpoint: 'http://web.push.apple.com/x' })).toHaveProperty('error');
    expect(parseSubscription({ ...sub, endpoint: 'https://push.apple.com.evil.example/x' })).toHaveProperty('error');
    expect(parseSubscription({ ...sub, keys: { p256dh: 'AAAA', auth: sub.keys.auth } })).toHaveProperty('error');
  });

  it('serviço: chaves guardadas (600), JWT do VAPID válido, envio cifrado e inscrição morta apagada', async () => {
    const file = join(tempDir().dir, 'push.json');
    const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    let status = 201;
    const svc = new PushService(file, async (url, init) => (calls.push({ url, headers: init.headers, body: init.body }), { status }));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(new PushService(file).publicKey).toBe(svc.publicKey);
    const { sub, ua, auth } = browserSub();
    expect(svc.subscribe(sub)).toEqual({ ok: true });
    expect(await svc.notify({ title: 'Habblaud', body: '📦 Estela entregou', tag: 'agent:.claude:1', urgent: true })).toBe(1);
    const c = calls[0];
    expect(c.url).toBe(sub.endpoint);
    expect(c.headers).toMatchObject({ 'Content-Encoding': 'aes128gcm', Urgency: 'high', TTL: '3600', Topic: 'agentclaude1' });
    expect(JSON.parse(decrypt(c.body, ua, auth).toString())).toMatchObject({ body: '📦 Estela entregou' });
    const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(c.headers.Authorization)!;
    expect(k).toBe(svc.publicKey);
    const [h, p, sig] = token.split('.');
    expect(JSON.parse(Buffer.from(p, 'base64url').toString())).toMatchObject({ aud: 'https://web.push.apple.com' });
    const pub = Buffer.from(k, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'))).toBe(true);
    status = 410;
    await svc.notify({ title: 'x', body: 'y' });
    expect(svc.count).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).subs).toEqual([]);
  });
});
