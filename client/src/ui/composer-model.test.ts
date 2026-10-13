import { describe, expect, it } from 'vitest';
import type { AgentInfo, SessionCommand } from '../../../shared/types';
import {
  acceptFiles,
  applyCommand,
  applyMention,
  canSend,
  commandOptions,
  commandQuery,
  menuAction,
  MESSAGE_FILE_MAX_BYTES,
  MESSAGE_FILES_MAX,
  moveActive,
  CODEX_BRIDGE_HINT,
  CODEX_TIMEOUT_ERROR,
  composerMode,
  composerTip,
  DELIVERED_SHOW_MS,
  enterSends,
  fileBadge,
  fileOptions,
  isSettled,
  mentionQuery,
  splitPath,
  messageText,
  PLUGIN_HINT,
  pollDelay,
  sendStatusText,
  timeoutError,
  TIMEOUT_ERROR,
  type ComposerEnv,
} from './composer-model';

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'acc:1',
    kind: 'main',
    roomId: 'r',
    name: 'Marina',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's-1',
    account: 'acc',
    status: 'idle',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    canMessage: true,
    ...over,
  };
}

const ON: ComposerEnv = { enabled: true, local: true, replaying: false };

describe('caixa de mensagem (peças puras)', () => {
  it('composerMode: pronta só para principal presente com o plugin, recurso ligado e página local', () => {
    expect(composerMode(agent(), ON)).toEqual({ kind: 'ready' });
    for (const status of ['working', 'waiting', 'shell'] as const) expect(composerMode(agent({ status }), ON).kind).toBe('ready');
    // Recurso ligado, mas a sessão sem o plugin: a dica de instalação.
    expect(composerMode(agent({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: PLUGIN_HINT });
    expect(PLUGIN_HINT).toBe('Para mandar mensagens daqui: npm run mod:install (plugin habblaud-mensagens)');
  });

  it('composerMode: quando não dá, diz por quê (a gaveta esconde, o terminal mostra o motivo)', () => {
    const off = (a: AgentInfo | undefined, env: Partial<ComposerEnv> = {}) => {
      const m = composerMode(a, { ...ON, ...env });
      expect(m.kind).toBe('off');
      return m.kind === 'off' ? m.text : '';
    };
    expect(off(agent({ kind: 'sub', parentId: 'acc:1' }))).toMatch(/^Subagentes não recebem/);
    expect(off(agent({ kind: 'sub', status: 'done' }))).toMatch(/^Subagentes/);
    expect(off(agent({ status: 'offline' }))).toBe('Sessão encerrada');
    expect(off(undefined)).toBe('Sessão encerrada');
    expect(off(agent(), { enabled: false })).toMatch(/terminal do Claude Code/);
    expect(off(agent({ canMessage: undefined }), { enabled: false })).toMatch(/terminal do Claude Code/);
    expect(off(agent(), { local: false })).toMatch(/localhost/);
    expect(off(agent(), { replaying: true })).toMatch(/timelapse/);
  });

  it('texto: sai sem os espaços do fim; vazio ou longo demais não manda', () => {
    expect(messageText('  oi\n  tudo bem?  \n\n')).toBe('  oi\n  tudo bem?');
    expect(canSend('oi')).toBe(true);
    expect(canSend(' \n\t ')).toBe(false);
    expect(canSend('x'.repeat(20_000))).toBe(true);
    expect(canSend('x'.repeat(20_001))).toBe(false);
    // Espaços no fim não contam para o limite (são cortados antes).
    expect(canSend(`${'x'.repeat(20_000)}\n\n`)).toBe(true);
  });

  it('Enter manda; Shift+Enter e Alt+Enter quebram a linha; Enter compondo acento (IME) não manda', () => {
    const k = (over: Partial<Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>> = {}) =>
      enterSends({ key: 'Enter', shiftKey: false, altKey: false, isComposing: false, ...over });
    expect(k()).toBe(true);
    expect(k({ shiftKey: true })).toBe(false);
    expect(k({ altKey: true })).toBe(false);
    expect(k({ isComposing: true })).toBe(false);
    expect(k({ key: 'a' })).toBe(false);
  });

  it('linha de situação: enviando, na fila, entregando, entregue (some depois de um tempo) e os erros', () => {
    expect(sendStatusText(undefined, 0)).toBe('');
    expect(sendStatusText({ phase: 'sending', at: 0 }, 0)).toBe('Enviando…');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0)).toMatch(/^Na fila/);
    expect(sendStatusText({ phase: 'sent', at: 0 }, 0)).toMatch(/^Entregando/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000)).toMatch(/^Entregue ✓ \(se o agente estiver ocupado, entra quando ele terminar\)$/);
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS)).toBe('');
    expect(sendStatusText({ phase: 'rejected', error: 'já há 5 mensagens', at: 0 }, 0)).toBe('Não foi possível mandar: já há 5 mensagens');
    expect(sendStatusText({ phase: 'failed', error: 'a sessão não confirmou a entrega', at: 0 }, 99_999)).toBe('Não foi entregue: a sessão não confirmou a entrega');
    expect(['delivered', 'failed', 'rejected'].every((p) => isSettled(p as never))).toBe(true);
    expect(['sending', 'queued', 'sent'].some((p) => isSettled(p as never))).toBe(false);
  });

  it('Codex: com entregador, igual ao Claude Code; sem ele, a dica do codex:bridge; recurso desligado manda ao Codex', () => {
    const codex = (over: Partial<AgentInfo> = {}) => agent({ provider: 'codex', ...over });
    expect(composerMode(codex(), ON)).toEqual({ kind: 'ready' });
    expect(composerMode(codex({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: CODEX_BRIDGE_HINT });
    expect(CODEX_BRIDGE_HINT).toBe('Para mandar mensagens ao Codex: com o Habblaud no Docker, deixe npm run codex:bridge rodando; no modo Node funciona sozinho');
    expect(composerMode(codex(), { ...ON, enabled: false })).toEqual({ kind: 'off', text: 'Para responder, use o Codex' });
    expect(composerMode(codex({ kind: 'sub', parentId: 'acc:1' }), ON).kind).toBe('off');
    expect(composerMode(codex({ status: 'offline' }), ON)).toEqual({ kind: 'off', text: 'Sessão encerrada' });
  });

  it('Codex: "Entregue" é a fila da sessão; dica e prazo falam do Codex', () => {
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'codex')).toBe('Entregue ✓ na fila da sessão: entra quando o Codex terminar o que está fazendo (até ~10 s)');
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS, 'codex')).toBe('');
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0, 'codex')).toBe('Na fila: entregando ao Codex…');
    // O Claude Code continua como antes.
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'claude')).toBe(sendStatusText({ phase: 'delivered', at: 0 }, 1_000));
    expect(composerTip('codex')).toMatch(/^Entra na fila da sessão e vira o próximo prompt quando o Codex terminar/);
    expect(composerTip()).toBe('Entra na sessão como se você tivesse digitado. Enter manda; Shift+Enter quebra a linha.');
    expect(timeoutError('codex')).toBe(CODEX_TIMEOUT_ERROR);
    expect(timeoutError()).toBe(TIMEOUT_ERROR);
  });

  it('consulta da entrega: rápida no começo, mais espaçada depois', () => {
    expect(pollDelay(0)).toBeLessThan(1_000);
    expect(pollDelay(20_000)).toBeGreaterThan(pollDelay(0));
    expect(pollDelay(60_000)).toBeGreaterThanOrEqual(pollDelay(20_000));
  });
});

