import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bytesToHex,
  hexToBytes,
  sha256Hex,
  sha256SyncHex,
  getPublicKeyHex,
  schnorrSign,
  schnorrVerify,
  signNostrEvent,
  verifyNostrEvent,
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  generateMasterSeed,
  deriveMasterSeedFromPassword,
  encryptLocalVault,
  decryptLocalVault,
  generatePassphrase,
  isValidHandleTag,
  deriveHandleTag,
  resolveUniqueHandleTag,
  formatUserHandle,
  computeNameBlockHash,
  isOnionRelay,
  normalizeRelayUrl,
  encodeInviteUrl,
  decodeInviteHash,
  encryptForPeer,
  decryptFromPeer,
} from '../js/crypto.js';
import { EMOJI_CATEGORIES, searchEmojis } from '../js/emojis.js';

// Official BIP-340 test vectors (vectors 0..3)
const BIP340_VECTORS = [
  {
    name: 'vector 0',
    seckey: '0000000000000000000000000000000000000000000000000000000000000003',
    pubkey: 'f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9',
    aux: '0000000000000000000000000000000000000000000000000000000000000000',
    msg: '0000000000000000000000000000000000000000000000000000000000000000',
    sig: 'e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0',
  },
  {
    name: 'vector 1',
    seckey: 'b7e151628aed2a6abf7158809cf4f3c762e7160f38b4da56a784d9045190cfef',
    pubkey: 'dff1d77f2a671c5f36183726db2341be58feae1da2deced843240f7b502ba659',
    aux: '0000000000000000000000000000000000000000000000000000000000000001',
    msg: '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89',
    sig: '6896bd60eeae296db48a229ff71dfe071bde413e6d43f917dc8dcf8c78de33418906d11ac976abccb20b091292bff4ea897efcb639ea871cfa95f6de339e4b0a',
  },
  {
    name: 'vector 2',
    seckey: 'c90fdaa22168c234c4c6628b80dc1cd129024e088a67cc74020bbea63b14e5c9',
    pubkey: 'dd308afec5777e13121fa72b9cc1b7cc0139715309b086c960e18fd969774eb8',
    aux: 'c87aa53824b4d7ae2eb035a2b5bbbccc080e76cdc6d1692c4b0b62d798e6d906',
    msg: '7e2d58d8b3bcdf1abadec7829054f90dda9805aab56c77333024b9d0a508b75c',
    sig: '5831aaeed7b44bb74e5eab94ba9d4294c49bcf2a60728d8b4c200f50dd313c1bab745879a5ad954a72c45a91c3a51d3c7adea98d82f8481e0e1e03674a6f3fb7',
  },
  {
    name: 'vector 3 (odd-Y pubkey negation)',
    seckey: '0b432b2677937381aef05bb02a66ecd012773062cf3fa2549e44f58ed2401710',
    pubkey: '25d1dff95105f5253c4022f628a996ad3a0d95fbf21d468a1b33f8c160d8f517',
    aux: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    msg: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
    sig: '7eb0509757e246f19449885651611cb965ecc1a187dd51b64fda1edc9637d5ec97582b9cb13db3933705b32ba982af5af25fd78881ebb32771fc5922efc66ea3',
  },
];

for (const v of BIP340_VECTORS) {
  test(`BIP-340 ${v.name}`, async () => {
    const sk = hexToBytes(v.seckey);
    const pkHex = getPublicKeyHex(sk);
    assert.equal(pkHex, v.pubkey);

    const sig = await schnorrSign(hexToBytes(v.msg), sk, hexToBytes(v.aux));
    assert.equal(bytesToHex(sig), v.sig);

    const valid = await schnorrVerify(hexToBytes(v.msg), hexToBytes(v.pubkey), sig);
    assert.equal(valid, true);

    // Tampered message must fail verification
    const badMsg = hexToBytes(v.msg);
    badMsg[0] ^= 0x01;
    assert.equal(await schnorrVerify(badMsg, hexToBytes(v.pubkey), sig), false);
  });
}

