// Novo agente (botão + na barra do topo): abre uma sessão nova no app desktop do Claude, na pasta escolhida e com o
// pedido já escrito (POST /api/spawn; server/spawn/spawn.ts). As pastas sugeridas são as salas do escritório (a mais
// recente primeiro); dá para digitar outra. O link abre a tela de sessão nova do app preenchida: Enter lá começa.
import { isDemoId } from '../../../shared/timeline';
import type { OfficeSnapshot } from '../../../shared/types';
import type { UiContext } from './context';
import { h, iconButton, setText } from './dom';
import { ICONS } from './icons';

export const SPAWN_PROMPT_MAX = 8_000;
const POLL_MS = 700;
const WAIT_MS = 20_000;

interface SpawnInfo {
  id: string;
  status: 'queued' | 'sent' | 'opened' | 'failed';
  error?: string;
}

/** Pastas das salas, da mais recente para a mais antiga (pelo agente mais recente de cada uma). */
export function spawnFolders(snap: Pick<OfficeSnapshot, 'rooms' | 'agents'> | null | undefined): string[] {
  if (!snap) return [];
  const last = new Map<string, number>();
  for (const a of snap.agents) last.set(a.roomId, Math.max(last.get(a.roomId) ?? 0, a.lastEventAt ?? 0));
  const paths = [...snap.rooms]
    .filter((r) => !isDemoId(r.id) && /^(\/|[A-Za-z]:[\\/])/.test(r.path ?? ''))
    .sort((a, b) => (last.get(b.id) ?? 0) - (last.get(a.id) ?? 0))
    .map((r) => r.path);
  return [...new Set(paths)];
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error('o Habblaud não respondeu');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `erro ${res.status}`);
  return body;
}

export class SpawnPanel {
  readonly el: HTMLElement;
  private readonly folder: HTMLInputElement;
  private readonly list: HTMLDataListElement;
  private readonly prompt: HTMLTextAreaElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private anchor?: HTMLElement;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.list = h('datalist', { attrs: { id: 'ui-spawn-folders' } });
    this.folder = h('input', {
      class: 'ui-rename__input',
      type: 'text',
      attrs: { list: 'ui-spawn-folders', id: 'ui-spawn-folder', placeholder: '/Users/voce/projeto', spellcheck: 'false', autocomplete: 'off' },
    });
    this.prompt = h('textarea', {
      class: 'ui-rename__input ui-spawn__prompt',
      attrs: { id: 'ui-spawn-prompt', rows: 5, maxlength: SPAWN_PROMPT_MAX, placeholder: 'O que o agente deve fazer (opcional)' },
    });
    this.submitBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow ui-spawn__go', type: 'button', on: { click: () => void this.submit() } }, 'Abrir no app do Claude');
    this.status = h('p', { class: 'ui-rename__hint ui-spawn__status', attrs: { role: 'status', 'aria-live': 'polite' } });
    for (const field of [this.folder, this.prompt] as HTMLElement[]) {
      field.addEventListener('keydown', (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.submit();
        }
      });
      field.addEventListener('keyup', (e) => e.stopPropagation());
    }
    const close = iconButton(ICONS.close, 'Fechar', () => this.hide(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-popover ui-spawn', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': 'Novo agente', id: 'ui-spawn', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: 'Novo agente' }), close),
      h(
        'div',
        { class: 'ui-set-group' },
        h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-spawn-folder' }, text: 'Pasta' }),
        this.folder,
        this.list,
        h('label', { class: 'ui-spawn__label', attrs: { for: 'ui-spawn-prompt' }, text: 'Pedido' }),
        this.prompt,
        h('p', { class: 'ui-rename__hint', text: 'Prepara uma sessão nova no app do Claude, no Mac, com a pasta e o pedido preenchidos: ela começa quando você aperta Enter lá.' }),
        this.submitBtn,
        this.status,
      ),
    );
    this.el.addEventListener('toggle', () => this.anchor?.setAttribute('aria-expanded', String(this.isOpen)));
  }

  get isOpen(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  toggle(anchor: HTMLElement): void {
    this.anchor = anchor;
    if (this.isOpen) return this.hide();
    const folders = spawnFolders(this.ctx.store.snapshot);
    this.list.replaceChildren(...folders.map((p) => h('option', { attrs: { value: p } })));
    if (!this.folder.value && folders[0]) this.folder.value = folders[0];
    if (!this.busy) setText(this.status, '');
    const r = anchor.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    anchor.setAttribute('aria-expanded', 'true');
    this.prompt.focus();
  }

  hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.isOpen) this.el.hidePopover();
    this.el.classList.remove('is-open');
    this.anchor?.setAttribute('aria-expanded', 'false');
  }

  private say(text: string, error = false): void {
    setText(this.status, text);
    this.status.classList.toggle('is-error', error);
  }

  private async submit(): Promise<void> {
    if (this.busy) return;
    const folder = this.folder.value.trim();
    if (!folder) return this.say('Escolha a pasta do projeto.', true);
    this.busy = true;
    this.submitBtn.disabled = true;
    this.say('Abrindo o app do Claude…');
    try {
      let info = await api<SpawnInfo>('/api/spawn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folder, prompt: this.prompt.value }),
      });
      const end = Date.now() + WAIT_MS;
      while ((info.status === 'queued' || info.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        info = await api<SpawnInfo>(`/api/spawn/${encodeURIComponent(info.id)}`);
      }
      if (info.status === 'opened') {
        this.say('Pronto no app do Claude: confira e aperte Enter lá para começar.');
        this.prompt.value = '';
        this.ctx.announce('Agente novo aberto no app do Claude.');
      } else this.say(info.error ? `Não abriu: ${info.error}` : 'O Mac não confirmou a abertura.', true);
    } catch (err) {
      this.say(`Não abriu: ${(err as Error).message}`, true);
    } finally {
      this.busy = false;
      this.submitBtn.disabled = false;
    }
  }
}
