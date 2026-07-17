#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { OfficeTerminalSurface } = require('../lib/office-terminal-surface');

async function main() {
  const surface = new OfficeTerminalSurface({ remoteCols: 24, remoteRows: 5 });
  try {
    await surface.write('\x1b[2J\x1b[HPrimary Codex\x1b[2;1Hfirst response');
    let viewport = surface.getViewport({ cols: 24, rows: 5 });
    assert.equal(viewport[0], 'Primary Codex');
    assert.equal(viewport[1], 'first response');
    assert.equal(viewport.join('\n').includes('\x1b'), false, 'ANSI controls leaked into the office renderer.');

    await surface.write('\x1b[?1049h\x1b[2J\x1b[HActive Codex UI\x1b[3;1Hready');
    viewport = surface.getViewport({ cols: 24, rows: 5 });
    assert.equal(viewport[0], 'Active Codex UI', 'The alternate screen was not reflected.');
    assert.equal(viewport[2], 'ready');
    assert.equal(viewport.join('\n').includes('Primary Codex'), false, 'The normal screen leaked into the active Codex UI.');

    await surface.write('\x1b[?1049l');
    viewport = surface.getViewport({ cols: 24, rows: 5 });
    assert.equal(viewport[0], 'Primary Codex', 'Returning from the alternate screen lost the normal terminal state.');

    surface.resizeRemote(48, 10);
    const horizontalBorder = `╔${'═'.repeat(46)}╗`;
    await surface.write(`\x1b[2J\x1b[H${horizontalBorder}\x1b[10;1H${horizontalBorder}`);
    viewport = surface.getViewport({ cols: 48, rows: 10 });
    assert.equal(viewport[0], horizontalBorder, 'A resized terminal did not render its complete top border.');
    assert.equal(viewport[9], horizontalBorder, 'A resized terminal did not render its complete bottom border.');

    const scrollback = new OfficeTerminalSurface({ remoteCols: 24, remoteRows: 5 });
    try {
      await scrollback.write(Array.from({ length: 8 }, (_, index) => `history-${index + 1}\r\n`).join(''));
      assert.equal(scrollback.isFollowingLiveOutput(), true, 'A live terminal should initially follow its newest output.');
      scrollback.scrollPages(-1);
      viewport = scrollback.getViewport({ cols: 24, rows: 5 });
      assert.equal(viewport[0], 'history-1', 'PageUp did not expose the earliest scrollback line.');
      assert.equal(scrollback.isFollowingLiveOutput(), false, 'PageUp did not leave live-follow mode.');
      scrollback.scrollToBottom();
      assert.equal(scrollback.isFollowingLiveOutput(), true, 'End did not return the office surface to live output.');
    }
    finally { scrollback.dispose(); }
    console.log('OFFICE_TERMINAL_SURFACE=PASS');
  }
  finally {
    surface.dispose();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
