// Pure-JS cryptography for DecLoc Chat:
// - BIP-340 secp256k1 Schnorr signatures (Nostr NIP-01)
// - Web Crypto PBKDF2-SHA256, HMAC-SHA256, AES-256-GCM (Room E2EE)
// Zero external dependencies — works offline and directly on GitHub Pages.

const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = {
  X: 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  Y: 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
  Z: 1n,
};
const INF = { X: 0n, Y: 1n, Z: 0n };
const SQRT_EXP = (P + 1n) >> 2n;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function hasWebCrypto() {
  return Boolean(globalThis.crypto && globalThis.crypto.subtle);
}

export function utf8ToBytes(str) {
  return enc.encode(str);
}

export function bytesToUtf8(bytes) {
  return dec.decode(bytes);
}

export function bytesToHex(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error('Invalid hex string');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export function base64UrlEncode(str) {
  return bytesToBase64(utf8ToBytes(str))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function base64UrlDecode(b64url) {
  let b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return bytesToUtf8(base64ToBytes(b64));
}

export function randomBytes(len) {
  const buf = new Uint8Array(len);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

export async function sha256(bytes) {
  const buf = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(buf);
}

export async function sha256Hex(strOrBytes) {
  const input = typeof strOrBytes === 'string' ? utf8ToBytes(strOrBytes) : strOrBytes;
  return bytesToHex(await sha256(input));
}

export async function hmacSha256(keyBytes, msgBytes) {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', key, msgBytes);
  return new Uint8Array(sig);
}

// --- BigInt modular & secp256k1 Jacobian elliptic curve arithmetic ---

function mod(a, m = P) {
  const r = a % m;
  return r >= 0n ? r : r + m;
}

function modPow(base, exp, m = P) {
  let result = 1n;
  let b = mod(base, m);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return result;
}

function bytesToBigInt(bytes) {
  return BigInt('0x' + (bytesToHex(bytes) || '0'));
}

function bigIntToBytes32(num) {
  const hex = num.toString(16).padStart(64, '0');
  return hexToBytes(hex);
}

function pointDouble(p) {
  if (p.Z === 0n || p.Y === 0n) return INF;
  const { X: X1, Y: Y1, Z: Z1 } = p;
  const A = mod(X1 * X1);
  const B = mod(Y1 * Y1);
  const C = mod(B * B);
  const D = mod(2n * (mod((X1 + B) * (X1 + B)) - A - C));
  const E = mod(3n * A);
  const F = mod(E * E);
  const X3 = mod(F - 2n * D);
  const Y3 = mod(E * (D - X3) - 8n * C);
  const Z3 = mod(2n * Y1 * Z1);
  return { X: X3, Y: Y3, Z: Z3 };
}

function pointAdd(p1, p2) {
  if (p1.Z === 0n) return p2;
  if (p2.Z === 0n) return p1;
  const Z1Z1 = mod(p1.Z * p1.Z);
  const Z2Z2 = mod(p2.Z * p2.Z);
  const U1 = mod(p1.X * Z2Z2);
  const U2 = mod(p2.X * Z1Z1);
  const S1 = mod(p1.Y * p2.Z * Z2Z2);
  const S2 = mod(p2.Y * p1.Z * Z1Z1);
  if (U1 === U2) {
    return S1 === S2 ? pointDouble(p1) : INF;
  }
  const H = mod(U2 - U1);
  const R = mod(S2 - S1);
  const H2 = mod(H * H);
  const H3 = mod(H * H2);
  const U1H2 = mod(U1 * H2);
  const X3 = mod(R * R - H3 - 2n * U1H2);
  const Y3 = mod(R * (U1H2 - X3) - S1 * H3);
  const Z3 = mod(H * p1.Z * p2.Z);
  return { X: X3, Y: Y3, Z: Z3 };
}

function pointMul(p, scalar) {
  let k = mod(scalar, N);
  if (k === 0n) return INF;
  let result = INF;
  let addend = p;
  while (k > 0n) {
    if (k & 1n) result = pointAdd(result, addend);
    addend = pointDouble(addend);
    k >>= 1n;
  }
  return result;
}

function toAffine(p) {
  if (p.Z === 0n) return null;
  const zInv = modPow(p.Z, P - 2n, P);
  const zInv2 = mod(zInv * zInv);
  const zInv3 = mod(zInv2 * zInv);
  return {
    x: mod(p.X * zInv2),
    y: mod(p.Y * zInv3),
  };
}

function hasEvenY(pt) {
  return (pt.y & 1n) === 0n;
}

function liftX(x) {
  if (x < 0n || x >= P) return null;
  const c = mod(modPow(x, 3n, P) + 7n, P);
  let y = modPow(c, SQRT_EXP, P);
  if (mod(y * y, P) !== c) return null;
  if ((y & 1n) !== 0n) y = P - y;
  return { x, y };
}

// --- BIP-340 Tagged Hashes & Schnorr Signatures ---

const tagHashCache = new Map();

async function taggedHash(tag, msgBytes) {
  let th = tagHashCache.get(tag);
  if (!th) {
    th = await sha256(utf8ToBytes(tag));
    tagHashCache.set(tag, th);
  }
  return sha256(concatBytes(th, th, msgBytes));
}

export function getPublicKeyBytes(privKeyBytes) {
  const d = bytesToBigInt(privKeyBytes);
  if (d <= 0n || d >= N) throw new Error('Invalid private key');
  const pt = toAffine(pointMul(G, d));
  return bigIntToBytes32(pt.x);
}

export function getPublicKeyHex(privKeyBytes) {
  return bytesToHex(getPublicKeyBytes(privKeyBytes));
}

// Pure-JS secp256k1 ECDH shared secret (x-coordinate of d * liftX(peerPubkey))
// Used for per-member end-to-end sealed room password rotation (blocked members cannot decrypt!).
export function computeEcdhSharedSecret(privKeyBytes, peerPubkeyHex) {
  if (!privKeyBytes || privKeyBytes.length !== 32) throw new Error('Invalid private key');
  if (typeof peerPubkeyHex !== 'string' || !/^[0-9a-f]{64}$/i.test(peerPubkeyHex)) {
    throw new Error('Invalid peer public key');
  }
  const dPrime = bytesToBigInt(privKeyBytes);
  if (dPrime <= 0n || dPrime >= N) throw new Error('Invalid private key');
  const peerPt = liftX(bytesToBigInt(hexToBytes(peerPubkeyHex)));
  if (!peerPt) throw new Error('Invalid peer public key');
  const shared = toAffine(pointMul({ X: peerPt.x, Y: peerPt.y, Z: 1n }, dPrime));
  if (!shared) throw new Error('Invalid ECDH point');
  return bigIntToBytes32(shared.x);
}

export async function encryptForPeer(myPrivKeyBytes, peerPubkeyHex, contextStr, obj) {
  const shared = computeEcdhSharedSecret(myPrivKeyBytes, peerPubkeyHex);
  const keyBytes = await sha256(concatBytes(utf8ToBytes(`decloc-ecdh:v1:${contextStr}:`), shared));
  const aesKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = randomBytes(12);
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8ToBytes(String(contextStr)) },
    aesKey,
    utf8ToBytes(JSON.stringify(obj))
  );
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ct))}`;
}

export async function decryptFromPeer(myPrivKeyBytes, peerPubkeyHex, contextStr, packed) {
  if (typeof packed !== 'string' || !packed.includes('.')) return null;
  try {
    const [ivB64, ctB64] = packed.split('.');
    const iv = base64ToBytes(ivB64);
    const ct = base64ToBytes(ctB64);
    const shared = computeEcdhSharedSecret(myPrivKeyBytes, peerPubkeyHex);
    const keyBytes = await sha256(concatBytes(utf8ToBytes(`decloc-ecdh:v1:${contextStr}:`), shared));
    const aesKey = await globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const pt = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: utf8ToBytes(String(contextStr)) },
      aesKey,
      ct
    );
    return JSON.parse(bytesToUtf8(new Uint8Array(pt)));
  } catch {
    return null;
  }
}

export async function schnorrSign(msg32, privKey32, auxRand32 = randomBytes(32)) {
  if (msg32.length !== 32 || privKey32.length !== 32 || auxRand32.length !== 32) {
    throw new Error('BIP-340 expects 32-byte inputs');
  }
  const dPrime = bytesToBigInt(privKey32);
  if (dPrime <= 0n || dPrime >= N) throw new Error('Invalid private key');

  const pt = toAffine(pointMul(G, dPrime));
  const d = hasEvenY(pt) ? dPrime : N - dPrime;
  const dBytes = bigIntToBytes32(d);
  const pxBytes = bigIntToBytes32(pt.x);

  const auxHash = await taggedHash('BIP0340/aux', auxRand32);
  const t = new Uint8Array(32);
  for (let i = 0; i < 32; i++) t[i] = dBytes[i] ^ auxHash[i];

  const rand = await taggedHash('BIP0340/nonce', concatBytes(t, pxBytes, msg32));
  const kPrime = mod(bytesToBigInt(rand), N);
  if (kPrime === 0n) throw new Error('Zero nonce generated');

  const R = toAffine(pointMul(G, kPrime));
  const k = hasEvenY(R) ? kPrime : N - kPrime;
  const rxBytes = bigIntToBytes32(R.x);

  const eBytes = await taggedHash('BIP0340/challenge', concatBytes(rxBytes, pxBytes, msg32));
  const e = mod(bytesToBigInt(eBytes), N);
  const s = mod(k + e * d, N);

  return concatBytes(rxBytes, bigIntToBytes32(s));
}

export async function schnorrVerify(msg32, pubKey32, sig64) {
  if (msg32.length !== 32 || pubKey32.length !== 32 || sig64.length !== 64) {
    return false;
  }
  const px = bytesToBigInt(pubKey32);
  const pt = liftX(px);
  if (!pt) return false;

  const rBytes = sig64.subarray(0, 32);
  const sBytes = sig64.subarray(32, 64);
  const r = bytesToBigInt(rBytes);
  const s = bytesToBigInt(sBytes);
  if (r >= P || s >= N) return false;

  const eBytes = await taggedHash('BIP0340/challenge', concatBytes(rBytes, pubKey32, msg32));
  const e = mod(bytesToBigInt(eBytes), N);

  const sG = pointMul(G, s);
  const negEP = pointMul({ X: pt.x, Y: pt.y, Z: 1n }, mod(N - e, N));
  const R = toAffine(pointAdd(sG, negEP));

  if (!R || !hasEvenY(R) || R.x !== r) return false;
  return true;
}

// --- Nostr NIP-01 Event Signing & Verification ---

export async function getEventIdBytes(ev) {
  const serialized = JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]);
  return sha256(utf8ToBytes(serialized));
}

export async function signNostrEvent(unsignedEv, privKeyBytes) {
  const pubkey = getPublicKeyHex(privKeyBytes);
  const ev = {
    pubkey,
    created_at: unsignedEv.created_at ?? Math.floor(Date.now() / 1000),
    kind: unsignedEv.kind,
    tags: unsignedEv.tags ?? [],
    content: unsignedEv.content ?? '',
  };
  const idBytes = await getEventIdBytes(ev);
  const sigBytes = await schnorrSign(idBytes, privKeyBytes);
  return {
    ...ev,
    id: bytesToHex(idBytes),
    sig: bytesToHex(sigBytes),
  };
}

export async function verifyNostrEvent(ev) {
  try {
    if (
      !ev ||
      typeof ev.id !== 'string' ||
      typeof ev.pubkey !== 'string' ||
      typeof ev.sig !== 'string' ||
      typeof ev.created_at !== 'number' ||
      typeof ev.kind !== 'number' ||
      !Array.isArray(ev.tags) ||
      typeof ev.content !== 'string'
    ) {
      return false;
    }
    if (ev.id.length !== 64 || ev.pubkey.length !== 64 || ev.sig.length !== 128) {
      return false;
    }
    const idBytes = await getEventIdBytes(ev);
    if (bytesToHex(idBytes) !== ev.id.toLowerCase()) return false;
    return await schnorrVerify(idBytes, hexToBytes(ev.pubkey), hexToBytes(ev.sig));
  } catch {
    return false;
  }
}

// --- Room E2EE Key Derivation & Payload Encryption ---

export function normalizeRoomSlug(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export async function deriveRoomSecrets(roomName, passphrase) {
  const slug = normalizeRoomSlug(roomName);
  if (!slug || !passphrase) throw new Error('Room name and passphrase are required');

  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8ToBytes(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const masterBuf = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: utf8ToBytes('decloc-chat:v1:room:' + slug),
      iterations: 200000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  const masterBits = new Uint8Array(masterBuf);

  // Domain-separated keys: channelId (public relay tag) cannot reveal aesKey (secret)
  const channelIdBytes = await hmacSha256(masterBits, utf8ToBytes('channel-id'));
  const aesKeyBytes = await hmacSha256(masterBits, utf8ToBytes('aes-gcm-key'));

  const aesKey = await globalThis.crypto.subtle.importKey(
    'raw',
    aesKeyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return {
    slug,
    channelId: bytesToHex(channelIdBytes),
    aesKey,
  };
}

// Derive a unique secp256k1 identity per room from user's master seed
// so public relays cannot correlate a user across different rooms.
export async function deriveRoomIdentity(masterSeedHex, channelId) {
  const raw = await hmacSha256(
    hexToBytes(masterSeedHex),
    utf8ToBytes('decloc-chat:v1:identity:' + channelId)
  );
  const d = (bytesToBigInt(raw) % (N - 1n)) + 1n;
  const privKeyBytes = bigIntToBytes32(d);
  const pubkeyHex = getPublicKeyHex(privKeyBytes);
  return { privKeyBytes, pubkeyHex };
}

export async function encryptRoomPayload(aesKey, pubkeyHex, channelId, payloadObj) {
  const iv = randomBytes(12);
  const plaintext = utf8ToBytes(JSON.stringify(payloadObj));
  const aad = utf8ToBytes(`${pubkeyHex}:${channelId}`);
  const ctBuf = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aad },
    aesKey,
    plaintext
  );
  return 'v1:' + bytesToBase64(concatBytes(iv, new Uint8Array(ctBuf)));
}

export async function decryptRoomPayload(aesKey, pubkeyHex, channelId, content) {
  if (typeof content !== 'string' || !content.startsWith('v1:')) return null;
  try {
    const raw = base64ToBytes(content.slice(3));
    if (raw.length < 28) return null; // 12-byte IV + 16-byte GCM tag minimum
    const iv = raw.subarray(0, 12);
    const ct = raw.subarray(12);
    const aad = utf8ToBytes(`${pubkeyHex}:${channelId}`);
    const ptBuf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: aad },
      aesKey,
      ct
    );
    return JSON.parse(bytesToUtf8(new Uint8Array(ptBuf)));
  } catch {
    return null;
  }
}

// --- User-Friendly Helpers ---

const PASSPHRASE_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function generatePassphrase(groups = 4, groupLen = 4) {
  const total = groups * groupLen;
  const bytes = randomBytes(total * 2);
  const chars = [];
  let idx = 0;
  // Rejection sampling for uniform randomness
  const limit = 256 - (256 % PASSPHRASE_ALPHABET.length);
  while (chars.length < total) {
    const b = idx < bytes.length ? bytes[idx++] : randomBytes(1)[0];
    if (b < limit) {
      chars.push(PASSPHRASE_ALPHABET[b % PASSPHRASE_ALPHABET.length]);
    }
  }
  const parts = [];
  for (let i = 0; i < groups; i++) {
    parts.push(chars.slice(i * groupLen, (i + 1) * groupLen).join(''));
  }
  return parts.join('-');
}

export function generateMasterSeed() {
  return bytesToHex(randomBytes(32));
}

// Deterministically derive a portable user identity masterSeed from (displayName + personal password).
// Allows signing in as the exact same verified person (#xxxx) on any device without any account server!
export async function deriveMasterSeedFromPassword(displayName, password) {
  const normName = normalizeRoomSlug(displayName);
  if (!normName || !password) throw new Error('Name and password required');
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8ToBytes(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await globalThis.crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: utf8ToBytes('decloc-chat:v1:user:' + normName),
      iterations: 250000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

// Local AES-256-GCM vault for optional device lock (password itself is NEVER stored!).
export async function encryptLocalVault(password, secretObj) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const keyMaterial = await globalThis.crypto.subtle.importKey(
    'raw',
    utf8ToBytes(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  const aesKey = await globalThis.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  );
  const ct = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    aesKey,
    utf8ToBytes(JSON.stringify(secretObj))
  );
  return {
    v: 1,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ct: bytesToBase64(new Uint8Array(ct)),
  };
}

export async function decryptLocalVault(password, vault) {
  if (!vault || vault.v !== 1 || !vault.salt || !vault.iv || !vault.ct) return null;
  try {
    const salt = base64ToBytes(vault.salt);
    const iv = base64ToBytes(vault.iv);
    const ct = base64ToBytes(vault.ct);
    const keyMaterial = await globalThis.crypto.subtle.importKey(
      'raw',
      utf8ToBytes(password),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    const aesKey = await globalThis.crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: 200000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt']
    );
    const pt = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ct);
    return JSON.parse(bytesToUtf8(new Uint8Array(pt)));
  } catch {
    return null;
  }
}

export function isOnionRelay(url) {
  try {
    return new URL(url).hostname.toLowerCase().endsWith('.onion');
  } catch {
    return false;
  }
}

export function normalizeRelayUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) return null;
  if (raw.startsWith('https://')) raw = 'wss://' + raw.slice(8);
  else if (raw.startsWith('http://')) raw = 'ws://' + raw.slice(7);
  else if (!raw.startsWith('wss://') && !raw.startsWith('ws://')) {
    // .onion Nostr relays typically use ws:// since Tor encrypts the transport layer
    const hostPart = raw.split('/')[0].split(':')[0].toLowerCase();
    raw = (hostPart.endsWith('.onion') ? 'ws://' : 'wss://') + raw;
  }
  try {
    const u = new URL(raw);
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null;
    if (!u.hostname) return null;
    // Strip trailing slash on bare root path for clean deduplication
    return u.pathname === '/' && !u.search && !u.hash ? `${u.protocol}//${u.host}` : u.toString();
  } catch {
    return null;
  }
}

