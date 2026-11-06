/**
 * The phone itself, through its renter door (D-144, D-156, D-171, D-173, D-175): a WebSocket to the phone host's
 * viewer opened with the broker's one-use control grant. Everything here is one of the door's own commands, run by
 * the rental gateway's executor under the renter's lease and audited there: an upload that installs an APK, a file
 * fetched from the phone's shared folders, the phone's log, and the phone's shell. Nothing of it passes the broker.
 *
 * Frames (`core/src/controlhub/cloud/renter_files.py`): commands are JSON text `{"cmd", "id", …}`, answered by
 * `{"type": "cmd", "id", "ok", …}`; a download's bytes come as binary `0xF1` + id (4 bytes, little endian) + data,
 * the shell's output as `0xF2` + id + data. Video frames (the lighter tier) arrive too and are ignored.
 */
import { createHash, randomBytes } from 'node:crypto';

export const DOWNLOAD_FRAME = 0xf1;
export const SHELL_FRAME = 0xf2;
/** Upload chunks, as the website sends them. */
export const CHUNK = 256 * 1024;
/** Unsent bytes allowed to queue before the upload waits. */
const MAX_BUFFERED = 8 * 1024 * 1024;
/** The shell closes after 15 minutes without input; an empty keystroke this often keeps a running test's open. */
export const KEEPALIVE_S = 240;
/** The phone's shell lasts at most 2 hours (the terminal's rules). */
export const MAX_RUN_S = 2 * 3600;

export interface Reply {
  type: 'cmd';
  id: number;
  ok: boolean;
  error?: string;
  ready?: boolean;
  done?: boolean;
  reason?: string;
  lines?: string[];
  dropped?: number;
  [k: string]: unknown;
}

export class DoorError extends Error {
  /** The phone host's close code when it refused the connection (4404 not connected, 4503 not reachable, …). */
  readonly code: number | null;

  constructor(message: string, code: number | null = null) {
    super(message);
    this.code = code;
  }
}

/** Close codes worth another try with a new grant: the phone's gateway is still starting. */
export const RETRY_CODES = new Set([4404, 4503]);

export interface RunResult {
  /** The command's exit code, or null when it did not finish. */
  exitCode: number | null;
  timedOut: boolean;
  /** Why the shell ended without an exit code. */
  reason?: string;
}

type Socket = WebSocket;

