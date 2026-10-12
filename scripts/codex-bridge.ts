// Auxiliar do Habblaud para as mensagens ao Codex quando o Habblaud roda no Docker. Roda no HOST (Mac), com tsx:
//
//   npm run codex:bridge     (opções: --port <n>, --once)
//
// As mensagens ao Codex entram na sessão por `codex queue --thread <threadId> --message <texto>`, que precisa rodar no
// Mac (é aqui que estão o Codex e as pastas das contas); no Docker o servidor não alcança o binário. Este processo, a
// cada 2 s, pergunta ao Habblaud se há mensagens para as sessões do Codex (POST /api/codex/bridge/poll), roda o
// comando para cada uma, na ordem, com o CODEX_HOME da conta, e confirma o resultado (POST /api/codex/bridge/ack).
// Enquanto ele roda, o escritório deixa mandar mensagens aos agentes do Codex (o Habblaud o considera presente por até
// 10 s depois da última rodada). Fora do Docker não precisa dele: o próprio servidor roda o comando.
//
// Binário: HABBLAUD_CODEX_BIN ou `codex` do PATH. Nunca roda o Codex com -c, --enable, --disable nem --no-daemon, e
// confere cada mensagem antes (id de thread, pasta do Codex que existe). O texto das mensagens nunca vai para a tela.
// Também abre os agentes novos do escritório no app do Claude (com os anexos gravados em ~/.habblaud/attachments/) e
// transcreve o ditado com o Whisper local (whisper-cli + ffmpeg + modelo; ver server/dictation/whisper.ts), a cada
// 0,5 s, só quando o Whisper está instalado.
// Ctrl+C para parar.
import { statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isClaudeDir } from '../server/accounts/detect';
import { createCodexQueueRunner, findCodexBin, THREAD_ID, type CodexQueueResult, type CodexQueueRunner } from '../server/messages/codex';
import { createOpener, folderProblem, parseSpawn, spawnUrl, type Opener } from '../server/spawn/spawn';
import { ATTACHMENT_MAX_BYTES, ATTACHMENTS_PER_SPAWN, attachmentsRoot, promptWithAttachments, safeFileName, writeAttachments, type Attachment } from '../server/spawn/attachments';
import { createWhisperTranscriber, findWhisper, type Transcriber } from '../server/dictation/whisper';

export const DEFAULT_PORT = 4747;
/** Intervalo entre as rodadas. */
export const POLL_MS = 2_000;
/** Intervalo do ditado (a pessoa espera o texto). */
export const DICTATION_POLL_MS = 500;
const REQUEST_TIMEOUT_MS = 5_000;

const USAGE = `Uso: npm run codex:bridge [-- opções]

Entrega as mensagens do escritório às sessões do Codex quando o Habblaud roda no Docker (deixe rodando no Mac).

Opções:
  --port <n>   porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  --once       faz uma rodada só e sai
  -h, --help   mostra esta ajuda

Binário do Codex: HABBLAUD_CODEX_BIN ou \`codex\` do PATH.`;

export interface BridgeMessage {
  id: string;
  account: string;
  codexHome: string;
  thread: string;
  text: string;
}

export interface BridgeResult {
  id: string;
  ok: boolean;
  error?: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

class FatalError extends Error {}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): { port: number; once: boolean } | 'help' {
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let once = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--once') once = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError('--port precisa de um número entre 1 e 65535.');
    } else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  return { port, once };
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Confere uma mensagem vinda do Habblaud antes de rodar o comando: id, texto, id de thread (UUID) e uma pasta do
 * Codex que existe neste computador (nunca uma do Claude Code). Devolve a mensagem ou o motivo da recusa.
 */
export function checkMessage(raw: unknown): BridgeMessage | { id?: string; error: string } {
  const r = rec(raw);
  const id = typeof r?.id === 'string' && r.id.trim() ? r.id : undefined;
  if (!r || !id) return { error: 'mensagem sem id' };
  if (typeof r.text !== 'string' || !r.text.trim()) return { id, error: 'mensagem vazia' };
  if (typeof r.thread !== 'string' || !THREAD_ID.test(r.thread)) return { id, error: 'id de thread do Codex inválido' };
  const home = typeof r.codexHome === 'string' ? r.codexHome : '';
  if (!home || !isAbsolute(home) || !isDir(home) || isClaudeDir(home)) return { id, error: `a pasta do Codex ${home || '(vazia)'} não existe neste computador` };
  return { id, account: typeof r.account === 'string' ? r.account : '', codexHome: resolve(home), thread: r.thread, text: r.text };
}