describe('menu de comandos de barra', () => {
  const LIST: SessionCommand[] = [
    { name: 'compact', description: 'Compacta a conversa', source: 'builtin' },
    { name: 'config', description: 'Abre as configurações', source: 'builtin' },
    { name: 'model', description: 'Troca o modelo', source: 'builtin' },
    { name: 'habblaud:revisão', description: 'Revisa o que mudou', source: 'plugin' },
    { name: 'recompilar', description: 'Compila tudo de novo', source: 'user' },
  ];
  const names = (q: string) => commandOptions(LIST, q).map((c) => c.name);
  const key = (k: string, over: Partial<KeyboardEvent> = {}) => ({ key: k, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, ...over });

  it('abre com a barra no começo e o cursor ainda no nome do comando', () => {
    expect(commandQuery('/', 1)).toBe('');
    expect(commandQuery('/com', 4)).toBe('com');
    expect(commandQuery('/compact agora', 4)).toBe('com');
    expect(commandQuery('/compact agora', 9)).toBeUndefined();
    expect(commandQuery('/model opus', 11)).toBeUndefined();
    expect(commandQuery('roda /compact', 13)).toBeUndefined();
    expect(commandQuery(' /compact', 9)).toBeUndefined();
    expect(commandQuery('', 0)).toBeUndefined();
  });

  it('filtra sem diferenciar maiúsculas nem acentos: começo do nome, depois meio do nome, depois a descrição', () => {
    expect(names('')).toEqual(LIST.map((c) => c.name));
    expect(names('COM')).toEqual(['compact', 'recompilar']);
    expect(names('co')).toEqual(['compact', 'config', 'recompilar']);
    // A parte depois de `:` conta como começo; a descrição vem por último.
    expect(names('revisao')).toEqual(['habblaud:revisão']);
    expect(names('mod')).toEqual(['model']);
    expect(names('troca')).toEqual(['model']);
    // Duas letras não buscam na descrição ("re" está em "Revisa", mas só o nome conta).
    expect(names('re')).toEqual(['habblaud:revisão', 'recompilar']);
    expect(names('rev')).toEqual(['habblaud:revisão']);
    expect(names('zzz')).toEqual([]);
  });

  it('marca o comando que sempre abre um painel (o que só abre sem argumento, não)', () => {
    const by = Object.fromEntries(commandOptions(LIST, '').map((c) => [c.name, c.panel]));
    expect(by).toMatchObject({ config: true, model: false, compact: false });
  });

  it('escolher troca o que foi digitado pelo nome, com um espaço, e mantém o que vinha depois', () => {
    expect(applyCommand('/com', 'compact')).toEqual({ value: '/compact ', caret: 9 });
    expect(applyCommand('/mo opus', 'model')).toEqual({ value: '/model opus', caret: 7 });
    expect(applyCommand('/', 'habblaud:revisão')).toEqual({ value: '/habblaud:revisão ', caret: 18 });
  });

  it('teclas: setas andam, Tab e Enter completam, Esc fecha; com o nome inteiro digitado, Enter manda', () => {
    const active = commandOptions(LIST, 'com')[0];
    expect(menuAction(key('ArrowDown'), 'com', active)).toBe('next');
    expect(menuAction(key('ArrowUp'), 'com', active)).toBe('prev');
    expect(menuAction(key('Tab'), 'com', active)).toBe('pick');
    expect(menuAction(key('Tab', { shiftKey: true }), 'com', active)).toBeUndefined();
    expect(menuAction(key('Enter'), 'com', active)).toBe('pick');
    expect(menuAction(key('Enter'), 'compact', active)).toBeUndefined();
    expect(menuAction(key('Enter', { shiftKey: true }), 'com', active)).toBeUndefined();
    expect(menuAction(key('Enter', { isComposing: true }), 'com', active)).toBeUndefined();
    expect(menuAction(key('Escape'), 'com', active)).toBe('close');
    expect(menuAction(key('a'), 'com', active)).toBeUndefined();
    // Sem nenhum comando na lista, só o Esc tem o que fazer.
    expect(menuAction(key('Enter'), 'zzz', undefined)).toBeUndefined();
    expect(menuAction(key('ArrowDown'), 'zzz', undefined)).toBeUndefined();
  });

  it('o destaque dá a volta nas pontas', () => {
    expect(moveActive(0, 3, 1)).toBe(1);
    expect(moveActive(2, 3, 1)).toBe(0);
    expect(moveActive(0, 3, -1)).toBe(2);
    expect(moveActive(0, 0, 1)).toBe(0);
  });
});

