// mcp-client.js — a small, self-contained Model Context Protocol client.
//
// DESIGN CHOICE (stated for the record): this is a HAND-ROLLED JSON-RPC client,
// not the official @modelcontextprotocol/sdk. Reasons:
//   1. Zero new dependencies. This app ships express/ws/chokidar/cors and nothing
//      else; the whole MCP surface CW-8 needs is three calls (initialize,
//      tools/list, tools/call) over one transport (stdio). A hand-rolled client is
//      ~200 lines we own and can read end to end, versus a transitive dep tree we
//      would have to vet on a machine that runs against real network kit.
//   2. Full control of the safety-critical bits: per-request timeouts, honest
//      errors that never fabricate a tool result, and a clean seam for the
//      connector's read-only posture + secret scrubbing to sit on top.
// If a future wave needs SSE/HTTP streaming or elicitation, the official SDK
// (pure-Node, vetted) is the upgrade path — this client is deliberately the small
// floor, not a ceiling.
//
// SCOPE: ONE server per instance. stdio transport (spawn a server process) is
// implemented in full. Everything is promise-based with a timeout on every
// request, so a stuck server can never hang a caller forever — it returns an
// honest "timed out", never a made-up answer.

const { spawn } = require('child_process');

const PROTOCOL_VERSION = '2024-11-05';
const DEFAULT_TIMEOUT_MS = 15000;
// Hard ceiling on the stdout read buffer. A well-behaved MCP server frames every
// message as ONE line (no embedded newlines) terminated by "\n", so the buffer
// only ever holds one in-flight frame. A misbehaving/hostile server that streams
// bytes without a newline would otherwise grow this buffer without limit (the
// per-request timeout rejects the promise but does NOT stop the accumulation).
// So the buffer is CAPPED: exceed it before a complete frame arrives and the
// connection is dropped with an honest error — bounded memory, never an OOM, and
// never a fabricated result. 16MB is comfortably above any real device transcript.
const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

