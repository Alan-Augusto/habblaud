// Mensagens pelo escritório (POST /api/messages): o que o servidor, o demo e a página têm em comum.
// Código puro: sem APIs de Node nem de DOM.
import { maskSecrets, truncate, type ActivityDescription } from './activity';
import { tr } from './i18n';
import type { SessionCommand } from './types';

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
/**
 * Sempre abrem um painel (um menu, um seletor, um assistente de configuração ou de login). Revisada com a lista de
 * comandos nativos do Claude Code 2.1.296, pelo que cada descrição diz: a API diz o nome, a descrição e a origem de
 * cada comando, mas não se ele desenha um painel. Os nomes antigos (settings, allowed-tools, checkpoint) ficam.
 */
const PANEL_ALWAYS = new Set([
  'artifacts',
  'bug',
  'checkpoint',
  'chrome',
  'config',
  'settings',
  'extra-usage',
  'feedback',
  'help',
  'hooks',
  'ide',
  'install-github-app',
  'install-slack-app',
  'login',
  'logout',
  'memory',
  'mobile',
  'passes',
  'permissions',
  'allowed-tools',
  'powerup',
  'privacy-settings',
  'pro-trial-expired',
  'rate-limit-options',
  'remote-control',
  'remote-env',
  'rewind',
  'sandbox',
  'setup-bedrock',
  'setup-vertex',
  'skills',
  'status',
  'tasks',
  'theme',
  'upgrade',
  'usage',
  'usage-credits',
  'web-setup',
]);
/** Abrem um painel só sem argumentos (`/model` abre o seletor; `/model opus` troca direto). */
const PANEL_WITHOUT_ARGS = new Set(['add-dir', 'effort', 'export', 'mcp', 'model', 'output-style', 'plugin', 'resume', 'continue']);

/**
 * Por que este comando de barra não vai pelo escritório (undefined = vai): ele abriria um painel no terminal da
 * sessão. Texto comum e comandos que respondem com texto (ou que a lista não conhece) passam. `source` é a origem do
 * comando na sessão, quando se sabe (a lista que o plugin manda): só os nativos do Claude Code abrem esses painéis, e
 * um comando de plugin, do usuário ou de um servidor MCP com o mesmo nome passa.
 */
export function panelCommandReason(text: string, source?: SessionCommand['source']): string | undefined {
  const slash = slashCommandOf(text);
  if (!slash || (source !== undefined && source !== 'builtin')) return undefined;
  const name = slash.command.toLowerCase();
  if (PANEL_ALWAYS.has(name)) return tr('/{0} abre um painel no terminal da sessão, que o escritório não mostra: rode esse comando no Claude Code', [name]);
  if (PANEL_WITHOUT_ARGS.has(name) && !slash.args) {
    return tr('/{0} sem argumento abre um painel no terminal da sessão, que o escritório não mostra: mande com o argumento (ex.: /model opus) ou rode no Claude Code', [name]);
  }
  return undefined;
}