describe('arquivos citados com @', () => {
  it('abre com o @ no começo ou depois de um espaço, enquanto o cursor está no caminho', () => {
    expect(mentionQuery('@', 1)).toEqual({ query: '', start: 0 });
    expect(mentionQuery('@src/ap', 7)).toEqual({ query: 'src/ap', start: 0 });
    expect(mentionQuery('olha o @comp', 12)).toEqual({ query: 'comp', start: 7 });
    expect(mentionQuery('linha um\n@read', 14)).toEqual({ query: 'read', start: 9 });
    // No meio de uma palavra (um e-mail) não é citação; depois do espaço, o cursor já saiu do caminho.
    expect(mentionQuery('fulano@exemplo.com', 18)).toBeUndefined();
    expect(mentionQuery('@src/app.ts e', 13)).toBeUndefined();
    expect(mentionQuery('sem arroba', 10)).toBeUndefined();
    // O cursor no meio do caminho: vale o que está antes dele.
    expect(mentionQuery('@src/app.ts', 4)).toEqual({ query: 'src', start: 0 });
  });

  it('escolher troca o que foi digitado por @caminho, com um espaço (sem repetir o que já havia)', () => {
    expect(applyMention('olha o @comp', 7, 12, 'src/ui/composer.ts')).toEqual({ value: 'olha o @src/ui/composer.ts ', caret: 27 });
    expect(applyMention('@rea e depois', 0, 4, 'README.md')).toEqual({ value: '@README.md e depois', caret: 11 });
    expect(applyMention('veja @', 5, 6, 'docs/meu plano.md')).toEqual({ value: 'veja @"docs/meu plano.md" ', caret: 26 });
    // Só o que está antes do cursor é trocado: o resto do caminho antigo fica para a pessoa apagar.
    expect(applyMention('@src/app.ts', 0, 4, 'src/index.ts')).toEqual({ value: '@src/index.ts /app.ts', caret: 14 });
  });

  it('linhas do menu: o caminho inteiro vai para a caixa; na tela, o nome e a pasta', () => {
    expect(fileOptions(['README.md', 'src/ui/composer.ts'])).toEqual([
      { name: 'README.md', description: '', panel: false, file: true },
      { name: 'src/ui/composer.ts', description: '', panel: false, file: true },
    ]);
    expect(splitPath('src/ui/composer.ts')).toEqual({ name: 'composer.ts', dir: 'src/ui' });
    expect(splitPath('README.md')).toEqual({ name: 'README.md', dir: '' });
  });

  it('Enter escolhe o arquivo destacado; com o caminho inteiro já digitado, manda', () => {
    const key = { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false };
    const [active] = fileOptions(['README.md']);
    expect(menuAction(key, 'read', active)).toBe('pick');
    expect(menuAction(key, 'README.md', active)).toBeUndefined();
  });
});

