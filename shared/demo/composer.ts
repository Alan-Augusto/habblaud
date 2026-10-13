// Dados fictícios da caixa de mensagem para o modo demonstração (?mock=1 e o demo): os comandos de barra de uma
// sessão e os arquivos de um projeto. Assim o menu de comandos e o `@` aparecem nas capturas sem sessão nem projeto
// de verdade. As descrições dos comandos vêm em inglês, como o Claude Code as manda.
import type { SessionCommand } from '../types';

export const DEMO_COMMANDS: readonly SessionCommand[] = [
  { name: 'clear', description: 'Start a new session with empty context', source: 'builtin' },
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', source: 'builtin' },
  { name: 'config', description: 'Open settings', source: 'builtin' },
  { name: 'context', description: 'Visualize current context usage as a colored grid', source: 'builtin' },
  { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation', source: 'builtin' },
  { name: 'model', description: 'Set the AI model for Claude Code', source: 'builtin' },
  { name: 'recap', description: 'Generate a one-line session recap now', source: 'builtin' },
  { name: 'rename', description: 'Rename the current conversation', source: 'builtin' },
  { name: 'security-review', description: 'Complete a security review of the pending changes on the current branch', source: 'builtin' },
  { name: 'usage', description: 'Show session cost, plan usage, and activity stats', source: 'builtin' },
  { name: 'habblaud', description: 'Resumo do escritório do Habblaud', source: 'plugin' },
  { name: 'revisar-pr', description: 'Revisa o pull request aberto no branch atual', source: 'user' },
];