class McpClient {
  // opts: { name, transport:'stdio', command, args?, env?, cwd?, timeoutMs? }
  constructor(opts = {}) {
    this.name = opts.name || 'mcp-server';
    this.transport = opts.transport || 'stdio';
    this.command = opts.command || null;
    this.args = Array.isArray(opts.args) ? opts.args : [];
    this.env = opts.env || null;
    this.cwd = opts.cwd || null;
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxBufferBytes = opts.maxBufferBytes && opts.maxBufferBytes > 0
      ? opts.maxBufferBytes : DEFAULT_MAX_BUFFER_BYTES;

    this.proc = null;
    this.connected = false;
    this.serverInfo = null;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer, method }
    this._buf = '';
    this._closedReason = null;
    this._overflowed = false;
  }

  // ── Connect: spawn the process and run the MCP initialize handshake ─────────
  // Honest on every failure: a bad command, a process that dies, or a server that
  // never answers initialize all reject with a clear reason — never a fake ok.
  async connect() {
    if (this.transport !== 'stdio') {
      throw new Error(`transport "${this.transport}" is not supported by this client (stdio only)`);
    }
    if (!this.command) throw new Error('no command configured for this stdio MCP server');

    await new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.proc = spawn(this.command, this.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: this.env ? { ...process.env, ...this.env } : process.env,
          cwd: this.cwd || undefined,
        });
      } catch (err) {
        return reject(new Error(`could not spawn "${this.command}": ${err.message}`));
      }

      const onSpawnError = (err) => {
        if (settled) return;
        settled = true;
        reject(new Error(`could not spawn "${this.command}": ${err.message}`));
      };
      this.proc.once('error', onSpawnError);

      // A process that exits before/without answering is a dead server, not a
      // silent success. Fail every in-flight request with the exit detail.
      this.proc.once('exit', (code, signal) => {
        // Keep the honest overflow reason if we killed the process for that.
        if (!this._overflowed) this._closedReason = `server process exited (code ${code}${signal ? `, signal ${signal}` : ''})`;
        this.connected = false;
        this._failAllPending(new Error(this._closedReason));
        if (!settled) { settled = true; reject(new Error(this._closedReason)); }
      });

      this.proc.stdout.on('data', (chunk) => this._onStdout(chunk));
      // stderr is the server's own log stream in MCP stdio; never parsed as a
      // message, never surfaced as a tool result. Kept only for a connect error.
      this._stderr = '';
      this.proc.stderr.on('data', (c) => { this._stderr = (this._stderr + c.toString()).slice(-2000); });

      // Give the process a tick to fail-to-spawn before we try to initialize.
      this.proc.stdout.once('readable', () => {});
      this.proc.removeListener('error', onSpawnError);
      this.proc.on('error', (err) => {
        this._closedReason = err.message;
        this.connected = false;
        this._failAllPending(err);
      });
      settled = true;
      resolve();
    });

    // The MCP initialize handshake.
    let init;
    try {
      init = await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'noc-triage', version: '1.0.0' },
      });
    } catch (err) {
      const detail = this._stderr ? ` (server stderr: ${this._stderr.trim().slice(0, 300)})` : '';
      try { this.close(); } catch (e) { /* ignore */ }
      throw new Error(`MCP initialize failed for "${this.name}": ${err.message}${detail}`);
    }
    this.serverInfo = (init && init.serverInfo) || null;
    // Tell the server we are ready (fire-and-forget notification, per spec).
    this._notify('notifications/initialized', {});
    this.connected = true;
    return { serverInfo: this.serverInfo, protocolVersion: init && init.protocolVersion };
  }

  // ── tools/list ──────────────────────────────────────────────────────────────
  async listTools() {
    const res = await this._request('tools/list', {});
    const tools = (res && Array.isArray(res.tools)) ? res.tools : [];
    // Normalise to just what the connector needs, keeping the safety annotations
    // the read-only posture is decided from. Never invent a tool.
    return tools.map((t) => ({
      name: String(t.name || ''),
      description: t.description ? String(t.description) : '',
      inputSchema: t.inputSchema || t.input_schema || null,
      annotations: t.annotations || null,
    })).filter((t) => t.name);
  }

  // ── tools/call ────────────────────────────────────────────────────────────
  // Returns the REAL server result: { isError, content:[...], text }. A protocol
  // error rejects; a tool-level error comes back with isError:true and the real
  // error content — never a fabricated success.
  async callTool(name, args) {
    const res = await this._request('tools/call', { name, arguments: args || {} });
    const content = (res && Array.isArray(res.content)) ? res.content : [];
    const text = content
      .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    return { isError: !!(res && res.isError), content, text, raw: res };
  }

  // ── low-level JSON-RPC over stdio ───────────────────────────────────────────
  _request(method, params) {
    if (!this.proc || this.proc.killed) {
      return Promise.reject(new Error(this._closedReason || 'server process is not running'));
    }
    const id = this._nextId++;
    const msg = { jsonrpc: '2.0', id, method, params: params || {} };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this._pending.has(id)) {
          this._pending.delete(id);
          reject(new Error(`"${method}" timed out after ${this.timeoutMs}ms (server did not answer)`));
        }
      }, this.timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this._pending.set(id, { resolve, reject, timer, method });
      try {
        this.proc.stdin.write(JSON.stringify(msg) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(new Error(`could not write "${method}" to the server: ${err.message}`));
      }
    });
  }

  _notify(method, params) {
    if (!this.proc || this.proc.killed) return;
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
    } catch (err) { /* a failed notification must never throw into a caller */ }
  }

  _onStdout(chunk) {
    if (this._overflowed) return; // connection already dropped — stop accumulating
    this._buf += chunk.toString();
    // Newline-delimited JSON framing (MCP stdio): one message per line.
    let idx;
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { continue; } // ignore non-JSON log noise
      this._dispatch(msg);
    }
    // BOUNDED BUFFER: whatever is left is an incomplete frame. If it has grown
    // past the cap without a terminating newline, the server is misbehaving —
    // drop the connection honestly rather than let memory grow without limit.
    if (this._buf.length > this.maxBufferBytes) this._overflow();
  }

  // Tear the connection down because the read buffer blew its cap. Bounded memory,
  // honest error, no fabricated result: every in-flight request rejects with the
  // reason, the buffer is released, and the server process is killed. connect()'s
  // catch turns this into "server unavailable + reason" at the connector.
  _overflow() {
    this._overflowed = true;
    this.connected = false;
    const reason = `MCP server "${this.name}" exceeded the ${this.maxBufferBytes}-byte message buffer ` +
      `without sending a complete message — dropped the connection to avoid unbounded memory (no fabricated result).`;
    this._closedReason = reason;
    this._buf = ''; // release the accumulated bytes immediately
    this._failAllPending(new Error(reason));
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) { /* ignore */ }
      try { this.proc.kill(); } catch (e) { /* ignore */ }
    }
  }

  _dispatch(msg) {
    // We only issue requests, so we only handle responses (id present). Server
    // notifications/requests are ignored in this minimal client.
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && this._pending.has(msg.id)) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) {
        const e = msg.error;
        p.reject(new Error(`server error ${e.code != null ? e.code : ''}: ${e.message || 'unknown error'}`.trim()));
      } else {
        p.resolve(msg.result);
      }
    }
  }

  _failAllPending(err) {
    for (const [id, p] of this._pending) {
      clearTimeout(p.timer);
      try { p.reject(err); } catch (e) { /* ignore */ }
      this._pending.delete(id);
    }
  }

  close() {
    this.connected = false;
    if (this.proc) {
      try { this.proc.stdin.end(); } catch (e) { /* ignore */ }
      try { this.proc.kill(); } catch (e) { /* ignore */ }
    }
    this._failAllPending(new Error(this._closedReason || 'client closed'));
  }
}

module.exports = { McpClient, PROTOCOL_VERSION };