test('Nostr event signing, verification, and tamper detection', async () => {
  const seed = generateMasterSeed();
  const room = await deriveRoomSecrets('Pere Jututuba', 'salajane-parool-123');
  const id = await deriveRoomIdentity(seed, room.channelId);

  const payload = { v: 1, t: 'msg', name: 'Mari', text: 'Tere maailm! 🇪🇪', ts: Date.now() };
  const encrypted = await encryptRoomPayload(room.aesKey, id.pubkeyHex, room.channelId, payload);

  const ev = await signNostrEvent(
    {
      kind: 42,
      tags: [['e', room.channelId, '', 'root']],
      content: encrypted,
    },
    id.privKeyBytes
  );

  assert.equal(await verifyNostrEvent(ev), true);

  // Decrypt with matching room secrets
  const decoded = await decryptRoomPayload(room.aesKey, ev.pubkey, room.channelId, ev.content);
  assert.deepEqual(decoded, payload);

  // Wrong passphrase fails decryption cleanly
  const wrongRoom = await deriveRoomSecrets('Pere Jututuba', 'vale-parool');
  assert.notEqual(wrongRoom.channelId, room.channelId);
  assert.equal(await decryptRoomPayload(wrongRoom.aesKey, ev.pubkey, room.channelId, ev.content), null);

  // AAD binding prevents re-signing ciphertext under another pubkey
  const otherId = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  assert.equal(await decryptRoomPayload(room.aesKey, otherId.pubkeyHex, room.channelId, ev.content), null);

  // Tampering event content invalidates Nostr signature
  assert.equal(await verifyNostrEvent({ ...ev, content: ev.content + 'x' }), false);
});

test('Per-room identities are unlinkable across different rooms', async () => {
  const seed = generateMasterSeed();
  const r1 = await deriveRoomSecrets('Tuba A', 'parool-1');
  const r2 = await deriveRoomSecrets('Tuba B', 'parool-2');
  const id1 = await deriveRoomIdentity(seed, r1.channelId);
  const id2 = await deriveRoomIdentity(seed, r2.channelId);
  assert.notEqual(id1.pubkeyHex, id2.pubkeyHex);
});

test('Invite URL encode/decode roundtrip (public & custom locked relay) + relay URL normalization', () => {
  assert.equal(normalizeRelayUrl('https://abc.trycloudflare.com'), 'wss://abc.trycloudflare.com');
  assert.equal(normalizeRelayUrl('wss://relay.example.ee/'), 'wss://relay.example.ee');
  assert.equal(normalizeRelayUrl('relay.example.ee/relay'), 'wss://relay.example.ee/relay');
  assert.equal(normalizeRelayUrl('http://localhost:7777/relay'), 'ws://localhost:7777/relay');
  assert.equal(normalizeRelayUrl('examplev3relay.onion'), 'ws://examplev3relay.onion');
  assert.equal(normalizeRelayUrl('http://examplev3relay.onion/'), 'ws://examplev3relay.onion');
  assert.equal(normalizeRelayUrl('ws://examplev3relay.onion/relay'), 'ws://examplev3relay.onion/relay');
  assert.equal(isOnionRelay('ws://examplev3relay.onion'), true);
  assert.equal(isOnionRelay('wss://nos.lol'), false);

  const pass = generatePassphrase();
  assert.match(pass, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);

  const pubUrl = encodeInviteUrl('https://chat.example.ee/index.html', {
    name: 'Sõbrad 🚀',
    passphrase: pass,
    relayMode: 'public',
  });
  const pubParsed = decodeInviteHash(pubUrl.slice(pubUrl.indexOf('#')));
  assert.deepEqual(pubParsed, {
    name: 'Sõbrad 🚀',
    passphrase: pass,
    relays: null,
    relayMode: 'public',
    customRelay: null,
  });

  const customUrl = encodeInviteUrl('https://chat.example.ee/index.html', {
    name: 'Pere',
    passphrase: pass,
    relayMode: 'custom',
    customRelay: 'wss://relay.minu.ee/relay',
  });
  const customParsed = decodeInviteHash(customUrl.slice(customUrl.indexOf('#')));
  assert.deepEqual(customParsed, {
    name: 'Pere',
    passphrase: pass,
    relays: ['wss://relay.minu.ee/relay'],
    relayMode: 'custom',
    customRelay: 'wss://relay.minu.ee/relay',
  });
});

