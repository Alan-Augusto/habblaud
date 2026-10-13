// Caixa de mensagem: manda um texto ao agente principal pelo Habblaud (POST /api/messages) e o plugin
// habblaud-mensagens o entrega à sessão como se você o tivesse digitado (no Codex, `codex queue` a põe na fila da
// sessão, que a usa quando fica ociosa). Fica na gaveta do agente e no rodapé do
// terminal (só a sessão ao vivo). Enter manda, Shift+Enter quebra a linha; a linha de situação acompanha a entrega
// (GET /api/messages/:id) até ela se resolver. As teclas digitadas aqui não disparam os atalhos globais. O rascunho de
// cada agente fica guardado (só na memória) ao trocar de agente. O microfone (ui/dictation.ts, Whisper local no Mac)
// põe o texto ditado no cursor; aparece quando o ditado funciona daqui. Com `/` no começo, abre o menu de comandos de
// barra da sessão do agente (a lista vem do plugin, por GET /api/messages/commands/:id): filtra ao digitar, setas
// andam, Enter ou Tab completam e Esc fecha. Com `@`, o mesmo menu lista os arquivos do projeto do agente que casam
// com o que vem depois (GET /api/messages/files/:id) e o escolhido entra como `@caminho`. A lógica pura está em
// ui/composer-model.ts.
import { MESSAGE_MAX } from '../../../shared/messages';
import type { AgentInfo, OutboxMessage, Provider, SessionCommand } from '../../../shared/types';
import {
  applyCommand,
  applyMention,
  canSend,
  commandOptions,
  commandQuery,
  COMMANDS_EMPTY_FRESH_MS,
  COMMANDS_FRESH_MS,
  composerMode,
  composerTip,
  enterSends,
  FILE_SEARCH_CACHE,
  FILE_SEARCH_DELAY_MS,
  fileOptions,
  isSettled,
  LOST_ERROR,
  menuAction,
  mentionQuery,
  messageText,
  moveActive,
  OFFLINE_ERROR,
  POLL_LIMIT_MS,
  pollDelay,
  sendStatusText,
  splitPath,
  timeoutError,
  type CommandOption,
  type ComposerMode,
  type SendState,
} from './composer-model';
import type { UiContext } from './context';
import { DictationButton, dictationAvailable, insertDictation } from './dictation';
import { h, setAttr, setHidden, setText, setTitle } from './dom';
import { access } from '../net/access';
import { tr } from '../../../shared/i18n';

export type ComposerVariant = 'drawer' | 'terminal';

export interface ComposerOptions {
  /** Esc dentro da caixa: para onde vai o foco (padrão: só sai da caixa). */
  onEscape?: () => void;
}

export class MessageComposer {
  readonly el: HTMLElement;
  /** Agente da caixa (ou a chave da conversa, no terminal do histórico). */
  private agentId = '';
  private mode: ComposerMode = { kind: 'off', text: '' };
  /** Rascunho por agente: é ele que manda no conteúdo da caixa. */
  private drafts = new Map<string, string>();
  /** Último envio de cada agente (a linha de situação). */
  private states = new Map<string, SendState>();
  /** Ferramenta de cada agente que recebeu mensagem (o texto da entrega e do prazo muda no Codex). */
  private providers = new Map<string, Provider>();
  /** Ferramenta do agente da caixa. */
  private provider: Provider = 'claude';
  /** O que a caixa mostra agora ("<agente>|<pronta>"): ao mudar, o conteúdo vem do rascunho. */
  private shown = '';

