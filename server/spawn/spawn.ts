// Novo agente pelo escritório: abre uma sessão nova no app desktop do Claude, na pasta escolhida e com o pedido já
// escrito, pelo link `claude://code/new?folder=<pasta>&q=<pedido>` (o mesmo do "New Claude Code Session Here" do
// Finder). Quem abre o link precisa estar no computador do app:
// - modo Node: o próprio servidor roda `open` (macOS), `xdg-open` (Linux) ou `cmd /c start` (Windows);
// - Docker: o auxiliar do host (scripts/codex-bridge.ts, npm run codex:bridge) busca os pedidos em
//   POST /api/host/spawn/poll, confere a pasta, abre o link e confirma em POST /api/host/spawn/ack.
// O link abre a tela de sessão nova do app, preenchida: a sessão começa quando a pessoa aperta Enter lá.
// Anexos (spawn/attachments.ts): quem abre o link grava os arquivos em ~/.habblaud/attachments/ e põe os caminhos no fim
// do pedido. Sem shell (execFile) e com prazo.
// Node puro e sem dependências: também é importado pelo auxiliar do host (via tsx).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { attachmentsRoot, promptWithAttachments, writeAttachments, type Attachment, type AttachmentStore } from './attachments';

/** Tamanho máximo do pedido (o link inteiro vai pela linha de comando do `open`). */
export const PROMPT_MAX = 8_000;
export const FOLDER_MAX = 1_024;
/** Prazo do `open`. */
export const OPEN_TIMEOUT_MS = 10_000;
/** O auxiliar conta como presente até este tempo depois da última rodada. */
export const HOST_PRESENCE_MS = 10_000;
/** Pedido buscado e não confirmado vira falha; pedido que ninguém buscou também. */
export const SENT_TIMEOUT_MS = 30_000;
export const QUEUED_TIMEOUT_MS = 60_000;
/** Pedidos resolvidos ficam este tempo para o GET. */
export const KEEP_MS = 10 * 60_000;
const MAX_OPEN = 5;
const ERROR_MAX = 300;

export interface SpawnRequest {
  folder: string;
  prompt: string;
}

export type SpawnStatus = 'queued' | 'sent' | 'opened' | 'failed';

export interface SpawnInfo {
  id: string;
  folder: string;
  status: SpawnStatus;
  error?: string;
}

export type OpenResult = { ok: true } | { ok: false; error: string };
export type Opener = (url: string) => Promise<OpenResult>;

/** Confere o corpo de POST /api/spawn; devolve o pedido ou o motivo da recusa. */
export function parseSpawn(raw: unknown): SpawnRequest | { error: string } {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const folder = typeof r.folder === 'string' ? r.folder.trim() : '';
  const prompt = typeof r.prompt === 'string' ? r.prompt.replace(/\s+$/, '') : '';
  if (!folder || folder.length > FOLDER_MAX || folder.includes('\0') || !(isAbsolute(folder) || /^[A-Za-z]:[\\/]/.test(folder))) {
    return { error: 'escolha uma pasta (caminho absoluto, ex.: /Users/voce/projeto)' };
  }
  if (prompt.length > PROMPT_MAX || prompt.includes('\0')) return { error: `o pedido passa de ${PROMPT_MAX} caracteres` };
  return { folder, prompt };
}

/** O link que o app do Claude entende (claude://code/new; `q` = pedido já escrito). */
export function spawnUrl(req: SpawnRequest): string {
  const q = new URLSearchParams();
  q.set('folder', req.folder);
  if (req.prompt.trim()) q.set('q', req.prompt);
  q.set('source', 'habblaud');
  return `claude://code/new?${q.toString().replace(/\+/g, '%20')}`;
}

/** A pasta existe neste computador (o auxiliar confere antes de abrir; o Docker não enxerga as pastas do host). */
export function folderProblem(folder: string, stat: (p: string) => { isDirectory(): boolean } = statSync): string | undefined {
  try {
    return stat(folder).isDirectory() ? undefined : 'não é uma pasta';
  } catch {
    return 'pasta não encontrada neste computador';
  }
}

/** `open`/`xdg-open`/`start` sem shell. */
export function createOpener(platform: NodeJS.Platform = process.platform, timeoutMs = OPEN_TIMEOUT_MS): Opener {
  const [bin, pre] = platform === 'darwin' ? ['open', []] : platform === 'win32' ? ['cmd', ['/c', 'start', '""']] : ['xdg-open', []];
  return (url) =>
    new Promise((ok) => {
      execFile(bin, [...pre, url], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, _out, stderr) => {
        if (!err) return ok({ ok: true });
        const line = (stderr || err.message || '').split('\n').find((l) => l.trim()) ?? 'falhou';
        ok({ ok: false, error: `${bin}: ${line.trim()}`.slice(0, ERROR_MAX) });
      });
    });
}

interface Entry {
  info: SpawnInfo;
  req: SpawnRequest;
  files: Attachment[];
  at: number;
}

/** Um pedido para o auxiliar do host, com os anexos em base64. */
export interface PolledSpawn extends SpawnRequest {
  id: string;
  files: Array<{ name: string; type: string; data: string }>;
}

