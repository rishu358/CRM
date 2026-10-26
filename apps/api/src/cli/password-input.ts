/**
 * Taking a password at a terminal, or from a pipe, without it ever being echoed, logged or placed in
 * the process's arguments or environment (ADR-0046).
 */

/** What a chunk of typed input did to the password being entered. */
export interface KeyResult {
  readonly value: string;
  readonly done: boolean;
  readonly aborted: boolean;
}

const ENTER = new Set(['\r', '\n']);
const CTRL_C = '\u0003';
const CTRL_D = '\u0004';
const BACKSPACE = new Set(['\u007f', '\b']);

/**
 * Apply typed (or pasted) characters to the password so far. Pure, so the editing rules are tested
 * without a terminal. Enter ends it; Ctrl-C or Ctrl-D aborts; backspace removes a character; every
 * other control character is ignored, so an arrow key's escape sequence cannot become part of a
 * password.
 */
export function applyKeys(current: string, chunk: string): KeyResult {
  let value = current;
  for (const character of chunk) {
    if (ENTER.has(character)) return { value, done: true, aborted: false };
    if (character === CTRL_C || character === CTRL_D) return { value, done: true, aborted: true };
    if (BACKSPACE.has(character)) {
      value = [...value].slice(0, -1).join('');
    } else if (character >= ' ') {
      value += character;
    }
  }
  return { value, done: false, aborted: false };
}

/**
 * Read one line from a stream that is not a terminal (a pipe): `echo "$PASSWORD" | ...`. Takes the
 * first line, drops the line ending, and keeps every other character exactly: a password's leading
 * and trailing spaces are part of it.
 */
export async function readLineFrom(stream: AsyncIterable<string | Uint8Array>): Promise<string> {
  let text = '';
  for await (const chunk of stream) {
    text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (text.includes('\n')) break;
  }
  return text.split(/\r?\n/, 1)[0] ?? '';
}

interface TerminalIn {
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
}

/**
 * Prompt on a terminal with nothing echoed. Raw mode, so each key arrives unprocessed and nothing is
 * drawn for it; the question is written, the answer is not. Returns null if the person aborted.
 */
export function promptHidden(
  question: string,
  stdin: TerminalIn,
  write: (text: string) => void,
): Promise<string | null> {
  return new Promise((resolve) => {
    let value = '';
    write(question);
    stdin.setEncoding('utf8');
    stdin.setRawMode?.(true);
    stdin.resume();

    const onData = (chunk: string) => {
      const result = applyKeys(value, chunk);
      value = result.value;
      if (!result.done) return;
      stdin.off('data', onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      write('\n');
      resolve(result.aborted ? null : value);
    };
    stdin.on('data', onData);
  });
}
