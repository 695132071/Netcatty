/**
 * Proxy Utilities - Shared proxy socket creation for SSH connections
 * Extracted from sshBridge.cjs and sftpBridge.cjs to eliminate code duplication
 */

const net = require("node:net");
const { spawn } = require("node:child_process");
const { Duplex } = require("node:stream");
const { enableTcpNoDelay } = require("./tcpNoDelay.cjs");

function quotePosixShellArg(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function quoteWindowsCmdArg(value) {
    const text = String(value);
    if (/[\0\r\n"%!]/.test(text)) {
        throw new Error("ProxyCommand target contains characters that cannot be safely substituted on Windows");
    }
    return `"${text}"`;
}

function quoteShellArg(value, platform = process.platform) {
    return platform === "win32" ? quoteWindowsCmdArg(value) : quotePosixShellArg(value);
}

function substituteProxyCommand(command, targetHost, targetPort, options = {}) {
    const platform = options.platform || process.platform;
    return String(command || "").replace(/%%|%h|%p/g, (token) => {
        if (token === "%%") return "%";
        if (token === "%h") return quoteShellArg(targetHost, platform);
        if (token === "%p") return quoteShellArg(targetPort, platform);
        return token;
    });
}

function createProcessSocket(child) {
    let proxyReady = false;
    const proxyReadyCallbacks = new Set();
    const markProxyReady = () => {
        if (proxyReady) return;
        proxyReady = true;
        for (const callback of proxyReadyCallbacks) callback();
        proxyReadyCallbacks.clear();
    };
    const socket = new Duplex({
        read() {
            child.stdout.resume();
        },
        write(chunk, encoding, callback) {
            if (!child.stdin.writable) {
                callback(new Error("ProxyCommand stdin is not writable"));
                return;
            }
            if (child.stdin.write(chunk, encoding)) {
                callback();
            } else {
                child.stdin.once("drain", callback);
            }
        },
        final(callback) {
            child.stdin.end(callback);
        },
        destroy(error, callback) {
            proxyReadyCallbacks.clear();
            try { child.stdin.destroy(); } catch { /* ignore */ }
            try { child.stdout.destroy(); } catch { /* ignore */ }
            if (!child.killed) {
                try { child.kill(); } catch { /* ignore */ }
            }
            callback(error);
        },
    });
    socket.setNoDelay = () => socket;
    socket.setKeepAlive = () => socket;
    socket.setTimeout = () => socket;
    socket.__netcattyOnProxyReady = (callback) => {
        if (proxyReady) queueMicrotask(callback);
        else proxyReadyCallbacks.add(callback);
    };

    child.stdout.on("data", (chunk) => {
        markProxyReady();
        if (!socket.push(chunk)) child.stdout.pause();
    });
    child.stdout.on("end", () => socket.push(null));
    child.stdout.on("error", (err) => socket.destroy(err));
    child.stdin.on("error", (err) => socket.destroy(err));

    return socket;
}

function runWhenProxyConnectionReady(socket, callback) {
    if (typeof socket?.__netcattyOnProxyReady === "function") {
        socket.__netcattyOnProxyReady(callback);
        return;
    }
    callback();
}

// Bytes after the proxy reply (often the SSH banner) can share the reply's
// TCP packet. Put them back for ssh2. Pause first so the tail stays queued
// until the SSH client resumes the socket.
function restoreTrailingSocketBytes(socket, trailing) {
    if (!trailing || trailing.length === 0) return;
    socket.pause();
    socket.unshift(Buffer.from(trailing));
}

// SOCKS5 connect reply: VER REP RSV ATYP BND.ADDR BND.PORT.
// Returns the reply size, null when the buffer is short, or -1 when ATYP is
// not a form we can bound.
function socks5ConnectReplyLength(buffer) {
    if (buffer.length < 4) return null;
    const addressType = buffer[3];
    let addressLength;
    if (addressType === 0x01) addressLength = 4;
    else if (addressType === 0x04) addressLength = 16;
    else if (addressType === 0x03) {
        if (buffer.length < 5) return null;
        addressLength = 1 + buffer[4];
    } else {
        return -1;
    }
    const total = 4 + addressLength + 2;
    return buffer.length < total ? null : total;
}

function createProxyCommandSocket(proxy, targetHost, targetPort, options = {}) {
    const command = substituteProxyCommand(proxy.command, targetHost, targetPort, { platform: process.platform }).trim();
    if (!command) return Promise.reject(new Error("ProxyCommand is required"));

    // Keep SSH ProxyCommand on the launch-time proxy env. App-level Direct/Custom
    // rewrites process.env for Node HTTP clients only and must not change SSH.
    const { buildTerminalProcessEnv } = require("./httpNetworkProxyBridge.cjs");
    const child = spawn(command, {
        shell: true,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: buildTerminalProcessEnv(process.env),
    });
    const socket = createProcessSocket(child);
    const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
        ? Number(options.timeoutMs)
        : 0;
    let settled = false;
    let stderr = "";
    let timeoutId = null;

    const clearConnectTimeout = () => {
        if (!timeoutId) return;
        clearTimeout(timeoutId);
        timeoutId = null;
    };

    child.stderr?.on("data", (chunk) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
    });
    child.stdout.once("data", clearConnectTimeout);
    child.once("close", clearConnectTimeout);

    if (timeoutMs) {
        timeoutId = setTimeout(() => {
            const err = new Error(`ProxyCommand connection timeout to ${targetHost}:${targetPort}`);
            socket.destroy(err);
        }, timeoutMs);
        timeoutId.unref?.();
    }

    return new Promise((resolve, reject) => {
        child.once("error", (err) => {
            clearConnectTimeout();
            if (settled) {
                socket.destroy(err);
                return;
            }
            settled = true;
            reject(err);
        });
        child.once("spawn", () => {
            settled = true;
            try { options.onSocket?.(socket); } catch { /* ignore */ }
            resolve(socket);
        });
        child.once("close", (code, signal) => {
            if (code === 0 || socket.destroyed) return;
            const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
            const err = new Error(`ProxyCommand exited ${signal ? `with signal ${signal}` : `with code ${code}`}${detail}`);
            if (!settled) {
                settled = true;
                reject(err);
            } else {
                socket.destroy(err);
            }
        });
    }).catch((err) => {
        clearConnectTimeout();
        try { child.kill(); } catch { /* ignore */ }
        throw err;
    });
}

/**
 * Create a socket through a proxy (HTTP CONNECT or SOCKS5)
 * @param {Object} proxy - Proxy configuration
 * @param {string} proxy.type - 'http' or 'socks5'
 * @param {string} proxy.host - Proxy host
 * @param {number} proxy.port - Proxy port
 * @param {string} [proxy.username] - Optional username for auth
 * @param {string} [proxy.password] - Optional password for auth
 * @param {string} targetHost - Target host to connect through proxy
 * @param {number} targetPort - Target port to connect through proxy
 * @param {Object} [options]
 * @param {(socket: net.Socket) => void} [options.onSocket] - Called immediately with the underlying socket
 * @returns {Promise<net.Socket>} Connected socket through proxy
 */
function createProxySocket(proxy, targetHost, targetPort, options = {}) {
    const { onSocket } = options;
    if (proxy.type === 'command') {
        return createProxyCommandSocket(proxy, targetHost, targetPort, options);
    }
    return new Promise((resolve, reject) => {
        const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
            ? Number(options.timeoutMs)
            : 0;
        let settled = false;
        let timeoutId = null;
        let socket = null;

        const clearHandshakeTimeout = () => {
            if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
            }
        };
        const settleResolve = () => {
            if (settled) return;
            settled = true;
            clearHandshakeTimeout();
            resolve(socket);
        };
        const settleReject = (err) => {
            if (settled) return;
            settled = true;
            clearHandshakeTimeout();
            try { socket?.destroy?.(); } catch { /* ignore */ }
            reject(err);
        };
        const armHandshakeTimeout = () => {
            if (!timeoutMs) return;
            timeoutId = setTimeout(() => {
                settleReject(new Error(`Proxy connection timeout to ${targetHost}:${targetPort}`));
            }, timeoutMs);
            timeoutId.unref?.();
        };

        if (proxy.type === 'http') {
            // HTTP CONNECT proxy
            socket = net.connect(proxy.port, proxy.host, () => {
                enableTcpNoDelay(socket);
                let authHeader = '';
                if (proxy.username && proxy.password) {
                    const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
                    authHeader = `Proxy-Authorization: Basic ${auth}\r\n`;
                }
                const connectRequest = `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n${authHeader}\r\n`;
                socket.write(connectRequest);

                let pending = Buffer.alloc(0);
                const onData = (data) => {
                    pending = pending.length === 0 ? data : Buffer.concat([pending, data]);
                    const headerEnd = pending.indexOf('\r\n\r\n');
                    if (headerEnd === -1) return;
                    socket.removeListener('data', onData);
                    const header = pending.toString('latin1', 0, headerEnd);
                    if (header.startsWith('HTTP/1.1 200') || header.startsWith('HTTP/1.0 200')) {
                        restoreTrailingSocketBytes(socket, pending.subarray(headerEnd + 4));
                        settleResolve();
                    } else {
                        settleReject(new Error(`HTTP proxy error: ${header.split('\r\n')[0]}`));
                    }
                };
                socket.on('data', onData);
            });
            enableTcpNoDelay(socket);
            try { onSocket?.(socket); } catch { /* ignore */ }
            armHandshakeTimeout();
            socket.on('error', settleReject);
        } else if (proxy.type === 'socks5') {
            // SOCKS5 proxy
            socket = net.connect(proxy.port, proxy.host, () => {
                enableTcpNoDelay(socket);
                // SOCKS5 greeting
                const authMethods = proxy.username && proxy.password ? [0x00, 0x02] : [0x00];
                socket.write(Buffer.from([0x05, authMethods.length, ...authMethods]));

                let step = 'greeting';
                let connectReply = Buffer.alloc(0);
                const onData = (data) => {
                    if (step === 'greeting') {
                        if (data[0] !== 0x05) {
                            settleReject(new Error('Invalid SOCKS5 response'));
                            return;
                        }
                        const method = data[1];
                        if (method === 0x02 && proxy.username && proxy.password) {
                            // Username/password auth
                            step = 'auth';
                            const userBuf = Buffer.from(proxy.username);
                            const passBuf = Buffer.from(proxy.password);
                            socket.write(Buffer.concat([
                                Buffer.from([0x01, userBuf.length]),
                                userBuf,
                                Buffer.from([passBuf.length]),
                                passBuf
                            ]));
                        } else if (method === 0x00) {
                            // No auth, proceed to connect
                            step = 'connect';
                            sendConnectRequest();
                        } else {
                            settleReject(new Error('SOCKS5 authentication method not supported'));
                        }
                    } else if (step === 'auth') {
                        if (data[1] !== 0x00) {
                            settleReject(new Error('SOCKS5 authentication failed'));
                            return;
                        }
                        step = 'connect';
                        sendConnectRequest();
                    } else if (step === 'connect') {
                        connectReply = connectReply.length === 0
                            ? data
                            : Buffer.concat([connectReply, data]);
                        const replyLength = socks5ConnectReplyLength(connectReply);
                        if (replyLength === null) return;
                        socket.removeListener('data', onData);
                        if (replyLength < 0) {
                            settleReject(new Error('Invalid SOCKS5 connect reply'));
                            return;
                        }
                        if (connectReply[1] === 0x00) {
                            restoreTrailingSocketBytes(socket, connectReply.subarray(replyLength));
                            settleResolve();
                        } else {
                            const errors = {
                                0x01: 'General failure',
                                0x02: 'Connection not allowed',
                                0x03: 'Network unreachable',
                                0x04: 'Host unreachable',
                                0x05: 'Connection refused',
                                0x06: 'TTL expired',
                                0x07: 'Command not supported',
                                0x08: 'Address type not supported',
                            };
                            settleReject(new Error(`SOCKS5 error: ${errors[connectReply[1]] || 'Unknown'}`));
                        }
                    }
                };

                const sendConnectRequest = () => {
                    // SOCKS5 connect request
                    const hostBuf = Buffer.from(targetHost);
                    const request = Buffer.concat([
                        Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                        hostBuf,
                        Buffer.from([(targetPort >> 8) & 0xff, targetPort & 0xff])
                    ]);
                    socket.write(request);
                };

                socket.on('data', onData);
            });
            enableTcpNoDelay(socket);
            try { onSocket?.(socket); } catch { /* ignore */ }
            armHandshakeTimeout();
            socket.on('error', settleReject);
        } else {
            reject(new Error(`Unknown proxy type: ${proxy.type}`));
        }
    });
}

module.exports = {
    createProxySocket,
    runWhenProxyConnectionReady,
    substituteProxyCommand,
};
