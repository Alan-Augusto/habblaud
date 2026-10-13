import { describe, expect, it } from 'vitest';
import { panelCommandReason, rankFiles, slashCommandOf } from './messages';

describe('comandos de barra', () => {
  it('lê o comando como o plugin habblaud-mensagens: barra no começo, nome até o primeiro espaço, resto como argumentos', () => {
    expect(slashCommandOf('/compact')).toEqual({ command: 'compact', args: '' });
    expect(slashCommandOf('/model  opus 4 \n')).toEqual({ command: 'model', args: 'opus 4' });
    expect(slashCommandOf('/habblaud:status')).toEqual({ command: 'habblaud:status', args: '' });
    expect(slashCommandOf('roda o /compact depois')).toBeUndefined();
    expect(slashCommandOf(' /compact')).toBeUndefined();
    expect(slashCommandOf('/ compact')).toBeUndefined();
    expect(slashCommandOf('/')).toBeUndefined();
  });

  it('comando de painel tem motivo; texto comum, comando de texto e comando com argumento não', () => {
    expect(panelCommandReason('/usage')).toMatch(/\/usage abre um painel/);
    expect(panelCommandReason('/CONFIG')).toMatch(/\/config abre um painel/);
    expect(panelCommandReason('/help qualquer coisa')).toMatch(/\/help abre um painel/);
    expect(panelCommandReason('/model')).toMatch(/\/model sem argumento/);
    expect(panelCommandReason('/model opus')).toBeUndefined();
    expect(panelCommandReason('/compact')).toBeUndefined();
    expect(panelCommandReason('/meu-comando')).toBeUndefined();
    expect(panelCommandReason('abre o /usage')).toBeUndefined();
  });
});

describe('panelCommandReason: origem do comando', () => {
  it('só os nativos do Claude Code são barrados: um comando de plugin, do usuário ou de MCP com o mesmo nome passa', () => {
    expect(panelCommandReason('/status', 'builtin')).toBeDefined();
    expect(panelCommandReason('/status')).toBeDefined();
    for (const source of ['plugin', 'user', 'mcp'] as const) {
      expect(panelCommandReason('/status', source)).toBeUndefined();
      expect(panelCommandReason('/model', source)).toBeUndefined();
    }
  });

  it('painéis da lista revisada: assistentes de configuração e de conta; os de texto passam', () => {
    for (const cmd of ['/usage-credits', '/remote-control', '/mobile', '/install-github-app', '/upgrade', '/sandbox']) expect(panelCommandReason(cmd)).toBeDefined();
    expect(panelCommandReason('/effort')).toBeDefined();
    expect(panelCommandReason('/effort high')).toBeUndefined();
    // /doctor e /agents deixaram de ser painéis; /compact, /context e /recap respondem com texto.
    for (const cmd of ['/doctor', '/agents', '/compact', '/context', '/recap', '/init']) expect(panelCommandReason(cmd)).toBeUndefined();
  });
});

describe('rankFiles (o @ da caixa de mensagem)', () => {
  const FILES = ['README.md', 'client/src/ui/composer.ts', 'client/src/ui/composer-model.ts', 'server/messages/http.ts', 'docs/compras.md', 'server/composição/índice.ts', 'package.json'];

  it('nome que começa assim, depois nome que tem o trecho, depois o caminho, depois as letras em ordem', () => {
    expect(rankFiles(FILES, 'comp')).toEqual(['docs/compras.md', 'client/src/ui/composer.ts', 'client/src/ui/composer-model.ts', 'server/composição/índice.ts']);
    expect(rankFiles(FILES, 'model')).toEqual(['client/src/ui/composer-model.ts']);
    expect(rankFiles(FILES, 'messages/')).toEqual(['server/messages/http.ts']);
    expect(rankFiles(FILES, 'smh')).toEqual(['server/messages/http.ts']);
    expect(rankFiles(FILES, 'zzz')).toEqual([]);
  });

  it('sem diferenciar maiúsculas nem acentos; sem nada digitado, os mais rasos; respeita o limite', () => {
    expect(rankFiles(FILES, 'INDICE')).toEqual(['server/composição/índice.ts']);
    expect(rankFiles(FILES, 'readme')).toEqual(['README.md']);
    expect(rankFiles(FILES, '').slice(0, 2)).toEqual(['README.md', 'package.json']);
    expect(rankFiles(FILES, '', 3)).toHaveLength(3);
  });
});
