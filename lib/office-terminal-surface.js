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
      // Codex and helper processes can interleave output at the ConPTY byte
      // boundary. Native terminals recover silently from an interrupted ANSI
      // sequence; keep xterm's internal parser dump out of the office UI too.
      logLevel: 'off',
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
    // The local viewport can be taller than the terminal's prior remote
    // geometry immediately after a full-screen resize. Anchor its bottom with
    // the requested rows, not stale remoteRows, so no lower screen area is
    // silently omitted.
    const start = Math.max(0, Math.min(buffer.viewportY, Math.max(0, buffer.length - visibleRows)));
    const lines = [];
    for (let index = 0; index < visibleRows; index += 1) {
      const line = buffer.getLine(start + index);
      lines.push(line ? cleanLine(line.translateToString(false), visibleCols) : '');
    }
    return lines;
  }

  isFollowingLiveOutput() {
    if (this.closed) {
      return true;
    }
    const buffer = this.terminal.buffer.active;
    return buffer.viewportY >= buffer.baseY;
  }

  scrollPages(pages) {
    if (this.closed) {
      throw new Error('The office terminal surface is closed.');
    }
    if (Number.isInteger(pages) && pages !== 0) {
      this.terminal.scrollPages(pages);
    }
    return this.isFollowingLiveOutput();
  }

  scrollLines(lines) {
    if (this.closed) {
      throw new Error('The office terminal surface is closed.');
    }
    if (Number.isInteger(lines) && lines !== 0) {
      this.terminal.scrollLines(lines);
    }
    return this.isFollowingLiveOutput();
  }

  scrollToTop() {
    if (this.closed) {
      throw new Error('The office terminal surface is closed.');
    }
    this.terminal.scrollToTop();
    return this.isFollowingLiveOutput();
  }

  scrollToBottom() {
    if (this.closed) {
      throw new Error('The office terminal surface is closed.');
    }
    this.terminal.scrollToBottom();
    return this.isFollowingLiveOutput();
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
    const buffer = this.terminal.buffer.active;
    const followLiveOutput = this.isFollowingLiveOutput();
    const linesAboveLiveOutput = Math.max(0, buffer.baseY - buffer.viewportY);
    this.remoteCols = nextCols;
    this.remoteRows = nextRows;
    this.terminal.resize(nextCols, nextRows);
    if (followLiveOutput) {
      this.terminal.scrollToBottom();
    }
    else {
      // Resizing changes wrapping and therefore baseY. Restore the user's
      // approximate distance from live output instead of jumping them back to
      // the bottom while they are reading an older response.
      this.terminal.scrollToBottom();
      this.terminal.scrollLines(-linesAboveLiveOutput);
    }
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