test('Emoji catalog and Estonian/English search work offline', () => {
  assert.ok(EMOJI_CATEGORIES.length >= 8);
  assert.ok(searchEmojis('süda').includes('❤️'));
  assert.ok(searchEmojis('heart').includes('❤️'));
  assert.ok(searchEmojis('eesti').includes('🇪🇪'));
  assert.ok(searchEmojis('naer').includes('😂'));
  assert.deepEqual(searchEmojis(''), []);
});

test('Personal password derives deterministic portable identity and encrypts local device lock vault', async () => {
  const s1 = await deriveMasterSeedFromPassword('Mari', 'minu-saladus-42');
  const s2 = await deriveMasterSeedFromPassword('  mari  ', 'minu-saladus-42');
  const sWrongPass = await deriveMasterSeedFromPassword('Mari', 'vale-parool');
  const sOtherName = await deriveMasterSeedFromPassword('Jüri', 'minu-saladus-42');

  assert.equal(s1.length, 64);
  assert.equal(s1, s2);
  assert.notEqual(s1, sWrongPass);
  assert.notEqual(s1, sOtherName);

  // Same room identity across devices
  const room = await deriveRoomSecrets('Pere', 'toa-parool');
  const idA = await deriveRoomIdentity(s1, room.channelId);
  const idB = await deriveRoomIdentity(s2, room.channelId);
  assert.equal(idA.pubkeyHex, idB.pubkeyHex);

  // Local device lock vault roundtrip (password never stored!)
  const vault = await encryptLocalVault('minu-saladus-42', { masterSeed: s1 });
  assert.equal(JSON.stringify(vault).includes('minu-saladus-42'), false);
  assert.equal(JSON.stringify(vault).includes(s1), false);

  const unlocked = await decryptLocalVault('minu-saladus-42', vault);
  assert.deepEqual(unlocked, { masterSeed: s1 });
  assert.equal(await decryptLocalVault('vale-parool', vault), null);
});

test('sha256SyncHex matches WebCrypto sha256Hex bit-for-bit across edge lengths & UTF-8', async () => {
  const samples = [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(129),
    'Jaan-4ftb → Erik-3sf6 õäöü🚀',
  ];
  for (const s of samples) {
    assert.equal(sha256SyncHex(s), await sha256Hex(s));
  }
});

