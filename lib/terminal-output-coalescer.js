'use strict';

const { Terminal } = require('@xterm/headless');

function normalizeDimension(value, fallback, minimum) {
  return Number.isInteger(value) && value >= minimum ? value : fallback;
}

function colorCodes(cell, foreground) {
  const codes = [];
  const color = foreground ? cell.getFgColor() : cell.getBgColor();
  const defaultCode = foreground ? 39 : 49;
  const paletteBase = foreground ? 30 : 40;
  const brightBase = foreground ? 90 : 100;
  const extended = foreground ? 38 : 48;
  const isDefault = foreground ? cell.isFgDefault() : cell.isBgDefault();
  const isRgb = foreground ? cell.isFgRGB() : cell.isBgRGB();

  if (isDefault) { codes.push(defaultCode); }
  else if (isRgb) { codes.push(extended, 2, (color >> 16) & 255, (color >> 8) & 255, color & 255); }
  else if (color < 8) { codes.push(paletteBase + color); }
  else if (color < 16) { codes.push(brightBase + color - 8); }
  else { codes.push(extended, 5, color); }
  return codes;
}

function cellStyleKey(cell) {
  return [
    cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor(),
    cell.isBold(), cell.isDim(), cell.isItalic(), cell.isUnderline(), cell.isBlink(),
    cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline(),
  ].join(':');
}

function cellStyleSequence(cell) {
  const codes = [0];
  if (cell.isBold()) { codes.push(1); }
  if (cell.isDim()) { codes.push(2); }
  if (cell.isItalic()) { codes.push(3); }
  if (cell.isUnderline()) { codes.push(4); }
  if (cell.isBlink()) { codes.push(5); }
  if (cell.isInverse()) { codes.push(7); }
  if (cell.isInvisible()) { codes.push(8); }
  if (cell.isStrikethrough()) { codes.push(9); }
  if (cell.isOverline()) { codes.push(53); }
  codes.push(...colorCodes(cell, true), ...colorCodes(cell, false));
  return `\x1b[${codes.join(';')}m`;
}

function renderBufferLine(line, cols) {
  let rendered = '';
  let currentStyle = null;
  for (let column = 0; column < cols; column += 1) {
    const cell = line?.getCell(column);
    if (!cell || cell.getWidth() === 0) { continue; }
    const style = cellStyleKey(cell);
    if (style !== currentStyle) {
      rendered += cellStyleSequence(cell);
      currentStyle = style;
    }
    rendered += cell.getChars() || ' ';
  }
  return `${rendered}\x1b[0m`;
}

// Codex emits many intermediate cursor/erase animations per second. Merely
// concatenating those bytes still makes Windows Terminal execute every one.
// This surface applies the raw stream to an in-memory terminal, then paints
// only the latest changed rows without erase-line commands.
function createTerminalOutputCoalescer(write, {
  cols = 120,
  rows = 36,
  frameIntervalMs = 80,
  schedule = (callback, delay) => setTimeout(callback, delay),
  cancel = (timer) => clearTimeout(timer),
} = {}) {
  if (typeof write !== 'function') { throw new TypeError('A terminal coalescer requires a write function.'); }
  if (!Number.isInteger(frameIntervalMs) || frameIntervalMs < 1) { throw new RangeError('A terminal coalescer frame interval must be positive.'); }

  let currentCols = normalizeDimension(cols, 120, 20);
  let currentRows = normalizeDimension(rows, 36, 5);
  let timer = null;
  let closed = false;
  let cursorVisible = true;
  let renderedLines = [];
  let renderedCursor = null;
  let pendingWrite = Promise.resolve();
  const terminal = new Terminal({
    cols: currentCols,
    rows: currentRows,
    scrollback: 2_000,
    allowProposedApi: true,
    convertEol: false,
  });

  function render() {
    if (closed) { return; }
    const buffer = terminal.buffer.active;
    const start = Math.max(0, Math.min(buffer.viewportY, Math.max(0, buffer.length - currentRows)));
    const nextLines = [];
    let output = '\x1b[?25l\x1b[?7l';
    let changed = false;
    for (let row = 0; row < currentRows; row += 1) {
      const line = renderBufferLine(buffer.getLine(start + row), currentCols);
      nextLines.push(line);
      if (line === renderedLines[row]) { continue; }
      output += `\x1b[${row + 1};1H${line}`;
      changed = true;
    }

    const absoluteCursorRow = buffer.baseY + buffer.cursorY;
    const cursorRow = Math.max(1, Math.min(currentRows, absoluteCursorRow - start + 1));
    const cursorColumn = Math.max(1, Math.min(currentCols, buffer.cursorX + 1));
    const cursor = `${cursorRow}:${cursorColumn}:${cursorVisible ? 'visible' : 'hidden'}`;
    if (changed || cursor !== renderedCursor) {
      output += `\x1b[${cursorRow};${cursorColumn}H\x1b[?7h${cursorVisible ? '\x1b[?25h' : '\x1b[?25l'}`;
      write(output);
    }
    renderedLines = nextLines;
    renderedCursor = cursor;
  }

  function scheduleRender() {
    if (closed || timer !== null) { return; }
    timer = schedule(() => {
      timer = null;
      render();
    }, frameIntervalMs);
  }

  function trackCursorVisibility(data) {
    const matches = data.matchAll(/\x1b\[\?25([hl])/g);
    for (const match of matches) { cursorVisible = match[1] === 'h'; }
  }

  async function flush() {
    await pendingWrite;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    render();
  }

  return {
    write(data) {
      if (closed || typeof data !== 'string' || !data) { return pendingWrite; }
      trackCursorVisibility(data);
      pendingWrite = pendingWrite.then(() => new Promise((resolve, reject) => {
        try {
          terminal.write(data, () => {
            scheduleRender();
            resolve();
          });
        }
        catch (error) { reject(error); }
      }));
      return pendingWrite;
    },
    resize(nextCols, nextRows) {
      if (closed) { return; }
      currentCols = normalizeDimension(nextCols, currentCols, 20);
      currentRows = normalizeDimension(nextRows, currentRows, 5);
      terminal.resize(currentCols, currentRows);
      renderedLines = [];
      renderedCursor = null;
      scheduleRender();
    },
    flush,
    async close() {
      if (closed) { return; }
      await flush();
      closed = true;
      terminal.dispose();
      write('\x1b[0m\x1b[?7h\x1b[?25h\r\n');
    },
  };
}

module.exports = { createTerminalOutputCoalescer };
