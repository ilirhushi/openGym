/* Failing to read a request body is the caller's problem, and every one of the three ways it
   happens used to be reported as a server error: a body that is not JSON answered 500 and printed
   a stack trace (reachable without a session on /api/login/verify), a body over MAX_BODY had its
   socket destroyed with no status at all, and a browser hanging up mid-body — which is what
   pagehide does to an in-flight sync — printed a stack trace per request.

   Raw sockets throughout: an oversize upload has to be observed while the client is still
   sending, and an abort has to be a real hang-up. Real server.js in a child. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const API = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = crypto.randomBytes(32).toString('hex');
const MAX_BODY = 5 * 1024 * 1024;         // server.js

function mintSession(uid) {
  const payload = `${uid}:${Date.now() + 86400000}:0`;
  return payload + '.' + crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

const freePort = () => new Promise(r => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
});

async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gym-bodyerr-'));
  fs.writeFileSync(path.join(dataDir, 'secret'), SECRET, { mode: 0o600 });
  fs.writeFileSync(path.join(dataDir, 'db.json'), JSON.stringify({
    users: [{ id: 'u_body_1', name: 'One', created: new Date().toISOString() }], creds: [], subs: [], invites: []
  }));
  const port = await freePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: API, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ORIGIN: 'http://localhost:8080', RP_ID: 'localhost' }
  });
  const h = { api: `http://127.0.0.1:${port}`, port, dataDir, log: '', exited: null };
  child.stdout.on('data', d => h.log += d);
  child.stderr.on('data', d => h.log += d);
  child.on('exit', (code, signal) => { h.exited = { code, signal }; });
  t.after(() => { child.kill('SIGKILL'); fs.rmSync(dataDir, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${h.api}/api/health`)).ok; } catch { /* not up yet */ }
    if (!up) await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(up, `server never came up:\n${h.log}`);
  h.cookie = `gymsid=${mintSession('u_body_1')}`;
  return h;
}

/* One request over a socket we drive ourselves. `write` is called with the socket once the
   headers are out, so a test can trickle, flood or hang up as it likes; the promise settles with
   whatever came back (or 'reset' / 'closed' if nothing did). No Origin header: no browser sent
   this, which is what csrfOk already allows. */
function raw(h, requestLine, headers, write) {
  return new Promise(resolve => {
    let got = '';
    const s = net.connect(h.port, '127.0.0.1', () => {
      s.write(`${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n${headers}\r\n`);
      write(s, () => resolve(got || 'closed'));
    });
    s.on('data', d => {
      got += d;
      if (got.includes('\r\n\r\n')) { s.destroy(); resolve(got); }
    });
    s.on('error', e => resolve(got || 'reset:' + e.code));
    s.on('close', () => resolve(got || 'closed'));
  });
}
const statusOf = r => +(/^HTTP\/1\.1 (\d+)/.exec(r)?.[1] || 0);
const stackLines = log => log.split('\n').filter(l => /^\s+at /.test(l));

test('a body that is not JSON is a 400 the caller can read, not a 500 with a stack', async t => {
  const h = await startServer(t);
  const body = '{"state":';                             // truncated mid-object
  const r = await raw(h, 'PUT /api/data',
    `Cookie: ${h.cookie}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n`,
    s => s.write(body));

  assert.equal(statusOf(r), 400, r.slice(0, 200));
  assert.match(r, /"error":"bad json"/);
  // The whole body was read, so this socket is still good: only the 413 below closes one.
  assert.doesNotMatch(r, /[Cc]onnection: close/, 'a 400 does not cost the client its connection');
  assert.equal(h.exited, null);
  assert.deepEqual(stackLines(h.log), [], `nothing to trace:\n${h.log}`);
  assert.equal(h.log.includes('server error'), false, 'it was never a server error');
});

test('a body over the limit gets a 413 and the socket closed, not a socket destroyed mid-upload', async t => {
  const h = await startServer(t);
  const claimed = MAX_BODY + 1024 * 1024;
  const chunk = Buffer.alloc(256 * 1024, 0x20);         // spaces: still being read as JSON
  const r = await raw(h, 'PUT /api/data',
    `Cookie: ${h.cookie}\r\nContent-Type: application/json\r\nContent-Length: ${claimed}\r\n`,
    s => {
      // Keep sending past the limit — the point is that the answer arrives while we are still
      // uploading, rather than the connection disappearing under us.
      s.write('{"state":{"pad":"');
      let sent = 0;
      const pump = () => {
        while (sent < claimed) { sent += chunk.length; if (!s.write(chunk)) return s.once('drain', pump); }
      };
      pump();
    });

  assert.equal(statusOf(r), 413, r.slice(0, 200));
  assert.match(r, /"error":"body too large"/);
  assert.match(r, /[Cc]onnection: close/, 'the rest of the body is never read, so the socket cannot be reused');
  assert.equal(h.exited, null);
  assert.deepEqual(stackLines(h.log), [], `nothing to trace:\n${h.log}`);

  // and the server is still serving on a fresh connection
  assert.equal((await fetch(`${h.api}/api/health`)).status, 200);
});

test('a client that hangs up mid-body costs one log line and no stack', async t => {
  const h = await startServer(t);
  const aborts = 5;
  for (let i = 0; i < aborts; i++) {
    await raw(h, 'PUT /api/data',
      `Cookie: ${h.cookie}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n`,
      (s, done) => { s.write('{"state":{'); setTimeout(() => { s.destroy(); done(); }, 60); });
  }
  await new Promise(r => setTimeout(r, 300));

  assert.equal(h.exited, null);
  assert.deepEqual(stackLines(h.log), [], `nothing to trace:\n${h.log}`);
  assert.equal((h.log.match(/client went away mid-body/g) || []).length, aborts, `one line each:\n${h.log}`);
  assert.equal(fs.existsSync(path.join(h.dataDir, 'state-u_body_1.json')), false, 'and nothing was written');
  assert.equal((await fetch(`${h.api}/api/health`)).status, 200);
});
