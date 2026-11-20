// Zero-dependency Web Push (RFC 8292 VAPID ES256 + RFC 8291 aes128gcm)
// using Node.js built-in node:crypto and fetch.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubJwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const rawPub = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(pubJwk.x, 'base64url'),
    Buffer.from(pubJwk.y, 'base64url'),
  ]);
  return {
    publicKey: rawPub.toString('base64url'),
    privateJwk: privJwk,
  };
}

export function loadOrCreateVapidKeys(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const filePath = path.join(dataDir, 'vapid.json');
  if (fs.existsSync(filePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (typeof parsed?.publicKey === 'string' && parsed?.privateJwk?.d) {
        return parsed;
      }
    } catch {
      // regenerate if corrupted
    }
  }
  const keys = generateVapidKeys();
  fs.writeFileSync(filePath, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

export function createVapidAuthHeader(endpoint, vapidKeys, subject = 'mailto:noreply@decloc.local') {
  const origin = new URL(endpoint).origin;
  const headerB64 = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const claimsB64 = Buffer.from(
    JSON.stringify({
      aud: origin,
      exp: Math.floor(Date.now() / 1000) + 12 * 3600,
      sub: subject,
    })
  ).toString('base64url');

  const unsigned = `${headerB64}.${claimsB64}`;
  const privKeyObj = crypto.createPrivateKey({ key: vapidKeys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned, 'utf8'), {
    key: privKeyObj,
    dsaEncoding: 'ieee-p1363',
  });
  const jwt = `${unsigned}.${sig.toString('base64url')}`;
  return `vapid t=${jwt}, k=${vapidKeys.publicKey}`;
}

export function encryptWebPushPayload(subscription, payloadStr) {
  const uaPublic = Buffer.from(subscription.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(subscription.keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error('Invalid subscription p256dh key');
  }
  if (authSecret.length !== 16) {
    throw new Error('Invalid subscription auth secret');
  }

  const asEcdh = crypto.createECDH('prime256v1');
  const asPublic = asEcdh.generateKeys();
  const ecdhSecret = asEcdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);

  // RFC 8291 Section 3.3 & 3.4 key schedule
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16)
  );
  const nonce = Buffer.from(
    crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12)
  );

  // RFC 8188 single final record delimiter (0x02)
  const padded = Buffer.concat([Buffer.from(payloadStr, 'utf8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final(), cipher.getAuthTag()]);

  const rsBuf = Buffer.alloc(4);
  rsBuf.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, rsBuf, Buffer.from([asPublic.length]), asPublic]);
  return Buffer.concat([header, encrypted]);
}

export async function sendWebPush(subscription, payloadObj, vapidKeys, { urgency = 'high', ttl = 86400 } = {}) {
  const endpoint = subscription?.endpoint;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) {
    return { ok: false, gone: true, status: 0 };
  }

  const body = encryptWebPushPayload(subscription, JSON.stringify(payloadObj));
  const authHeader = createVapidAuthHeader(endpoint, vapidKeys);

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      TTL: String(ttl),
      Urgency: urgency,
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      'Content-Length': String(body.length),
      Authorization: authHeader,
    },
    body,
    signal: AbortSignal.timeout(10000),
  });

  return {
    ok: res.ok,
    status: res.status,
    gone: res.status === 404 || res.status === 410,
  };
}
