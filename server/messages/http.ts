// Rotas das mensagens pelo escritório. A trava (recurso ligado + Host local) já foi conferida em http/app.ts; o
// guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   POST /api/messages          (página)  {agentId, text, attachments?}: 201 OutboxMessage (queued) | 400 | 404 | 409 | 429
//                                         (`attachments` = ids de POST /api/messages/attachments; com eles o texto
//                                         pode vir vazio)
//   GET  /api/messages/:id      (página)  situação da mensagem: 200 OutboxMessage | 404
//   GET  /api/messages/commands/:agentId
//                               (página)  comandos de barra da sessão do agente: 200 {commands: SessionCommand[]}
//   GET  /api/messages/files/:agentId?q=texto
//                               (página)  arquivos do projeto do agente que casam com o texto, para citar com `@`:
//                                         200 {files: string[], truncated} | 404 | 503 (sem o auxiliar do host)
//   POST /api/messages/attachments
//                               (página)  {name, type?, data (base64)}: um anexo para a próxima mensagem (imagem ou
//                                         arquivo colado ou arrastado na caixa): 201 {id, name, size} | 400 | 403 | 429
//   POST /api/mod/inbox         (plugin)  {session, account?, commands?}: 200 {messages: InboxMessage[], needCommands?}
//                                         (marca a presença; `commands` = a lista de comandos de barra da sessão, que
//                                         o plugin manda quando ela muda ou quando a resposta traz `needCommands`)
//   POST /api/mod/inbox/ack     (plugin)  {session, results: [{id, ok, error?}]}: 200 {ok: true}
//   POST /api/codex/bridge/poll (auxiliar do Codex no host, npm run codex:bridge)
//                                         {}: 200 {messages: [{id, account, codexHome, thread, text}]} (marca a presença)
//   POST /api/codex/bridge/ack  (auxiliar) {results: [{id, ok, error?}]}: 200 {ok: true}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { rankFiles } from '../../shared/messages';
import type { ListResult } from '../deliveries/fetcher';
import { ATTACHMENT_BODY_MAX, parseAttachment, type AttachmentStore } from '../spawn/attachments';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';
import { tr } from '../../shared/i18n';

const ITEM = /^\/api\/messages\/([^/]+)$/;
const COMMANDS = /^\/api\/messages\/commands\/([^/]+)$/;
const FILES = /^\/api\/messages\/files\/([^/]+)$/;
/** Tamanho máximo do texto buscado depois do `@`. */
const QUERY_MAX = 200;

/** Quem lista os arquivos de uma pasta de projeto (deliveries/fetcher.ts); sem ele, o `@` não lista nada. */
export type ProjectLister = (root: string) => Promise<ListResult>;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: tr('erro interno') });
}

export function createMessageRoutes(
  registry: MessageRegistry,
  listFiles?: ProjectLister,
  /** O depósito dos anexos das mensagens (o mesmo do registro); sem ele, a caixa não aceita anexos. */
  attachments?: AttachmentStore,
): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const attach = async (req: IncomingMessage, res: ServerResponse) => {
    if (!attachments) return sendJson(res, 403, { error: tr('anexos desligados') });
    const a = parseAttachment(await readJson(req, ATTACHMENT_BODY_MAX));
    if ('error' in a) return sendJson(res, 400, { error: a.error });
    const r = attachments.put(a);
    if ('error' in r) return sendJson(res, 429, { error: r.error });
    sendJson(res, 201, { id: r.id, name: a.name, size: a.data.length });
  };

  const files = async (req: IncomingMessage, res: ServerResponse, agentId: string) => {
    const root = registry.projectOf(agentId);
    if (!root) return sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
    if (!listFiles) return sendJson(res, 503, { error: tr('arquivos desligados') });
    const listed = await listFiles(root);
    if ('error' in listed) return sendJson(res, listed.status, { error: listed.error });
    const q = (new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? '').slice(0, QUERY_MAX);
    sendJson(res, 200, { files: rankFiles(listed.files, q), truncated: listed.truncated });
  };

  const send = async (req: IncomingMessage, res: ServerResponse) => {
    const r = registry.send(await readJson(req));
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'not-found':
        return sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: tr('já há {0} mensagens esperando a entrega para este agente: espere a sessão buscar', [MAX_OPEN]) });
    }
  };

  const inbox = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readJson(req);
    const messages = registry.inbox(body);
    sendJson(res, 200, registry.lacksCommands(body) ? { messages, needCommands: true } : { messages });
  };

  const ack = async (req: IncomingMessage, res: ServerResponse) => {
    registry.ack(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const codexPoll = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.codexPoll(await readJson(req)) });
  };

  const codexAck = async (req: IncomingMessage, res: ServerResponse) => {
    registry.codexAck(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const post = (req: IncomingMessage, res: ServerResponse, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    handler(req, res).catch((err) => fail(res, err));
  };

  return (req, res, path) => {
    if (path === '/api/messages') return post(req, res, send);
    if (path === '/api/messages/attachments') return post(req, res, attach);
    if (path === '/api/mod/inbox') return post(req, res, inbox);
    if (path === '/api/mod/inbox/ack') return post(req, res, ack);
    if (path === '/api/codex/bridge/poll') return post(req, res, codexPoll);
    if (path === '/api/codex/bridge/ack') return post(req, res, codexAck);
    const commands = COMMANDS.exec(path);
    const listing = FILES.exec(path);
    const m = commands ?? listing ?? ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    if (commands) return sendJson(res, 200, { commands: registry.commandsOf(id) });
    if (listing) return void files(req, res, id).catch((err) => fail(res, err));
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: tr('mensagem desconhecida: ela já foi resolvida há mais de 10 min ou o Habblaud reiniciou') });
  };
}
