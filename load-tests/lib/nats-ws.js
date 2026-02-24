/**
 * Minimal NATS client over k6 WebSocket.
 *
 * Implements just enough of the NATS text protocol to:
 *  - authenticate via token (auth callout)
 *  - SUB / UNSUB / PUB / request-reply
 *  - parse MSG and HMSG (messages with headers from TracedPublish)
 *  - handle PING/PONG keepalive
 *
 * Limitation: payload byte-length calculation assumes ASCII.
 * This is fine for JSON load-test payloads but would break on
 * multi-byte UTF-8 characters.
 */

import ws from 'k6/ws';
import { Counter, Trend } from 'k6/metrics';

// ------------------------------------------------------------------
// Shared metrics (imported by scenario scripts)
// ------------------------------------------------------------------
export const natsConnectDuration = new Trend('nats_connect_duration', true);
export const natsErrors = new Counter('nats_errors');

// ------------------------------------------------------------------
// Binary helpers — NATS WS uses binary frames containing text protocol
// ------------------------------------------------------------------

function encode(str) {
  const buf = new ArrayBuffer(str.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < str.length; i++) {
    view[i] = str.charCodeAt(i);
  }
  return buf;
}

function decode(buf) {
  return String.fromCharCode.apply(null, new Uint8Array(buf));
}

// ------------------------------------------------------------------
// NATS WebSocket connection
// ------------------------------------------------------------------

/**
 * Open a NATS WebSocket connection, run `onReady` when the handshake
 * completes, and keep the socket open for `durationMs`.
 *
 * @param {string} url        NATS WS URL  (ws://host:9222)
 * @param {string} token      Keycloak access_token
 * @param {object} handlers   { onReady(api), onClose() }
 *   api exposes: subscribe, publish, request, socket
 * @param {number} durationMs How long to keep the connection open
 * @returns k6 ws.connect response
 */
export function connectNats(url, token, handlers, durationMs) {
  const t0 = Date.now();

  return ws.connect(url, {}, function (socket) {
    let buffer = '';
    let sidCounter = 0;
    const subs = {}; // sid -> { subject, callback }

    // ---- send helpers ----

    function sendRaw(data) {
      socket.sendBinary(encode(data));
    }

    function subscribe(subject, callback) {
      const sid = String(++sidCounter);
      subs[sid] = { subject, callback };
      sendRaw('SUB ' + subject + ' ' + sid + '\r\n');
      return sid;
    }

    function unsubscribe(sid, maxMsgs) {
      if (maxMsgs !== undefined) {
        sendRaw('UNSUB ' + sid + ' ' + maxMsgs + '\r\n');
      } else {
        sendRaw('UNSUB ' + sid + '\r\n');
      }
    }

    function publish(subject, payload) {
      const data = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      sendRaw('PUB ' + subject + ' ' + data.length + '\r\n' + data + '\r\n');
    }

    /** Fire-and-forget request with INBOX reply. */
    function request(subject, payload, timeoutMs, callback) {
      const inbox = '_INBOX.k6.' + Date.now() + '.' + Math.random().toString(36).slice(2);
      const sid = subscribe(inbox, function (_subj, replyData) {
        callback(replyData);
      });
      unsubscribe(sid, 1); // auto-unsub after one reply

      const data = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
      sendRaw('PUB ' + subject + ' ' + inbox + ' ' + data.length + '\r\n' + data + '\r\n');

      // safety timeout: clean up if no reply arrives
      if (timeoutMs) {
        socket.setTimeout(function () {
          delete subs[sid];
        }, timeoutMs);
      }
    }

    const api = { subscribe, unsubscribe, publish, request, socket };

    // ---- protocol parser ----

    function processBuffer() {
      while (true) {
        const nl = buffer.indexOf('\r\n');
        if (nl === -1) break;

        const line = buffer.substring(0, nl);

        if (line.startsWith('INFO ')) {
          buffer = buffer.substring(nl + 2);
          // Respond with CONNECT
          const cp = JSON.stringify({
            verbose: false,
            pedantic: false,
            token: token,
            lang: 'k6',
            version: '1.0.0',
            protocol: 1,
            no_responders: true,
          });
          sendRaw('CONNECT ' + cp + '\r\n');
          natsConnectDuration.add(Date.now() - t0);
          if (handlers.onReady) handlers.onReady(api);

        } else if (line.startsWith('MSG ')) {
          // MSG subject sid [reply] size\r\npayload\r\n
          const parts = line.split(' ');
          const subject = parts[1];
          const sid = parts[2];
          const payloadSize = parseInt(parts[parts.length - 1]);
          const dataStart = nl + 2;
          const needed = dataStart + payloadSize + 2;

          if (buffer.length >= needed) {
            const payload = buffer.substring(dataStart, dataStart + payloadSize);
            buffer = buffer.substring(needed);
            const entry = subs[sid];
            if (entry && entry.callback) entry.callback(subject, payload);
          } else {
            break; // incomplete — wait for more data
          }

        } else if (line.startsWith('HMSG ')) {
          // HMSG subject sid [reply] hdr_size total_size\r\n(headers+payload)\r\n
          const parts = line.split(' ');
          const subject = parts[1];
          const sid = parts[2];
          const hdrSize = parseInt(parts[parts.length - 2]);
          const totalSize = parseInt(parts[parts.length - 1]);
          const dataStart = nl + 2;
          const needed = dataStart + totalSize + 2;

          if (buffer.length >= needed) {
            const raw = buffer.substring(dataStart, dataStart + totalSize);
            buffer = buffer.substring(needed);
            // payload comes after the header block
            const payload = raw.substring(hdrSize);
            const entry = subs[sid];
            if (entry && entry.callback) entry.callback(subject, payload);
          } else {
            break;
          }

        } else if (line === 'PING') {
          buffer = buffer.substring(nl + 2);
          sendRaw('PONG\r\n');

        } else if (line === 'PONG' || line === '+OK') {
          buffer = buffer.substring(nl + 2);

        } else if (line.startsWith('-ERR')) {
          buffer = buffer.substring(nl + 2);
          natsErrors.add(1);
          console.error('NATS error: ' + line);

        } else {
          // unknown — skip
          buffer = buffer.substring(nl + 2);
        }
      }
    }

    // ---- wire up socket events ----

    socket.on('binaryMessage', function (data) {
      buffer += decode(data);
      processBuffer();
    });

    // Also handle text frames (some NATS servers may send text)
    socket.on('message', function (data) {
      buffer += data;
      processBuffer();
    });

    socket.on('error', function (e) {
      natsErrors.add(1);
      console.error('WebSocket error: ' + e.error());
    });

    socket.on('close', function () {
      if (handlers.onClose) handlers.onClose();
    });

    // auto-close after duration
    if (durationMs) {
      socket.setTimeout(function () {
        socket.close();
      }, durationMs);
    }
  });
}
