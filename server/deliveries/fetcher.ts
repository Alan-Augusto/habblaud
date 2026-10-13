// Lê os arquivos das entregas para o escritório. No modo Node o próprio servidor lê; no Docker, o que está numa pasta
// montada (as pastas das contas, ex.: capturas em projects/) é lido aqui, e o resto o auxiliar do host busca:
// POST /api/host/files/poll entrega os caminhos pedidos e /api/host/files/ack devolve o conteúdo (base64). Toda leitura
// passa por checkFile (deliveries/files.ts), aqui e no auxiliar. Os arquivos lidos ficam num cache pequeno em memória.
// Pelo mesmo caminho vai a lista de arquivos de um projeto (o `@` da caixa de mensagem, deliveries/project-files.ts):
// o servidor lista no modo Node; no Docker, o pedido sai na mesma rodada com `list: true` e o auxiliar devolve os
// caminhos. A lista de cada projeto vale LIST_FRESH_MS.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import { checkFile, DELIVERY_FILE_MAX_BYTES } from './files';
import { listProjectFiles, looksSecret, PROJECT_FILES_MAX, type ProjectFiles } from './project-files';

export const HOST_PRESENCE_MS = 10_000;
export const WAIT_MS = 20_000;
const CACHE_MAX_BYTES = 80 * 1024 * 1024;
const MAX_PENDING = 16;
/** A lista de arquivos de um projeto vale este tempo; guardam-se as dos últimos LIST_CACHE_MAX projetos. */
export const LIST_FRESH_MS = 30_000;
const LIST_CACHE_MAX = 8;
const LIST_PATH_MAX = 1_024;

export type FetchResult = { data: Buffer } | { error: string; status: number };
export type ListResult = ProjectFiles | { error: string; status: number };

/** Um pedido da rodada do auxiliar: um arquivo para ler ou, com `list`, uma pasta de projeto para listar. */
export interface HostFileRequest {
  id: string;
  path: string;
  list?: true;
}

interface PendingList {
  id: string;
  root: string;
  sent: boolean;
  done: (r: ListResult) => void;
}

interface Pending {
  id: string;
  path: string;
  sent: boolean;
  at: number;
  done: (r: FetchResult) => void;
}

export interface FileFetcherOptions {
  /** Modo Node: lê direto do disco. */
  direct?: boolean;
  /** Docker: o caminho do host dentro do container, quando a pasta está montada (undefined = não está). */
  mapHostPath?: (path: string) => string | undefined;
  read?: (path: string) => Buffer;
  check?: typeof checkFile;
  listFiles?: typeof listProjectFiles;
  now?: () => number;
}

export class FileFetcher {
  private readonly cache = new Map<string, Buffer>();
  private cacheBytes = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly lists = new Map<string, { at: number; value: ProjectFiles }>();
  private readonly pendingLists = new Map<string, PendingList>();
  /** Listagem em andamento por projeto: quem pede de novo no meio espera a mesma. */
  private readonly listing = new Map<string, Promise<ListResult>>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: FileFetcherOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  hostAvailable(): boolean {
    return this.host.present();
  }

  async get(path: string): Promise<FetchResult> {
    const hit = this.cache.get(path);
    if (hit) {
      this.cache.delete(path);
      this.cache.set(path, hit);
      return { data: hit };
    }
    const local = this.opts.direct ? path : this.opts.mapHostPath?.(path);
    if (local) {
      const r = this.readLocal(local);
      if ('data' in r || this.opts.direct) return r;
    }
    if (this.opts.direct) return { error: tr('arquivo não encontrado'), status: 404 };
    if (!this.hostAvailable()) return { error: tr('o auxiliar do computador (npm run codex:bridge) não está rodando'), status: 503 };
    if (this.pending.size >= MAX_PENDING) return { error: tr('arquivos demais sendo buscados: tente de novo'), status: 429 };
    const r = await new Promise<FetchResult>((done) => {
      const p: Pending = { id: randomUUID(), path, sent: false, at: this.now(), done };
      this.pending.set(p.id, p);
      this.host.wake();
      setTimeout(() => {
        if (this.pending.delete(p.id)) done({ error: tr('o computador não respondeu a tempo'), status: 504 });
      }, WAIT_MS).unref?.();
    });
    if ('data' in r) this.remember(path, r.data);
    return r;
  }

