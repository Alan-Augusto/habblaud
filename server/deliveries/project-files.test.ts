// Lista de arquivos de um projeto (o `@` da caixa de mensagem): git ou caminhada, sem segredos e com limites.
// Sem disco: o git e a pasta são injetados.
import { describe, expect, it } from 'vitest';
import { listProjectFiles, looksSecret, WALK_MAX_DEPTH } from './project-files';

type Tree = { [name: string]: Tree | null };

/** readdir sobre uma árvore em memória (null = arquivo). */
function fakeDir(tree: Tree) {
  return (dir: string) => {
    let node: Tree = tree;
    for (const part of dir.replace(/^\/p\/?/, '').split('/').filter(Boolean)) {
      const next = node[part];
      if (!next) throw new Error('ENOENT');
      node = next;
    }
    return Object.entries(node).map(([name, v]) => ({ name, isDirectory: () => v !== null, isFile: () => v === null }));
  };
}

const dir = { isDirectory: () => true };

describe('listProjectFiles', () => {
  it('num repositório git, a lista é a do git, sem o que tem cara de segredo', () => {
    const r = listProjectFiles('/p', { ...dir, git: () => ['src/app.ts', '.env', '.env.local', 'README.md', 'certs/server.pem', 'src/tokens.css', 'deploy/id_rsa'] });
    expect(r).toEqual({ files: ['src/app.ts', 'README.md', 'src/tokens.css'], truncated: false });
  });

  it('fora do git, caminha pela pasta: os mais rasos primeiro, sem pastas ocultas nem as de dependências', () => {
    const tree: Tree = {
      'b.txt': null,
      'a.txt': null,
      '.git': { config: null },
      node_modules: { lib: { 'index.js': null } },
      src: { 'main.ts': null, util: { 'x.ts': null } },
      '.gitignore': null,
    };
    const r = listProjectFiles('/p', { ...dir, git: () => undefined, readdir: fakeDir(tree), home: '/outra' });
    expect(r).toEqual({ files: ['.gitignore', 'a.txt', 'b.txt', 'src/main.ts', 'src/util/x.ts'], truncated: false });
  });

  it('sessão aberta na pasta pessoal: não entra nas pastas que o sistema protege (num projeto, um nome igual é só uma pasta)', () => {
    const tree: Tree = { 'notas.txt': null, '.zsh_history': null, Documents: { 'extrato.pdf': null }, Downloads: { 'x.zip': null }, dev: { Documents: { 'spec.md': null } } };
    const readdir = fakeDir(tree);
    expect(listProjectFiles('/p', { ...dir, git: () => undefined, readdir, home: '/p' })).toEqual({ files: ['notas.txt', 'dev/Documents/spec.md'], truncated: false });
    expect(listProjectFiles('/p', { ...dir, git: () => undefined, readdir, home: '/outra' })).toEqual({
      files: ['.zsh_history', 'notas.txt', 'Documents/extrato.pdf', 'Downloads/x.zip', 'dev/Documents/spec.md'],
      truncated: false,
    });
  });

  it('a caminhada para na profundidade máxima', () => {
    let tree: Tree = { 'fundo.txt': null };
    for (let i = 0; i < WALK_MAX_DEPTH + 1; i++) tree = { d: tree, [`n${i}.txt`]: null };
    const r = listProjectFiles('/p', { ...dir, git: () => undefined, readdir: fakeDir(tree) });
    if ('error' in r) throw new Error(r.error);
    expect(r.files).toHaveLength(WALK_MAX_DEPTH + 1);
    expect(r.files.some((f) => f.endsWith('fundo.txt'))).toBe(false);
  });

  it('lista grande demais vem cortada, com truncated', () => {
    const r = listProjectFiles('/p', { ...dir, max: 3, git: () => ['a', 'b', 'c', 'd', 'e'] });
    expect(r).toEqual({ files: ['a', 'b', 'c'], truncated: true });
  });

  it('caminho inválido ou pasta que não existe: o motivo, sem listar', () => {
    const git = () => {
      throw new Error('não deveria listar');
    };
    for (const root of ['', 'relativo/x', '/p/../etc', '/p\0x']) expect(listProjectFiles(root, { ...dir, git })).toHaveProperty('error');
    expect(listProjectFiles('/p', { isDirectory: () => false, git })).toHaveProperty('error');
    expect(
      listProjectFiles('/p', {
        isDirectory: () => {
          throw new Error('ENOENT');
        },
        git,
      }),
    ).toHaveProperty('error');
  });

  it('looksSecret: arquivos de ambiente, chaves e pastas de credenciais; código com "token" no nome não', () => {
    for (const p of ['.env', 'api/.env.production', '.ssh/config', 'x/.aws/credentials', 'id_ed25519.pub', 'tls/site.key', '.npmrc']) expect(looksSecret(p)).toBe(true);
    for (const p of ['src/tokenizer.ts', 'docs/senha.md', 'env.ts', 'keys.ts', 'src/environment.ts']) expect(looksSecret(p)).toBe(false);
  });
});
