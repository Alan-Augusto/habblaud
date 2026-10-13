// Mensagens pelo escritório (Claude Code 2.1.287+): leva para a sessão o que você digita no Habblaud (no painel
// do agente ou no terminal da tecla T), como se você tivesse digitado no terminal.
//
// O que faz, e `claude plugin validate` lista exatamente o que o módulo chama (a saída está no mod/README.md):
//
// 1. A cada 2 s, só onde a sessão desenha (`$.session.surfaces()` vazia = `claude -p`/SDK: nada a fazer) ou numa
//    sessão do app desktop (CLAUDE_CODE_ENTRYPOINT=claude-desktop: SDK por baixo, sem superfície fora da tela), pergunta
//    ao Habblaud local se há mensagens para ela: POST http://127.0.0.1:<HABBLAUD_PORT ou 4747>/api/mod/inbox com
//    {session, account}. A pergunta também marca a presença da sessão: é ela que acende, no escritório, a caixa de
//    mensagem deste agente. Fora do ar, ou respondendo qualquer coisa que não seja 2xx (403 = mensagens desligadas
//    no Habblaud; 404 = uma versão sem a rota), passa a perguntar a cada 30 s até ele voltar.
// 2. Cada mensagem, na ordem, vai para a sessão por `$.prompt.submit({ text, asUser: true })`: o modelo a lê como
//    sua, sem o "The habblaud-mensagens plugin sent a message" (o registro da sessão ainda nomeia o plugin). O
//    texto vai exatamente como chegou. `{drop}` (um hook recusou) ou exceção = falha, com o motivo.
//    Mensagem que começa com `/` é um comando de barra (`/compact`, `/model opus`): o Claude Code recusa esse texto
//    em `$.prompt.submit`, então ela vai por `$.command.run({ command, args })`, que roda o comando como se você o
//    tivesse digitado (com a sessão ocupada, quando ela ficar livre). Nome que a sessão não conhece = falha.
//    Com a sessão no meio de um turno, o Claude Code guarda o prompt (ou o comando) até ela ficar livre e a chamada
//    pode demorar a voltar: a espera por mensagem é de no máximo 2 s. Passou disso, a mensagem está na fila da sessão
//    e conta como entregue, e as seguintes da mesma rodada vão em seguida, na ordem, sem esperar. Assim a rodada nunca
//    passa de uns poucos segundos: a presença (10 s no servidor) e a confirmação (30 s) não vencem por uma
//    sessão ocupada. O preço: um hook que recuse a mensagem depois desses 2 s não chega ao escritório.
// 3. Um único POST /api/mod/inbox/ack com {session, results: [{id, ok, error?}]}. Sem mensagens, sem ack.
// 4. A lista de comandos de barra da sessão (`$.command.list()`: nome, descrição e origem de cada um) vai no corpo da
//    pergunta do passo 1, em `commands`, para o menu da caixa de mensagem do escritório. Ela é relida a cada minuto
//    e só é mandada quando mudou ou quando o Habblaud a pede (`needCommands` na resposta: ele ainda não a tem, ou
//    reiniciou). Se a leitura falhar, a pergunta segue sem a lista.
//
// Por que um plugin à parte do mod `habblaud`: aquele só observa (uso do plano, aviso embaixo do prompt,
// /habblaud) e nunca muda o que a sessão faz. Este age: digita na sessão em seu nome. Separado, dá para ficar sem
// ele (npm run mod:install -- --sem-mensagens) e a análise estática de cada um continua curta.
//
// Regras: nenhum hook lança (um hook que lança é pulado, mas o que ele deixou pela metade fica): cada passo tem seu
// try/catch e falha = silêncio. Uma rodada por vez (um Habblaud lento não acumula perguntas). Nada de $.process,
// $.model, $.fs, leitura da conversa nem decisão de ferramenta; a rede é só 127.0.0.1. O estado fica em variáveis
// do módulo: um hot reload recomeça do zero (uma mensagem buscada e não confirmada falha no servidor em 30 s).
// O Claude Code pode carregar o plugin de uma cópia só dele: os ajudantes de caminho são cópias dos de
// mod/habblaud/hooks/register.ts, não importações.
//
// Análise estática do Claude Code: cada chamada é escrita por extenso ($.noun.método), o nome do evento é
// sempre uma string literal e `$` só é passado para funções declaradas no topo deste arquivo.
import type { EngineInterface, HttpResponse, Register } from 'claude-code'

