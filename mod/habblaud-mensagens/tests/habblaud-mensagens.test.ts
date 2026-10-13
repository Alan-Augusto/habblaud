// Testes do plugin de mensagens, rodados pelo próprio Claude Code: `claude plugin test` dentro de
// mod/habblaud-mensagens (sem sessão, sem login, sem rede). Os stubs respondem no lugar do Claude Code e do
// Habblaud: env, relógio (mock.clock), $.session.id, $.session.surfaces, $.http.fetch (as duas rotas do
// servidor), o prompt.submit de baixo (a sessão: aceita, um hook recusa, a chamada lança ou fica presa) e o
// command.run de baixo (o comando roda, não existe ou fica na fila da sessão ocupada) e, nos testes da lista de
// comandos, o command.list de baixo.
import type { HttpResponse, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import {
  accountIdOf,
  ackBody,
  commandRows,
  configDirOf,
  inboxBody,
  MAX_COMMANDS,
  MAX_DESCRIPTION,
  MAX_REASON,
  normalizePath,
  parseCommand,
  parseInbox,
  portOf,
  reasonText,
  wantsCommands,
  type InboxMessage,
} from '../hooks/register'

const NOW = Date.parse('2026-10-09T12:00:00Z')
const PORT = '4850'
const INBOX_URL = `http://127.0.0.1:${PORT}/api/mod/inbox`
const ACK_URL = `${INBOX_URL}/ack`
const JSON_HEADERS = { 'content-type': 'application/json', accept: 'application/json' }

/** Resposta do Habblaud ao inbox: mensagens, 'offline' (conexão recusada), 'hang' (não responde) ou um HTTP cru. */
type Answer = InboxMessage[] | 'offline' | 'hang' | { status: number; text: string }
/** O que a sessão faz com um prompt: entra, um hook recusa, a chamada lança, ou fica presa (sessão ocupada). */
type Fate = 'ok' | 'drop' | 'throw' | 'hang'

interface World {
  env?: Record<string, string>
  surfaces?: ReadonlyArray<'terminal' | 'desktop'>
  /** Padrão: nenhuma mensagem. */
  inbox?: () => Answer
  /** Padrão: o ack responde 200. */
  ack?: () => 'ok' | 'offline' | 'hang'
  /** Padrão: 'ok'. */
  fate?: (text: string) => Fate
  /** O que a sessão faz com um comando de barra ('drop' não vale aqui). Padrão: 'ok'. */
  commandFate?: (command: string) => Exclude<Fate, 'drop'>
  /** Os comandos de barra da sessão ('throw' = a leitura falha). Sem isto, não há stub: a leitura é rejeitada. */
  commandList?: () => Array<{ name: string; description: string; source: 'builtin' | 'plugin' | 'user' | 'mcp'; plugin?: string }> | 'throw'
  /** O Habblaud pede a lista de comandos na resposta da caixa de entrada. Padrão: não. */
  needCommands?: () => boolean
}

interface Sent {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function response(status: number, text: string): HttpResponse {
  return { status, ok: status >= 200 && status < 300, headers: { 'content-type': 'application/json' }, text }
}

/** Uma fila de respostas: cada pergunta leva a próxima; acabou, nenhuma mensagem. */
function batches(...list: Answer[]): () => Answer {
  return () => list.shift() ?? []
}

/** Registra todos os stubs (antes da primeira chamada em $, como o kit exige) e devolve o que foi capturado. */
function world(on: On, w: World = {}) {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, w.env ?? { HOME: '/home/fulano', CLAUDE_CONFIG_DIR: '~/.claude-conta2', HABBLAUD_PORT: PORT })
  const sent: Sent[] = []
  const submits: Array<{ text: string; origin: unknown }> = []
  const commands: Array<{ command: string; args: string; origin: unknown }> = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.surfaces', () => ({ value: w.surfaces ?? ['terminal'] }))
  on('http.fetch', async ($, e) => {
    const body = e.init?.body
    sent.push({ url: e.url, method: e.init?.method, headers: e.init?.headers, body: body === undefined ? undefined : JSON.parse(body) })
    if (e.url.endsWith('/ack')) {
      const a = w.ack ? w.ack() : 'ok'
      if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
      if (a === 'hang') {
        await clock.sleep(60_000)
        return { deny: 'tarde demais' }
      }
      return { value: response(200, '{"ok":true}') }
    }
    const a = w.inbox ? w.inbox() : []
    if (a === 'offline') return { deny: 'connect ECONNREFUSED 127.0.0.1:4850' }
    if (a === 'hang') {
      await clock.sleep(60_000)
      return { deny: 'tarde demais' }
    }
    if (!Array.isArray(a)) return { value: response(a.status, a.text) }
    return { value: response(200, JSON.stringify(w.needCommands?.() ? { messages: a, needCommands: true } : { messages: a })) }
  })
  if (w.commandList) {
    const list = w.commandList
    on('command.list', () => {
      const value = list()
      if (value === 'throw') throw new Error('sem lista')
      return { value }
    })
  }
  on('prompt.submit', async ($, e) => {
    submits.push({ text: e.text, origin: e.origin })
    const fate = w.fate ? w.fate(e.text) : 'ok'
    if (fate === 'drop') return { drop: `recusada por um hook: ${e.text}` }
    if (fate === 'throw') throw new Error('a sessão\nfechou')
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: e.text }
  })
  on('command.run', async ($, e) => {
    commands.push({ command: e.command, args: e.args, origin: e.origin })
    const fate = w.commandFate ? w.commandFate(e.command) : 'ok'
    // O kit pula o hook que lança e, sem mais ninguém abaixo, rejeita a chamada: é como um nome desconhecido chega.
    if (fate === 'throw') throw new Error(`Unknown command: /${e.command}`)
    if (fate === 'hang') await clock.sleep(60_000)
    return { text: `rodou /${e.command}` }
  })
  return {
    clock,
    sent,
    submits,
    commands,
    inboxes: () => sent.filter((s) => s.url === INBOX_URL),
    acks: () => sent.filter((s) => s.url === ACK_URL),
    texts: () => submits.map((s) => s.text),
  }
}

