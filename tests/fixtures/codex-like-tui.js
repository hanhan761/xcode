#!/usr/bin/env node
'use strict';

let line = '';

function render(message) {
  process.stdout.write(`\x1b[${message.row};1H\x1b[2K${message.text}`);
}

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[1;1HCodex-like full-screen conversation\x1b[2;1HTUI_READY');

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
