// Avisos no celular (Web Push), em Configurações › Avisos: "precisa de você" e "entregou" chegam como notificação mesmo
// com o Habblaud fechado. No iPhone só funciona com o app adicionado à Tela de Início (Compartilhar › Adicionar à Tela
// de Início) e aberto pelo ícone; o botão explica isso quando falta. O servidor guarda a inscrição do aparelho
// (server/push/webpush.ts) e o service worker (/sw.js) mostra o aviso; o toque abre o agente ou a entrega certa.
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';

export type PushSupport = 'ok' | 'install' | 'unsupported';

export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
}

export function isIOS(ua = navigator.userAgent, touch = navigator.maxTouchPoints): boolean {
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1);
}

/** O que dá para fazer neste navegador: ligar, instalar primeiro (iPhone no Safari) ou nada. */
export function pushSupport(): PushSupport {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return isIOS() ? 'install' : 'unsupported';
  if (!('PushManager' in window) || typeof Notification === 'undefined') return isIOS() && !isStandalone() ? 'install' : 'unsupported';
  return 'ok';
}

/** Chave pública do VAPID (base64url) no formato que o PushManager pede. */
export function keyBytes(b64url: string): Uint8Array {
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(json.error ?? `erro ${res.status}`);
  return json;
}

let registration: Promise<ServiceWorkerRegistration | null> | null = null;

/** Registra o /sw.js (uma vez); null se o navegador não deixa. */
export function serviceWorker(): Promise<ServiceWorkerRegistration | null> {
  registration ??= 'serviceWorker' in navigator && window.isSecureContext ? navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => null) : Promise.resolve(null);
  return registration;
}

/** Toque num aviso com o app aberto: o service worker manda o caminho (?agent= / ?delivery=) para esta janela. */
export function onPushOpen(cb: (url: URL) => void): void {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as { type?: string; url?: string } | null;
    if (d?.type === 'habblaud:open' && typeof d.url === 'string' && d.url.startsWith('/')) cb(new URL(d.url, location.origin));
  });
}

export class PushSettings {
  readonly el: HTMLElement;
  private readonly status: HTMLElement;
  private readonly toggleBtn: HTMLButtonElement;
  private readonly testBtn: HTMLButtonElement;
  private subscribed = false;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.status = h('span', { class: 'ui-set__hint', text: 'Verificando…' });
    this.toggleBtn = h('button', { class: 'ui-btn ui-push__btn', type: 'button', text: 'Ligar', on: { click: () => void this.toggle() } });
    this.testBtn = h('button', { class: 'ui-btn ui-push__btn', type: 'button', text: 'Testar', hidden: true, on: { click: () => void this.test() } });
    this.el = h(
      'div',
      { class: 'ui-set ui-push' },
      h('div', { class: 'ui-set__text' }, h('span', { class: 'ui-set__label', text: 'Avisos no celular' }), this.status),
      h('div', { class: 'ui-push__actions' }, this.testBtn, this.toggleBtn),
    );
  }

  /** Relê o estado (ao abrir as Configurações). */
  async refresh(): Promise<void> {
    const support = pushSupport();
    if (support !== 'ok') {
      this.subscribed = false;
      setHidden(this.toggleBtn, true);
      setHidden(this.testBtn, true);
      setText(
        this.status,
        support === 'install'
          ? 'No iPhone: toque em Compartilhar › Adicionar à Tela de Início, abra o Habblaud pelo ícone e ligue aqui.'
          : 'Este navegador não recebe avisos com o app fechado.',
      );
      return;
    }
    const reg = await serviceWorker();
    const sub = await reg?.pushManager.getSubscription().catch(() => null);
    this.subscribed = !!sub;
    this.paint();
  }

  private paint(text?: string): void {
    setHidden(this.toggleBtn, false);
    setText(this.toggleBtn, this.subscribed ? 'Desligar' : 'Ligar');
    this.toggleBtn.classList.toggle('ui-perm__btn--allow', !this.subscribed);
    this.toggleBtn.disabled = this.busy;
    setHidden(this.testBtn, !this.subscribed);
    this.testBtn.disabled = this.busy;
    setText(
      this.status,
      text ??
        (this.subscribed
          ? 'Ligados neste aparelho: "precisa de você" e "entregou" chegam mesmo com o app fechado.'
          : Notification.permission === 'denied'
            ? 'Bloqueados: libere as notificações do Habblaud nos Ajustes do aparelho.'
            : 'Receba "precisa de você" e "entregou" mesmo com o app fechado.'),
    );
  }

  private async toggle(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.paint(this.subscribed ? 'Desligando…' : 'Ligando…');
    try {
      const reg = await serviceWorker();
      if (!reg) throw new Error('o navegador não deixou registrar o app');
      if (this.subscribed) {
        const sub = await reg.pushManager.getSubscription();
        if (sub) {
          await api('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
          await sub.unsubscribe();
        }
        this.subscribed = false;
        this.busy = false;
        this.paint('Desligados neste aparelho.');
        return;
      }
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') throw new Error(perm === 'denied' ? 'notificações bloqueadas nos Ajustes do aparelho' : 'permissão não concedida');
      const { publicKey } = await api<{ publicKey: string }>('/api/push');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) as BufferSource });
      await api('/api/push/subscribe', { subscription: sub.toJSON() });
      this.subscribed = true;
      this.busy = false;
      this.paint();
      this.ctx.announce('Avisos no celular ligados.');
      void this.test();
    } catch (err) {
      this.busy = false;
      this.paint(`Não deu: ${(err as Error).message}`);
    }
  }

  private async test(): Promise<void> {
    try {
      const r = await api<{ sent: number }>('/api/push/test', {});
      this.paint(r.sent ? 'Aviso de teste enviado: deve aparecer em instantes.' : 'O aviso de teste não saiu (o serviço de push recusou). Desligue e ligue de novo.');
    } catch (err) {
      this.paint(`Teste falhou: ${(err as Error).message}`);
    }
  }
}