export interface SpawnServiceOptions {
  /** Modo Node: abre aqui mesmo. Ausente (Docker): fica na fila para o auxiliar do host. */
  opener?: Opener;
  /** Confere a pasta antes de abrir no modo direto (padrão: statSync). */
  folderProblem?: (folder: string) => string | undefined;
  /** Anexos enviados antes do pedido (POST /api/spawn/attachments); ausente = pedidos sem anexos. */
  attachments?: AttachmentStore;
  /** Modo direto: grava os anexos e devolve os caminhos (padrão: ~/.habblaud/attachments/). */
  writeFiles?: (spawnId: string, files: readonly Attachment[]) => string[];
  now?: () => number;
  newId?: () => string;
}

export type SpawnSubmit = { spawn: SpawnInfo } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

export class SpawnService {
  private readonly entries = new Map<string, Entry>();
  private hostSeenAt = -Infinity;
  private readonly now: () => number;

  constructor(private readonly opts: SpawnServiceOptions = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Dá para abrir agora: modo direto, ou o auxiliar do host passou há pouco. */
  available(): boolean {
    return !!this.opts.opener || this.now() - this.hostSeenAt <= HOST_PRESENCE_MS;
  }

  mode(): 'direct' | 'host' {
    return this.opts.opener ? 'direct' : 'host';
  }

  submit(raw: unknown): SpawnSubmit {
    this.prune();
    const req = parseSpawn(raw);
    if ('error' in req) return { error: 'invalid', reason: req.error };
    if (!this.available()) {
      return { error: 'unavailable', reason: 'o auxiliar do Mac não está rodando: deixe npm run codex:bridge no ar (o Habblaud está no Docker)' };
    }
    let open = 0;
    for (const e of this.entries.values()) if (e.info.status === 'queued' || e.info.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: `já há ${MAX_OPEN} agentes novos esperando para abrir` };
    const ids = raw && typeof raw === 'object' ? (raw as { attachments?: unknown }).attachments : undefined;
    let files: Attachment[] = [];
    if (ids !== undefined && !(Array.isArray(ids) && !ids.length)) {
      if (!this.opts.attachments) return { error: 'invalid', reason: 'anexos desligados' };
      const taken = this.opts.attachments.take(ids);
      if ('error' in taken) return { error: 'invalid', reason: taken.error };
      files = taken;
    }
    const info: SpawnInfo = { id: this.opts.newId?.() ?? randomUUID(), folder: req.folder, status: 'queued' };
    const entry: Entry = { info, req, files, at: this.now() };
    this.entries.set(info.id, entry);
    if (this.opts.opener) void this.openDirect(entry, this.opts.opener);
    return { spawn: { ...info } };
  }

  get(id: string): SpawnInfo | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.info };
  }

  /** Rodada do auxiliar: marca presença e entrega os pedidos na fila (ele monta o link: não abre um vindo de fora). */
  poll(): PolledSpawn[] {
    this.hostSeenAt = this.now();
    this.prune();
    const out: PolledSpawn[] = [];
    for (const e of this.entries.values()) {
      if (e.info.status !== 'queued') continue;
      e.info.status = 'sent';
      e.at = this.now();
      const files = e.files.map((f) => ({ name: f.name, type: f.type, data: f.data.toString('base64') }));
      e.files = [];
      out.push({ id: e.info.id, folder: e.req.folder, prompt: e.req.prompt, files });
    }
    return out;
  }

  ack(raw: unknown): void {
    this.hostSeenAt = this.now();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.info.status !== 'sent') continue;
      this.resolve(e, x.ok === true ? { ok: true } : { ok: false, error: typeof x.error === 'string' && x.error ? x.error.slice(0, ERROR_MAX) : 'o auxiliar não abriu o app' });
    }
  }

  private async openDirect(e: Entry, opener: Opener): Promise<void> {
    e.info.status = 'sent';
    const problem = (this.opts.folderProblem ?? folderProblem)(e.req.folder);
    if (problem) return this.resolve(e, { ok: false, error: problem });
    let paths: string[];
    try {
      paths = (this.opts.writeFiles ?? ((id, files) => writeAttachments(attachmentsRoot(), id, files)))(e.info.id, e.files);
    } catch (err) {
      return this.resolve(e, { ok: false, error: `não deu para gravar os anexos (${(err as Error).message})`.slice(0, ERROR_MAX) });
    } finally {
      e.files = [];
    }
    const req = { folder: e.req.folder, prompt: promptWithAttachments(e.req.prompt, paths) };
    this.resolve(e, await opener(spawnUrl(req)).catch(() => ({ ok: false as const, error: 'falhou ao abrir o app' })));
  }

  private resolve(e: Entry, r: OpenResult): void {
    e.files = [];
    e.info.status = r.ok ? 'opened' : 'failed';
    if (!r.ok) e.info.error = r.error;
    e.at = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.at;
      if (e.info.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.resolve(e, { ok: false, error: 'o auxiliar do Mac não buscou o pedido' });
      else if (e.info.status === 'sent' && age > SENT_TIMEOUT_MS) this.resolve(e, { ok: false, error: 'o auxiliar do Mac não confirmou' });
      else if ((e.info.status === 'opened' || e.info.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
