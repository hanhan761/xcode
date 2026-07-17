#!/usr/bin/env node
'use strict';

let trusted = false;
let line = '';

process.stdin.setEncoding('utf8');
if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
process.stdin.resume();
process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H\x1b[2;1HDo you trust the contents of this directory?\x1b[4;1HPress enter to continue');

process.stdin.on('data', (data) => {
  for (const character of data) {
    if (!trusted) {
      if (character === '\r' || character === '\n') {
        trusted = true;
        process.stdout.write('\x1b[2J\x1b[H\x1b[1;1HREADY FOR CODEX MESSAGES');
      }
      continue;
    }
    if (character === '\r' || character === '\n') {
      process.stdout.write(`\x1b[3;1H\x1b[2KOFFICE:${line}`);
      line = '';
      continue;
    }
    if (character >= ' ') { line += character; }
  }
});
