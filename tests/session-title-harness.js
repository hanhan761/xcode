'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const packageRoot = path.resolve(process.env.XCODE_PACKAGE_ROOT || path.join(__dirname, '..'));
const {
  resolveSessionTitle,
  terminalTitleSequence,
} = require(path.join(packageRoot, 'lib', 'session-title'));

assert.equal(resolveSessionTitle(null, 'C:\\work\\xcode'), 'xcode');
assert.equal(resolveSessionTitle('  长效标题  ', 'C:\\work\\xcode'), '长效标题');
assert.equal(resolveSessionTitle('\x1b]0;hijack\x07', 'C:\\work\\xcode'), ']0;hijack');
assert.equal(resolveSessionTitle('', 'C:\\'), 'Codex');
assert.equal(terminalTitleSequence('长效标题'), '\x1b]0;长效标题\x07');
assert.equal(terminalTitleSequence('\x1b]2;bad\x07'), '\x1b]0;]2;bad\x07');

process.stdout.write('SESSION_TITLE=PASS\n');