/** Porta padrão do Habblaud (a mesma do servidor, do mod e do docker-compose). */
export const DEFAULT_PORT = 4747
/** Intervalo das perguntas ao Habblaud; fora do ar, recua para o segundo até ele voltar. */
export const POLL_MS = 2_000
export const OFFLINE_POLL_MS = 30_000
/** Quanto esperar o Habblaud local responder (`$.http.fetch` não aceita AbortSignal: a corrida é com um timer). */
export const FETCH_TIMEOUT_MS = 2_000
/** Quanto esperar `$.prompt.submit` voltar antes de dar a mensagem como na fila da sessão. */
export const SUBMIT_WAIT_MS = 2_000
/** De quantas em quantas rodadas a lista de comandos de barra é relida (30 rodadas de 2 s = 1 min). */
export const COMMANDS_EVERY = 30
/** Quantos comandos vão na lista, e o tamanho da descrição de cada um (o corpo da pergunta tem limite no servidor). */
export const MAX_COMMANDS = 500
export const MAX_DESCRIPTION = 200
/** Tamanho máximo do motivo de uma falha (vem de um hook ou de uma exceção; o texto da mensagem nunca é cortado). */
export const MAX_REASON = 500

/** Mensagem como POST /api/mod/inbox entrega (shared/types.ts, InboxMessage). */
export interface InboxMessage {
  id: string
  /** O texto como foi digitado; vazio quando o servidor mandou algo que não é texto. */
  text: string
}

/** Resultado de uma mensagem, como POST /api/mod/inbox/ack recebe. */
export interface AckResult {
  id: string
  ok: boolean
  error?: string
}

/** Um comando de barra como `$.command.run` recebe: o nome sem a barra e o que veio depois dele. */
export interface SlashCommand {
  command: string
  args: string
}

/** Um comando de barra da sessão, como vai em `commands` no corpo de POST /api/mod/inbox (shared/types.ts, SessionCommand). */
export interface CommandRow {
  name: string
  description: string
  source: string
}

/** Desfecho de um `$.prompt.submit` ou de um `$.command.run`. */
type Submitted = { ok: true } | { ok: false; error: string }

interface ModEnv {
  /** Id da conta (o nome da pasta, como o servidor chama); ausente sem HOME (ou USERPROFILE) nem CLAUDE_CONFIG_DIR. */
  accountId?: string
  port: number
  /** Sessão do app desktop do Claude (CLAUDE_CODE_ENTRYPOINT=claude-desktop): roda como SDK e só tem superfície
   *  enquanto está na tela do app, mas é interativa e recebe prompts mesmo assim. */
  desktop: boolean
}