const START = { cwd: '/work', surface: 'terminal', isInteractive: true } as const

describe('rodadas', () => {
  test('a cada 2 s pergunta ao Habblaud (marca a presença); sem mensagens, nada vai para a sessão e não há ack', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    expect(w.sent).toEqual([])
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: INBOX_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', account: '.claude-conta2' } }])
    await w.clock.advance(4_000)
    expect(w.inboxes().length).toBe(3)
    expect(w.acks()).toEqual([])
    expect(w.submits).toEqual([])
  })

  test('entrega na ordem, como se você tivesse digitado (texto intacto), e confirma tudo num POST só', async ($, on) => {
    const typed = '  e depois:\n- abre o PR\n\n(sem pressa)  '
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'roda os testes' }, { id: 'm2', text: typed }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['roda os testes', typed])
    expect(w.submits[0]?.origin).toEqual({ kind: 'plugin', name: 'habblaud-mensagens', asUser: true })
    expect(w.acks()).toEqual([{ url: ACK_URL, method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] } }])
    await w.clock.advance(2_000)
    expect(w.sent.map((s) => s.url)).toEqual([INBOX_URL, ACK_URL, INBOX_URL])
    expect(w.submits.length).toBe(2)
  })

  test('recusa de um hook e exceção viram falha com o motivo; sem texto, falha sem ir para a sessão', async ($, on) => {
    const raw = JSON.stringify({
      messages: [
        { id: 'a', text: 'pode ir' },
        { id: 'b', text: 'proibida' },
        { id: 'c', text: 'quebra' },
        { id: 'd', text: '  \n ' },
        { id: 'e', text: 42 },
        // sem id: não há como confirmar, fica de fora
        { text: 'órfã' },
      ],
    })
    const w = world(on, {
      inbox: batches({ status: 200, text: raw }),
      fate: (t) => (t === 'proibida' ? 'drop' : t === 'quebra' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['pode ir', 'proibida', 'quebra'])
    expect(w.acks()[0]?.body).toEqual({
      session: 'sess-1',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'recusada por um hook: proibida' },
        // O hook de baixo que lança é pulado e, sem nada embaixo dele, a chamada rejeita: o motivo é o do kit.
        { id: 'c', ok: false, error: expect.stringMatching(/\S/) },
        { id: 'd', ok: false, error: 'mensagem vazia' },
        { id: 'e', ok: false, error: 'mensagem vazia' },
      ],
    })
  })

  test('sessão ocupada: passou de 2 s, conta como entregue e as seguintes vão em seguida, na ordem; as rodadas seguem', async ($, on) => {
    const w = world(on, {
      inbox: batches([
        { id: 'm1', text: 'primeira' },
        { id: 'm2', text: 'segunda' },
        { id: 'm3', text: 'terceira' },
      ]),
      fate: (t) => (t === 'primeira' ? 'hang' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira'])
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['primeira', 'segunda', 'terceira'])
    expect(w.acks().map((a) => a.body)).toEqual([
      {
        session: 'sess-1',
        results: [
          { id: 'm1', ok: true },
          { id: 'm2', ok: true },
          { id: 'm3', ok: true },
        ],
      },
    ])
    const asked = w.inboxes().length
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBeGreaterThan(asked)
  })

  test('uma rodada por vez: com a sessão ocupada e o ack travado, a pergunta do meio é pulada', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'primeira' }]), fate: () => 'hang', ack: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    // A rodada vai de 2 s (pergunta) a 4 s (prazo do submit) e daí a 6 s (prazo do ack): a de 4 s não começa.
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBe(1)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(3_000)
    expect(w.inboxes().length).toBeGreaterThan(1)
    expect(w.texts()).toEqual(['primeira'])
  })

  test('ack que falha = silêncio: as rodadas seguem', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: 'oi' }]), ack: () => 'offline' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks().length).toBe(1)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    expect(w.texts()).toEqual(['oi'])
  })

  test('Habblaud fora do ar, 403 (mensagens desligadas) ou 404 (versão sem a rota): recua para 30 s até voltar', async ($, on) => {
    let answer: Answer = 'offline'
    const w = world(on, { inbox: () => answer })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(28_000)
    expect(w.inboxes().length).toBe(1)
    answer = { status: 403, text: '{"error":"mensagens pelo escritório desligadas"}' }
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(2)
    answer = { status: 404, text: '{"error":"rota desconhecida"}' }
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(3)
    answer = []
    await w.clock.advance(30_000)
    expect(w.inboxes().length).toBe(4)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(5)
    expect(w.acks()).toEqual([])
  })

  test('comando de barra vai por command.run (nunca por prompt.submit), na ordem, com os argumentos', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: '/compact' }, { id: 'm2', text: 'e agora segue' }, { id: 'm3', text: '/model  opus 4 ' }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.commands.map((c) => ({ command: c.command, args: c.args }))).toEqual([
      { command: 'compact', args: '' },
      { command: 'model', args: 'opus 4' },
    ])
    expect(w.commands[0]?.origin).toEqual({ kind: 'plugin', name: 'habblaud-mensagens' })
    expect(w.texts()).toEqual(['e agora segue'])
    expect(w.acks()[0]?.body).toEqual({ session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }, { id: 'm3', ok: true }] })
  })

  test('comando que a sessão não conhece: falha com o motivo, e as outras mensagens seguem', async ($, on) => {
    const w = world(on, {
      inbox: batches([{ id: 'm1', text: '/naoexiste agora' }, { id: 'm2', text: 'oi' }]),
      commandFate: (c) => (c === 'naoexiste' ? 'throw' : 'ok'),
    })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.texts()).toEqual(['oi'])
    expect(w.acks()[0]?.body).toEqual({
      session: 'sess-1',
      results: [{ id: 'm1', ok: false, error: 'no implementation for command.run' }, { id: 'm2', ok: true }],
    })
  })

  test('comando com a sessão ocupada: em 2 s conta como na fila e as seguintes vão atrás, sem esperar', async ($, on) => {
    const w = world(on, { inbox: batches([{ id: 'm1', text: '/compact' }, { id: 'm2', text: 'depois disso, segue' }]), commandFate: () => 'hang' })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.acks()).toEqual([])
    await w.clock.advance(2_000)
    expect(w.commands.map((c) => c.command)).toEqual(['compact'])
    expect(w.texts()).toEqual(['depois disso, segue'])
    expect(w.acks()[0]?.body).toEqual({ session: 'sess-1', results: [{ id: 'm1', ok: true }, { id: 'm2', ok: true }] })
  })

  test('Habblaud travado: desiste em 2 s e recua para 30 s', async ($, on) => {
    let hang = true
    const w = world(on, { inbox: () => (hang ? 'hang' : []) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    await w.clock.advance(31_000)
    expect(w.inboxes().length).toBe(1)
    hang = false
    await w.clock.advance(1_000)
    expect(w.inboxes().length).toBe(2)
  })

  test('sessão sem superfície (claude -p, SDK): nem pergunta ao Habblaud', async ($, on) => {
    const w = world(on, { surfaces: [] })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(10_000)
    expect(w.sent).toEqual([])
  })

  test('sessão do app desktop fora da tela (SDK sem superfície): pergunta mesmo assim', async ($, on) => {
    const w = world(on, { surfaces: [], env: { HOME: '/home/fulano', CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', HABBLAUD_PORT: PORT } })
    await $.session.start({ cwd: '/work', surface: null, isInteractive: false })
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
  })

  test('sem HOME nem CLAUDE_CONFIG_DIR: pergunta sem a conta, na porta padrão', async ($, on) => {
    const w = world(on, { env: {} })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.sent).toEqual([{ url: 'http://127.0.0.1:4747/api/mod/inbox', method: 'POST', headers: JSON_HEADERS, body: { session: 'sess-1' } }])
  })
})

describe('lista de comandos de barra', () => {
  const COMPACT = { name: 'compact', description: 'Compacta a conversa', source: 'builtin' } as const
  const RESUMO = { name: 'habblaud', description: 'Resumo do escritório', source: 'plugin', plugin: 'habblaud' } as const
  const withList = (w: ReturnType<typeof world>) => w.inboxes().filter((s) => (s.body as { commands?: unknown }).commands !== undefined)
  const listOf = (s: Sent) => (s.body as { commands: unknown }).commands

  test('vai na primeira pergunta e só volta a ir quando muda (relida a cada minuto)', async ($, on) => {
    let list: Array<typeof COMPACT | typeof RESUMO> = [COMPACT]
    const w = world(on, { commandList: () => list })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(w.inboxes().length).toBe(1)
    expect(listOf(w.inboxes()[0]!)).toEqual([COMPACT])
    list = [COMPACT, RESUMO]
    await w.clock.advance(20_000)
    expect(withList(w).length).toBe(1)
    await w.clock.advance(60_000)
    expect(withList(w).length).toBe(2)
    // Só nome, descrição e origem: o plugin de cada comando não vai.
    expect(listOf(withList(w)[1]!)).toEqual([COMPACT, { name: 'habblaud', description: 'Resumo do escritório', source: 'plugin' }])
    await w.clock.advance(120_000)
    expect(withList(w).length).toBe(2)
  })

  test('o Habblaud pede a lista (needCommands): vai de novo na pergunta seguinte, mesmo sem ter mudado', async ($, on) => {
    let need = false
    const w = world(on, { commandList: () => [COMPACT], needCommands: () => need })
    await $.session.start(START)
    await w.clock.advance(4_000)
    expect(withList(w).length).toBe(1)
    need = true
    await w.clock.advance(2_000)
    need = false
    await w.clock.advance(4_000)
    expect(withList(w).length).toBe(2)
    expect(listOf(withList(w)[1]!)).toEqual([COMPACT])
  })

  test('a leitura da lista falha: a pergunta segue sem ela e as mensagens são entregues', async ($, on) => {
    const w = world(on, { commandList: () => 'throw', inbox: batches([{ id: 'm1', text: 'oi' }]) })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(withList(w).length).toBe(0)
    expect(w.texts()).toEqual(['oi'])
    expect(w.acks().length).toBe(1)
  })

  test('o Habblaud fora do ar na hora da lista: ela vai quando ele voltar', async ($, on) => {
    let up = false
    const w = world(on, { commandList: () => [COMPACT], inbox: () => (up ? [] : 'offline') })
    await $.session.start(START)
    await w.clock.advance(2_000)
    expect(withList(w).length).toBe(1)
    up = true
    await w.clock.advance(30_000)
    expect(withList(w).length).toBe(2)
    // Recebida: as perguntas seguintes vão sem ela.
    await w.clock.advance(4_000)
    expect(withList(w).length).toBe(2)
    expect(w.inboxes().length).toBe(4)
  })
})

describe('funções puras', () => {
  test('lista de comandos: só nome, descrição cortada e origem; item sem nome fica de fora; a lista tem limite', () => {
    expect(commandRows(undefined)).toEqual([])
    expect(commandRows([{ name: 'a', description: 'x'.repeat(MAX_DESCRIPTION + 50), source: 'mcp', plugin: 'p' }, { name: '' }, null, 'b', { name: 'c' }])).toEqual([
      { name: 'a', description: 'x'.repeat(MAX_DESCRIPTION), source: 'mcp' },
      { name: 'c', description: '', source: 'builtin' },
    ])
    expect(commandRows(Array.from({ length: MAX_COMMANDS + 5 }, (_, i) => ({ name: `c${i}` }))).length).toBe(MAX_COMMANDS)
    expect(wantsCommands('{"messages":[],"needCommands":true}')).toBe(true)
    expect(wantsCommands('{"messages":[]}')).toBe(false)
    expect(wantsCommands('<html>')).toBe(false)
  })

  test('inbox: formato estranho = fora do ar; item sem id fica de fora; sem texto vira texto vazio', () => {
    expect(parseInbox('<html>')).toBeUndefined()
    expect(parseInbox('[]')).toBeUndefined()
    expect(parseInbox('{"messages":{}}')).toBeUndefined()
    expect(parseInbox('{"messages":[]}')).toEqual([])
    expect(parseInbox(JSON.stringify({ messages: [{ id: 'a', text: ' x\n' }, { id: '', text: 'y' }, { text: 'z' }, null, { id: 'b' }] }))).toEqual([
      { id: 'a', text: ' x\n' },
      { id: 'b', text: '' },
    ])
  })

  test('corpos das duas rotas', () => {
    expect(JSON.parse(inboxBody('s', '.claude'))).toEqual({ session: 's', account: '.claude' })
    expect(JSON.parse(inboxBody('s', undefined))).toEqual({ session: 's' })
    const rows = [{ name: 'compact', description: 'Compacta', source: 'builtin' }]
    expect(JSON.parse(inboxBody('s', '.claude', rows))).toEqual({ session: 's', account: '.claude', commands: rows })
    expect(JSON.parse(inboxBody('s', undefined, []))).toEqual({ session: 's', commands: [] })
    expect(JSON.parse(ackBody('s', [{ id: 'a', ok: true }, { id: 'b', ok: false, error: 'não' }]))).toEqual({
      session: 's',
      results: [
        { id: 'a', ok: true },
        { id: 'b', ok: false, error: 'não' },
      ],
    })
  })

  test('motivo da falha: uma linha, tamanho limitado, e o padrão quando não há texto', () => {
    expect(reasonText('um\nhook\t recusou ', 'padrão')).toBe('um hook recusou')
    expect(reasonText(new Error('boom'), 'padrão')).toBe('boom')
    expect(reasonText({ message: 'de outro mundo' }, 'padrão')).toBe('de outro mundo')
    expect(reasonText('   ', 'padrão')).toBe('padrão')
    expect(reasonText(undefined, 'padrão')).toBe('padrão')
    const long = reasonText('x'.repeat(2_000), 'padrão')
    expect(long.length).toBe(MAX_REASON)
    expect(long.endsWith('…')).toBe(true)
  })

  test('comando de barra: a barra no começo, o nome até o primeiro espaço e o resto como argumentos', () => {
    expect(parseCommand('/compact')).toEqual({ command: 'compact', args: '' })
    expect(parseCommand('/compact  guarda só o plano \n')).toEqual({ command: 'compact', args: 'guarda só o plano' })
    expect(parseCommand('/habblaud:status')).toEqual({ command: 'habblaud:status', args: '' })
    expect(parseCommand('/review\n123')).toEqual({ command: 'review', args: '123' })
    // texto comum, mesmo com barra no meio ou espaço antes dela, continua sendo um prompt
    expect(parseCommand('roda o /compact depois')).toBeUndefined()
    expect(parseCommand(' /compact')).toBeUndefined()
    expect(parseCommand('/')).toBeUndefined()
    expect(parseCommand('/ compact')).toBeUndefined()
    expect(parseCommand('')).toBeUndefined()
  })

  test('conta e porta como o mod habblaud calcula (também no Windows)', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(configDirOf(' ~/.claude-conta2 , /x', '/home/f')).toBe('/home/f/.claude-conta2')
    expect(configDirOf(undefined, '/home/f/')).toBe('/home/f/.claude')
    expect(configDirOf('', undefined)).toBeUndefined()
    expect(configDirOf('C:\\Users\\f\\.claude-conta2\\', undefined)).toBe('C:/Users/f/.claude-conta2')
    expect(accountIdOf('C:/Users/f/.claude-conta2')).toBe('.claude-conta2')
    expect(accountIdOf('/')).toBeUndefined()
    expect(portOf('4850')).toBe(4850)
    expect(portOf('0')).toBe(4747)
    expect(portOf('abc')).toBe(4747)
    expect(portOf(undefined)).toBe(4747)
  })
})
