import { describe, expect, it } from 'vitest';
import { spawnFolders } from './spawn';

describe('spawnFolders', () => {
  it('pastas das salas, a mais recente primeiro, sem as do demo nem caminhos relativos', () => {
    const rooms = [
      { id: 'r1', path: '/Users/a/antigo' },
      { id: 'r2', path: '/Users/a/novo' },
      { id: 'demo:x', path: '/demo/x' },
      { id: 'r3', path: 'relativo' },
      { id: 'r4', path: 'C:\\code\\win' },
    ];
    const agents = [
      { roomId: 'r1', lastEventAt: 10 },
      { roomId: 'r2', lastEventAt: 50 },
      { roomId: 'r4', lastEventAt: 20 },
    ];
    expect(spawnFolders({ rooms, agents } as never)).toEqual(['/Users/a/novo', 'C:\\code\\win', '/Users/a/antigo']);
    expect(spawnFolders(null)).toEqual([]);
  });
});
