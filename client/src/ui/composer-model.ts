// Caixa de mensagem (ui/composer.ts), parte pura e testada em ui/composer-model.test.ts: quando a caixa aparece (e
// por que não), o que a tecla Enter faz, o menu de comandos de barra e o de arquivos citados com `@` (quando abrem, o
// que listam e o que cada tecla faz neles), a linha de situação de cada envio e o ritmo da consulta da entrega.
// No Codex a mensagem entra na fila da sessão (`codex queue`) e vira prompt quando ela fica ociosa: "Entregue" diz
// isso; sem quem entregue (no Docker, o auxiliar do host), a dica é a do `npm run codex:bridge`.
import { MESSAGE_MAX, panelCommandReason } from '../../../shared/messages';
import type { AgentInfo, OutboxStatus, Provider, SessionCommand } from '../../../shared/types';
import { tr } from '../../../shared/i18n';

/** Dica para quem tem o recurso ligado, mas a sessão do agente não está com o plugin conectado. */
export const PLUGIN_HINT = tr('Para mandar mensagens daqui: npm run mod:install (plugin habblaud-mensagens)');
/** A mesma dica para um agente do Codex sem entregador (no modo Node o próprio servidor entrega). */
export const CODEX_BRIDGE_HINT = tr('Para mandar mensagens ao Codex: com o Habblaud no Docker, deixe npm run codex:bridge rodando; no modo Node funciona sozinho');

/**
 * - ready: dá para mandar (principal com o plugin conectado, recurso ligado, página local);
 * - hint: recurso ligado e principal presente, mas a sessão não está com o plugin (`text` diz como instalar);
 * - off: não dá (`text` diz por quê). A gaveta esconde a caixa; o terminal mostra o motivo no lugar dela.
 */
export type ComposerMode = { kind: 'ready' } | { kind: 'hint'; text: string } | { kind: 'off'; text: string };

export interface ComposerEnv {
  /** Recurso ligado no servidor (OfficeSnapshot.meta.messages; no ?mock=1, sempre). */
  enabled: boolean;
  /** Página aberta pelo próprio computador (o servidor só aceita mensagens assim). */
  local: boolean;
  /** Timelapse: o escritório mostrado é o do momento reproduzido. */
  replaying: boolean;
}

export function composerMode(agent: AgentInfo | undefined, env: ComposerEnv): ComposerMode {
  if (env.replaying) return { kind: 'off', text: tr('Sem mensagens no timelapse: o escritório mostrado é o de outro momento') };
  if (agent?.kind === 'sub') return { kind: 'off', text: tr('Subagentes não recebem mensagens: escreva para o agente principal') };
  if (!agent || agent.status === 'offline' || agent.status === 'done') return { kind: 'off', text: tr('Sessão encerrada') };
  const codex = agent.provider === 'codex';
  if (!env.enabled) return { kind: 'off', text: codex ? tr('Para responder, use o Codex') : tr('Para responder, use o terminal do Claude Code') };
  if (!env.local) return { kind: 'off', text: tr('Para mandar mensagens por aqui, abra o Habblaud por http://localhost (ou 127.0.0.1)') };
  if (!agent.canMessage) return { kind: 'hint', text: codex ? CODEX_BRIDGE_HINT : PLUGIN_HINT };
  return { kind: 'ready' };
}

/** Dica embaixo da caixa (gaveta): como a mensagem entra na sessão. */
export function composerTip(provider: Provider = 'claude'): string {
  return provider === 'codex'
    ? tr('Entra na fila da sessão e vira o próximo prompt quando o Codex terminar o que está fazendo. Enter manda; Shift+Enter quebra a linha.')
    : tr('Entra na sessão como se você tivesse digitado. Enter manda; Shift+Enter quebra a linha.');
}

/** Dica dos anexos (gravados no computador da sessão; a mensagem leva os caminhos). */
export const ATTACH_TIP = tr('Cole ou arraste imagens e arquivos para anexar.');

/** O que sai da caixa: o texto como foi digitado, sem os espaços e linhas em branco do fim. */
export function messageText(raw: string): string {
  return raw.replace(/\s+$/, '');
}

/** Dá para mandar: há texto (ou, sem texto, ao menos um anexo) e ele cabe no limite. */
export function canSend(raw: string, attachments = 0): boolean {
  const text = messageText(raw);
  return (text.trim().length > 0 || attachments > 0) && text.length <= MESSAGE_MAX;
}

/** Anexos por mensagem e o tamanho de cada um (os mesmos limites do servidor: spawn/attachments.ts). */
export const MESSAGE_FILES_MAX = 5;
export const MESSAGE_FILE_MAX_BYTES = 15 * 1024 * 1024;

/**
 * Quais dos arquivos colados ou arrastados entram como anexos, com `have` já na caixa: os vazios e os grandes demais
 * ficam de fora, e a lista para no limite por mensagem. `problem` diz o primeiro motivo de algum ter ficado de fora.
 */