export function encodeInviteUrl(baseUrl, { name, passphrase, relays, relayMode, customRelay, creatorPubkey }) {
  const payload = { n: name, p: passphrase };
  if (relayMode === 'custom' && customRelay) {
    payload.m = 'custom';
    payload.r = [customRelay];
  } else if (Array.isArray(relays) && relays.length > 0) {
    payload.r = relays;
  }
  if (typeof creatorPubkey === 'string' && /^[0-9a-f]{64}$/i.test(creatorPubkey)) {
    payload.c = creatorPubkey.toLowerCase();
  }
  const cleanBase = baseUrl.split('#')[0].split('?')[0];
  return `${cleanBase}#join=${base64UrlEncode(JSON.stringify(payload))}`;
}

export function decodeInviteHash(hashStr) {
  if (!hashStr || !hashStr.includes('join=')) return null;
  try {
    const raw = hashStr.replace(/^#/, '');
    const params = new URLSearchParams(raw);
    const token = params.get('join');
    if (!token) return null;
    const data = JSON.parse(base64UrlDecode(token));
    if (typeof data?.n !== 'string' || typeof data?.p !== 'string') return null;
    const validRelays = Array.isArray(data.r)
      ? data.r.map(normalizeRelayUrl).filter(Boolean)
      : null;
    const relayMode = data.m === 'custom' && validRelays && validRelays.length > 0 ? 'custom' : 'public';
    const creatorPubkey =
      typeof data.c === 'string' && /^[0-9a-f]{64}$/i.test(data.c) ? data.c.toLowerCase() : null;
    const result = {
      name: data.n.trim(),
      passphrase: data.p,
      relays: validRelays && validRelays.length > 0 ? validRelays : null,
      relayMode,
      customRelay: relayMode === 'custom' ? validRelays[0] : null,
    };
    if (creatorPubkey) result.creatorPubkey = creatorPubkey;
    return result;
  } catch {
    return null;
  }
}

export function shortFingerprint(pubkeyHex) {
  return '#' + String(pubkeyHex || '0000').slice(0, 4);
}

// Pure-JS synchronous SHA-256 (FIPS 180-4) for deterministic handle tags & hash-chain verification
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export function sha256SyncBytes(input) {
  const bytes = typeof input === 'string' ? utf8ToBytes(input) : input;
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  const w = new Uint32Array(64);

  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = ((w[i - 15] >>> 7) | (w[i - 15] << 25)) ^ ((w[i - 15] >>> 18) | (w[i - 15] << 14)) ^ (w[i - 15] >>> 3);
      const s1 = ((w[i - 2] >>> 17) | (w[i - 2] << 15)) ^ ((w[i - 2] >>> 19) | (w[i - 2] << 13)) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0, false); outView.setUint32(4, h1, false);
  outView.setUint32(8, h2, false); outView.setUint32(12, h3, false);
  outView.setUint32(16, h4, false); outView.setUint32(20, h5, false);
  outView.setUint32(24, h6, false); outView.setUint32(28, h7, false);
  return out;
}

