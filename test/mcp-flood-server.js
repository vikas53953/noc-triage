#!/usr/bin/env node
// mcp-flood-server.js — a HOSTILE stub for the buffer-cap test. It ignores the MCP
// protocol entirely and floods stdout with bytes and NEVER a newline, so the
// client's read buffer would grow without limit unless it is capped. Proves the
// client caps + disconnects honestly (bounded memory, no OOM, no fabricated
// result). It stays alive until the client kills it.

const chunk = 'x'.repeat(64 * 1024); // 64KB per write, no newline ever
function pump() {
  // Keep writing until backpressure, then resume on drain — a relentless flood.
  let okToContinue = true;
  while (okToContinue) okToContinue = process.stdout.write(chunk);
  process.stdout.once('drain', pump);
}
pump();
// Ignore stdin; never respond to initialize. The point is the flood, not a reply.
process.stdin.resume();
