#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`Process exited ${code}.`)));
  });
}

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'xcode-window-event-probe-'));
  const outputPath = path.join(workspace, 'probe.json');
  try {
    const probe = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'visible-child-window-probe.ps1'),
      '-OutputPath', outputPath, '-DurationSeconds', '4',
    ], { windowsHide: true, stdio: 'ignore' });

    await new Promise((resolve) => setTimeout(resolve, 750));
    const control = spawn('powershell.exe', [
      '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
      'Add-Type -AssemblyName System.Windows.Forms; ' +
      '$f = New-Object System.Windows.Forms.Form; ' +
      '$f.Text = "xcode-window-event-probe-control"; ' +
      '$f.StartPosition = "Manual"; $f.Location = New-Object Drawing.Point(0,0); ' +
      '$f.Size = New-Object Drawing.Size(1,1); $f.Opacity = 0.01; $f.ShowInTaskbar = $false; ' +
      '$t = New-Object System.Windows.Forms.Timer; $t.Interval = 250; ' +
      '$t.Add_Tick({ $t.Stop(); $f.Close() }); $t.Start(); [void]$f.ShowDialog()',
    ], { windowsHide: true, stdio: 'ignore' });
    await Promise.all([waitForExit(control), waitForExit(probe)]);

    const result = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    const controlShows = (result.windowEvents || []).filter((event) =>
      event.eventName === 'show' &&
      event.visible === true &&
      event.title === 'xcode-window-event-probe-control');
    assert.ok(controlShows.length > 0,
      `The event probe missed a 250ms visible control window: ${JSON.stringify(result.windowEvents)}`);
    console.log(`TRANSIENT_WINDOW_EVENT_PROBE=PASS caught_show_events=${controlShows.length}`);
  }
  finally {
    fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