export function acceptFiles<T extends { name: string; size: number }>(files: readonly T[], have: number): { accepted: T[]; problem?: string } {
  const accepted: T[] = [];
  let problem: string | undefined;
  for (const f of files) {
    if (!f.size) continue;
    if (f.size > MESSAGE_FILE_MAX_BYTES) problem ??= tr('{0} passa de {1} MB.', [f.name, MESSAGE_FILE_MAX_BYTES / 1024 / 1024]);
    else if (have + accepted.length >= MESSAGE_FILES_MAX) problem ??= tr('No máximo {0} anexos por mensagem.', [MESSAGE_FILES_MAX]);
    else accepted.push(f);
  }
  return problem ? { accepted, problem } : { accepted };
}

/** Rótulo de um anexo que não é imagem, no lugar da miniatura: a extensão (até 4 letras) ou "ARQ". */
export function fileBadge(name: string): string {
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? name.slice(dot + 1) : '').slice(0, 4).toUpperCase() || tr('ARQ');
}

/** Enter manda; Shift+Enter (e Alt+Enter) quebram a linha; Enter compondo um acento (IME) não conta. */
export function enterSends(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.isComposing;
}

// ---------------------------------------------------------------- menu de comandos de barra

/**
 * O que filtra o menu de comandos (undefined = fechado): a caixa começa com `/` e o cursor ainda está no nome do
 * comando (nenhum espaço antes dele). Só a barra = '' (todos os comandos).
 */
export function commandQuery(value: string, caret: number): string | undefined {
  return /^\/(\S*)$/.exec(value.slice(0, caret))?.[1];
}

/** Uma linha do menu da caixa: um comando de barra ou um arquivo do projeto. */
export interface CommandOption {
  /** O nome do comando (sem a barra) ou o caminho do arquivo: é o que vai para a caixa. */
  name: string;
  /** A descrição do comando; num arquivo, vazia. */
  description: string;
  /** Abre sempre um painel no terminal da sessão: o escritório não o manda (shared/messages.ts). */
  panel: boolean;
  /** Arquivo do projeto (citado com `@`), e não um comando. */
  file?: true;
}

export const DESCRIPTION_QUERY_MIN = 3;

const fold = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/**
 * Os comandos que casam com o que foi digitado, sem diferenciar maiúsculas nem acentos. Primeiro os que começam
 * assim (no nome ou na parte depois de `:`, como em `plugin:comando`), depois os que têm o trecho no nome e, por
 * fim, só na descrição (a partir de DESCRIPTION_QUERY_MIN letras: com menos, casa com quase tudo); em cada grupo, na
 * ordem em que a sessão os lista.
 */
export function commandOptions(list: readonly SessionCommand[], query: string): CommandOption[] {
  const q = fold(query);
  const groups: CommandOption[][] = [[], [], []];
  for (const c of list) {
    const name = fold(c.name);
    const rank = !q || name.startsWith(q) || name.slice(name.lastIndexOf(':') + 1).startsWith(q) ? 0 : name.includes(q) ? 1 : q.length >= DESCRIPTION_QUERY_MIN && fold(c.description).includes(q) ? 2 : -1;
    if (rank < 0) continue;
    groups[rank].push({ name: c.name, description: c.description, panel: panelCommandReason(`/${c.name} x`, c.source) !== undefined });
  }
  return groups.flat();
}

/** O comando escolhido no lugar do que foi digitado: `/nome ` (o que vinha depois do nome fica) e o cursor depois dele. */
export function applyCommand(value: string, name: string): { value: string; caret: number } {
  const head = `/${name} `;
  return { value: head + value.replace(/^\/\S*\s*/, ''), caret: head.length };
}

/**
 * O arquivo sendo citado (undefined = nenhum): o `@` no começo da caixa ou depois de um espaço, e o cursor ainda no
 * caminho. `start` é onde está o `@`. Só o `@` = '' (os arquivos mais rasos do projeto).
 */
export function mentionQuery(value: string, caret: number): { query: string; start: number } | undefined {
  const m = /(?:^|\s)@(\S*)$/.exec(value.slice(0, caret));
  return m ? { query: m[1], start: caret - m[1].length - 1 } : undefined;
}

/** Os arquivos encontrados como linhas do menu. */
export function fileOptions(paths: readonly string[]): CommandOption[] {
  return paths.map((name) => ({ name, description: '', panel: false, file: true }));
}

/** Um caminho como aparece no menu: o nome do arquivo e, à parte, a pasta dele ('' na raiz do projeto). */
export function splitPath(path: string): { name: string; dir: string } {
  const i = path.lastIndexOf('/');
  return { name: path.slice(i + 1), dir: i < 0 ? '' : path.slice(0, i) };
}

/**
 * O arquivo escolhido no lugar do que foi digitado depois do `@` (de `start` até o cursor): `@caminho `, entre aspas se
 * o caminho tem espaço, como no Claude Code. O espaço não se repete se já havia um depois do cursor.
 */
