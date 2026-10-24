const net = require('node:net');

// Local Windows IPC only: do not interpret remote UNC paths as serial ports.
// Keep in sync with domain/serialEndpoint.ts (covered by the endpoint tests).
function isWindowsNamedPipePath(value) {
  return typeof value === 'string' && /^\\\\[.?]\\pipe\\[^\r\n\0]+$/i.test(value);
}

/** A byte stream with the open/close interface used by serial sessions. */
class SerialNamedPipe extends net.Socket {
  constructor(path) {
    super();
    this.path = path;
    this.finishOpen = null;
  }

  open(callback) {
    const onConnect = () => finish(null);
    const onError = (error) => finish(error);
    const finish = (error) => {
      if (this.finishOpen !== finish) return;
      this.finishOpen = null;
      this.removeListener('connect', onConnect);
      this.removeListener('error', onError);
      callback(error);
    };
    this.finishOpen = finish;
    this.once('connect', onConnect);
    this.once('error', onError);
    try {
      this.connect(this.path);
    } catch (error) {
      finish(error);
    }
  }

  close() {
    // Cancel even before connect completes; a superseded boot must not linger.
    this.destroy();
    // Match asynchronous SerialPort open failures so the boot abort can settle
    // with its superseded error before this transport-level cancellation.
    queueMicrotask(() => this.finishOpen?.(new Error('Named pipe connection closed before opening')));
  }
}

function createSerialTransport(options, SerialPort, platform = process.platform) {
  const path = options.path?.trim();
  if (!isWindowsNamedPipePath(path)) return new SerialPort({ ...options, path });
  if (platform !== 'win32') {
    throw new Error('Windows named pipes are only supported on Windows');
  }
  return new SerialNamedPipe(path);
}

module.exports = { isWindowsNamedPipePath, SerialNamedPipe, createSerialTransport };
