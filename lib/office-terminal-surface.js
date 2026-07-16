'use strict';

const { Terminal } = require('@xterm/headless');

function normalizeDimension(value, fallback, minimum) {
  if (Number.isInteger(value) && value >= minimum) {
    return value;
  }
  return fallback;
}

function cleanLine(value, cols) {
  // `translateToString` produces screen text, not terminal controls. Keep the
  // renderer defensive so a malformed remote stream cannot take over the
  // office terminal's cursor or title through a later rendering change.
  return value
    .replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    .slice(0, cols)
    .trimEnd();
}

class OfficeTerminalSurface {
  constructor({ remoteCols = 120, remoteRows = 36 } = {}) {
    this.remoteCols = normalizeDimension(remoteCols, 120, 20);
    this.remoteRows = normalizeDimension(remoteRows, 36, 5);
    this.closed = false;
    this.pendingWrite = Promise.resolve();
    this.terminal = new Terminal({
      cols: this.remoteCols,
      rows: this.remoteRows,
      scrollback: 2_000,
      // xterm deliberately marks its in-memory Buffer API as proposed. It is
      // the one place this module needs xterm internals; callers only receive
      // visible text lines through getViewport().
      allowProposedApi: true,
      convertEol: false,
    });
  }

  write(data) {
    if (this.closed) {
      return Promise.reject(new Error('The office terminal surface is closed.'));
    }
    if (typeof data !== 'string' || data.length === 0) {
      return this.pendingWrite;
    }
    this.pendingWrite = this.pendingWrite.then(() => new Promise((resolve, reject) => {
      try {
        this.terminal.write(data, resolve);
      }
      catch (error) {
        reject(error);
      }
    }));
    return this.pendingWrite;
  }

  getViewport({ cols = this.remoteCols, rows = this.remoteRows } = {}) {
    if (this.closed) {
      return [];
    }
    const visibleCols = normalizeDimension(cols, this.remoteCols, 1);
    const visibleRows = normalizeDimension(rows, this.remoteRows, 1);
    const buffer = this.terminal.buffer.active;
    const start = Math.max(0, Math.min(buffer.viewportY, Math.max(0, buffer.length - this.remoteRows)));
    const lines = [];
    for (let index = 0; index < visibleRows; index += 1) {
      const line = buffer.getLine(start + index);
      lines.push(line ? cleanLine(line.translateToString(false), visibleCols) : '');
    }
    return lines;
  }

  resizeRemote(cols, rows) {
    if (this.closed) {
      throw new Error('The office terminal surface is closed.');
    }
    const nextCols = normalizeDimension(cols, this.remoteCols, 20);
    const nextRows = normalizeDimension(rows, this.remoteRows, 5);
    if (nextCols === this.remoteCols && nextRows === this.remoteRows) {
      return;
    }
    this.remoteCols = nextCols;
    this.remoteRows = nextRows;
    this.terminal.resize(nextCols, nextRows);
  }

  dispose() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.terminal.dispose();
  }
}

module.exports = { OfficeTerminalSurface };