  private row: HTMLElement;
  private box: HTMLTextAreaElement;
  private sendBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private tip: HTMLElement | null;
  private status: HTMLElement;
  private dictate: DictationButton;
  /** Linha do ditado (gravando, transcrevendo, idioma, erro). */
  private dictStatus: HTMLElement;
  private dictTimer: ReturnType<typeof setTimeout> | null = null;
  /** Rascunho que recebe o ditado em andamento (o agente pode mudar enquanto o Mac transcreve). */
  private dictKey = '';
  private canDictate = false;
  /** Menu de comandos de barra: a lista de cada agente (com a hora da busca), o que está na tela e o destaque. */
  private menu: HTMLElement;
  private commandLists = new Map<string, { at: number; list: SessionCommand[] }>();
  private fetching = new Set<string>();
  private options: CommandOption[] = [];
  private active = 0;
  /** Fechado com Esc: só volta a abrir quando o texto mudar. */
  private menuClosed = false;
  /** Arquivos citados com `@`: as buscas já feitas ("<agente>\n<texto>"), a que está na tela e a que espera a vez. */
  private fileHits = new Map<string, string[]>();
  private fileKey = '';
  private fileTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private ctx: UiContext,
    private variant: ComposerVariant,
    private opts: ComposerOptions = {},
  ) {
    const term = variant === 'terminal';
    this.box = h('textarea', {
      class: `ui-msg__input${term ? ' ui-term__input' : ''}`,
      attrs: { rows: 1, maxlength: MESSAGE_MAX, autocomplete: 'off', enterkeyhint: 'send' },
    });
    this.box.addEventListener('input', () => {
      this.drafts.set(this.agentId, this.box.value);
      this.resize();
      this.syncButton();
      this.menuClosed = false;
      this.syncMenu();
    });
    this.box.addEventListener('focus', () => {
      this.resize();
      this.syncMenu();
    });
    this.box.addEventListener('blur', () => this.syncMenu());
    // O cursor saiu do nome do comando (setas, clique): o menu fecha; voltou, abre.
    this.box.addEventListener('keyup', () => this.syncMenu());
    this.box.addEventListener('click', () => this.syncMenu());
    this.box.addEventListener('keydown', (e) => this.onKey(e));
    this.menu = h('ul', { class: 'ui-msg__menu', role: 'listbox', hidden: true, attrs: { id: `ui-msg-menu-${variant}`, 'aria-label': tr('Comandos de barra') } });
    setAttr(this.box, 'aria-controls', this.menu.id);
    setAttr(this.box, 'aria-autocomplete', 'list');
    this.sendBtn = h(
      'button',
      {
        class: term ? 'ui-msg__send' : 'ui-btn ui-msg__send',
        type: 'button',
        title: tr('Mandar (Enter)'),
        attrs: { 'aria-label': tr('Mandar a mensagem') },
        on: { click: () => void this.send() },
      },
      term ? '↵' : tr('Enviar'),
    );
    this.dictStatus = h('p', { class: 'ui-msg__status ui-msg__dictation', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.dictate = new DictationButton(
      (t) => this.insertDictated(t.text),
      (text, error) => this.sayDictation(text, error),
      { compact: true, onStart: () => (this.dictKey = this.agentId) },
    );
    this.dictate.el.classList.add('ui-msg__mic');
    setHidden(this.dictate.el, true);
    this.row = h('div', { class: `ui-msg__row${term ? ' ui-term__prompt ui-term__prompt--mic' : ''}` });
    if (term) this.row.append(h('span', { class: 'ui-term__caret', text: '>', attrs: { 'aria-hidden': 'true' } }));
    this.row.append(this.box, this.dictate.el, this.sendBtn);
    // Clique na "linha do prompt" (fora do botão) põe o cursor na caixa, como num terminal.
    this.row.addEventListener('mousedown', (e) => {
      if (e.target === this.row && !this.box.disabled) {
        e.preventDefault();
        this.box.focus();
      }
    });
    this.hint = h('p', { class: 'ui-msg__hint', hidden: true });
    this.status = h('p', { class: 'ui-msg__status', role: 'status', hidden: true, attrs: { 'aria-live': 'polite' } });
    this.tip = term ? null : h('p', { class: 'ui-msg__tip', text: composerTip() });
    // O menu abre para cima, ancorado na linha da caixa.
    const anchor = h('div', { class: 'ui-msg__anchor' }, this.menu, this.row);
    this.el = h('div', { class: `ui-msg ui-msg--${variant}` }, this.hint, anchor, this.dictStatus, this.status, this.tip);
  }

  /**
   * Atualiza a caixa para `agent` (undefined = nenhum: sessão do histórico ou agente que saiu); `key` identifica o
   * rascunho. Devolve o modo: a gaveta esconde a seção quando é 'off'.
   */
  render(agent: AgentInfo | undefined, key = agent?.id ?? ''): ComposerMode['kind'] {
    const store = this.ctx.store;
    const mode = composerMode(agent, {
      enabled: store.mock || !!store.snapshot?.meta.messages,
      local: store.mock || access().messages,
      replaying: store.replaying,
    });
    this.mode = mode;
    const ready = mode.kind === 'ready';
    const term = this.variant === 'terminal';
    this.provider = agent?.provider === 'codex' ? 'codex' : 'claude';

    // Troca de agente (ou a caixa passou a valer/deixou de valer): o conteúdo vem do rascunho guardado.
    const shown = `${key}|${ready}`;
    if (shown !== this.shown) {
      // Gravando para outro agente: para sem transcrever (a fala era para aquele).
      this.dictate.cancel();
      this.shown = shown;
      this.agentId = key;
      this.box.value = ready ? (this.drafts.get(key) ?? '') : '';
      this.box.style.height = '';
      if (ready) requestAnimationFrame(() => this.resize());
    }
    this.box.disabled = !ready;
    const name = agent?.name ?? tr('o agente');
    const placeholder = ready ? (term ? tr('Mensagem para {0} (Enter manda, Shift+Enter quebra a linha)', [name]) : tr('Mensagem para {0}…', [name])) : mode.text;
    setAttr(this.box, 'placeholder', placeholder);
    setAttr(this.box, 'aria-label', ready ? tr('Mensagem para {0}', [name]) : mode.text);
    setTitle(this.box, ready ? '' : mode.text);
    this.row.classList.toggle('is-disabled', !ready);
    setHidden(this.sendBtn, !ready);
    // Consulta em cache (30 s): o Mac pode instalar o Whisper ou parar o auxiliar com a página aberta.
    void dictationAvailable().then((ok) => {
      if (ok === this.canDictate) return;
      this.canDictate = ok;
      this.ctx.invalidate();
    });
    // Transcrevendo: o botão fica até o texto chegar (ele vai para o rascunho de quem ditou).
    setHidden(this.dictate.el, !this.canDictate || (!ready && !this.dictate.busy));
    // Na gaveta, a dica do plugin entra no lugar da caixa; no terminal ela já está no lugar do texto.
    setHidden(this.row, !term && !ready);
    if (this.tip) {
      setHidden(this.tip, !ready);
      setText(this.tip, composerTip(this.provider));
    }
    setHidden(this.hint, term || mode.kind !== 'hint');
    setText(this.hint, mode.kind === 'hint' ? mode.text : '');
    this.syncButton();
    this.syncMenu();

    const state = this.states.get(key);
    const text = sendStatusText(state, Date.now(), this.providers.get(key) ?? this.provider);
    setText(this.status, text);
    setHidden(this.status, !text);
    this.status.classList.toggle('is-error', state?.phase === 'failed' || state?.phase === 'rejected');
    this.status.classList.toggle('is-ok', state?.phase === 'delivered');
    return mode.kind;
  }

  // ---------------------------------------------------------------- internos

  private onKey(e: KeyboardEvent): void {
    // Os atalhos globais (F, T, P, /, setas...) não valem dentro da caixa. Com Ctrl/⌘ a tecla segue adiante
    // (Ctrl/⌘+F busca na conversa do terminal; os atalhos globais ignoram essas combinações).
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    if (!this.menu.hidden) {
      const at = this.box.selectionStart ?? 0;
      const typed = this.options[0]?.file ? mentionQuery(this.box.value, at)?.query : commandQuery(this.box.value, at);
      const action = menuAction(e, typed ?? '', this.options[this.active]);
      if (action) {
        // Esc fecha só o menu (o próximo sai da caixa).
        e.preventDefault();
        e.stopPropagation();
        if (action === 'close') {
          this.menuClosed = true;
          this.syncMenu();
        } else if (action === 'pick') this.pick(this.active);
        else this.setActive(moveActive(this.active, this.options.length, action === 'next' ? 1 : -1));
        return;
      }
    }
    if (e.key === 'Escape') {
      // Esc só sai da caixa (o próximo fecha o terminal ou a gaveta).
      e.preventDefault();
      e.stopPropagation();
      if (this.opts.onEscape) this.opts.onEscape();
      else this.box.blur();
      return;
    }
    if (enterSends(e)) {
      e.preventDefault();
      void this.send();
    }
  }

  /**
   * Abre, atualiza ou fecha o menu conforme o texto e o cursor, com a caixa em foco: os comandos de barra (só no
   * Claude Code: é o plugin dele que manda a lista) ou os arquivos citados com `@`. Sem nada que case, fica fechado.
   */
  private syncMenu(): void {
    const box = this.box;
    const caret = box.selectionStart ?? 0;
    if (this.mode.kind !== 'ready' || document.activeElement !== box || this.menuClosed) return this.showMenu([]);
    const query = this.provider === 'claude' ? commandQuery(box.value, caret) : undefined;
    let options: CommandOption[];
    if (query !== undefined) {
      this.loadCommands(this.agentId);
      options = commandOptions(this.commandLists.get(this.agentId)?.list ?? [], query);
    } else {
      const mention = mentionQuery(box.value, caret);
      if (!mention) return this.showMenu([]);
      const hits = this.loadFiles(this.agentId, mention.query);
      // Busca a caminho: o menu de arquivos que já está na tela fica até ela chegar (sem piscar a cada letra).
      if (!hits && this.options[0]?.file) return;
      options = fileOptions(hits ?? []);
    }
    // A lista é a mesma (o cursor andou, a tecla soltou): o destaque fica; mudou, volta ao primeiro.
    const same = options.length === this.options.length && options.every((o, i) => o.name === this.options[i].name);
    this.showMenu(options, same ? this.active : 0);
  }

  /**
   * Os arquivos do projeto do agente que casam com `query`, se a busca já foi feita; senão undefined, e ela é pedida
   * quando a digitação parar um instante (o menu é atualizado quando chegar). Falha = nenhum arquivo.
   */
  private loadFiles(agentId: string, query: string): string[] | undefined {
    const key = `${agentId}\n${query}`;
    const hit = this.fileHits.get(key);
    if (hit || key === this.fileKey) return hit;
    this.fileKey = key;
    if (this.fileTimer) clearTimeout(this.fileTimer);
    this.fileTimer = setTimeout(() => {
      this.fileTimer = null;
      this.ctx.store
        .projectFiles(agentId, query)
        .catch(() => [] as string[])
        .then((files) => {
          this.fileHits.set(key, files);
          if (this.fileHits.size > FILE_SEARCH_CACHE) this.fileHits.delete(this.fileHits.keys().next().value as string);
          if (key === this.fileKey) {
            this.fileKey = '';
            this.syncMenu();
          }
        });
    }, FILE_SEARCH_DELAY_MS);
    return undefined;
  }

  private showMenu(options: CommandOption[], active = 0): void {
    const same = options.length === this.options.length && options.every((o, i) => o.name === this.options[i].name && o.description === this.options[i].description);
    this.options = options;
    const open = options.length > 0;
    setHidden(this.menu, !open);
    setAttr(this.box, 'aria-expanded', String(open));
    if (open) setAttr(this.menu, 'aria-label', options[0].file ? tr('Arquivos do projeto') : tr('Comandos de barra'));
    if (!same) {
      this.menu.replaceChildren(
        ...options.map((o, i) => {
          // Arquivo: o nome em destaque e a pasta ao lado; comando: `/nome` e a descrição.
          const path = o.file ? splitPath(o.name) : undefined;
          const item = h(
            'li',
            { class: `ui-msg__opt${o.panel ? ' is-panel' : ''}`, role: 'option', title: path ? o.name : undefined, attrs: { id: `${this.menu.id}-${i}` } },
            h('span', { class: 'ui-msg__opt-name', text: path ? path.name : `/${o.name}` }),
            h('span', { class: 'ui-msg__opt-desc', text: path ? path.dir : o.description }),
            o.panel ? h('span', { class: 'ui-msg__opt-tag', text: tr('só no terminal'), title: tr('Abre um painel no terminal da sessão, que o escritório não mostra') }) : null,
          );
          // mousedown (e não click): a caixa não perde o foco, e o menu não fecha antes da escolha.
          item.addEventListener('mousedown', (e) => {
            e.preventDefault();
            this.pick(i);
          });
          return item;
        }),
      );
    }
    this.setActive(open ? Math.min(active, options.length - 1) : 0);
  }

  private setActive(index: number): void {
    this.active = index;
    const items = this.menu.children;
    for (let i = 0; i < items.length; i++) {
      const on = i === index;
      items[i].classList.toggle('is-active', on);
      setAttr(items[i], 'aria-selected', String(on));
      if (on && !this.menu.hidden) (items[i] as HTMLElement).scrollIntoView({ block: 'nearest' });
    }
    setAttr(this.box, 'aria-activedescendant', this.menu.hidden || !items[index] ? null : items[index].id);
  }

  /**
   * Completa a caixa com o comando ou o arquivo escolhido; o menu fecha (o cursor fica depois dele, pronto para o
   * argumento ou o resto da mensagem).
   */
  private pick(index: number): void {
    const option = this.options[index];
    if (!option) return;
    const at = this.box.selectionStart ?? this.box.value.length;
    const mention = option.file ? mentionQuery(this.box.value, at) : undefined;
    if (option.file && !mention) return;
    const { value, caret } = mention ? applyMention(this.box.value, mention.start, at, option.name) : applyCommand(this.box.value, option.name);
    this.box.value = value.slice(0, MESSAGE_MAX);
    this.drafts.set(this.agentId, this.box.value);
    this.box.focus({ preventScroll: true });
    this.box.setSelectionRange(caret, caret);
    this.resize();
    this.syncButton();
    this.syncMenu();
  }

  /** Busca a lista de comandos do agente, se a que há é velha (ou não há). Falha = fica a que havia. */
  private loadCommands(agentId: string): void {
    const known = this.commandLists.get(agentId);
    const fresh = known && Date.now() - known.at < (known.list.length ? COMMANDS_FRESH_MS : COMMANDS_EMPTY_FRESH_MS);
    if (fresh || this.fetching.has(agentId)) return;
    this.fetching.add(agentId);
    this.ctx.store
      .sessionCommands(agentId)
      .then((list) => this.commandLists.set(agentId, { at: Date.now(), list }))
      .catch(() => undefined)
      .finally(() => {
        this.fetching.delete(agentId);
        if (agentId === this.agentId) this.syncMenu();
      });
  }

  /** Texto ditado: no cursor, se a caixa ainda é a de quem ditou; senão, no fim do rascunho daquele agente. */
  private insertDictated(text: string): void {
    const key = this.dictKey;
    if (key === this.agentId && !this.box.disabled) {
      const box = this.box;
      const { value, caret } = insertDictation(box.value, box.selectionStart ?? box.value.length, box.selectionEnd ?? box.value.length, text);
      box.value = value.slice(0, MESSAGE_MAX);
      this.drafts.set(key, box.value);
      this.resize();
      this.syncButton();
      box.focus({ preventScroll: true });
      box.setSelectionRange(caret, caret);
    } else {
      const cur = this.drafts.get(key) ?? '';
      this.drafts.set(key, insertDictation(cur, cur.length, cur.length, text).value.slice(0, MESSAGE_MAX));
    }
  }

  private sayDictation(text: string, error = false): void {
    if (this.dictTimer) clearTimeout(this.dictTimer);
    setText(this.dictStatus, text);
    setHidden(this.dictStatus, !text);
    this.dictStatus.classList.toggle('is-error', error);
    // Avisos de sucesso somem sozinhos; "Gravando…" e "Transcrevendo…" ficam até a próxima mudança.
    if (!error && !/…$/.test(text)) this.dictTimer = setTimeout(() => setHidden(this.dictStatus, true), 6_000);
  }

  private syncButton(): void {
    this.sendBtn.disabled = this.mode.kind !== 'ready' || !canSend(this.box.value) || this.states.get(this.agentId)?.phase === 'sending';
  }

  /** Cresce com o texto até o limite do CSS (~6 linhas; depois rola). Escondida, mede quando aparecer. */
  private resize(): void {
    const box = this.box;
    if (!box.isConnected || box.offsetParent === null) return;
    box.style.height = 'auto';
    box.style.height = `${box.scrollHeight + box.offsetHeight - box.clientHeight}px`;
  }

  private setState(agentId: string, state: SendState): void {
    this.states.set(agentId, state);
    if (agentId === this.agentId) this.syncButton();
    this.ctx.invalidate();
  }

  private async send(): Promise<void> {
    const agentId = this.agentId;
    const raw = this.box.value;
    if (this.mode.kind !== 'ready' || !canSend(raw) || this.states.get(agentId)?.phase === 'sending') return;
    this.providers.set(agentId, this.provider);
    this.setState(agentId, { phase: 'sending', at: Date.now() });
    let r: { message: OutboxMessage } | { error: string };
    try {
      r = await this.ctx.store.sendMessage(agentId, messageText(raw));
    } catch {
      r = { error: OFFLINE_ERROR };
    }
    if ('error' in r) {
      // Recusada: o texto continua na caixa para tentar de novo.
      this.setState(agentId, { phase: 'rejected', error: r.error, at: Date.now() });
      return;
    }
    // Na fila: a caixa esvazia (a não ser que você tenha continuado a escrever enquanto o envio ia).
    if ((this.drafts.get(agentId) ?? '') === raw) {
      this.drafts.delete(agentId);
      if (this.agentId === agentId && this.box.value === raw) {
        this.box.value = '';
        this.resize();
      }
    }
    const m = r.message;
    this.setState(agentId, { phase: m.status, id: m.id, error: m.error, at: Date.now() });
    if (!isSettled(m.status)) this.poll(agentId, m.id, Date.now());
  }

  /** Consulta a situação até ela se resolver (ou o prazo acabar). Para quando outro envio toma a linha de situação. */
  private poll(agentId: string, id: string, since: number): void {
    const step = async () => {
      if (this.states.get(agentId)?.id !== id) return;
      let m: OutboxMessage | null | undefined;
      try {
        m = await this.ctx.store.messageStatus(id);
      } catch {
        // Sem conexão agora: tenta de novo na próxima volta.
      }
      const cur = this.states.get(agentId);
      if (cur?.id !== id) return;
      const now = Date.now();
      if (m === null) return this.setState(agentId, { phase: 'failed', id, error: LOST_ERROR, at: now });
      if (m && (m.status !== cur.phase || m.error !== cur.error)) this.setState(agentId, { phase: m.status, id, error: m.error, at: now });
      if (m && isSettled(m.status)) return;
      const elapsed = now - since;
      if (elapsed >= POLL_LIMIT_MS) return this.setState(agentId, { phase: 'failed', id, error: timeoutError(this.providers.get(agentId)), at: now });
      setTimeout(() => void step(), pollDelay(elapsed));
    };
    setTimeout(() => void step(), pollDelay(0));
  }
}