/** POST JSON ao Habblaud local; null = fora do ar, tempo esgotado ou resposta ilegível. */
export type Post = (path: string, body: unknown) => Promise<{ status: number; json: unknown } | null>;

export function httpPost(port: number): Post {
  return async (path, body) => {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        // O guard do Habblaud exige JSON em todo POST da API (mesmo o corpo vazio da rodada).
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, json };
    } catch {
      return null;
    }
  };
}

export type RoundResult =
  | { state: 'down' }
  | { state: 'refused'; status: number; error?: string }
  | { state: 'ok'; results: BridgeResult[] };

/** Uma rodada: busca as mensagens, roda `codex queue` para cada uma (na ordem) e confirma. Nunca lança. */
export async function round(post: Post, run: CodexQueueRunner, log: (line: string) => void = () => {}): Promise<RoundResult> {
  const polled = await post('/api/codex/bridge/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.messages;
  if (polled.status !== 200 || !Array.isArray(list)) {
    const error = rec(polled.json)?.error;
    return { state: 'refused', status: polled.status, ...(typeof error === 'string' ? { error } : {}) };
  }
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const m = checkMessage(raw);
    if ('error' in m) {
      if (m.id) results.push({ id: m.id, ok: false, error: m.error });
      log(`✗ mensagem recusada: ${m.error}`);
      continue;
    }
    let r: CodexQueueResult;
    try {
      r = await run({ codexHome: m.codexHome, thread: m.thread, text: m.text });
    } catch (err) {
      r = { ok: false, error: String(err) };
    }
    results.push(r.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: r.error });
    log(r.ok ? `✓ mensagem na fila do thread ${m.thread.slice(0, 8)}… (${m.account || 'Codex'})` : `✗ thread ${m.thread.slice(0, 8)}…: ${r.error}`);
  }
  if (results.length) await post('/api/codex/bridge/ack', { results });
  return { state: 'ok', results };
}

/**
 * Agentes novos pelo escritório: busca os pedidos (POST /api/host/spawn/poll), confere cada um (pasta que existe
 * aqui), monta o link claude://code/new ele mesmo e abre o app do Claude; confirma em /api/host/spawn/ack. Nunca lança.
 */
/** Anexos de um pedido vindo do Habblaud: nomes seguros, base64 válido, tamanho e quantidade no limite. */
export function checkFiles(raw: unknown): Attachment[] | { error: string } {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > ATTACHMENTS_PER_SPAWN) return { error: 'anexos inválidos' };
  const out: Attachment[] = [];
  for (const f of raw) {
    const r = rec(f);
    if (!r || typeof r.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) return { error: 'anexo ilegível' };
    const data = Buffer.from(r.data, 'base64');
    if (!data.length || data.length > ATTACHMENT_MAX_BYTES) return { error: 'anexo vazio ou grande demais' };
    out.push({ name: safeFileName(typeof r.name === 'string' ? r.name : 'arquivo'), type: typeof r.type === 'string' ? r.type : '', data });
  }
  return out;
}