  /**
   * Os arquivos que dá para citar no projeto de `root` (a pasta do projeto no computador). No modo Node o servidor
   * lista; no Docker, quem lista é o auxiliar do host. A lista vale LIST_FRESH_MS.
   */
  list(root: string): Promise<ListResult> {
    const hit = this.lists.get(root);
    if (hit && this.now() - hit.at < LIST_FRESH_MS) return Promise.resolve(hit.value);
    const running = this.listing.get(root);
    if (running) return running;
    const p = this.listNow(root).then((r) => {
      this.listing.delete(root);
      if ('files' in r) {
        this.lists.delete(root);
        this.lists.set(root, { at: this.now(), value: r });
        if (this.lists.size > LIST_CACHE_MAX) this.lists.delete(this.lists.keys().next().value as string);
      }
      return r;
    });
    this.listing.set(root, p);
    return p;
  }

  private async listNow(root: string): Promise<ListResult> {
    if (this.opts.direct) {
      const r = (this.opts.listFiles ?? listProjectFiles)(root);
      return 'error' in r ? { error: r.error, status: 404 } : r;
    }
    if (!this.hostAvailable()) return { error: tr('o auxiliar do computador (npm run codex:bridge) não está rodando'), status: 503 };
    if (this.pendingLists.size >= MAX_PENDING) return { error: tr('arquivos demais sendo buscados: tente de novo'), status: 429 };
    return new Promise<ListResult>((done) => {
      const p: PendingList = { id: randomUUID(), root, sent: false, done };
      this.pendingLists.set(p.id, p);
      this.host.wake();
      setTimeout(() => {
        if (this.pendingLists.delete(p.id)) done({ error: tr('o computador não respondeu a tempo'), status: 504 });
      }, WAIT_MS).unref?.();
    });
  }

  /** Rodada do auxiliar: marca presença e entrega os caminhos pedidos (arquivos para ler e pastas para listar). */
  poll(): HostFileRequest[] {
    this.host.seen();
    const out: HostFileRequest[] = [];
    for (const p of this.pending.values()) {
      if (p.sent) continue;
      p.sent = true;
      out.push({ id: p.id, path: p.path });
    }
    for (const p of this.pendingLists.values()) {
      if (p.sent) continue;
      p.sent = true;
      out.push({ id: p.id, path: p.root, list: true });
    }
    return out;
  }

  /** Rodada com espera (?wait=1): sem nada pedido, fica parada até chegar um pedido ou passar `ms`. */
  pollWait(ms: number, signal?: AbortSignal): Promise<HostFileRequest[]> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const listed = typeof x.id === 'string' ? this.pendingLists.get(x.id) : undefined;
      if (listed) {
        this.pendingLists.delete(listed.id);
        if (x.ok === true && Array.isArray(x.files)) {
          // O auxiliar já filtrou; aqui, de novo, só o que tem forma de caminho relativo e não tem cara de segredo.
          const all = x.files.filter((f): f is string => typeof f === 'string' && !!f && f.length <= LIST_PATH_MAX && !f.startsWith('/') && !f.includes('\0') && !looksSecret(f));
          listed.done({ files: all.slice(0, PROJECT_FILES_MAX), truncated: x.truncated === true || all.length > PROJECT_FILES_MAX });
        } else listed.done({ error: typeof x.error === 'string' && x.error ? x.error.slice(0, 200) : tr('o computador não listou a pasta'), status: 404 });
        continue;
      }
      const p = typeof x.id === 'string' ? this.pending.get(x.id) : undefined;
      if (!p) continue;
      this.pending.delete(p.id);
      if (x.ok === true && typeof x.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(x.data)) {
        const data = Buffer.from(x.data, 'base64');
        if (data.length <= DELIVERY_FILE_MAX_BYTES) {
          p.done({ data });
          continue;
        }
      }
      p.done({ error: typeof x.error === 'string' && x.error ? x.error.slice(0, 200) : tr('o computador não leu o arquivo'), status: 404 });
    }
  }

  private readLocal(path: string): FetchResult {
    const c = (this.opts.check ?? checkFile)(path);
    if ('error' in c) return { error: c.error, status: c.error === tr('arquivo não encontrado') ? 404 : 403 };
    try {
      const data = (this.opts.read ?? readFileSync)(c.path);
      this.remember(path, data);
      return { data };
    } catch {
      return { error: tr('arquivo ilegível'), status: 404 };
    }
  }

  private remember(path: string, data: Buffer): void {
    if (data.length > CACHE_MAX_BYTES / 4) return;
    this.cache.set(path, data);
    this.cacheBytes += data.length;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= CACHE_MAX_BYTES) break;
      this.cache.delete(k);
      this.cacheBytes -= v.length;
    }
  }
}
