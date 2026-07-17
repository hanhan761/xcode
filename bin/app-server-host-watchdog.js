#!/usr/bin/env node
'use strict';

const { runSharedAppServerWatchdog } = require('../lib/app-server-host');

const [hostRoot, hostId] = process.argv.slice(2);
if (!hostRoot || !hostId) {
  process.stderr.write('xcode: app-server host watchdog requires a state root and host id.\n');
  process.exit(1);
}
runSharedAppServerWatchdog({ hostRoot, hostId });
