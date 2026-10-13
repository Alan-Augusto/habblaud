import { describe, expect, it } from 'vitest';
import { panelCommandReason, slashCommandOf } from './messages';

describe('comandos de barra', () => {
  it('lê o comando como o plugin habblaud-mensagens: barra no começo, nome até o primeiro espaço, resto como argumentos', () => {
    expect(slashCommandOf('/compact')).toEqual({ command: 'compact', args: '' });
    expect(slashCommandOf('/model  opus 4 \n')).toEqual({ command: 'model', args: 'opus 4' });
    expect(slashCommandOf('/habblaud:status')).toEqual({ command: 'habblaud:status', args: '' });
    expect(slashCommandOf('roda o /compact depois')).toBeUndefined();
    expect(slashCommandOf(' /compact')).toBeUndefined();
    expect(slashCommandOf('/ compact')).toBeUndefined();
    expect(slashCommandOf('/')).toBeUndefined();
  });

  it('comando de painel tem motivo; texto comum, comando de texto e comando com argumento não', () => {
    expect(panelCommandReason('/usage')).toMatch(/\/usage abre um painel/);
    expect(panelCommandReason('/CONFIG')).toMatch(/\/config abre um painel/);
    expect(panelCommandReason('/help qualquer coisa')).toMatch(/\/help abre um painel/);
    expect(panelCommandReason('/model')).toMatch(/\/model sem argumento/);
    expect(panelCommandReason('/model opus')).toBeUndefined();
    expect(panelCommandReason('/compact')).toBeUndefined();
    expect(panelCommandReason('/meu-comando')).toBeUndefined();
    expect(panelCommandReason('abre o /usage')).toBeUndefined();
  });
});
