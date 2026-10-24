import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { applyKeys, promptHidden, readLineFrom } from './password-input.js';

describe('typing a password', () => {
  it('collects characters and finishes on enter', () => {
    expect(applyKeys('', 'abc')).toEqual({ value: 'abc', done: false, aborted: false });
    expect(applyKeys('abc', 'd\r')).toEqual({ value: 'abcd', done: true, aborted: false });
    expect(applyKeys('', 'x\n').done).toBe(true);
  });

  it('removes a character on backspace and does nothing on an empty line', () => {
    expect(applyKeys('abc', '\u007f').value).toBe('ab');
    expect(applyKeys('abc', '\b\b').value).toBe('a');
    expect(applyKeys('', '\u007f').value).toBe('');
  });

  it('keeps a character outside the basic plane whole when backspacing', () => {
    expect(applyKeys('a😀', '\u007f').value).toBe('a');
  });

  it('aborts on Ctrl-C and Ctrl-D, keeping nothing of it', () => {
    expect(applyKeys('abc', '\u0003')).toMatchObject({ done: true, aborted: true });
    expect(applyKeys('abc', '\u0004')).toMatchObject({ done: true, aborted: true });
  });

  it('ignores other control characters, so an arrow key cannot become part of the password', () => {
    // Up arrow is ESC [ A: the escape is dropped, the rest are printable and would be kept, which
    // is why the terminal is put in raw mode only for printable entry; the escape itself is gone.
    expect(applyKeys('ab', '\u001b').value).toBe('ab');
    expect(applyKeys('ab', '\t').value).toBe('ab');
  });

  it('takes a pasted password in one chunk, spaces and all', () => {
    expect(applyKeys('', ' pass word \n')).toEqual({
      value: ' pass word ',
      done: true,
      aborted: false,
    });
  });

  it('stops at the first enter and ignores what follows', () => {
    expect(applyKeys('', 'one\rtwo').value).toBe('one');
  });
});

describe('reading a password from a pipe', () => {
  it('takes the first line and drops its ending', async () => {
    expect(await readLineFrom(Readable.from(['s3cret\n']))).toBe('s3cret');
    expect(await readLineFrom(Readable.from(['s3cret\r\nsecond\n']))).toBe('s3cret');
  });

  it('keeps leading and trailing spaces, which are part of a password', async () => {
    expect(await readLineFrom(Readable.from(['  pw  \n']))).toBe('  pw  ');
  });

  it('reads a line that arrives in pieces, and one with no line ending', async () => {
    expect(await readLineFrom(Readable.from(['sec', 'ret\n']))).toBe('secret');
    expect(await readLineFrom(Readable.from(['no-newline']))).toBe('no-newline');
  });

  it('returns an empty string for empty input, which the password policy then refuses', async () => {
    expect(await readLineFrom(Readable.from([]))).toBe('');
  });
});

/** A terminal as far as the prompt can tell: raw mode, data events, pause and resume. */
class FakeTerminal extends EventEmitter {
  isTTY = true;
  rawMode: boolean[] = [];
  setRawMode(mode: boolean) {
    this.rawMode.push(mode);
  }
  resume() {}
  pause() {}
  setEncoding() {}
}

describe('prompting on a terminal', () => {
  it('writes the question and a newline, and never an echo of what is typed', async () => {
    const terminal = new FakeTerminal();
    const written: string[] = [];
    const answer = promptHidden('Password: ', terminal, (text) => written.push(text));
    terminal.emit('data', 'hun');
    terminal.emit('data', 'ter2\r');

    expect(await answer).toBe('hunter2');
    expect(written).toEqual(['Password: ', '\n']);
    expect(written.join('')).not.toContain('hunter2');
  });

  it('puts the terminal in raw mode while typing and always puts it back', async () => {
    const terminal = new FakeTerminal();
    const answer = promptHidden('Password: ', terminal, () => undefined);
    terminal.emit('data', 'x\n');
    await answer;
    expect(terminal.rawMode).toEqual([true, false]);
    expect(terminal.listenerCount('data')).toBe(0);
  });

  it('returns null when aborted, and restores the terminal', async () => {
    const terminal = new FakeTerminal();
    const answer = promptHidden('Password: ', terminal, () => undefined);
    terminal.emit('data', 'half\u0003');
    expect(await answer).toBeNull();
    expect(terminal.rawMode).toEqual([true, false]);
  });
});
