// Ditado: botão de microfone que grava no navegador (MediaRecorder), manda o áudio ao Habblaud (POST /api/dictation)
// e devolve o texto transcrito pelo Whisper local do Mac, com o idioma detectado sozinho (português ou inglês; ver
// server/dictation/whisper.ts). O microfone só existe em página segura (HTTPS ou localhost): fora disso o botão some.
import { h, setText } from './dom';
import { ICONS } from './icons';

export const MAX_RECORD_MS = 180_000;
const POLL_MS = 600;
const WAIT_MS = 150_000;
/** Formatos em ordem de preferência: o Safari do iPhone grava mp4 (AAC); Chrome e Firefox, webm/ogg (Opus). */
const MIME_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export const LANG_NAMES: Readonly<Record<string, string>> = { pt: 'português', en: 'inglês', es: 'espanhol' };

export interface DictationText {
  text: string;
  lang?: string;
}

type State = 'idle' | 'recording' | 'working';

interface DictationReply {
  id: string;
  status: 'queued' | 'sent' | 'done' | 'failed';
  text?: string;
  lang?: string;
  error?: string;
}

/** Junta o texto ditado ao que já está no campo, na posição do cursor, com espaço/linha certos. */
export function insertDictation(value: string, start: number, end: number, text: string): { value: string; caret: number } {
  const t = text.trim();
  if (!t) return { value, caret: end };
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = after && !/^\s/.test(after) ? ' ' : '';
  const next = `${before}${lead}${t}${trail}${after}`;
  return { value: next, caret: before.length + lead.length + t.length };
}

export function pickMimeType(isSupported: (t: string) => boolean): string | undefined {
  return MIME_TYPES.find((t) => {
    try {
      return isSupported(t);
    } catch {
      return false;
    }
  });
}

export function canRecord(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error('não deu para ler a gravação'));
    r.readAsDataURL(blob);
  });
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', cache: 'no-store', ...init });
  } catch {
    throw new Error('o Habblaud não respondeu');
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `erro ${res.status}`);
  return body;
}

export class DictationButton {
  readonly el: HTMLButtonElement;
  private readonly label: HTMLElement;
  private state: State = 'idle';
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = 0;
  private cancelled = false;

  constructor(
    private readonly onText: (t: DictationText) => void,
    private readonly say: (text: string, error?: boolean) => void,
  ) {
    this.label = h('span', { class: 'ui-dictate__label', text: 'Ditar' });
    this.el = h('button', { class: 'ui-btn ui-dictate', type: 'button', attrs: { 'aria-pressed': 'false', title: 'Ditar o pedido (português ou inglês, o idioma é detectado sozinho)' }, on: { click: () => void this.toggle() } });
    const icon = h('span', { class: 'ui-dictate__icon', attrs: { 'aria-hidden': 'true' } });
    icon.innerHTML = ICONS.mic;
    this.el.append(icon, this.label);
  }

  get busy(): boolean {
    return this.state !== 'idle';
  }

  /** Para a gravação sem transcrever (painel fechado). */
  cancel(): void {
    if (this.state !== 'recording') return;
    this.cancelled = true;
    this.stopRecorder();
  }

  private async toggle(): Promise<void> {
    if (this.state === 'recording') return this.stopRecorder();
    if (this.state === 'working') return;
    await this.start();
  }

  private async start(): Promise<void> {
    if (!canRecord()) return this.say('Este navegador não deixa gravar áudio aqui (precisa de HTTPS).', true);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (err) {
      const denied = (err as DOMException)?.name === 'NotAllowedError';
      return this.say(denied ? 'Sem permissão para o microfone: libere nas configurações do navegador e tente de novo.' : 'Não deu para abrir o microfone.', true);
    }
    const mimeType = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    try {
      this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    } catch {
      this.release();
      return this.say('Este navegador não grava áudio.', true);
    }
    this.chunks = [];
    this.cancelled = false;
    this.recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size) this.chunks.push(e.data);
    });
    this.recorder.addEventListener('stop', () => void this.finish(), { once: true });
    this.recorder.start(1_000);
    this.startedAt = Date.now();
    this.set('recording');
    this.say('Gravando… fale em português ou inglês e toque em Parar.');
    this.timer = setInterval(() => {
      const ms = Date.now() - this.startedAt;
      const s = Math.floor(ms / 1000);
      setText(this.label, `Parar ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
      if (ms >= MAX_RECORD_MS) this.stopRecorder();
    }, 250);
  }

  private stopRecorder(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      if (this.recorder?.state !== 'inactive') this.recorder?.stop();
    } catch {
      // já parado
    }
  }

  private release(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  private async finish(): Promise<void> {
    const type = this.recorder?.mimeType || this.chunks[0]?.type || 'audio/mp4';
    const blob = new Blob(this.chunks, { type });
    this.chunks = [];
    this.recorder = null;
    this.release();
    if (this.cancelled) {
      this.cancelled = false;
      return this.set('idle');
    }
    if (blob.size < 512) {
      this.set('idle');
      return this.say('Não ouvi nada: tente de novo, mais perto do microfone.', true);
    }
    this.set('working');
    this.say('Transcrevendo no Mac…');
    try {
      let r = await api<DictationReply>('/api/dictation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: type.split(';')[0], data: await blobToBase64(blob) }),
      });
      const end = Date.now() + WAIT_MS;
      while ((r.status === 'queued' || r.status === 'sent') && Date.now() < end) {
        await new Promise((ok) => setTimeout(ok, POLL_MS));
        r = await api<DictationReply>(`/api/dictation/${encodeURIComponent(r.id)}`);
      }
      if (r.status !== 'done') throw new Error(r.error || 'o Mac não respondeu a tempo');
      if (!r.text?.trim()) this.say('Não entendi nada na gravação: tente de novo.', true);
      else {
        this.onText({ text: r.text, lang: r.lang });
        this.say(r.lang && LANG_NAMES[r.lang] ? `Ditado em ${LANG_NAMES[r.lang]}: confira o texto.` : 'Ditado pronto: confira o texto.');
      }
    } catch (err) {
      this.say(`Ditado falhou: ${(err as Error).message}`, true);
    } finally {
      this.set('idle');
    }
  }

  private set(state: State): void {
    this.state = state;
    this.el.classList.toggle('is-recording', state === 'recording');
    this.el.classList.toggle('is-working', state === 'working');
    this.el.setAttribute('aria-pressed', String(state === 'recording'));
    this.el.disabled = state === 'working';
    const icon = this.el.querySelector('.ui-dictate__icon');
    if (icon) icon.innerHTML = state === 'recording' ? ICONS.stopRec : ICONS.mic;
    setText(this.label, state === 'recording' ? 'Parar 0:00' : state === 'working' ? 'Transcrevendo…' : 'Ditar');
  }
}
