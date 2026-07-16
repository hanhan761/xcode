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