export async function spawnRound(
  post: Post,
  open: Opener,
  log: (line: string) => void = () => {},
  problem: (folder: string) => string | undefined = folderProblem,
  write: (id: string, files: readonly Attachment[]) => string[] = (id, files) => writeAttachments(attachmentsRoot(), id, files),
): Promise<RoundResult> {
  const polled = await post('/api/host/spawn/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.spawns;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: BridgeResult[] = [];
  for (const raw of list) {
    const id = typeof rec(raw)?.id === 'string' ? (rec(raw)!.id as string) : '';
    if (!id) continue;
    const req = parseSpawn(raw);
    const files = checkFiles(rec(raw)?.files);
    const bad = 'error' in req ? req.error : 'error' in files ? files.error : problem(req.folder);
    if (bad || 'error' in req || 'error' in files) {
      results.push({ id, ok: false, error: bad ?? 'pedido inválido' });
      log(`✗ agente novo recusado: ${bad}`);
      continue;
    }
    let r: { ok: boolean; error?: string };
    try {
      const paths = write(id, files);
      r = await open(spawnUrl({ folder: req.folder, prompt: promptWithAttachments(req.prompt, paths) }));
    } catch (err) {
      r = { ok: false, error: String((err as Error)?.message ?? err) };
    }
    results.push(r.ok ? { id, ok: true } : { id, ok: false, error: r.error });
    const extra = files.length ? ` com ${files.length} anexo${files.length > 1 ? 's' : ''}` : '';
    log(r.ok ? `✓ agente novo aberto no app do Claude em ${req.folder}${extra}` : `✗ agente novo em ${req.folder}: ${r.error}`);
  }
  if (results.length) await post('/api/host/spawn/ack', { results });
  return { state: 'ok', results };
}

/**
 * Ditado: busca os áudios (POST /api/host/dictation/poll), transcreve cada um com o Whisper local e devolve o texto e
 * o idioma em /api/host/dictation/ack. O texto nunca vai para a tela. Nunca lança.
 */
export async function dictationRound(post: Post, transcribe: Transcriber, log: (line: string) => void = () => {}): Promise<RoundResult> {
  const polled = await post('/api/host/dictation/poll', {});
  if (!polled) return { state: 'down' };
  const list = rec(polled.json)?.dictations;
  if (polled.status !== 200 || !Array.isArray(list)) return { state: 'refused', status: polled.status };
  const results: Array<BridgeResult & { text?: string; lang?: string }> = [];
  for (const raw of list) {
    const r = rec(raw);
    const id = typeof r?.id === 'string' ? r.id : '';
    if (!id) continue;
    if (typeof r?.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(r.data)) {
      results.push({ id, ok: false, error: 'áudio ilegível' });
      continue;
    }
    const started = Date.now();
    try {
      const t = await transcribe(Buffer.from(r.data, 'base64'), typeof r.type === 'string' ? r.type : '');
      results.push({ id, ok: true, text: t.text, lang: t.lang });
      log(`✓ ditado transcrito (${t.lang || '?'}, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    } catch (err) {
      const error = (err as Error)?.message || 'o Whisper falhou';
      results.push({ id, ok: false, error });
      log(`✗ ditado: ${error}`);
    }
  }
  if (results.length) await post('/api/host/dictation/ack', { results });
  return { state: 'ok', results };
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  const bin = findCodexBin(process.env);
  const run = bin ? createCodexQueueRunner(bin) : undefined;
  const open = createOpener();
  const post = httpPost(parsed.port);
  const log = (line: string) => console.log(`[codex-bridge] ${line}`);
  log(
    bin
      ? `Entregando as mensagens do Habblaud (http://127.0.0.1:${parsed.port}) às sessões do Codex com ${bin}, e abrindo os agentes novos no app do Claude. Ctrl+C para parar.`
      : `Sem o Codex (codex no PATH ou HABBLAUD_CODEX_BIN): só abro os agentes novos do Habblaud (http://127.0.0.1:${parsed.port}) no app do Claude. Ctrl+C para parar.`,
  );
  const whisper = findWhisper(process.env);
  if ('missing' in whisper) log(`Ditado desligado: falta ${whisper.missing}.`);
  else {
    log(`Ditado: Whisper local (${whisper.model.split('/').pop()}), idiomas ${whisper.langs.join('/')} detectados sozinhos.`);
    const transcribe = createWhisperTranscriber(whisper);
    if (!parsed.once) {
      void (async () => {
        for (;;) {
          await dictationRound(post, transcribe, log);
          await new Promise((ok) => setTimeout(ok, DICTATION_POLL_MS));
        }
      })();
    }
  }
  let last = '';
  for (;;) {
    const spawned = await spawnRound(post, open, log);
    const r = run ? await round(post, run, log) : spawned;
    const state =
      r.state === 'down'
        ? `Habblaud fora do ar em http://127.0.0.1:${parsed.port}; tentando de novo a cada ${POLL_MS / 1_000} s.`
        : r.state === 'refused'
          ? `o Habblaud recusou (${r.status}${r.error ? `: ${r.error}` : ''}).`
          : 'conectado: os agentes do Codex já recebem mensagens pelo escritório.';
    if (state !== last) log(state);
    last = state;
    if (parsed.once) {
      process.exitCode = r.state === 'ok' && r.results.every((x) => x.ok) ? 0 : 1;
      return;
    }
    await new Promise((ok) => setTimeout(ok, POLL_MS));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[codex-bridge] Erro: ${err.message}` : `[codex-bridge] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