// ---------------------------------------------------------------------------------------------
// Funções puras (testadas em tests/habblaud-mensagens.test.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Normaliza um caminho (barras repetidas, `.`, `..` e a barra do fim): o ambiente do mod não tem node:path. Cópia
 * de mod/habblaud: caminhos do Windows (com drive ou UNC) saem com `/` e o drive conta como raiz; nos outros, `\`
 * é parte do nome.
 */
export function normalizePath(p: string): string {
  const win = /^(?:[A-Za-z]:|\\\\)/.test(p)
  const slashed = win ? p.replace(/\\/g, '/') : p
  const drive = /^[A-Za-z]:(?=\/|$)/.exec(slashed)?.[0] ?? (win && slashed.startsWith('//') ? '/' : '')
  const rest = slashed.slice(drive.length)
  const abs = rest.startsWith('/')
  const out: string[] = []
  for (const seg of rest.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push(seg)
      continue
    }
    out.push(seg)
  }
  const joined = out.join('/')
  return drive + (abs ? `/${joined}` : joined || (drive ? '' : '.'))
}

/** `~` no começo vira o HOME. */
function expandHome(p: string, home: string | undefined): string {
  return home && /^~(?=[\\/]|$)/.test(p) ? home + p.slice(1) : p
}

/** Config dir da conta: o primeiro item de CLAUDE_CONFIG_DIR (com `~` expandido) ou ~/.claude. */
export function configDirOf(claudeConfigDir: string | undefined, home: string | undefined): string | undefined {
  const first = (claudeConfigDir ?? '').split(',')[0]?.trim() ?? ''
  if (first) return normalizePath(expandHome(first, home))
  return home ? normalizePath(`${home}/.claude`) : undefined
}

/** Id da conta = nome da pasta (AccountInfo.id do servidor, ex.: ".claude-conta2"). */
export function accountIdOf(configDir: string): string | undefined {
  const name = configDir.split('/').filter(Boolean).pop()
  return name && name !== '.' && name !== '..' ? name : undefined
}

export function portOf(raw: string | undefined): number {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : DEFAULT_PORT
}

/** Corpo de POST /api/mod/inbox: a conta só quando se sabe qual é; a lista de comandos só quando há o que mandar. */
export function inboxBody(session: string, account: string | undefined, commands?: readonly CommandRow[]): string {
  return JSON.stringify({ session, ...(account ? { account } : {}), ...(commands ? { commands } : {}) })
}

/** O que vai de cada comando de `$.command.list()`: nome, descrição cortada e origem. Item sem nome fica de fora. */
export function commandRows(list: unknown): CommandRow[] {
  if (!Array.isArray(list)) return []
  const out: CommandRow[] = []
  for (const item of list) {
    if (out.length >= MAX_COMMANDS) break
    if (!item || typeof item !== 'object') continue
    const c = item as Record<string, unknown>
    if (typeof c.name !== 'string' || !c.name) continue
    const description = typeof c.description === 'string' ? c.description.slice(0, MAX_DESCRIPTION) : ''
    out.push({ name: c.name, description, source: typeof c.source === 'string' ? c.source : 'builtin' })
  }
  return out
}

/** A resposta de POST /api/mod/inbox pede a lista de comandos (`needCommands: true`)? Fora do formato = não. */
export function wantsCommands(text: string): boolean {
  try {
    const j: unknown = JSON.parse(text)
    return !!j && typeof j === 'object' && (j as Record<string, unknown>).needCommands === true
  } catch {
    return false
  }
}

/** Corpo de POST /api/mod/inbox/ack. */
export function ackBody(session: string, results: readonly AckResult[]): string {
  return JSON.stringify({ session, results })
}

/**
 * Lê a resposta de POST /api/mod/inbox; fora do formato = undefined (vale "fora do ar"). Item sem id fica de fora
 * (não há como confirmá-lo); com id e sem texto, entra com texto vazio, para ser confirmado como falha em vez de o
 * servidor esperar 30 s.
 */
export function parseInbox(text: string): InboxMessage[] | undefined {
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined
  const list = (j as Record<string, unknown>).messages
  if (!Array.isArray(list)) return undefined
  const out: InboxMessage[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const m = item as Record<string, unknown>
    if (typeof m.id !== 'string' || !m.id) continue
    out.push({ id: m.id, text: typeof m.text === 'string' ? m.text : '' })
  }
  return out
}

/**
 * Mensagem que é um comando de barra (`/compact`, `/model opus`): a barra é o primeiro caractere e o nome vai até o
 * primeiro espaço ou quebra de linha; o resto, sem os espaços das pontas, são os argumentos. Só a barra, ou a barra
 * seguida de espaço, não é comando. O Claude Code recusa em `$.prompt.submit` todo texto que começa com `/`: quem
 * diz se o nome existe é o `$.command.run`.
 */
export function parseCommand(text: string): SlashCommand | undefined {
  const m = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!m) return undefined
  return { command: m[1] ?? '', args: (m[2] ?? '').trim() }
}

/** O motivo de uma falha numa linha só, com tamanho limitado: o texto de um `{drop}` ou a mensagem de uma exceção. */
export function reasonText(raw: unknown, fallback: string): string {
  const msg = typeof raw === 'string' ? raw : raw && typeof (raw as { message?: unknown }).message === 'string' ? (raw as { message: string }).message : ''
  const line = msg.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!line) return fallback
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1)}…` : line
}