describe('anexos colados ou arrastados', () => {
  const f = (name: string, size = 10) => ({ name, size });

  it('com anexo, dá para mandar sem texto; texto longo demais continua não indo', () => {
    expect(canSend('', 0)).toBe(false);
    expect(canSend('  \n', 1)).toBe(true);
    expect(canSend('oi', 2)).toBe(true);
    expect(canSend('x'.repeat(20_001), 1)).toBe(false);
  });

  it('entram os que cabem: vazio fica de fora em silêncio; grande demais e além do limite, com o motivo', () => {
    expect(acceptFiles([f('a.png'), f('vazio.txt', 0)], 0)).toEqual({ accepted: [f('a.png')] });
    const big = acceptFiles([f('video.mov', MESSAGE_FILE_MAX_BYTES + 1), f('b.png')], 0);
    expect(big.accepted).toEqual([f('b.png')]);
    expect(big.problem).toMatch(/video\.mov passa de 15 MB/);
    const many = acceptFiles(Array.from({ length: 4 }, (_, i) => f(`n${i}.png`)), MESSAGE_FILES_MAX - 2);
    expect(many.accepted.map((x) => x.name)).toEqual(['n0.png', 'n1.png']);
    expect(many.problem).toMatch(/No máximo 5 anexos/);
    expect(acceptFiles([f('x.png')], MESSAGE_FILES_MAX)).toMatchObject({ accepted: [] });
  });

  it('sem miniatura, o rótulo é a extensão', () => {
    expect(fileBadge('relatório.pdf')).toBe('PDF');
    expect(fileBadge('pacote.tar.gzip2')).toBe('GZIP');
    expect(fileBadge('Makefile')).toBe('ARQ');
    expect(fileBadge('.gitignore')).toBe('ARQ');
  });
});