test('Unique per-room 4-char handle tags & verifiable name-change hash-chain', async () => {
  const roomA = await deriveRoomSecrets('Tuba A', 'parool-a');
  const roomB = await deriveRoomSecrets('Tuba B', 'parool-b');
  const user1 = await deriveRoomIdentity(generateMasterSeed(), roomA.channelId);
  const user2 = await deriveRoomIdentity(generateMasterSeed(), roomA.channelId);

  // 1. Format: Name-xxxx with 4 unambiguous alphanumeric chars (no 0/o/1/i/l)
  const h1Jaan = formatUserHandle('Jaan', user1.pubkeyHex, roomA.channelId);
  const h2Jaan = formatUserHandle('Jaan', user2.pubkeyHex, roomA.channelId);
  assert.match(h1Jaan, /^Jaan-[a-hjkmnp-z2-9]{4}$/);
  assert.match(h2Jaan, /^Jaan-[a-hjkmnp-z2-9]{4}$/);

  // 2. Two different users with identical display name "Jaan" get distinct unforgeable handles
  assert.notEqual(h1Jaan, h2Jaan);

  // 3. Case/spacing normalized deterministically for the same user
  assert.equal(
    deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Jaan'),
    deriveHandleTag(user1.pubkeyHex, roomA.channelId, '  jaan  ')
  );

  // 4. Renaming Jaan -> Erik yields a distinct tag bound to the same pubkey (e.g. Jaan-xxxx -> Erik-yyyy)
  const h1Erik = formatUserHandle('Erik', user1.pubkeyHex, roomA.channelId);
  assert.match(h1Erik, /^Erik-[a-hjkmnp-z2-9]{4}$/);
  assert.notEqual(
    deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Jaan'),
    deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Erik')
  );

  // 5. Same pubkey in different rooms yields different tags
  assert.notEqual(
    deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Jaan'),
    deriveHandleTag(user1.pubkeyHex, roomB.channelId, 'Jaan')
  );

  // 6. Hash-chain links Block #1 (Jaan) -> Block #2 (Erik) and detects any tampering
  const tag1 = deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Jaan');
  const tag2 = deriveHandleTag(user1.pubkeyHex, roomA.channelId, 'Erik');
  const b1Hash = computeNameBlockHash({
    channelId: roomA.channelId,
    pubkey: user1.pubkeyHex,
    seq: 1,
    name: 'Jaan',
    tag: tag1,
    prevHash: 'GENESIS',
    ts: 1700000001000,
  });
  const b2Hash = computeNameBlockHash({
    channelId: roomA.channelId,
    pubkey: user1.pubkeyHex,
    seq: 2,
    name: 'Erik',
    tag: tag2,
    prevHash: b1Hash,
    ts: 1700000005000,
  });
  const b2Tampered = computeNameBlockHash({
    channelId: roomA.channelId,
    pubkey: user1.pubkeyHex,
    seq: 2,
    name: 'Erik',
    tag: tag2,
    prevHash: '0'.repeat(64),
    ts: 1700000005000,
  });
  assert.equal(b1Hash.length, 64);
  assert.equal(b2Hash.length, 64);
  assert.notEqual(b1Hash, b2Hash);
  assert.notEqual(b2Hash, b2Tampered);

  // 7. Non-reusable tag reservation: archived/used tags are strictly skipped deterministically
  assert.equal(isValidHandleTag(tag1), true);
  assert.equal(isValidHandleTag('4ft7k'), true); // 5-char expanded tag valid
  assert.equal(isValidHandleTag('4ft7kp'), true); // 6-char expanded tag valid
  assert.equal(isValidHandleTag('0oil'), false);
  assert.equal(isValidHandleTag('abc'), false);
  const nonce0 = deriveHandleTag(user2.pubkeyHex, roomA.channelId, 'Jaan', 0);
  const nonce1 = deriveHandleTag(user2.pubkeyHex, roomA.channelId, 'Jaan', 1);
  const reserved = new Set([nonce0, nonce1]);
  const resolved = resolveUniqueHandleTag(user2.pubkeyHex, roomA.channelId, 'Jaan', reserved);
  assert.equal(isValidHandleTag(resolved), true);
  assert.equal(reserved.has(resolved), false);
  assert.equal(resolved, resolveUniqueHandleTag(user2.pubkeyHex, roomA.channelId, 'Jaan', reserved));
});

