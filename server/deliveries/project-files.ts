// Arquivos de um projeto, para o `@` da caixa de mensagem: os caminhos (relativos à pasta do projeto) que a pessoa
// pode citar numa mensagem. Só nomes: nada é lido. Num repositório git, a lista é a do próprio git (rastreados e novos,
// sem o que o .gitignore tira); fora de um, uma caminhada curta pela pasta, sem pastas ocultas nem as de dependências
// (e, com a sessão aberta na pasta pessoal, sem as pastas que o sistema protege nem os arquivos ocultos dela).
// Nada com cara de segredo entra na lista. Quem lista é o servidor (modo Node) ou o auxiliar do host
// (scripts/codex-bridge.ts), que só lista pastas de projeto que alguma conta conhece.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';

/** Quantos caminhos uma lista leva (o que passar fica de fora, com `truncated`). */
export const PROJECT_FILES_MAX = 20_000;
/** Caminhada fora de um repositório git: profundidade e quantas pastas olhar. */
export const WALK_MAX_DEPTH = 4;
export const WALK_MAX_DIRS = 1_500;

export interface ProjectFiles {
  /** Caminhos relativos à pasta do projeto, com `/`. */
  files: string[];
  /** Havia mais do que cabe na lista. */
  truncated: boolean;
}

/** Pastas e nomes que não se oferecem para citar: chaves, credenciais, arquivos de ambiente. */
const SECRET_DIRS = /(^|\/)(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.password-store|Keychains)(\/|$)/i;
const SECRET_NAMES = /(^|\/)(\.env[^/]*|\.netrc|\.npmrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|key|p12|pfx|keystore|jks|kdbx))$/i;
/** Fora do git, pastas que só fazem volume. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'target', 'vendor', 'venv', '__pycache__', 'Library', 'Applications']);
/**
 * Com a sessão aberta na pasta pessoal, as pastas dela que o macOS protege (ele pergunta antes de deixar um programa
 * abri-las, e a leitura fica parada até a resposta) e as de mídia: não se entra nelas.
 */
const HOME_SKIP_DIRS = new Set(['Desktop', 'Documents', 'Downloads', 'Movies', 'Music', 'Pictures', 'Public']);

export function looksSecret(relPath: string): boolean {
  return SECRET_DIRS.test(relPath) || SECRET_NAMES.test(relPath);
}

/** A lista do git (rastreados e novos, sem os ignorados), ou undefined se a pasta não é de um repositório (ou não há git). */
function gitFiles(root: string): string[] | undefined {
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      timeout: 5_000,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return undefined;
  }
}

interface DirEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Caminhada em largura (os arquivos mais rasos primeiro), sem pastas ocultas nem as de SKIP_DIRS, com limites. */
function walkFiles(root: string, readdir: (dir: string) => DirEntry[], max: number, home: string): string[] {
  const out: string[] = [];
  let level = [''];
  let dirs = 0;
  for (let depth = 0; depth <= WALK_MAX_DEPTH && level.length; depth++) {
    const next: string[] = [];
    for (const rel of level) {
      if (out.length > max || ++dirs > WALK_MAX_DIRS) return out;
      let entries: DirEntry[];
      try {
        entries = readdir(rel ? join(root, rel) : root);
      } catch {
        continue;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const e of entries) {
        const path = rel ? `${rel}/${e.name}` : e.name;
        // Na pasta pessoal, os arquivos ocultos são configuração do computador, não do projeto.
        if (e.isFile() && !(root === home && e.name.startsWith('.'))) out.push(path);
        else if (e.isDirectory() && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name) && !(depth === 0 && root === home && HOME_SKIP_DIRS.has(e.name))) next.push(path);
      }
    }
    level = next;
  }
  return out;
}

export interface ListOptions {
  git?: (root: string) => string[] | undefined;
  readdir?: (dir: string) => DirEntry[];
  isDirectory?: (path: string) => boolean;
  max?: number;
  /** A pasta pessoal de quem roda (padrão: a do sistema). */
  home?: string;
}

/** Os arquivos que dá para citar no projeto de `root` (caminho absoluto de uma pasta), ou o motivo de não listar. */
export function listProjectFiles(root: string, opts: ListOptions = {}): ProjectFiles | { error: string } {
  if (!root || root.includes('\0') || !root.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(root)) return { error: tr('caminho inválido') };
  const isDirectory = opts.isDirectory ?? ((p: string) => statSync(p).isDirectory());
  try {
    if (!isDirectory(root)) return { error: tr('pasta do projeto não encontrada') };
  } catch {
    return { error: tr('pasta do projeto não encontrada') };
  }
  const max = opts.max ?? PROJECT_FILES_MAX;
  const listed = (opts.git ?? gitFiles)(root) ?? walkFiles(root, opts.readdir ?? ((dir) => readdirSync(dir, { withFileTypes: true })), max, (opts.home ?? homedir()).replace(/\/+$/, ''));
  const files: string[] = [];
  let truncated = false;
  for (const raw of listed) {
    const path = raw.replace(/\\/g, '/');
    if (!path || path.startsWith('/') || looksSecret(path)) continue;
    if (files.length >= max) {
      truncated = true;
      break;
    }
    files.push(path);
  }
  return { files, truncated };
}
