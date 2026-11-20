import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDecLocServer } from '../relay/server.mjs';
import {
  generateVapidKeys,
  createVapidAuthHeader,
  encryptWebPushPayload,
} from '../relay/webpush.mjs';
import { normalizeNtfyUrl } from '../js/notify.js';
import {
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  signNostrEvent,
  generateMasterSeed,
  deriveHandleTag,
  resolveUniqueHandleTag,
} from '../js/crypto.js';
import { RelayPool } from '../js/nostr.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'decloc-relay-test-'));
}

test('DecLoc Chat server serves static app, auto-discovery, NIP-11, and blocks private server paths', async () => {
  const dataDir = makeTempDir();
  const srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  const info = await srv.start();

  try {
    // 1. Serves index.html
    const home = await fetch(`${info.httpUrl}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const html = await home.text();
    assert.ok(html.includes('js/app.js'));

    // 2. Serves self-hosted relay auto-discovery JSON (including VAPID public key)
    const disc = await fetch(`${info.httpUrl}/decloc-relay.json`);
    assert.equal(disc.status, 200);
    const discJson = await disc.json();
    assert.equal(discJson.selfHostedRelay, true);
    assert.equal(discJson.wsPath, '/relay');
    assert.equal(typeof discJson.vapidPublicKey, 'string');
    const rawVapidPub = Buffer.from(discJson.vapidPublicKey, 'base64url');
    assert.equal(rawVapidPub.length, 65);
    assert.equal(rawVapidPub[0], 0x04);

    // 3. Serves health endpoint
    const health = await fetch(`${info.httpUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);
    assert.equal(healthJson.storage, 'sqlite');

    // 4. Serves NIP-11 relay info
    const nip11 = await fetch(`${info.httpUrl}/relay`, {
      headers: { Accept: 'application/nostr+json' },
    });
    assert.equal(nip11.status, 200);
    const nip11Json = await nip11.json();
    assert.ok(nip11Json.supported_nips.includes(9));

    // 5. Blocks access to server code, database dir, tests, and hidden files
    assert.equal((await fetch(`${info.httpUrl}/relay/server.mjs`)).status, 403);
    assert.equal((await fetch(`${info.httpUrl}/tests/crypto.test.mjs`)).status, 403);
    assert.equal((await fetch(`${info.httpUrl}/.gitignore`)).status, 403);
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('DecLoc Chat SQLite relay persists across restarts, blocks spam/bad sigs, handles ephemeral & NIP-09 self-only deletion', async () => {
  const dataDir = makeTempDir();
  const room = await deriveRoomSecrets('Termux Tuba', 'salakood-2026');
  const aliceId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  const bobId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

  let srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  let info = await srv.start();
  let aliceMsgEv;

  try {
    // Connect Alice & Bob via real RelayPool to /relay
    const bobMsgs = [];
    const bobEphemeral = [];
    let readyA, readyB;
    const pA = new Promise((r) => (readyA = r));
    const pB = new Promise((r) => (readyB = r));

    const alicePool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyA();
      },
    });
    const bobPool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyB();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (!pt) return;
        if (ev.kind === 20042) bobEphemeral.push(pt);
        else bobMsgs.push({ ev, pt });
      },
    });

    await Promise.all([pA, pB]);
    alicePool.setSubscribedChannels([room.channelId]);
    bobPool.setSubscribedChannels([room.channelId]);
    await new Promise((r) => setTimeout(r, 60));

    // 1. Alice sends persisted encrypted message (kind 42)
    aliceMsgEv = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Mari',
          text: 'Säilib üle restardi!',
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(aliceMsgEv);

    // 2. Alice sends ephemeral typing signal (kind 20042) — delivered live, NOT persisted
    const typingEv = await signNostrEvent(
      {
        kind: 20042,
        tags: [['e', room.channelId]],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'typing',
          name: 'Mari',
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(typingEv);

    // 3. Spam kind: 1 and tampered signature must NOT be stored
    const spamEv = await signNostrEvent({ kind: 1, tags: [], content: 'spam' }, bobId.privKeyBytes);
    const tamperedEv = { ...aliceMsgEv, content: aliceMsgEv.content + 'bad' };
    alicePool.publish(spamEv);
    alicePool.publish(tamperedEv);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(bobMsgs.length, 1);
    assert.equal(bobMsgs[0].pt.text, 'Säilib üle restardi!');
    assert.equal(bobEphemeral.length, 1);
    assert.equal(bobEphemeral[0].t, 'typing');
    assert.equal(srv.store.count(), 1); // ONLY aliceMsgEv persisted!

    // 4. Bob tries forged NIP-09 deletion of Alice's event -> MUST FAIL
    const forgedDel = await signNostrEvent(
      { kind: 5, tags: [['e', aliceMsgEv.id], ['k', '42']], content: '' },
      bobId.privKeyBytes
    );
    bobPool.publish(forgedDel);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.count(), 1);

    alicePool.destroy();
    bobPool.destroy();
  } finally {
    await srv.stop();
  }

  // 5. Simulate phone reboot: start brand new server instance pointing at SAME dataDir!
  srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  info = await srv.start();

  try {
    assert.equal(srv.store.count(), 1);

    // Fresh client connects after reboot and receives Alice's persisted message from SQLite
    const recovered = [];
    let readyC;
    const pC = new Promise((r) => (readyC = r));
    const clientPool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) readyC();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (pt) recovered.push(pt);
      },
    });
    await pC;
    clientPool.setSubscribedChannels([room.channelId]);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].text, 'Säilib üle restardi!');

    // 6. Alice now legitimately deletes her own message via NIP-09 -> physically wiped from SQLite!
    const legitDel = await signNostrEvent(
      { kind: 5, tags: [['e', aliceMsgEv.id], ['k', '42']], content: '' },
      aliceId.privKeyBytes
    );
    clientPool.publish(legitDel);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(srv.store.count(), 0);
    clientPool.destroy();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Web Push RFC 8292 VAPID ES256 signature and RFC 8291 aes128gcm encryption roundtrip', () => {
  const vapidKeys = generateVapidKeys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-token-123';
  const authHeader = createVapidAuthHeader(endpoint, vapidKeys);

  // 1. Verify RFC 8292 VAPID Authorization header format & ES256 signature
  const m = authHeader.match(/^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/);
  assert.ok(m, 'Authorization header must match RFC 8292 format');
  const [, headerB64, claimsB64, sigB64, pubB64] = m;
  assert.equal(pubB64, vapidKeys.publicKey);
  const claims = JSON.parse(Buffer.from(claimsB64, 'base64url').toString('utf8'));
  assert.equal(claims.aud, 'https://fcm.googleapis.com');

  const pubKeyObj = crypto.createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: vapidKeys.privateJwk.x,
      y: vapidKeys.privateJwk.y,
    },
    format: 'jwk',
  });
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${headerB64}.${claimsB64}`, 'utf8'),
    { key: pubKeyObj, dsaEncoding: 'ieee-p1363' },
    Buffer.from(sigB64, 'base64url')
  );
  assert.equal(verified, true);

  // 2. Verify RFC 8291 aes128gcm payload encryption by decrypting as a browser Push User Agent
  const uaEcdh = crypto.createECDH('prime256v1');
  const uaPublic = uaEcdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const sub = {
    endpoint,
    keys: {
      p256dh: uaPublic.toString('base64url'),
      auth: authSecret.toString('base64url'),
    },
  };

  const payload = { title: 'DecLoc Chat', body: 'New encrypted message', channelId: 'a'.repeat(64), type: 'msg' };
  const body = encryptWebPushPayload(sub, JSON.stringify(payload));

  // Parse RFC 8188 header: salt(16) || rs(4) || idlen(1) || asPublic(idlen) || ciphertext || tag(16)
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  assert.equal(rs, 4096);
  const idlen = body[20];
  assert.equal(idlen, 65);
  const asPublic = body.subarray(21, 21 + idlen);
  const encWithTag = body.subarray(21 + idlen);
  const ciphertext = encWithTag.subarray(0, encWithTag.length - 16);
  const tag = encWithTag.subarray(encWithTag.length - 16);

  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12));

  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assert.equal(decrypted[decrypted.length - 1], 0x02);
  const parsed = JSON.parse(decrypted.subarray(0, decrypted.length - 1).toString('utf8'));
  assert.deepEqual(parsed, payload);
});

test('Server Web Push API dispatches messages & calls, skips sender, ignores non-notify events, and prunes 410 endpoints', async () => {
  const dataDir = makeTempDir();
  const sentPushes = [];
  const srv = await createDecLocServer({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    sendPushFn: async (subscription, payload) => {
      sentPushes.push({ endpoint: subscription.endpoint, payload });
      if (subscription.endpoint.includes('stale-device')) {
        return { ok: false, gone: true, status: 410 };
      }
      return { ok: true, gone: false, status: 201 };
    },
  });
  const info = await srv.start();

  try {
    const room = await deriveRoomSecrets('Push Tuba', 'push-secret-2026');
    const aliceId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
    const bobId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

    const makeFakeSub = (endpoint) => ({
      endpoint,
      keys: {
        p256dh: crypto.createECDH('prime256v1').generateKeys().toString('base64url'),
        auth: crypto.randomBytes(16).toString('base64url'),
      },
    });

    const aliceSub = makeFakeSub('https://push.example.test/alice');
    const bobSub = makeFakeSub('https://push.example.test/bob');
    const staleSub = makeFakeSub('https://push.example.test/stale-device');

    for (const [sub, pk] of [
      [aliceSub, aliceId.pubkeyHex],
      [bobSub, bobId.pubkeyHex],
      [staleSub, bobId.pubkeyHex],
    ]) {
      const res = await fetch(`${info.httpUrl}/api/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subscription: sub,
          channels: [room.channelId],
          senderPubkeys: [pk],
        }),
      });
      assert.equal(res.status, 200);
    }

    let ready;
    const connected = new Promise((r) => (ready = r));
    const alicePool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) ready();
      },
    });
    await connected;

    // 1. Alice sends chat message with ['p_notify', '1'] -> Bob & stale device notified; Alice skipped!
    const msgEv = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root'], ['p_notify', '1']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Alice',
          text: 'Top secret text',
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(msgEv);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(sentPushes.length, 2);
    const endpoints1 = sentPushes.map((p) => p.endpoint).sort();
    assert.deepEqual(endpoints1, [bobSub.endpoint, staleSub.endpoint]);
    assert.equal(sentPushes[0].payload.type, 'msg');
    assert.equal(sentPushes[0].payload.channelId, room.channelId);
    assert.ok(!JSON.stringify(sentPushes[0].payload).includes('Top secret'));

    // 2. Alice sends read receipt WITHOUT p_notify -> 0 pushes
    sentPushes.length = 0;
    const readEv = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: 'ciphertext',
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(readEv);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sentPushes.length, 0);

    // 3. Alice starts call with ['p_notify', 'call'] -> ONLY Bob notified (stale device already pruned on 410!)
    const callEv = await signNostrEvent(
      {
        kind: 20042,
        tags: [['e', room.channelId], ['p_notify', 'call']],
        content: 'ciphertext',
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(callEv);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sentPushes.length, 1);
    assert.equal(sentPushes[0].endpoint, bobSub.endpoint);
    assert.equal(sentPushes[0].payload.type, 'call');

    // 4. Bob unsubscribes -> next Alice message sends 0 pushes
    sentPushes.length = 0;
    const unsubRes = await fetch(`${info.httpUrl}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: bobSub.endpoint }),
    });
    assert.equal(unsubRes.status, 200);

    const msgEv2 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root'], ['p_notify', '1']],
        content: 'ciphertext-2',
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(msgEv2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(sentPushes.length, 0);

    alicePool.destroy();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('normalizeNtfyUrl accepts safe HTTPS topics and rejects unsafe/invalid inputs', () => {
  assert.equal(normalizeNtfyUrl('decloc-secret-123'), 'https://ntfy.sh/decloc-secret-123');
  assert.equal(normalizeNtfyUrl('ntfy.sh/my-topic/'), 'https://ntfy.sh/my-topic');
  assert.equal(normalizeNtfyUrl('https://ntfy.example.org/group-99'), 'https://ntfy.example.org/group-99');
  assert.equal(normalizeNtfyUrl('http://ntfy.sh/insecure'), '');
  assert.equal(normalizeNtfyUrl('https://ntfy.sh/'), '');
  assert.equal(normalizeNtfyUrl(''), '');
});

test('Member archive scrubs names/messages via NIP-09 and leaves only nameless archived-xxxx with permanently reserved tags', async () => {
  const dataDir = makeTempDir();
  const srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  const info = await srv.start();

  try {
    const room = await deriveRoomSecrets('Liikmete Tuba', 'arhiiv-saladus');
    const aliceId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

    let ready;
    const connected = new Promise((r) => (ready = r));
    const alicePool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) ready();
      },
    });
    await connected;

    const tagJaan = deriveHandleTag(aliceId.pubkeyHex, room.channelId, 'Jaan');
    const tagOtt = deriveHandleTag(aliceId.pubkeyHex, room.channelId, 'Ott');

    // 1. Alice joins as Jaan, sends a message, then renames to Ott
    const nick1 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1, t: 'nick', name: 'Jaan', prevName: null, seq: 1, prevHash: 'GENESIS', ts: Date.now() - 2000,
        }),
      },
      aliceId.privKeyBytes
    );
    const msg1 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1, t: 'msg', name: 'Jaan', text: 'Tere kõigile!', ts: Date.now() - 1500,
        }),
      },
      aliceId.privKeyBytes
    );
    const nick2 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1, t: 'nick', name: 'Ott', prevName: 'Jaan', seq: 2, prevHash: 'prev', ts: Date.now() - 1000,
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(nick1);
    alicePool.publish(msg1);
    alicePool.publish(nick2);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(srv.store.count(), 3);

    // 2. Alice deletes all her data & archives -> NIP-09 deletes msg1 + nick1 + nick2, leaves ONLY nameless t:'archive'
    const nip09All = await signNostrEvent(
      {
        kind: 5,
        tags: [['e', msg1.id], ['e', nick1.id], ['e', nick2.id], ['k', '42']],
        content: '',
      },
      aliceId.privKeyBytes
    );
    const archiveEv = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, aliceId.pubkeyHex, room.channelId, {
          v: 1,
          t: 'archive',
          lastTag: tagOtt,
          reservedTags: [tagJaan, tagOtt],
          ts: Date.now(),
        }),
      },
      aliceId.privKeyBytes
    );
    alicePool.publish(nip09All);
    alicePool.publish(archiveEv);
    await new Promise((r) => setTimeout(r, 140));

    // Only the nameless archive record remains in SQLite
    assert.equal(srv.store.count(), 1);
    alicePool.destroy();

    // 3. New member Bob joins later and verifies ONLY archived-<tagOtt> exists (zero Jaan/Ott names!)
    const bobPayloads = [];
    let bobReady;
    const bobConn = new Promise((r) => (bobReady = r));
    const bobPool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) bobReady();
      },
      onEvent: async (ev) => {
        const pt = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
        if (pt) bobPayloads.push(pt);
      },
    });
    await bobConn;
    bobPool.setSubscribedChannels([room.channelId]);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(bobPayloads.length, 1);
    assert.equal(bobPayloads[0].t, 'archive');
    assert.equal(bobPayloads[0].lastTag, tagOtt);
    assert.deepEqual(bobPayloads[0].reservedTags, [tagJaan, tagOtt]);
    assert.equal(JSON.stringify(bobPayloads[0]).includes('Jaan'), false);
    assert.equal(JSON.stringify(bobPayloads[0]).includes('Ott'), false);

    // 4. Both archived tags remain permanently reserved and cannot be reassigned
    const reservedSet = new Set(bobPayloads[0].reservedTags);
    const freshTag = resolveUniqueHandleTag(aliceId.pubkeyHex, room.channelId, 'Ott', reservedSet);
    assert.notEqual(freshTag, tagOtt);
    assert.notEqual(freshTag, tagJaan);

    bobPool.destroy();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('Room Creator & Admin Governance: init creator, grant co-admin, ban & physically wipe member, and nuke entire room on SQLite relay', async () => {
  const dataDir = makeTempDir();
  const srv = await createDecLocServer({ port: 0, host: '127.0.0.1', dataDir });
  const info = await srv.start();

  try {
    const room = await deriveRoomSecrets('Admin Tuba', 'admin-saladus-999');
    const creator = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
    const coAdmin = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
    const troll = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

    let ready;
    const conn = new Promise((r) => (ready = r));
    const pool = new RelayPool([info.wsUrl], {
      onStatusChange: (s) => {
        if (s.some((x) => x.status === 'connected')) ready();
      },
      onEvent: () => {},
    });
    await conn;
    pool.setSubscribedChannels([room.channelId]);

    // 1. Founding creator registers room creator (`d_admin_init`) and posts a message
    const initEv = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_admin_init', '1'],
        ],
        content: await encryptRoomPayload(room.aesKey, creator.pubkeyHex, room.channelId, {
          v: 1,
          t: 'gov',
          action: 'init',
          target: creator.pubkeyHex,
          ts: Date.now(),
        }),
      },
      creator.privKeyBytes
    );
    const creatorMsg = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, creator.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Jaan',
          text: 'Tere tulemast jututuppa!',
          ts: Date.now(),
        }),
      },
      creator.privKeyBytes
    );
    pool.publish(initEv);
    pool.publish(creatorMsg);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(srv.store.isRoomCreator(room.channelId, creator.pubkeyHex), true);
    assert.equal(srv.store.isRoomAdmin(room.channelId, creator.pubkeyHex), true);
    assert.equal(srv.store.isRoomAdmin(room.channelId, troll.pubkeyHex), false);

    // 2. Troll posts 2 spam messages
    const trollMsg1 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, troll.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Troll',
          text: 'Spam 1',
          ts: Date.now(),
        }),
      },
      troll.privKeyBytes
    );
    const trollMsg2 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: await encryptRoomPayload(room.aesKey, troll.pubkeyHex, room.channelId, {
          v: 1,
          t: 'msg',
          name: 'Troll',
          text: 'Spam 2',
          ts: Date.now(),
        }),
      },
      troll.privKeyBytes
    );
    pool.publish(trollMsg1);
    pool.publish(trollMsg2);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.count(), 4); // initEv + creatorMsg + trollMsg1 + trollMsg2

    // 3. Non-admin (troll) attempts to ban creator or nuke room -> REJECTED by relay!
    const fakeBan = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_admin_ban', creator.pubkeyHex],
        ],
        content: 'fake',
      },
      troll.privKeyBytes
    );
    const fakeNuke = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_room_nuke', '1'],
        ],
        content: 'fake',
      },
      troll.privKeyBytes
    );
    pool.publish(fakeBan);
    pool.publish(fakeNuke);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.isRoomBanned(room.channelId, creator.pubkeyHex), false);
    assert.equal(srv.store.count(), 4); // fakeBan & fakeNuke were rejected and not stored!

    // 4. Creator grants admin rights to coAdmin (`d_admin_grant`)
    const grantEv = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_admin_grant', coAdmin.pubkeyHex],
        ],
        content: await encryptRoomPayload(room.aesKey, creator.pubkeyHex, room.channelId, {
          v: 1,
          t: 'gov',
          action: 'grant_admin',
          target: coAdmin.pubkeyHex,
          ts: Date.now(),
        }),
      },
      creator.privKeyBytes
    );
    pool.publish(grantEv);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.isRoomAdmin(room.channelId, coAdmin.pubkeyHex), true);

    // 5. Co-admin cannot ban or demote the founding creator!
    const coupAttempt = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_admin_ban', creator.pubkeyHex],
        ],
        content: 'coup',
      },
      coAdmin.privKeyBytes
    );
    pool.publish(coupAttempt);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.isRoomBanned(room.channelId, creator.pubkeyHex), false);
    assert.equal(srv.store.isRoomAdmin(room.channelId, creator.pubkeyHex), true);

    // 6. Co-admin bans troll (`d_admin_ban`) -> troll's 2 messages are physically wiped from SQLite and troll is banned!
    const banTrollEv = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_admin_ban', troll.pubkeyHex],
        ],
        content: await encryptRoomPayload(room.aesKey, coAdmin.pubkeyHex, room.channelId, {
          v: 1,
          t: 'gov',
          action: 'ban',
          target: troll.pubkeyHex,
          ts: Date.now(),
        }),
      },
      coAdmin.privKeyBytes
    );
    pool.publish(banTrollEv);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(srv.store.isRoomBanned(room.channelId, troll.pubkeyHex), true);
    // Remaining in store: initEv + creatorMsg + grantEv + banTrollEv = 4 (both trollMsg1 & trollMsg2 physically erased!)
    assert.equal(srv.store.count(), 4);

    // 7. Banned troll tries to post another message -> blocked by relay!
    const trollMsg3 = await signNostrEvent(
      {
        kind: 42,
        tags: [['e', room.channelId, '', 'root']],
        content: 'still spamming',
      },
      troll.privKeyBytes
    );
    pool.publish(trollMsg3);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(srv.store.count(), 4);

    // 8. Admin nukes the entire room (`d_room_nuke`) -> physically deletes all room events except the nuke tombstone
    const nukeEv = await signNostrEvent(
      {
        kind: 42,
        tags: [
          ['e', room.channelId, '', 'root'],
          ['d_room_nuke', '1'],
        ],
        content: await encryptRoomPayload(room.aesKey, creator.pubkeyHex, room.channelId, {
          v: 1,
          t: 'nuke',
          by: 'Jaan-1234',
          ts: Date.now(),
        }),
      },
      creator.privKeyBytes
    );
    pool.publish(nukeEv);
    await new Promise((r) => setTimeout(r, 120));

    assert.equal(srv.store.count(), 1);
    const remaining = srv.store.query([{ kinds: [42], '#e': [room.channelId] }]);
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, nukeEv.id);

    pool.destroy();
  } finally {
    await srv.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
