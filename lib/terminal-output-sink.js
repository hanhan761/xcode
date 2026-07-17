'use strict';

function createTerminalOutputSink(output, onFatalError = () => {}) {
  if (!output || typeof output.write !== 'function' || typeof output.on !== 'function') {
    throw new TypeError('A terminal output sink requires a writable event stream.');
  }
  if (typeof onFatalError !== 'function') {
    throw new TypeError('A terminal output sink requires an error callback.');
  }

  let closed = false;
  const handledErrors = new WeakSet();
  const report = (error) => {
    if (closed || !error || error.code === 'EAGAIN') { return; }
    if (typeof error === 'object' && handledErrors.has(error)) { return; }
    if (typeof error === 'object') { handledErrors.add(error); }
    closed = true;
    output.off('error', report);
    onFatalError(error);
  };
  output.on('error', report);

  return {
    write(data) {
      if (closed || !data) { return; }
      try { output.write(data, report); }
      catch (error) { report(error); }
    },
    close() {
      if (closed) { return; }
      closed = true;
      output.off('error', report);
    },
  };
}

module.exports = { createTerminalOutputSink };
