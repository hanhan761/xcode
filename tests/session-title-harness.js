'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const {
  createTerminalTitleFilter,
  resolveSessionTitle,
  terminalTitleSequence,
} = require(path.join(packageRoot, 'lib', 'session-title'));

assert.equal(resolveSessionTitle(null, 'C:\\work\\xcode'), 'xcode');
assert.equal(resolveSessionTitle('  长效标题  ', 'C:\\work\\xcode'), '长效标题');
assert.equal(resolveSessionTitle('\x1b]0;hijack\x07', 'C:\\work\\xcode'), ']0;hijack');
assert.equal(resolveSessionTitle('', 'C:\\'), 'Codex');
assert.equal(terminalTitleSequence('长效标题'), '\x1b]0;长效标题\x07');
assert.equal(terminalTitleSequence('\x1b]2;bad\x07'), '\x1b]0;]2;bad\x07');

const terminalTitles = [];
const titleFilter = createTerminalTitleFilter((data) => terminalTitles.push(data), 'Shared conversation');
titleFilter.write('\x1b]0;\u280b xcode\x07\x1b]0;\u2819 xcode\x07');
titleFilter.flush();
assert.deepEqual(terminalTitles, [
  terminalTitleSequence('\u280b xcode — Shared conversation'),
  terminalTitleSequence('\u2819 xcode — Shared conversation'),
], 'Working title frames were discarded instead of being forwarded with the durable session title.');

process.stdout.write('SESSION_TITLE=PASS\n');