const CLOSE_REASONS: Record<number, string> = {
  4401: 'the phone host refused the connection (grant expired or already used)',
  4404: 'the phone is not connected',
  4409: 'someone else has control of this phone (close it in the browser or the app)',
  4429: 'too many connections to this phone host: try again in a minute',
  4503: 'the phone is not reachable right now',
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class Door {
  readonly #ws: Socket;
  readonly #replies = new Map<number, (r: Reply) => void>();
  readonly #downloads = new Map<number, Buffer[]>();
  readonly #shells = new Map<number, (data: Buffer) => void>();
  #id = 0;
  #closed: string | null = null;

  private constructor(ws: Socket) {
    this.#ws = ws;
  }

  /** Opens the door with a control grant; resolves once the phone's session says this connection has control. */
  static open(url: string, grant: string, timeoutS = 30): Promise<Door> {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    const door = new Door(ws);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new DoorError(`the phone did not answer within ${timeoutS} s`));
        ws.close();
      }, timeoutS * 1000);
      let started = false;
      ws.addEventListener('open', () => ws.send(JSON.stringify({ grant })));
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') {
          door.#binary(Buffer.from(ev.data as ArrayBuffer));
          return;
        }
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(ev.data) as Record<string, unknown>;
        } catch {
          return;
        }
        if (!started && typeof msg.control === 'boolean') {
          started = true;
          clearTimeout(timer);
          if (msg.control) resolve(door);
          else {
            reject(new DoorError('the phone was opened without control'));
            ws.close();
          }
          return;
        }
        if (msg.type === 'cmd' && typeof msg.id === 'number') door.#replies.get(msg.id)?.(msg as unknown as Reply);
        if (msg.type === 'lease_revoked') door.#end('control of the phone was taken over (the browser or the app)');
      });
      ws.addEventListener('close', (ev) => {
        const why = CLOSE_REASONS[ev.code] ?? (ev.reason || `the connection closed (${ev.code})`);
        door.#end(why);
        if (!started) {
          clearTimeout(timer);
          reject(new DoorError(why, ev.code));
        }
      });
      ws.addEventListener('error', () => undefined); // the close event says why
    });
  }

  #end(why: string): void {
    if (this.#closed) return;
    this.#closed = why;
    for (const done of this.#replies.values()) done({ type: 'cmd', id: 0, ok: false, error: why });
    this.#replies.clear();
  }

  #binary(data: Buffer): void {
    if (data.length < 5) return;
    const id = data.readUInt32LE(1);
    if (data[0] === DOWNLOAD_FRAME) this.#downloads.get(id)?.push(data.subarray(5));
    else if (data[0] === SHELL_FRAME) this.#shells.get(id)?.(data.subarray(5));
    // anything else is the picture: not needed here
  }

  #send(body: Record<string, unknown>, id: number): void {
    if (this.#closed) return;
    this.#ws.send(JSON.stringify({ ...body, id }));
  }

  /** Sends a command; `each` sees every reply; resolves with the first failed reply or the one `until` accepts. */
  command(body: Record<string, unknown>, until: (r: Reply) => boolean = () => true, each?: (r: Reply) => void): Promise<Reply> {
    if (this.#closed) return Promise.resolve({ type: 'cmd', id: 0, ok: false, error: this.#closed });
    this.#id += 1;
    const id = this.#id;
    return new Promise((resolve) => {
      this.#replies.set(id, (r) => {
        each?.(r);
        if (!r.ok || until(r)) {
          this.#replies.delete(id);
          resolve(r);
        }
      });
      this.#send(body, id);
    });
  }

  /** Installs an APK (up to 500 MB): sent in chunks to the phone's host, checked by SHA-256, installed there. */
  async install(name: string, bytes: Uint8Array<ArrayBuffer>): Promise<string[]> {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let id = 0;
    const ready = await this.command({ cmd: 'upload', name, size: bytes.byteLength, sha256, to: 'install' }, (r) => r.ready === true, (r) => (id = r.id));
    if (!ready.ok) throw new DoorError(`${name}: ${ready.error ?? 'not accepted'}`);
    const done = new Promise<Reply>((resolve) => {
      this.#replies.set(id, (r) => {
        if (!r.ok || r.done) {
          this.#replies.delete(id);
          resolve(r);
        }
      });
    });
    for (let at = 0; at < bytes.byteLength && !this.#closed; at += CHUNK) {
      while ((this.#ws.bufferedAmount ?? 0) > MAX_BUFFERED && !this.#closed) await sleep(20);
      this.#ws.send(bytes.subarray(at, at + CHUNK));
    }
    const end = await done;
    if (!end.ok) throw new DoorError(`${name}: ${end.error ?? 'not installed'}`);
    return Array.isArray(end.packages) ? (end.packages as string[]) : [];
  }

  /** A file from the phone's shared folders (`/sdcard/Download/…`, Pictures, Screenshots, Camera, Movies, Documents). */
  async pull(path: string): Promise<Buffer> {
    let id = 0;
    const end = await this.command(
      { cmd: 'download', path },
      (r) => r.done === true,
      (r) => {
        if (r.ok && !r.done && typeof r.name === 'string') {
          id = r.id;
          this.#downloads.set(id, []);
        }
      },
    );
    const parts = this.#downloads.get(id) ?? [];
    this.#downloads.delete(id);
    if (!end.ok) throw new DoorError(`${path}: ${end.error ?? 'could not be fetched'}`);
    return Buffer.concat(parts);
  }

  /** Follows the phone's log; call the returned function to stop. Lines arrive in batches. */
  async logs(onLines: (lines: string[]) => void): Promise<() => Promise<void>> {
    let id = 0;
    let opened!: (r: Reply) => void;
    const first = new Promise<Reply>((r) => (opened = r));
    void this.command(
      { cmd: 'logs', on: true },
      (r) => r.done === true,
      (r) => {
        if (r.ready) {
          id = r.id;
          opened(r);
        }
        if (r.lines?.length) onLines(r.lines);
      },
    ).then((r) => opened(r));
    const r = await first;
    if (!r.ok) throw new DoorError(`the log: ${r.error ?? 'cannot be followed'}`);
    return async () => {
      if (id) await this.command({ cmd: 'logs', on: false });
    };
  }

  /**
   * Runs a command in the phone's shell (the Shell tab's shell, D-173) and returns its exit code. The command runs
   * as `(command) </dev/null`, followed by a marker line with its exit code that the output never shows. An empty
   * keystroke every few minutes keeps the shell open while the command runs; after `timeoutS` it gets Ctrl-C.
   */
  async run(command: string, o: { timeoutS?: number; output?: (text: string) => void; keepaliveS?: number } = {}): Promise<RunResult> {
    const timeoutS = Math.min(o.timeoutS ?? 1800, MAX_RUN_S);
    const nonce = randomBytes(6).toString('hex');
    const marker = new RegExp(`BFEND${nonce}:(\\d+)`);
    const output = o.output ?? ((t: string) => void process.stdout.write(t));
    let id = 0;
    let pending = '';
    /** An empty line held back: the one just before the marker is the marker's own newline, not the command's. */
    let blank = false;
    let finish!: (r: RunResult) => void;
    const result = new Promise<RunResult>((r) => (finish = r));

    const onData = (data: Buffer) => {
      pending += data.toString('utf8').replace(/\r/g, '');
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const m = marker.exec(line);
        if (m) {
          const before = line.slice(0, m.index);
          if (before.trim()) output(before + '\n');
          finish({ exitCode: Number(m[1]), timedOut: false });
          return;
        }
        if (line.includes(`BFEND ${nonce}`) || line.includes('stty -echo')) continue; // the typed lines, echoed
        if (blank) output('\n');
        blank = line === '';
        if (!blank) output(line + '\n');
      }
    };

    let opened!: (r: Reply) => void;
    const first = new Promise<Reply>((r) => (opened = r));
    void this.command(
      { cmd: 'shell', on: true, cols: 200, rows: 50 },
      (r) => r.done === true,
      (r) => {
        if (r.ready === true) {
          id = r.id;
          this.#shells.set(id, onData);
          opened(r);
        }
      },
    ).then((r) => {
      opened(r);
      if (pending.trim()) onData(Buffer.from('\n'));
      finish({ exitCode: null, timedOut: false, reason: r.ok ? (r.reason ?? 'the shell ended') : (r.error ?? 'the shell ended') });
    });
    const open = await first;
    if (!open.ok || !id) throw new DoorError(`the phone's shell: ${open.error ?? 'could not be opened'}`);

    const type = (data: string) => this.#send({ cmd: 'shell_input', data }, id);
    type("stty -echo 2>/dev/null; PS1=''; PS2=''\n");
    await sleep(300);
    type(`(${command}) </dev/null; printf '\\n%s%s:%s\\n' BFEND ${nonce} $?\n`);

    const keepalive = setInterval(() => type(''), (o.keepaliveS ?? KEEPALIVE_S) * 1000);
    const timer = setTimeout(() => {
      type('\u0003');
      finish({ exitCode: null, timedOut: true, reason: `not finished within ${timeoutS} s` });
    }, timeoutS * 1000);
    try {
      return await result;
    } finally {
      clearInterval(keepalive);
      clearTimeout(timer);
      this.#shells.delete(id);
      await this.command({ cmd: 'shell', on: false });
    }
  }

  close(): void {
    this.#end('closed');
    this.#ws.close();
  }
}
