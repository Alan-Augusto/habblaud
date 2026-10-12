import { describe, expect, it } from 'vitest';
import type { DeliveryInfo } from '../../shared/types';
import { plainNotice, PushAnnouncer } from './announcer';
import type { PushMessage } from './webpush';

const delivery = (id: string, finishedAt: number): DeliveryInfo => ({ id, account: 'a', sessionId: `s-${id}`, agentName: 'Kauã', request: '', headline: `Feito ${id}.`, text: '', startedAt: 0, finishedAt, tools: 1, edited: 0, attachments: [] });

describe('PushAnnouncer', () => {
  it('precisa de você vira aviso urgente que abre o agente; nada sem aparelho inscrito', async () => {
    const sent: PushMessage[] = [];
    const push = { count: 1, notify: async (m: PushMessage) => (sent.push(m), 1) };
    const a = new PushAnnouncer({ push });
    a.onNotice({ id: 'n1', level: 'alert', text: '✋ Kauã precisa de você em loja-demo: aprovar um comando', agentId: '.claude:9', at: 1 });
    a.onNotice({ id: 'n2', level: 'info', text: '👋 chegou', at: 2 });
    expect(sent).toEqual([{ title: 'Precisa de você', body: 'Kauã precisa de você em loja-demo: aprovar um comando', tag: 'wait-.claude:9', url: '/?agent=.claude%3A9', urgent: true }]);
    push.count = 0;
    a.onNotice({ id: 'n3', level: 'alert', text: '✋ x', at: 3 });
    expect(sent).toHaveLength(1);
  });

  it('entrega nova depois de "concluiu": manchete e link para a entrega, uma vez só', async () => {
    const sent: PushMessage[] = [];
    let list = [delivery('old', 50), delivery('d1', 150)];
    const a = new PushAnnouncer({ push: { count: 1, notify: async (m) => (sent.push(m), 1) }, deliveries: { list: async () => list }, now: () => 100, settleMs: 1 });
    expect(await a.checkDeliveries()).toBe(1);
    expect(sent[0]).toMatchObject({ title: '📦 Kauã entregou', body: 'Feito d1.', url: '/?delivery=d1' });
    expect(await a.checkDeliveries()).toBe(0);
    list = [...list, delivery('d2', 200)];
    a.onNotice({ id: 'n', level: 'success', text: '✅ Kauã concluiu em loja-demo', at: 5 });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(sent.map((m) => m.body)).toEqual(['Feito d1.', 'Feito d2.']);
  });

  it('plainNotice tira o emoji do começo', () => {
    expect(plainNotice('📦 Estela entregou')).toBe('Estela entregou');
    expect(plainNotice('Sem emoji')).toBe('Sem emoji');
  });
});