// ---------------------------------------------------------------------------------------------
// Estado do módulo (some num hot reload) e o que fala com o Claude Code
// ---------------------------------------------------------------------------------------------

let env: ModEnv | undefined
let timer: { cancel: () => void } | undefined
let timerMs = 0
/** Uma rodada por vez: um Habblaud lento ou uma sessão ocupada não empilham rodadas. */
let polling = false
/** Lista de comandos de barra: a última lida (e ela como texto, para comparar), a última que o Habblaud recebeu,
 *  quantas rodadas faltam para reler e se ele pediu a lista na última resposta. */
let commands: CommandRow[] | undefined
let commandsKey = ''
let commandsSent = ''
let roundsToList = 0
let commandsWanted = false

/** O ambiente da sessão, lido uma vez por carga (cada nome escrito por extenso, como a análise exige). */
async function readEnv($: EngineInterface): Promise<ModEnv> {
  if (env) return env
  // No Windows, HOME só existe se alguém o definir: vale o USERPROFILE (a mesma ordem do mod habblaud).
  const home = (await $.env.get('HOME'))?.trim() || (await $.env.get('USERPROFILE'))?.trim() || undefined
  const configDir = configDirOf(await $.env.get('CLAUDE_CONFIG_DIR'), home)
  const next: ModEnv = {
    port: portOf(await $.env.get('HABBLAUD_PORT')),
    desktop: (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() === 'claude-desktop',
  }
  const accountId = configDir ? accountIdOf(configDir) : undefined
  if (accountId) next.accountId = accountId
  env = next
  return next
}

/** O que `promise` resolver em até `ms`; passou disso, undefined (a promessa segue sozinha). */
async function waitAtMost<T>($: EngineInterface, promise: Promise<T>, ms: number): Promise<T | undefined> {
  let wait: { cancel: () => void } | undefined
  const timeout = new Promise<undefined>((resolve) => {
    wait = $.clock.after(ms, () => resolve(undefined))
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    wait?.cancel()
  }
}

/** POST de um JSON ao Habblaud local com prazo de 2 s: a resposta, ou undefined (fora do ar, travado). Nunca lança. */
async function postJson($: EngineInterface, port: number, path: string, body: string): Promise<HttpResponse | undefined> {
  try {
    const request = $.http.fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      // Sem o Content-Type, o guarda do servidor recusa o POST (415).
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body,
    })
    return await waitAtMost($, request, FETCH_TIMEOUT_MS)
  } catch {
    return undefined
  }
}

/**
 * A lista de comandos de barra a mandar nesta rodada: relida a cada COMMANDS_EVERY rodadas, e devolvida só se mudou
 * desde a última que o Habblaud recebeu ou se ele a pediu. Nada a mandar (ou a leitura falhou) = undefined. Nunca lança.
 */
