import { describe, expect, it } from 'vitest';
import { FileFetcher, HOST_PRESENCE_MS, LIST_FRESH_MS } from './fetcher';

const ok = (p: string) => ({ path: p, size: 3 });

describe('FileFetcher', () => {
  it('Node: lê direto do disco, com a checagem', async () => {
    const f = new FileFetcher({ direct: true, check: ok, read: () => Buffer.from('abc') });
    expect(await f.get('/a/x.png')).toEqual({ data: Buffer.from('abc') });
    const denied = new FileFetcher({ direct: true, check: () => ({ error: 'arquivo protegido' }) });
    expect(await denied.get('/a/.ssh/x.png')).toEqual({ error: 'arquivo protegido', status: 403 });
  });

  it('Docker: pasta montada lê aqui; o resto vai pelo auxiliar (poll → ack) e fica no cache', async () => {
    let now = 1_000;
    const reads: string[] = [];
    const f = new FileFetcher({
      now: () => now,
      check: ok,
      read: (p) => (reads.push(p), Buffer.from('m')),
      mapHostPath: (p) => (p.startsWith('/Users/a/.claude/') ? `/claude${p.slice('/Users/a/.claude'.length)}` : undefined),
    });
    expect(await f.get('/Users/a/.claude/projects/x/t.jpg')).toEqual({ data: Buffer.from('m') });
    expect(reads).toEqual(['/claude/projects/x/t.jpg']);
    expect(await f.get('/tmp/x.png')).toMatchObject({ status: 503 });
    f.poll();
    const pending = f.get('/tmp/x.png');
    const [req] = f.poll();
    expect(req.path).toBe('/tmp/x.png');
    f.ack({ results: [{ id: req.id, ok: true, data: Buffer.from('png').toString('base64') }] });
    expect(await pending).toEqual({ data: Buffer.from('png') });
    now += HOST_PRESENCE_MS + 1;
    expect(await f.get('/tmp/x.png')).toEqual({ data: Buffer.from('png') });
  });

  it('auxiliar recusa: o erro dele chega ao navegador', async () => {
    const f = new FileFetcher({ check: ok });
    f.poll();
    const pending = f.get('/tmp/y.png');
    const [req] = f.poll();
    f.ack({ results: [{ id: req.id, ok: false, error: 'arquivo protegido' }] });
    expect(await pending).toEqual({ error: 'arquivo protegido', status: 404 });
  });

  it('rodada com espera (?wait=1): o auxiliar fica parado até a página pedir um arquivo, e conta como presente', async () => {
    const f = new FileFetcher({ mapHostPath: () => undefined });
    expect(f.hostAvailable()).toBe(false);
    const round = f.pollWait(60_000);
    expect(f.hostAvailable()).toBe(true);
    const got = f.get('/proj/a.png');
    const list = await round;
    expect(list).toEqual([{ id: expect.any(String), path: '/proj/a.png' }]);
    f.ack({ results: [{ id: list[0].id, ok: true, data: Buffer.from('png').toString('base64') }] });
    await expect(got).resolves.toEqual({ data: Buffer.from('png') });
  });

  it('lista de arquivos de um projeto, Node: o servidor lista e a lista vale 30 s', async () => {
    let now = 1_000;
    let calls = 0;
    const f = new FileFetcher({ direct: true, now: () => now, listFiles: () => (calls++, { files: ['a.ts', 'b.ts'], truncated: false }) });
    expect(await f.list('/p')).toEqual({ files: ['a.ts', 'b.ts'], truncated: false });
    await f.list('/p');
    expect(calls).toBe(1);
    now += LIST_FRESH_MS;
    await f.list('/p');
    expect(calls).toBe(2);
    const bad = new FileFetcher({ direct: true, listFiles: () => ({ error: 'pasta do projeto não encontrada' }) });
    expect(await bad.list('/x')).toEqual({ error: 'pasta do projeto não encontrada', status: 404 });
  });

  it('lista de arquivos, Docker: vai pelo auxiliar na mesma rodada (list: true); a resposta é conferida de novo', async () => {
    const f = new FileFetcher({ mapHostPath: () => undefined });
    expect(await f.list('/p')).toMatchObject({ status: 503 });
    f.poll();
    const first = f.list('/p');
    // Pedida de novo no meio: é a mesma listagem, um pedido só ao auxiliar.
    const second = f.list('/p');
    const reqs = f.poll();
    expect(reqs).toEqual([{ id: expect.any(String), path: '/p', list: true }]);
    f.ack({ results: [{ id: reqs[0].id, ok: true, files: ['src/a.ts', '.env', '/etc/passwd', 7, '', 'README.md'], truncated: true }] });
    expect(await first).toEqual({ files: ['src/a.ts', 'README.md'], truncated: true });
    expect(await second).toEqual({ files: ['src/a.ts', 'README.md'], truncated: true });
    expect(f.poll()).toEqual([]);

    const other = f.list('/q');
    const [req] = f.poll();
    f.ack({ results: [{ id: req.id, ok: false, error: 'fora das pastas de projeto conhecidas' }] });
    expect(await other).toEqual({ error: 'fora das pastas de projeto conhecidas', status: 404 });
  });

  it('anexos de uma mensagem, Docker: vão ao auxiliar em base64 (write: true) e voltam os caminhos, um por arquivo', async () => {
    const files = [
      { name: 'tela.png', type: 'image/png', data: Buffer.from('png') },
      { name: 'notas.txt', type: 'text/plain', data: Buffer.from('oi') },
    ];
    const f = new FileFetcher({ mapHostPath: () => undefined });
    expect(await f.write('m-1', files)).toEqual({ error: expect.stringMatching(/codex:bridge/) });
    f.poll();
    const pending = f.write('m-1', files);
    const [req] = f.poll();
    expect(req).toEqual({
      id: expect.stringMatching(/^m-1:/),
      path: '',
      write: true,
      files: [
        { name: 'tela.png', type: 'image/png', data: Buffer.from('png').toString('base64') },
        { name: 'notas.txt', type: 'text/plain', data: Buffer.from('oi').toString('base64') },
      ],
    });
    f.ack({ results: [{ id: req.id, ok: true, paths: ['/home/u/.habblaud/attachments/x/tela.png', '/home/u/.habblaud/attachments/x/notas.txt'] }] });
    expect(await pending).toEqual(['/home/u/.habblaud/attachments/x/tela.png', '/home/u/.habblaud/attachments/x/notas.txt']);

    // Caminhos a menos, relativos ou recusa: erro, nunca uma lista pela metade.
    for (const result of [{ ok: true, paths: ['/a/tela.png'] }, { ok: true, paths: ['tela.png', 'notas.txt'] }, { ok: false, error: 'anexo ilegível' }]) {
      const again = f.write('m-2', files);
      const [r] = f.poll();
      f.ack({ results: [{ id: r.id, ...result }] });
      expect(await again).toHaveProperty('error');
    }
  });
});