test('Handle tag exhaustion defense: economical FIFO archive recycle first, then auto-expand 4 -> 5 -> 6 -> 7 chars', async () => {
  const room = await deriveRoomSecrets('Suur Tuba', 'suur-parool');
  const user = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

  // 1. Simulate ALL 4-char probes saturated, with 2 archived tags in FIFO queue (oldest first!)
  const saturated4 = new Set();
  for (let n = 0; n < 8; n++) {
    saturated4.add(deriveHandleTag(user.pubkeyHex, room.channelId, 'Mari', n, 4));
  }
  const fifo = ['4ft7', '56gb']; // '4ft7' is oldest archived, '56gb' is newer
  saturated4.add('4ft7');
  saturated4.add('56gb');

  const recycledList = [];
  const t1 = resolveUniqueHandleTag(user.pubkeyHex, room.channelId, 'Mari', saturated4, {
    maxProbesPerLen: 8,
    archivedFifoQueue: fifo,
    activeTagsSet: new Set(),
    onRecycle: (tag) => recycledList.push(tag),
  });
  // Releases ONLY the oldest archived tag ('4ft7') via FIFO, keeping handle at 4 chars!
  assert.equal(t1, '4ft7');
  assert.deepEqual(recycledList, ['4ft7']);
  assert.deepEqual(fifo, ['56gb']);

  // Next allocation when still saturated releases the second oldest ('56gb') via FIFO
  saturated4.add('4ft7'); // now held by active user!
  const t2 = resolveUniqueHandleTag(user.pubkeyHex, room.channelId, 'Mari', saturated4, {
    maxProbesPerLen: 8,
    archivedFifoQueue: fifo,
    activeTagsSet: new Set(['4ft7']),
    onRecycle: (tag) => recycledList.push(tag),
  });
  assert.equal(t2, '56gb');
  assert.deepEqual(recycledList, ['4ft7', '56gb']);
  assert.deepEqual(fifo, []);

  // 2. Now FIFO archive queue is EMPTY (all 4-char codes held by ACTIVE members) -> auto-expands to 5 chars!
  saturated4.add('56gb');
  const t5 = resolveUniqueHandleTag(user.pubkeyHex, room.channelId, 'Mari', saturated4, {
    maxProbesPerLen: 8,
    archivedFifoQueue: fifo,
    activeTagsSet: new Set(['4ft7', '56gb']),
  });
  assert.equal(t5.length, 5);
  assert.equal(isValidHandleTag(t5), true);

  // 3. Simulate 4-char, 5-char, AND 6-char spaces completely full by active members -> expands cleanly to 7 chars!
  const mockFullUpTo6 = { has: (tag) => tag.length <= 6 };
  const t7 = resolveUniqueHandleTag(user.pubkeyHex, room.channelId, 'Mari', mockFullUpTo6, {
    maxProbesPerLen: 8,
    archivedFifoQueue: [],
  });
  assert.equal(t7.length, 7);
  assert.equal(isValidHandleTag(t7), true);
  // Deterministic across devices
  assert.equal(
    t7,
    resolveUniqueHandleTag(user.pubkeyHex, room.channelId, 'Mari', mockFullUpTo6, {
      maxProbesPerLen: 8,
      archivedFifoQueue: [],
    })
  );
});

test('Secp256k1 ECDH + AES-256-GCM peer-sealed rekey envelopes & creatorPubkey invite hash', async () => {
  const room = await deriveRoomSecrets('Tuba Admin', 'vana-parool-123');
  const admin = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  const honestMember = await deriveRoomIdentity(generateMasterSeed(), room.channelId);
  const bannedMember = await deriveRoomIdentity(generateMasterSeed(), room.channelId);

  const rekeyPayload = {
    name: 'Tuba Admin',
    passphrase: 'uus-parool-456-xyz',
    relayMode: 'public',
    customRelay: null,
    creatorPubkey: admin.pubkeyHex,
  };

  // Admin seals new room passphrase strictly for honestMember
  const envelope = await encryptForPeer(
    admin.privKeyBytes,
    honestMember.pubkeyHex,
    room.channelId,
    rekeyPayload
  );
  assert.equal(typeof envelope, 'string');
  assert.equal(envelope.includes('uus-parool-456-xyz'), false);

  // Honest member decrypts with their private key + admin's pubkey
  const decrypted = await decryptFromPeer(
    honestMember.privKeyBytes,
    admin.pubkeyHex,
    room.channelId,
    envelope
  );
  assert.deepEqual(decrypted, rekeyPayload);

  // Banned member (or any other room participant who knew the old room key) CANNOT decrypt the envelope
  const bannedAttempt = await decryptFromPeer(
    bannedMember.privKeyBytes,
    admin.pubkeyHex,
    room.channelId,
    envelope
  );
  assert.equal(bannedAttempt, null);

  // Wrong sender pubkey or wrong channelId AAD fails decryption
  const spoofAttempt = await decryptFromPeer(
    honestMember.privKeyBytes,
    bannedMember.pubkeyHex,
    room.channelId,
    envelope
  );
  assert.equal(spoofAttempt, null);

  // Invite URL with creatorPubkey preserves 64-hex founding admin pubkey
  const urlWithCreator = encodeInviteUrl('https://chat.example.ee/', {
    name: 'Tuba Admin',
    passphrase: 'uus-parool-456-xyz',
    relayMode: 'public',
    creatorPubkey: admin.pubkeyHex,
  });
  const parsedInvite = decodeInviteHash(urlWithCreator.slice(urlWithCreator.indexOf('#')));
  assert.equal(parsedInvite.creatorPubkey, admin.pubkeyHex);
});