async function commandsToSend($: EngineInterface): Promise<CommandRow[] | undefined> {
  try {
    if (roundsToList <= 0 || !commands) {
      roundsToList = COMMANDS_EVERY
      const list = await waitAtMost($, $.command.list(), FETCH_TIMEOUT_MS)
      if (list) {
        commands = commandRows(list)
        commandsKey = JSON.stringify(commands)
      }
    } else roundsToList--
  } catch {
    // sem a lista, a caixa do escritório fica sem o menu de comandos; as mensagens seguem
  }
  return commands && (commandsWanted || commandsKey !== commandsSent) ? commands : undefined
}

/** Um comando de barra na sessão, como se você o tivesse digitado. Nunca lança. */
async function runCommand($: EngineInterface, slash: SlashCommand): Promise<Submitted> {
  try {
    await $.command.run({ command: slash.command, args: slash.args })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'a sessão não aceitou o comando') }
  }
}

/** Uma mensagem para a sessão, como se você a tivesse digitado: um comando de barra ou um prompt. Nunca lança. */
async function submitOne($: EngineInterface, text: string): Promise<Submitted> {
  const slash = parseCommand(text)
  if (slash) return runCommand($, slash)
  try {
    const r = await $.prompt.submit({ text, asUser: true })
    if (typeof r?.drop === 'string') return { ok: false, error: reasonText(r.drop, 'um hook da sessão recusou a mensagem') }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: reasonText(err, 'a sessão não aceitou a mensagem') }
  }
}

/** Manda as mensagens à sessão, na ordem, e devolve o resultado de cada uma. Nunca lança. */
async function deliver($: EngineInterface, messages: readonly InboxMessage[]): Promise<AckResult[]> {
  const results: AckResult[] = []
  /** Uma chamada passou do prazo: a sessão está ocupada e as seguintes entram na fila atrás dela, sem esperar. */
  let queued = false
  for (const m of messages) {
    if (!m.text.trim()) {
      results.push({ id: m.id, ok: false, error: 'mensagem vazia' })
      continue
    }
    const submitted = submitOne($, m.text)
    if (queued) {
      void submitted
      results.push({ id: m.id, ok: true })
      continue
    }
    const out = await waitAtMost($, submitted, SUBMIT_WAIT_MS)
    if (!out) {
      queued = true
      results.push({ id: m.id, ok: true })
    } else results.push(out.ok ? { id: m.id, ok: true } : { id: m.id, ok: false, error: out.error })
  }
  return results
}

/** (Re)agenda as rodadas: 2 s com o Habblaud no ar, 30 s fora do ar. */
function schedule($: EngineInterface, ms: number): void {
  if (timer && timerMs === ms) return
  timer?.cancel()
  timerMs = ms
  timer = $.clock.every(ms, () => {
    void round($)
  })
}

/** Uma rodada: busca as mensagens desta sessão, manda cada uma e confirma. Nunca lança. */
async function round($: EngineInterface): Promise<void> {
  if (polling) return
  polling = true
  try {
    const e = await readEnv($)
    const surfaces = await $.session.surfaces()
    if (!surfaces.length && !e.desktop) return
    const session = await $.session.id()
    const list = await commandsToSend($)
    const sentKey = commandsKey
    const res = await postJson($, e.port, '/api/mod/inbox', inboxBody(session, e.accountId, list))
    const messages = res?.ok ? parseInbox(res.text) : undefined
    if (!messages || !res) {
      schedule($, OFFLINE_POLL_MS)
      return
    }
    schedule($, POLL_MS)
    if (list) commandsSent = sentKey
    commandsWanted = wantsCommands(res.text)
    if (!messages.length) return
    const results = await deliver($, messages)
    // Falhou a confirmação: o servidor dá as mensagens como falhas em 30 s ("a sessão não confirmou a entrega").
    await postJson($, e.port, '/api/mod/inbox/ack', ackBody(session, results))
  } catch {
    // silêncio: a próxima rodada tenta de novo
  } finally {
    polling = false
  }
}

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    try {
      schedule($, POLL_MS)
    } catch {
      // sem as rodadas, a sessão segue como sempre
    }
    return next(e)
  })
}
