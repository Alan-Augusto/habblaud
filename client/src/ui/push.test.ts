import { describe, expect, it } from 'vitest';
import { isIOS, keyBytes } from './push';

describe('avisos no celular', () => {
  it('chave do VAPID em base64url vira os bytes certos', () => {
    const bytes = new Uint8Array(65).map((_, i) => (i * 37) % 256);
    const b64url = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect([...keyBytes(b64url)]).toEqual([...bytes]);
  });
  it('reconhece iPhone e iPad (que se apresenta como Mac com toque)', () => {
    expect(isIOS('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true);
    expect(isIOS('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isIOS('Mozilla/5.0 (Linux; Android 14)', 5)).toBe(false);
  });
});
