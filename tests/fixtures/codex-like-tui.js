#!/usr/bin/env node
'use strict';

let line = '';

function render(message) {
  process.stdout.write(`\x1b[${message.row};1H\x1b[2K${message.text}`);
}

function renderFullScreenFrame() {
  const cols = Math.max(20, process.stdout.columns || 120);
  const rows = Math.max(5, process.stdout.rows || 36);
  const horizontal = '─'.repeat(cols - 2);
  render({ row: 1, text: `┌${horizontal}┐` });
  render({ row: 2, text: `│ TUI_WIDTH:${cols}`.padEnd(cols - 1, ' ') + '│' });
  render({ row: rows, text: `└${horizontal}┘` });
}

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
renderFullScreenFrame();
render({ row: 3, text: 'Codex-like full-screen conversation' });
render({ row: 4, text: 'TUI_READY' });
process.stdout.on('resize', renderFullScreenFrame);

process.stdin.on('data', (data) => {
  for (const character of data) {
    if (character === '\u0003') {
      process.stdout.write('\x1b[?1049l');
      process.exit(0);
    }
    if (character === '\r' || character === '\n') {
      render({ row: 5, text: `TUI_RECEIVED:${line}` });
      line = '';
      continue;
    }
    if (character === '\u0008' || character === '\u007f') {
      line = line.slice(0, -1);
      continue;
    }
    if (character >= ' ') {
      line += character;
      render({ row: 3, text: `Draft:${line}` });
    }
  }
});
