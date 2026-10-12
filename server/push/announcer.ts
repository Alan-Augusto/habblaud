// O que vira aviso no celular (server/push/webpush.ts): "precisa de você" (o aviso de alerta do escritório) e cada
// entrega nova (quando um agente conclui, a lista de entregas é relida e o que apareceu depois do último aviso vai com
// a manchete). Só manda quando há aparelho inscrito; o toque abre o agente ou a entrega certa (?agent= / ?delivery=).
import type { DeliveryInfo, Notice } from '../../shared/types';
import type { PushMessage } from './webpush';

export interface AnnouncerOptions {
  push: { readonly count: number; notify(msg: PushMessage): Promise<number> };
  deliveries?: { list(): Promise<DeliveryInfo[]> };
  now?: () => number;
  /** Espera depois do "concluiu" para o transcript ter a resposta final. */
  settleMs?: number;
}

const MAX_PER_CHECK = 3;

/** Tira o emoji do começo do aviso ("✋ Kauã precisa de você..." → "Kauã precisa de você..."). */
export function plainNotice(text: string): string {
  return text.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

export class PushAnnouncer {
  private since: number;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AnnouncerOptions) {
    this.since = (opts.now ?? Date.now)();
  }

  onNotice(n: Notice): void {
    if (!this.opts.push.count) return;
    if (n.level === 'alert') {
      void this.opts.push.notify({
        title: 'Precisa de você',
        body: plainNotice(n.text),
        tag: `wait-${n.agentId ?? n.id}`,
        url: n.agentId ? `/?agent=${encodeURIComponent(n.agentId)}` : '/',
        urgent: true,
      });
    } else if (n.level === 'success' && n.text.startsWith('✅') && this.opts.deliveries) {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.checkDeliveries(), this.opts.settleMs ?? 2_500);
      this.timer.unref?.();
    }
  }

  async checkDeliveries(): Promise<number> {
    this.timer = null;
    let list: DeliveryInfo[];
    try {
      list = (await this.opts.deliveries?.list()) ?? [];
    } catch {
      return 0;
    }
    const fresh = list.filter((d) => d.finishedAt > this.since).sort((a, b) => a.finishedAt - b.finishedAt);
    if (!fresh.length) return 0;
    this.since = Math.max(...fresh.map((d) => d.finishedAt));
    let sent = 0;
    for (const d of fresh.slice(-MAX_PER_CHECK)) {
      sent += await this.opts.push.notify({
        title: `📦 ${d.agentName ?? 'Um agente'} entregou`,
        body: d.headline,
        tag: `deliv-${d.sessionId.slice(0, 8)}`,
        url: `/?delivery=${encodeURIComponent(d.id)}`,
      });
    }
    return sent;
  }
}