export function sha256SyncHex(input) {
  return bytesToHex(sha256SyncBytes(input));
}

export const HANDLE_MIN_LEN = 4;
export const HANDLE_MAX_LEN = 16;

export function isValidHandleTag(tag) {
  return typeof tag === 'string' && /^[a-hjkmnp-z2-9]{4,16}$/.test(tag);
}

// Cryptographically derived alphanumeric handle tag (starts at 4 chars; expands to 5, 6... up to 16 if needed)
// bound to (room, pubkey, displayName).
// Cannot be forged or edited by users: every recipient recomputes it locally from the verified Schnorr pubkey!
// - Two users with the same name ("Jaan") get distinct tags (e.g. Jaan-4ftb vs Jaan-9k2m).
// - When a user renames ("Jaan" -> "Erik"), their tag updates (Jaan-4ftb -> Erik-3sf6) while staying
//   cryptographically linked to the exact same room pubkey in the signed name hash-chain.
export function deriveHandleTag(pubkeyHex, channelId, displayName = '', nonce = 0, length = HANDLE_MIN_LEN) {
  const safeLen = Math.min(Math.max(Math.floor(Number(length) || HANDLE_MIN_LEN), HANDLE_MIN_LEN), HANDLE_MAX_LEN);
  const normName = String(displayName || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const lenPart = safeLen > HANDLE_MIN_LEN ? `:len${safeLen}` : '';
  const noncePart = nonce > 0 ? `#${nonce}` : '';
  const digest = sha256SyncBytes(`decloc-handle:v1:${channelId || ''}:${pubkeyHex || ''}:${normName}${lenPart}${noncePart}`);
  const alphaLen = PASSPHRASE_ALPHABET.length; // 31 unambiguous alphanumeric chars (no 0/o/1/i/l)
  let out = '';
  for (let i = 0; i < safeLen; i++) {
    const val = ((digest[i * 2] << 8) | digest[i * 2 + 1]) >>> 0;
    out += PASSPHRASE_ALPHABET[val % alphaLen];
  }
  return out;
}

// Deterministically resolves a room-unique tag with two-tier exhaustion protection:
//   1. Normal: picks an unused 4-char tag avoiding BOTH active and archived tags.
//   2. Economical FIFO recycle: if 4-char space is saturated, releases ONE oldest archived tag (FIFO)
//      so new members still get compact 4-char codes without unbounded archive growth.
//   3. Auto-expand (4 -> 5 -> 6 -> ... -> 16): if NO archived tags remain at the current length
//      (all slots held by active members), automatically increases tag length so the room never hits a cap.
export function resolveUniqueHandleTag(
  pubkeyHex,
  channelId,
  displayName = '',
  reservedTagsSet = null,
  options = {}
) {
  if (!reservedTagsSet) {
    return deriveHandleTag(pubkeyHex, channelId, displayName, 0, HANDLE_MIN_LEN);
  }
  const maxProbes = Math.max(1, Math.floor(Number(options?.maxProbesPerLen) || 64));
  const fifo = Array.isArray(options?.archivedFifoQueue) ? options.archivedFifoQueue : null;
  const activeSet = options?.activeTagsSet || null;
  const onRecycle = typeof options?.onRecycle === 'function' ? options.onRecycle : null;

  for (let len = HANDLE_MIN_LEN; len <= HANDLE_MAX_LEN; len++) {
    for (let nonce = 0; nonce < maxProbes; nonce++) {
      const tag = deriveHandleTag(pubkeyHex, channelId, displayName, nonce, len);
      if (!reservedTagsSet.has(tag)) {
        return tag;
      }
    }

    // Current length is saturated: release ONE oldest archived tag of this length (FIFO)
    if (fifo && fifo.length > 0) {
      const idx = fifo.findIndex(
        (t) => typeof t === 'string' && t.length === len && (!activeSet || !activeSet.has(t))
      );
      if (idx !== -1) {
        const [recycled] = fifo.splice(idx, 1);
        if (typeof reservedTagsSet.delete === 'function') {
          reservedTagsSet.delete(recycled);
        }
        if (onRecycle) onRecycle(recycled);
        return recycled;
      }
    }
  }

  for (let nonce = maxProbes; nonce < maxProbes + 10000; nonce++) {
    const tag = deriveHandleTag(pubkeyHex, channelId, displayName, nonce, HANDLE_MAX_LEN);
    if (!reservedTagsSet.has(tag)) return tag;
  }
  return deriveHandleTag(pubkeyHex, channelId, displayName, 0, HANDLE_MAX_LEN);
}

export function formatUserHandle(displayName, pubkeyHex, channelId, reservedTagsSet = null) {
  const clean = String(displayName || '?').trim().slice(0, 32) || '?';
  if (!pubkeyHex) return clean;
  const tag = reservedTagsSet
    ? resolveUniqueHandleTag(pubkeyHex, channelId, clean, reservedTagsSet)
    : deriveHandleTag(pubkeyHex, channelId, clean);
  return `${clean}-${tag}`;
}

// Deterministic hash-chain block hash for room name history ("plokiahel")
export function computeNameBlockHash({ channelId, pubkey, seq, name, tag, prevHash, ts }) {
  const canonical = `decloc-nick:v1|${channelId}|${pubkey}|${seq}|${String(name || '').trim()}|${tag}|${prevHash || 'GENESIS'}|${Number(ts || 0)}`;
  return sha256SyncHex(canonical);
}

export function colorFromPubkey(pubkeyHex) {
  const hash = parseInt(String(pubkeyHex || '000000').slice(0, 6), 16) || 0;
  const hue = hash % 360;
  return `hsl(${hue}, 72%, 58%)`;
}
