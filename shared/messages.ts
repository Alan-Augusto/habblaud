// Mensagens pelo escritório (POST /api/messages): o que o servidor, o demo e a página têm em comum.
// Código puro: sem APIs de Node nem de DOM.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';

/** Tamanho máximo de uma mensagem (caracteres). */
export const MESSAGE_MAX = 20_000;
/** `Activity.tool` da atividade "Mensagem pelo Habblaud" (não é uma ferramenta do agente: é o seu texto entrando). */
export const MESSAGE_TOOL = 'HabblaudMessage';
/** Detalhe da atividade: o começo do texto, mascarado e cortado (o texto inteiro vai só para a sessão). */
const DETAIL_MAX = 300;

/**
 * Atividade "Mensagem pelo Habblaud" de uma mensagem entregue à sessão (entrou nela ou na fila dela: não quer dizer
 * que o agente já leu).
 */
export function describeMessage(text: string): ActivityDescription & { tool: string } {
  const detail = truncate(maskSecrets(text.slice(0, DETAIL_MAX * 4)), DETAIL_MAX);
  return { kind: 'communicate', icon: '✉️', text: tr('Mensagem pelo Habblaud'), tool: MESSAGE_TOOL, ...(detail ? { detail } : {}) };
}

/** Um comando de barra: o nome sem a barra e o que veio depois dele. */
export interface SlashCommand {
  command: string;
  args: string;
}

/**
 * Mensagem que é um comando de barra (`/compact`, `/model opus`), lida como o plugin habblaud-mensagens a lê
 * (mod/habblaud-mensagens/hooks/register.ts, parseCommand): a barra é o primeiro caractere, o nome vai até o primeiro
 * espaço e o resto são os argumentos.
 */
export function slashCommandOf(text: string): SlashCommand | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
  if (!m) return undefined;
  return { command: m[1] ?? '', args: (m[2] ?? '').trim() };
}

// Comandos do Claude Code que respondem com um painel desenhado no terminal da sessão (um menu, um seletor, um
// diálogo). O plugin só recebe a saída em texto de um comando: mandado pelo escritório, o painel ficaria aberto num
// terminal que ninguém está olhando, até alguém fechá-lo lá. A lista é do que o Claude Code traz de fábrica; um
// comando de painel que ela não conhece passa (e abre no terminal).
/** Sempre abrem um painel. */
const PANEL_ALWAYS = new Set([
  'agents',
  'config',
  'settings',
  'doctor',
  'feedback',
  'bug',
  'help',
  'hooks',
  'ide',
  'login',
  'logout',
  'memory',
  'permissions',
  'allowed-tools',
  'privacy-settings',
  'rewind',
  'checkpoint',
  'skills',
  'status',
  'tasks',
  'theme',
  'usage',
]);
/** Abrem um painel só sem argumentos (`/model` abre o seletor; `/model opus` troca direto). */
const PANEL_WITHOUT_ARGS = new Set(['add-dir', 'export', 'mcp', 'model', 'output-style', 'plugin', 'resume', 'continue']);

/**
 * Por que este comando de barra não vai pelo escritório (undefined = vai): ele abriria um painel no terminal da
 * sessão. Texto comum e comandos que respondem com texto (ou que a lista não conhece) passam.
 */
export function panelCommandReason(text: string): string | undefined {
  const slash = slashCommandOf(text);
  if (!slash) return undefined;
  const name = slash.command.toLowerCase();
  if (PANEL_ALWAYS.has(name)) return tr('/{0} abre um painel no terminal da sessão, que o escritório não mostra: rode esse comando no Claude Code', [name]);
  if (PANEL_WITHOUT_ARGS.has(name) && !slash.args) {
    return tr('/{0} sem argumento abre um painel no terminal da sessão, que o escritório não mostra: mande com o argumento (ex.: /model opus) ou rode no Claude Code', [name]);
  }
  return undefined;
}