export function applyMention(value: string, start: number, caret: number, path: string): { value: string; caret: number } {
  const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`;
  const rest = value.slice(caret);
  const head = `${value.slice(0, start)}${mention}${/^\s/.test(rest) ? '' : ' '}`;
  return { value: head + rest, caret: head.length + (/^\s/.test(rest) ? 1 : 0) };
}

/** Quanto esperar a digitação parar antes de buscar os arquivos, e quantas buscas ficam guardadas. */
export const FILE_SEARCH_DELAY_MS = 90;
export const FILE_SEARCH_CACHE = 40;

export type MenuAction = 'next' | 'prev' | 'pick' | 'close';

/**
 * O que uma tecla faz com o menu aberto (undefined = segue o caminho normal da caixa). Setas andam, Tab completa,
 * Esc fecha. Enter completa o comando destacado; com o nome já digitado por inteiro, manda a mensagem.
 */
export function menuAction(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing'>, query: string, active: CommandOption | undefined): MenuAction | undefined {
  if (e.isComposing || e.ctrlKey || e.metaKey) return undefined;
  if (e.key === 'Escape') return 'close';
  if (!active) return undefined;
  if (e.key === 'ArrowDown') return 'next';
  if (e.key === 'ArrowUp') return 'prev';
  if (e.key === 'Tab' && !e.shiftKey && !e.altKey) return 'pick';
  if (enterSends(e) && active.name !== query) return 'pick';
  return undefined;
}

/** O índice destacado depois de andar `delta` numa lista de `count` itens (dá a volta nas pontas). */
export function moveActive(index: number, count: number, delta: number): number {
  return count > 0 ? (index + delta + count) % count : 0;
}

/** A lista de comandos de uma sessão vale este tempo na página; vazia (a sessão ainda não a mandou), bem menos. */
export const COMMANDS_FRESH_MS = 30_000;
export const COMMANDS_EMPTY_FRESH_MS = 4_000;

/**
 * Situação do último envio de um agente: `sending` (o POST ainda não voltou), `rejected` (o servidor recusou: o texto
 * fica na caixa) ou a situação da mensagem no servidor (OutboxStatus).
 */
export type SendPhase = 'sending' | 'rejected' | OutboxStatus;

export interface SendState {
  phase: SendPhase;
  /** Id da mensagem no servidor (depois do 201). */
  id?: string;
  error?: string;
  /** Última mudança (epoch ms, relógio da página). */
  at: number;
}

export function isSettled(phase: SendPhase): boolean {
  return phase === 'delivered' || phase === 'failed' || phase === 'rejected';
}

/** "Entregue" some sozinho depois deste tempo; erros ficam até o próximo envio. */
export const DELIVERED_SHOW_MS = 12_000;

/** Texto da linha de situação ('' = nada a mostrar). */
export function sendStatusText(s: SendState | undefined, now: number, provider: Provider = 'claude'): string {
  if (!s) return '';
  const codex = provider === 'codex';
  switch (s.phase) {
    case 'sending':
      return tr('Enviando…');
    case 'queued':
      return codex ? tr('Na fila: entregando ao Codex…') : tr('Na fila: esperando a sessão buscar a mensagem…');
    case 'sent':
      return tr('Entregando à sessão…');
    case 'delivered':
      // Entregue = entrou na sessão ou na fila dela (com o agente ocupado, só entra quando ele terminar o turno). No
      // Codex é sempre a fila: o dono da sessão a consulta a cada ~10 s e só a usa com a sessão ociosa.
      if (now - s.at >= DELIVERED_SHOW_MS) return '';
      return codex
        ? tr('Entregue ✓ na fila da sessão: entra quando o Codex terminar o que está fazendo (até ~10 s)')
        : tr('Entregue ✓ (se o agente estiver ocupado, entra quando ele terminar)');
    case 'rejected':
      return tr('Não foi possível mandar: {0}', [s.error ?? tr('erro desconhecido')]);
    case 'failed':
      return tr('Não foi entregue: {0}', [s.error ?? tr('erro desconhecido')]);
  }
}

/** Consulta da entrega: o servidor leva até ~90 s para desistir (60 s na fila + 30 s sem confirmação). */
export const POLL_LIMIT_MS = 120_000;

/** Espera até a próxima consulta: rápida no começo (a sessão busca a cada 2 s), mais espaçada depois. */
export function pollDelay(elapsed: number): number {
  if (elapsed < 10_000) return 700;
  if (elapsed < 40_000) return 1_500;
  return 3_000;
}

export const LOST_ERROR = tr('o Habblaud não conhece mais esta mensagem (ele reiniciou?)');
export const TIMEOUT_ERROR = tr('sem notícia da entrega: confira no terminal do Claude Code');
export const CODEX_TIMEOUT_ERROR = tr('sem notícia da entrega: confira no Codex');
export const OFFLINE_ERROR = tr('não foi possível falar com o Habblaud');

/** Prazo da consulta acabou sem notícia: onde conferir. */
export function timeoutError(provider: Provider = 'claude'): string {
  return provider === 'codex' ? CODEX_TIMEOUT_ERROR : TIMEOUT_ERROR;
}
