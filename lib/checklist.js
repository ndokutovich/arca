// A checklist for the terminal, in about a hundred lines.
//
// The alternative is a prompt library, and this package just shed 275 MB of
// dependencies; adding one back to draw eleven lines would be a poor trade.
//
// It only runs when there is a terminal to run in. Piped, redirected or in CI
// there is nothing to press a key on, so the caller is told to decide without
// it rather than left waiting on stdin that will never arrive.
import readline from 'node:readline';

const ESC = String.fromCharCode(27);
const CLEAR_LINE = `${ESC}[2K`;
const UP = (n) => (n > 0 ? `${ESC}[${n}A` : '');
const HIDE = `${ESC}[?25l`;
const SHOW = `${ESC}[?25h`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const RESET = `${ESC}[0m`;

export function interactive(streams = {}) {
  const input = streams.input || process.stdin;
  const output = streams.output || process.stdout;
  return Boolean(input.isTTY && output.isTTY);
}

/**
 * Ask which of these to turn on.
 *
 * @param {Array<{id: string, label: string, checked?: boolean, disabled?: boolean, note?: string}>} items
 * @param {{title?: string, footer?: string, input?: object, output?: object}} opts
 * @returns {Promise<string[]|null>} the ids left checked, or null if cancelled
 */
export function checklist(items, opts = {}) {
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  if (!interactive({ input, output })) {
    throw new Error('not a terminal');
  }

  const state = items.map((i) => ({ ...i, checked: !i.disabled && i.checked !== false }));
  const selectable = state.map((s, i) => (s.disabled ? -1 : i)).filter((i) => i >= 0);
  let cursor = selectable.length ? selectable[0] : 0;
  let drawn = 0;

  const width = Math.max(...state.map((s) => s.id.length), 4);

  const render = () => {
    const lines = [];
    if (opts.title) lines.push(opts.title);
    for (let i = 0; i < state.length; i++) {
      const s = state[i];
      const here = i === cursor && !s.disabled;
      const box = s.disabled ? '   ' : s.checked ? '[x]' : '[ ]';
      const body = `${here ? '>' : ' '} ${box} ${s.id.padEnd(width)}  ${s.label}${s.note ? `  ${s.note}` : ''}`;
      lines.push(s.disabled ? `${DIM}${body}${RESET}` : here ? `${BOLD}${body}${RESET}` : body);
    }
    lines.push('');
    lines.push(`${DIM}${opts.footer || 'space toggles · a all · n none · enter confirms · q cancels'}${RESET}`);

    // Redraw in place: move up over what was written last time, and clear each
    // line before rewriting it, or a shorter line leaves the tail of a longer
    // one behind it.
    output.write(UP(drawn));
    for (const line of lines) output.write(`${CLEAR_LINE}${line}\n`);
    drawn = lines.length;
  };

  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    readline.emitKeypressEvents(input);
    if (input.setRawMode) input.setRawMode(true);
    output.write(HIDE);
    render();

    const finish = (value) => {
      input.off('keypress', onKey);
      if (input.setRawMode) input.setRawMode(Boolean(wasRaw));
      input.pause();
      output.write(SHOW);
      resolve(value);
    };

    const move = (delta) => {
      if (!selectable.length) return;
      const at = selectable.indexOf(cursor);
      const next = (at + delta + selectable.length) % selectable.length;
      cursor = selectable[next];
    };

    function onKey(_str, key) {
      if (!key) return;
      if (key.name === 'up' || key.name === 'k') { move(-1); render(); return; }
      if (key.name === 'down' || key.name === 'j') { move(1); render(); return; }
      if (key.name === 'space') {
        const s = state[cursor];
        if (s && !s.disabled) s.checked = !s.checked;
        render();
        return;
      }
      if (key.name === 'a') { for (const s of state) if (!s.disabled) s.checked = true; render(); return; }
      if (key.name === 'n') { for (const s of state) if (!s.disabled) s.checked = false; render(); return; }
      if (key.name === 'return' || key.name === 'enter') {
        finish(state.filter((s) => !s.disabled && s.checked).map((s) => s.id));
        return;
      }
      // Ctrl-C has to work here or the terminal is left in raw mode with no
      // cursor, which looks like a hung shell.
      if (key.name === 'escape' || key.name === 'q' || (key.ctrl && key.name === 'c')) {
        finish(null);
      }
    }

    input.on('keypress', onKey);
    input.resume();
  });
}
