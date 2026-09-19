// A checklist that gets a keystroke wrong is worse than no checklist: the
// person believes they chose something other than what was recorded, and the
// only evidence is a list of assistants that quietly never got read.
//
// Driven through a real readline keypress stream rather than by calling the
// handler, because the thing most likely to break is the parsing of an arrow
// key into an event, and that is readline's job, not this file's.
import { test } from 'node:test';
import assert from 'node:assert';
import { PassThrough } from 'node:stream';
import { checklist, interactive } from './checklist.js';

const ESC = String.fromCharCode(27);
const NEWLINE = String.fromCharCode(10);
const UP_PATTERN_START = ESC + '[';
const KEYS = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  space: ' ',
  enter: String.fromCharCode(13),
  escape: ESC,
};

function terminal() {
  const input = new PassThrough();
  const output = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  input.setRawMode = () => {};
  const written = [];
  output.on('data', (b) => written.push(b.toString()));
  return { input, output, written };
}

/** Press these in order, once the widget is listening. */
function press(input, keys) {
  setImmediate(() => {
    for (const k of keys) input.write(KEYS[k] ?? k);
  });
}

const ITEMS = [
  { id: 'codex', label: 'Codex CLI' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'aider', label: 'Aider', disabled: true },
  { id: 'cline', label: 'Cline' },
];

test('everything available starts on, and enter keeps it that way', async () => {
  const { input, output } = terminal();
  press(input, ['enter']);
  const chosen = await checklist(ITEMS, { input, output });
  assert.deepEqual(chosen, ['codex', 'cursor', 'cline']);
});

test('space turns the one under the cursor off', async () => {
  const { input, output } = terminal();
  press(input, ['space', 'enter']);
  const chosen = await checklist(ITEMS, { input, output });
  assert.deepEqual(chosen, ['cursor', 'cline']);
});

test('down moves past the disabled row rather than onto it', async () => {
  // Landing on a row that cannot be toggled makes the widget look broken.
  const { input, output } = terminal();
  press(input, ['down', 'down', 'space', 'enter']);
  const chosen = await checklist(ITEMS, { input, output });
  assert.deepEqual(chosen, ['codex', 'cursor'], 'the third stop should have been cline');
});

test('the cursor wraps instead of stopping at the end', async () => {
  const { input, output } = terminal();
  press(input, ['up', 'space', 'enter']);
  const chosen = await checklist(ITEMS, { input, output });
  assert.deepEqual(chosen, ['codex', 'cursor'], 'up from the first should land on the last');
});

test('n clears and a restores, and neither touches a disabled row', async () => {
  const { input, output } = terminal();
  press(input, ['n', 'enter']);
  assert.deepEqual(await checklist(ITEMS, { input, output }), []);

  const second = terminal();
  press(second.input, ['n', 'a', 'enter']);
  const chosen = await checklist(ITEMS, { input: second.input, output: second.output });
  assert.deepEqual(chosen, ['codex', 'cursor', 'cline'], 'aider must not have come back on');
});

test('a disabled item is never returned, however it started', async () => {
  const { input, output } = terminal();
  press(input, ['a', 'enter']);
  const chosen = await checklist(
    [{ id: 'aider', label: 'Aider', disabled: true, checked: true }, { id: 'codex', label: 'Codex CLI' }],
    { input, output },
  );
  assert.deepEqual(chosen, ['codex']);
});

test('escape cancels, and cancelling is not the same as choosing nothing', async () => {
  // Returning [] here would silently record "read nothing from anywhere".
  const { input, output } = terminal();
  press(input, ['escape']);
  assert.equal(await checklist(ITEMS, { input, output }), null);
});

test('q cancels too', async () => {
  const { input, output } = terminal();
  press(input, ['q']);
  assert.equal(await checklist(ITEMS, { input, output }), null);
});

test('what it starts with can be set, not just assumed', async () => {
  const { input, output } = terminal();
  press(input, ['enter']);
  const chosen = await checklist(
    [{ id: 'a', label: 'A', checked: false }, { id: 'b', label: 'B', checked: true }],
    { input, output },
  );
  assert.deepEqual(chosen, ['b']);
});

test('raw mode is given back, whatever happens', async () => {
  // Left on, the shell afterwards echoes nothing and looks hung.
  const { input, output } = terminal();
  const modes = [];
  input.setRawMode = (on) => modes.push(on);
  press(input, ['escape']);
  await checklist(ITEMS, { input, output });
  assert.deepEqual(modes, [true, false]);
});

test('the cursor is hidden and put back', async () => {
  const { input, output, written } = terminal();
  press(input, ['enter']);
  await checklist(ITEMS, { input, output });
  const all = written.join('');
  assert.ok(all.includes(`${ESC}[?25l`), 'never hidden');
  assert.ok(all.includes(`${ESC}[?25h`), 'never shown again');
});

test('without a terminal it refuses rather than waiting forever', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  assert.equal(interactive({ input, output }), false);
  assert.throws(() => checklist(ITEMS, { input, output }), /not a terminal/);
});
test('a redraw moves up by exactly as many lines as it wrote', () => {
  // The whole widget is a line count. A title containing a newline, or a row
  // wider than the terminal, writes two lines where one was counted — and the
  // next redraw then lands in the middle of the last one.
  const { input, output, written } = terminal();
  output.columns = 80;
  const done = checklist(ITEMS, {
    input,
    output,
    title: `Which assistants should arca read?${NEWLINE}`,
  });
  press(input, ['down', 'enter']);
  return done.then(() => {
    const all = written.join('');
    const UP = new RegExp(`${ESC}\\[(\\d+)A`);
    const up = UP.exec(all);
    assert.ok(up, 'the second frame never moved the cursor up');
    const firstFrame = all.slice(0, up.index);
    const wrote = firstFrame.split(NEWLINE).length - 1;
    assert.equal(Number(up[1]), wrote, `wrote ${wrote} lines but moved up ${up[1]}`);
  });
});

test('a row wider than the terminal is cut, not wrapped', () => {
  const { input, output, written } = terminal();
  output.columns = 40;
  press(input, ['enter']);
  return checklist(
    [{ id: 'x', label: 'a label far longer than forty columns could ever hold' }],
    { input, output },
  ).then(() => {
    const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
    for (const line of written.join('').split(NEWLINE)) {
      // Measure without the colour: escapes are not width.
      const plain = line.replace(ANSI, '');
      assert.ok(plain.length <= 40, `a line was ${plain.length} wide: ${JSON.stringify(plain)}`);
    }
  });
});
