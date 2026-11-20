import { CONFIG } from '../config.js';
import { createTranslator } from './i18n.js';
import {
  hasWebCrypto,
  sha256Hex,
  deriveRoomSecrets,
  deriveRoomIdentity,
  encryptRoomPayload,
  decryptRoomPayload,
  signNostrEvent,
  generateMasterSeed,
  deriveMasterSeedFromPassword,
  encryptLocalVault,
  decryptLocalVault,
  generatePassphrase,
  isOnionRelay,
  normalizeRelayUrl,
  encodeInviteUrl,
  decodeInviteHash,
  shortFingerprint,
  isValidHandleTag,
  deriveHandleTag,
  resolveUniqueHandleTag,
  formatUserHandle,
  computeNameBlockHash,
  colorFromPubkey,
} from './crypto.js';
import {
  loadSettings,
  saveSettings,
  getAllRooms,
  saveRoom,
  deleteRoom,
  saveMessage,
  deleteMessagesByIds,
  getRoomMessages,
  exportBackup,
  clearAllData,
} from './storage.js';
import { RelayPool } from './nostr.js';
import { CallManager } from './webrtc.js';
import { EMOJI_CATEGORIES, searchEmojis } from './emojis.js';
import {
  initAudioUnlock,
  playMessageSound,
  startCallRingtone,
  stopCallRingtone,
  vibrateDevice,
  updateUnreadBadges,
  stopTitleFlash,
  requestNotificationPermission,
  showOsNotification,
  syncServerWebPush,
  normalizeNtfyUrl,
  sendNtfyPing,
} from './notify.js';

const REACT_EMOJIS = ['👍', '❤️', '😂', '🎉'];

const $ = (id) => document.getElementById(id);

let settings = loadSettings();
let t = createTranslator(settings.lang);
let pool = null;
let callManager = null;

// In-memory runtime state per joined room:
const roomsState = new Map();
let activeChannelId = null;
let replyTarget = null; // { id, pubkey, name, text }
let pendingInvite = null;
let lastTypingSentAt = 0;
let invitePassVisible = false;
let selfHostedRelayUrl = null;
let selfHostedVapidKey = null;
let webPushActive = false;
let activeMasterSeed = settings.masterSeed || null;
const appBootSec = Math.floor(Date.now() / 1000);

// Picker & Video Call UI state
let pickerTab = 'emoji'; // 'emoji' | 'gif'
let activeEmojiCat = 'smileys';
let pickerReactTargetMsgId = null;
let gifSearchTimer = null;
let readReceiptTimer = null;
const membershipAnchorTimers = new Map();
const callMediaElCache = new Map(); // `${key}:${kind}` -> HTMLMediaElement (reused to prevent Safari/Firefox black video!)
let callLayout = 'compact'; // 'compact' | 'grid' | 'split' | 'spotlight'
let pinnedCallPeer = null; // 'local' | remotePubkey | null
let cachedReadmeText = null;
let infoModalLang = settings.lang;

function getEnabledPublicRelays() {
  const valid = (settings.relays || []).filter((r) => CONFIG.DEFAULT_RELAYS.includes(r));
  return valid.length > 0 ? valid : [...CONFIG.DEFAULT_RELAYS];
}

function getRoomRelays(room) {
  if (room && room.relayMode === 'custom' && room.customRelay) {
    return [room.customRelay];
  }
  return getEnabledPublicRelays();
}

function formatRelayHost(url) {
  return String(url || '').replace(/^wss?:\/\//, '').replace(/\/+$/, '');
}

async function detectSelfHostedRelay() {
  try {
    const res = await fetch('./decloc-relay.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.selfHostedRelay === true) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsPath = typeof data.wsPath === 'string' ? data.wsPath : '/relay';
      return {
        wsUrl: `${proto}//${window.location.host}${wsPath}`,
        vapidPublicKey: typeof data.vapidPublicKey === 'string' ? data.vapidPublicKey : null,
      };
    }
  } catch {
    // Running statically (e.g. GitHub Pages) without local relay
  }
  return null;
}

// --- Boot ---

async function init() {
  initAudioUnlock();
  applyTheme();
  applyI18n();
  setupEmojiPopover();
  bindEvents();

  if (!hasWebCrypto()) {
    showToast(t('insecureContextWarn'), 7000);
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (evt) => {
      if (evt.data?.type === 'OPEN_ROOM' && evt.data.channelId && roomsState.has(evt.data.channelId)) {
        selectRoom(evt.data.channelId);
      }
    });
  }

  // Capture any #join=... invite from URL immediately and strip hash from bar
  pendingInvite = consumeInviteFromUrl();

  // Optional front-door gate configured in config.js
  if (CONFIG.SITE_PASSCODE_SHA256 && !settings.gatePassed) {
    showOverlay('gateOverlay');
    $('gateInput').focus();
    return;
  }

  await continueBootAfterGate();
}

async function continueBootAfterGate() {
  if (!settings.name) {
    openWelcomeOverlay();
    return;
  }
  if (settings.deviceLockEnabled && settings.lockedVault && !activeMasterSeed) {
    openUnlockOverlay();
    return;
  }
  if (!activeMasterSeed) {
    activeMasterSeed = settings.masterSeed || generateMasterSeed();
    settings.masterSeed = activeMasterSeed;
    saveSettings(settings);
  }
  await startApp();
}

function openUnlockOverlay() {
  $('unlockDesc').textContent = t('unlockDesc', settings.name);
  $('unlockPassInput').value = '';
  $('unlockError').classList.add('hidden');
  showOverlay('unlockOverlay');
  $('unlockPassInput').focus();
}

function consumeInviteFromUrl() {
  const parsed = decodeInviteHash(window.location.hash);
  if (parsed) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  return parsed;
}

function openWelcomeOverlay() {
  $('welcomeAppName').textContent = CONFIG.APP_NAME;
  $('welcomeLangBtn').textContent = settings.lang === 'et' ? 'EN' : 'ET';
  if (pendingInvite) {
    $('welcomeInviteBanner').classList.remove('hidden');
    $('welcomeInviteRoom').textContent = pendingInvite.name;
    $('welcomeSubmitBtn').textContent = t('joinInvitedBtn');
  } else {
    $('welcomeInviteBanner').classList.add('hidden');
    $('welcomeSubmitBtn').textContent = t('startBtn');
  }
  showOverlay('welcomeOverlay');
  $('welcomeNameInput').focus();
}

async function startApp() {
  $('sidebarUserName').textContent = settings.name;
  $('appTitle').textContent = CONFIG.APP_NAME;
  $('lockAppBtn').classList.toggle('hidden', !settings.deviceLockEnabled);

  // Auto-discover built-in relay & VAPID Web Push when hosted via relay/server.mjs
  const selfInfo = await detectSelfHostedRelay();
  selfHostedRelayUrl = selfInfo?.wsUrl || null;
  selfHostedVapidKey = selfInfo?.vapidPublicKey || null;
  renderNotifyButtonState();

  // Load saved rooms and derive keys
  const savedRooms = await getAllRooms();
  for (const r of savedRooms) {
    await hydrateRoom(r);
  }

  // Setup relay pool & WebRTC call manager (routes are applied strictly per-room via syncSubscriptions)
  pool = new RelayPool([], {
    onEvent: handleIncomingNostrEvent,
    onStatusChange: handleRelayStatusChange,
    onAck: handleEventAck,
  });

  callManager = new CallManager({
    sendSignal: sendRoomEphemeral,
    onStateChange: renderCallUI,
    getIceServers: getConfiguredIceServers,
    onResumeMedia: resumeAllCallMedia,
    onNotice: (key) => showToast(t(key), 4500),
  });

  // Auto-join pending invite link if user opened one
  if (pendingInvite) {
    const inv = pendingInvite;
    pendingInvite = null;
    const chId = await joinOrCreateRoom(inv.name, inv.passphrase, {
      relayMode: inv.relayMode || 'public',
      customRelay: inv.customRelay || null,
    });
    if (chId) selectRoom(chId);
  } else if (settings.lastRoomId && roomsState.has(settings.lastRoomId)) {
    selectRoom(settings.lastRoomId);
  } else if (roomsState.size > 0) {
    const first = [...roomsState.keys()][0];
    selectRoom(first);
  }

  syncSubscriptions();
  renderRoomList();
  updateTabTitle();

  // Presence heartbeat & pruning
  setInterval(() => {
    if (activeChannelId) announcePresence(activeChannelId, 'online');
  }, 20000);

  setInterval(() => {
    pruneEphemeralStates();
  }, 4000);
}

// --- Room Hydration & Joining ---

async function hydrateRoom(room) {
  if (roomsState.has(room.channelId)) return roomsState.get(room.channelId);

  const secrets = await deriveRoomSecrets(room.name, room.passphrase);
  const identity = await deriveRoomIdentity(activeMasterSeed, secrets.channelId);

  const stored = await getRoomMessages(secrets.channelId);
  const msgMap = new Map();
  const reactMap = new Map();
  const deletedTargets = new Map(); // targetId -> Set(issuerPubkey)
  const verifiedDeletedIds = new Set();
  const archiveEvents = new Map(); // pubkey -> { id, pubkey, lastTag, reservedTags, archivedAtMs, createdAt }

  // Pass 1: load deletion tombstones AND member archive records first so deleted/archived data cannot reappear
  for (const item of stored) {
    if (item.type === 'del' && Array.isArray(item.targets) && typeof item.pubkey === 'string') {
      for (const tid of item.targets) {
        let issuers = deletedTargets.get(tid);
        if (!issuers) {
          issuers = new Set();
          deletedTargets.set(tid, issuers);
        }
        issuers.add(item.pubkey);
      }
    } else if (item.type === 'archive' && typeof item.pubkey === 'string' && isValidHandleTag(item.lastTag)) {
      const archivedAtMs = typeof item.archivedAtMs === 'number' ? item.archivedAtMs : (item.createdAt || 0) * 1000;
      const prev = archiveEvents.get(item.pubkey);
      if (!prev || archivedAtMs >= prev.archivedAtMs) {
        const reserved = Array.isArray(item.reservedTags)
          ? [...new Set([item.lastTag, ...item.reservedTags.filter(isValidHandleTag)])].slice(0, 20)
          : [item.lastTag];
        archiveEvents.set(item.pubkey, {
          id: item.id,
          pubkey: item.pubkey,
          lastTag: item.lastTag,
          reservedTags: reserved,
          archivedAtMs,
          createdAt: item.createdAt || Math.floor(archivedAtMs / 1000),
        });
      }
    }
  }

  const isPreArchive = (pubkey, tsMs) => {
    const arch = archiveEvents.get(pubkey);
    return Boolean(arch && tsMs <= arch.archivedAtMs);
  };

  // Pass 2: load non-deleted, non-archived messages and purge any leftover zombie copies
  const purgeIds = [];
  for (const item of stored) {
    if (item.type === 'msg' || !item.type) {
      const tsMs = typeof item.tsMs === 'number' ? item.tsMs : (item.createdAt || 0) * 1000;
      if (deletedTargets.get(item.id)?.has(item.pubkey) || isPreArchive(item.pubkey, tsMs)) {
        verifiedDeletedIds.add(item.id);
        purgeIds.push(item.id);
      } else {
        msgMap.set(item.id, item);
      }
    }
  }

  // Pass 3: load reactions, read receipts, and signed name-change blocks (scrubbing pre-archive entries)
  const readReceipts = new Map(); // pubkey -> { msgId, msgTs, name, seenAtMs }
  const nickEvents = new Map(); // evId -> { id, pubkey, name, prevName, seq, prevHash, tsMs, createdAt }
  let lastSentReadMsgId = null;

  for (const item of stored) {
    if (item.type === 'react') {
      const tsMs = typeof item.tsMs === 'number' ? item.tsMs : (item.createdAt || 0) * 1000;
      if (verifiedDeletedIds.has(item.target) || isPreArchive(item.pubkey, tsMs)) {
        purgeIds.push(item.id);
      } else {
        applyReactionInMemory(reactMap, item);
      }
    } else if (item.type === 'nick' && typeof item.pubkey === 'string' && typeof item.name === 'string') {
      const tsMs = typeof item.tsMs === 'number' ? item.tsMs : (item.createdAt || 0) * 1000;
      if (isPreArchive(item.pubkey, tsMs)) {
        purgeIds.push(item.id);
      } else {
        nickEvents.set(item.id, item);
      }
    } else if (item.type === 'read' && typeof item.pubkey === 'string' && typeof item.msgId === 'string') {
      const seenAtMs = typeof item.seenAtMs === 'number' ? item.seenAtMs : (item.createdAt || 0) * 1000;
      if (isPreArchive(item.pubkey, seenAtMs)) {
        purgeIds.push(item.id);
        continue;
      }
      const prev = readReceipts.get(item.pubkey);
      if (!prev || seenAtMs >= prev.seenAtMs) {
        readReceipts.set(item.pubkey, {
          msgId: item.msgId,
          msgTs: Number(item.msgTs || 0),
          name: String(item.name || '?').slice(0, 32),
          seenAtMs,
        });
      }
      if (item.pubkey === identity.pubkeyHex) {
        lastSentReadMsgId = item.msgId;
      }
    }
  }

  if (purgeIds.length > 0) {
    deleteMessagesByIds(purgeIds).catch(() => {});
  }

  const state = {
    room: { ...room, channelId: secrets.channelId },
    aesKey: secrets.aesKey,
    identity,
    messages: msgMap,
    reactions: reactMap,
    readReceipts,
    nickEvents,
    archiveEvents,
    members: new Map(), // pubkey -> { pubkey, name, isOnline, lastActiveMs, firstSeenMs }
    archivedMembers: new Map(), // pubkey -> { pubkey, lastTag, reservedTags, archivedAtMs }
    archivedTags: new Set(), // retired tags (released FIFO only if tag space saturates)
    archivedFifoQueue: [], // oldest-first FIFO queue of archived tags
    activeTags: new Set(), // tags held by currently active members
    claimedTags: new Set(), // all tags currently active or archived in this room
    resolvedTags: new Map(), // `${pubkey}:${normName}` -> unique tag
    nameChains: new Map(), // pubkey -> Array<verifiedBlock>
    ownMetaEventIds: new Set(), // own kind:42 nick/read/react event IDs for clean NIP-09 wipe on archive
    lastSentReadMsgId,
    deletedTargets,
    verifiedDeletedIds,
    presence: new Map(),
    typing: new Map(),
  };
  rebuildRoomDirectory(state);
  recomputeRoomPreview(state);
  roomsState.set(secrets.channelId, state);
  return state;
}

async function joinOrCreateRoom(roomName, passphrase, { relayMode = 'public', customRelay = null } = {}) {
  const cleanName = roomName.trim();
  if (!cleanName || !passphrase) return null;

  const normCustom = relayMode === 'custom' ? normalizeRelayUrl(customRelay) : null;
  const finalMode = relayMode === 'custom' && normCustom ? 'custom' : 'public';

  const secrets = await deriveRoomSecrets(cleanName, passphrase);
  let state = roomsState.get(secrets.channelId);
  if (state) {
    // Room is permanently locked to its original relay choice — never change it!
    const existingMode = state.room.relayMode === 'custom' ? 'custom' : 'public';
    const existingRelay = existingMode === 'custom' ? state.room.customRelay : null;
    if (existingMode !== finalMode || (finalMode === 'custom' && existingRelay !== normCustom)) {
      showToast(t('roomRelayMismatchToast'), 4000);
    }
  } else {
    const roomObj = {
      channelId: secrets.channelId,
      name: cleanName,
      passphrase,
      relayMode: finalMode,
      customRelay: finalMode === 'custom' ? normCustom : null,
      joinedAt: Math.floor(Date.now() / 1000),
      lastActivity: Math.floor(Date.now() / 1000),
      lastReadAt: 0,
      lastPreview: '',
    };
    await saveRoom(roomObj);
    state = await hydrateRoom(roomObj);
    syncSubscriptions();
  }
  renderRoomList();
  return secrets.channelId;
}

function syncSubscriptions() {
  if (!pool) return;
  const routes = new Map();
  let hasPublicRoom = false;

  for (const [channelId, state] of roomsState.entries()) {
    const relays = getRoomRelays(state.room);
    routes.set(channelId, relays);
    if (state.room.relayMode !== 'custom') hasPublicRoom = true;
  }

  // Only keep public relays connected if user has public rooms or no rooms yet (non-self-hosted)
  const keepAlive =
    hasPublicRoom || (roomsState.size === 0 && !selfHostedRelayUrl)
      ? getEnabledPublicRelays()
      : selfHostedRelayUrl && roomsState.size === 0
        ? [selfHostedRelayUrl]
        : [];

  pool.setChannelRoutes(routes, keepAlive);
  handleRelayStatusChange();
  syncPushRegistration();
}

async function syncPushRegistration() {
  if (!selfHostedVapidKey) return;
  const selfRooms = [...roomsState.values()].filter(
    (s) => s.room.relayMode === 'custom' && s.room.customRelay === selfHostedRelayUrl
  );
  const channels = selfRooms.map((s) => s.room.channelId);
  const senderPubkeys = selfRooms.map((s) => s.identity.pubkeyHex);
  const enabled = settings.notifications && 'Notification' in window && Notification.permission === 'granted';
  webPushActive = await syncServerWebPush({
    vapidPublicKey: selfHostedVapidKey,
    enabled,
    channels,
    senderPubkeys,
  });
  renderWebPushStatus();
}

function renderNotifyButtonState() {
  const btn = $('notifyBtn');
  if (!btn) return;
  const active = settings.notifications && 'Notification' in window && Notification.permission === 'granted';
  btn.classList.toggle('notify-on', active);
  const label = active ? t('notifyBtnActive') : t('notifyBtnEnable');
  btn.title = label;
  btn.setAttribute('aria-label', label);
}

function renderWebPushStatus() {
  const el = $('webPushStatusText');
  if (!el) return;
  if (!selfHostedVapidKey) {
    el.classList.add('hidden');
    return;
  }
  el.classList.remove('hidden');
  el.textContent = webPushActive ? t('webPushActiveStatus') : t('webPushReadyStatus');
}

function normalizeHandleName(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBlockedByArchive(state, pubkey, tsMs) {
  const arch = state?.archiveEvents?.get(pubkey);
  return Boolean(arch && Number(tsMs || 0) <= arch.archivedAtMs);
}

// Lookup (or deterministically derive) a room-unique tag with FIFO archive recycle + auto-expand (4 -> 5 -> 6...)
function getRoomTag(state, pubkey, displayName) {
  if (!state || !pubkey) return '';
  const norm = normalizeHandleName(displayName);
  const key = `${pubkey}:${norm}`;
  const existing = state.resolvedTags?.get(key);
  if (existing) return existing;
  return resolveUniqueHandleTag(pubkey, state.room.channelId, displayName, state.claimedTags || null, {
    archivedFifoQueue: state.archivedFifoQueue ? [...state.archivedFifoQueue] : null,
    activeTagsSet: state.activeTags || null,
  });
}

function getRoomHandle(state, displayName, pubkey) {
  const clean = String(displayName || '?').trim().slice(0, 32) || '?';
  if (!state || !pubkey) return clean;
  return `${clean}-${getRoomTag(state, pubkey, clean)}`;
}

function renderMyRoomHandle(state) {
  const btn = $('myHandleBtn');
  if (!btn || !state) return;
  const handle = getRoomHandle(state, settings.name, state.identity.pubkeyHex);
  btn.textContent = `👤 ${handle}`;
  btn.title = t('myHandleTooltip');
}

// Reconstruct the entire room directory in one deterministic pass:
// 1) Permanently reserves all archived tags (never reusable in this room!)
// 2) Assigns non-colliding chronological 4-char tags for every (pubkey, name)
// 3) Rebuilds every user's verified name-change hash-chain ("plokiahel")
// 4) Builds persistent Members (online + offline) AND Archived Members (archived-xxxx, zero names)
function rebuildRoomDirectory(state) {
  const channelId = state.room.channelId;
  const myPubkey = state.identity.pubkeyHex;

  const archivedTags = new Set();
  const archivedFifoQueue = []; // oldest-first FIFO order for economical recycling if space ever saturates
  const archivedOwnerByTag = new Map(); // tag -> archived pubkey
  const recycledArchivePubkeys = new Set(); // archived records whose lastTag was recycled via FIFO
  const activeTags = new Set();
  const claimedTags = new Set();
  const resolvedTags = new Map(); // `${pubkey}:${normName}` -> tag
  const nameChains = new Map();
  const members = new Map();
  const archivedMembers = new Map();

  // 1. Seed archived tags in deterministic FIFO order (oldest archived first; older historical tags before lastTag)
  const sortedArchives = [...state.archiveEvents.values()].sort(
    (a, b) => (a.archivedAtMs || 0) - (b.archivedAtMs || 0) || String(a.id || '').localeCompare(String(b.id || ''))
  );
  for (const arch of sortedArchives) {
    const olderTags = (arch.reservedTags || []).filter((tg) => tg !== arch.lastTag);
    const orderedTags = [...olderTags, arch.lastTag];
    for (const tg of orderedTags) {
      if (isValidHandleTag(tg) && !archivedTags.has(tg)) {
        archivedTags.add(tg);
        claimedTags.add(tg);
        archivedFifoQueue.push(tg);
        archivedOwnerByTag.set(tg, arch.pubkey);
      }
    }
  }

  // 2. Gather ALL non-archived nick & msg events room-wide in deterministic chronological order
  const allCandidates = [];
  for (const ev of state.nickEvents.values()) {
    const cleanName = String(ev.name || '').trim().slice(0, 32);
    const ts = typeof ev.tsMs === 'number' ? ev.tsMs : (ev.createdAt || 0) * 1000;
    if (!cleanName || isBlockedByArchive(state, ev.pubkey, ts)) continue;
    allCandidates.push({
      id: ev.id,
      pubkey: ev.pubkey,
      source: 'nick',
      name: cleanName,
      prevName: typeof ev.prevName === 'string' ? ev.prevName.trim().slice(0, 32) : null,
      seq: Number(ev.seq || 0),
      prevHash: typeof ev.prevHash === 'string' ? ev.prevHash : null,
      ts,
    });
  }
  for (const m of state.messages.values()) {
    const cleanName = String(m.name || '').trim().slice(0, 32);
    const ts = typeof m.tsMs === 'number' ? m.tsMs : (m.createdAt || 0) * 1000;
    if (!cleanName || isBlockedByArchive(state, m.pubkey, ts)) continue;
    allCandidates.push({
      id: m.id,
      pubkey: m.pubkey,
      source: 'msg',
      name: cleanName,
      prevName: null,
      seq: 0,
      prevHash: null,
      ts,
    });
  }

  allCandidates.sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    if (a.source !== b.source) return a.source === 'nick' ? -1 : 1;
    if (a.seq !== b.seq) return a.seq - b.seq;
    return String(a.id).localeCompare(String(b.id));
  });

  const claimTagFor = (pubkey, name) => {
    const norm = normalizeHandleName(name);
    const key = `${pubkey}:${norm}`;
    const existing = resolvedTags.get(key);
    if (existing) return existing;
    const tag = resolveUniqueHandleTag(pubkey, channelId, name, claimedTags, {
      archivedFifoQueue,
      activeTagsSet: activeTags,
      onRecycle: (recycledTag) => {
        archivedTags.delete(recycledTag);
        const ownerPk = archivedOwnerByTag.get(recycledTag);
        if (ownerPk) {
          const ownerArch = state.archiveEvents.get(ownerPk);
          if (ownerArch && ownerArch.lastTag === recycledTag) {
            recycledArchivePubkeys.add(ownerPk);
          }
        }
      },
    });
    resolvedTags.set(key, tag);
    claimedTags.add(tag);
    activeTags.add(tag);
    return tag;
  };

  for (const item of allCandidates) {
    const pubkey = item.pubkey;
    const tag = claimTagFor(pubkey, item.name);
    const handle = `${item.name}-${tag}`;

    let chain = nameChains.get(pubkey);
    if (!chain) {
      chain = [];
      nameChains.set(pubkey, chain);
    }
    const prevBlock = chain.length > 0 ? chain[chain.length - 1] : null;

    if (prevBlock && prevBlock.name === item.name) {
      if (prevBlock.source === 'msg' && item.source === 'nick') {
        const beforePrev = chain.length > 1 ? chain[chain.length - 2] : null;
        const effectiveSeq = item.seq > 0 ? item.seq : prevBlock.seq;
        const effectivePrevHash = item.prevHash || (beforePrev ? beforePrev.blockHash : 'GENESIS');
        const blockHash = computeNameBlockHash({
          channelId,
          pubkey,
          seq: effectiveSeq,
          name: item.name,
          tag,
          prevHash: effectivePrevHash,
          ts: item.ts,
        });
        const chainLinked = beforePrev
          ? effectivePrevHash === beforePrev.blockHash
          : effectivePrevHash === 'GENESIS';
        chain[chain.length - 1] = {
          id: item.id,
          seq: effectiveSeq,
          name: item.name,
          tag,
          handle,
          prevName: beforePrev ? beforePrev.name : null,
          prevHash: effectivePrevHash,
          blockHash,
          ts: item.ts,
          source: 'nick',
          chainLinked,
        };
      }
      continue;
    }

    const effectiveSeq = item.source === 'nick' && item.seq > 0 ? item.seq : (prevBlock ? prevBlock.seq + 1 : 1);
    const effectivePrevHash =
      item.source === 'nick' && item.prevHash
        ? item.prevHash
        : prevBlock
          ? prevBlock.blockHash
          : 'GENESIS';
    const blockHash = computeNameBlockHash({
      channelId,
      pubkey,
      seq: effectiveSeq,
      name: item.name,
      tag,
      prevHash: effectivePrevHash,
      ts: item.ts,
    });
    const chainLinked = prevBlock
      ? effectivePrevHash === prevBlock.blockHash
      : effectivePrevHash === 'GENESIS';

    chain.push({
      id: item.id,
      seq: effectiveSeq,
      name: item.name,
      tag,
      handle,
      prevName: prevBlock ? prevBlock.name : null,
      prevHash: effectivePrevHash,
      blockHash,
      ts: item.ts,
      source: item.source,
      chainLinked,
    });
  }

  // 3. Build persistent active Members directory (Online + Offline)
  const myChain = nameChains.get(myPubkey) || [];
  const myName = settings.name || (myChain.length > 0 ? myChain[myChain.length - 1].name : '?');
  claimTagFor(myPubkey, myName);
  members.set(myPubkey, {
    pubkey: myPubkey,
    name: myName,
    isOnline: true,
    isMe: true,
    lastActiveMs: Date.now(),
    firstSeenMs: myChain.length > 0 ? myChain[0].ts : Date.now(),
  });

  // All peers known from persisted nameChains (messages or nick/join blocks) — visible even when Offline!
  for (const [pk, chain] of nameChains.entries()) {
    if (pk === myPubkey || chain.length === 0) continue;
    const latest = chain[chain.length - 1];
    const pres = state.presence.get(pk);
    const receipt = state.readReceipts.get(pk);
    const name = pres?.name || latest.name;
    claimTagFor(pk, name);
    members.set(pk, {
      pubkey: pk,
      name,
      isOnline: Boolean(pres),
      isMe: false,
      lastActiveMs: Math.max(latest.ts, pres?.ts || 0, receipt?.seenAtMs || 0),
      firstSeenMs: chain[0].ts,
    });
  }

  // Any peers currently online via live presence (before their nick block arrives)
  for (const [pk, pres] of state.presence.entries()) {
    if (pk === myPubkey || members.has(pk) || isBlockedByArchive(state, pk, pres.ts)) continue;
    claimTagFor(pk, pres.name);
    members.set(pk, {
      pubkey: pk,
      name: pres.name,
      isOnline: true,
      isMe: false,
      lastActiveMs: pres.ts,
      firstSeenMs: pres.ts,
    });
  }

  // Any peers known via non-archived read receipts
  for (const [pk, rcpt] of state.readReceipts.entries()) {
    if (pk === myPubkey || members.has(pk) || isBlockedByArchive(state, pk, rcpt.seenAtMs)) continue;
    claimTagFor(pk, rcpt.name);
    members.set(pk, {
      pubkey: pk,
      name: rcpt.name,
      isOnline: false,
      isMe: false,
      lastActiveMs: rcpt.seenAtMs,
      firstSeenMs: rcpt.seenAtMs,
    });
  }

  // 4. Archived members (departed & data-erased): ONLY show those not currently active or FIFO-recycled
  for (const [pk, arch] of state.archiveEvents.entries()) {
    if (!members.has(pk) && !recycledArchivePubkeys.has(pk)) {
      archivedMembers.set(pk, arch);
    }
  }

  state.archivedTags = archivedTags;
  state.archivedFifoQueue = archivedFifoQueue;
  state.activeTags = activeTags;
  state.claimedTags = claimedTags;
  state.resolvedTags = resolvedTags;
  state.nameChains = nameChains;
  state.members = members;
  state.archivedMembers = archivedMembers;
}

function rebuildNameChainForPubkey(state, pubkey) {
  rebuildRoomDirectory(state);
  return state.nameChains.get(pubkey) || [];
}

async function applyArchiveInRoom(state, archiveItem) {
  const prev = state.archiveEvents.get(archiveItem.pubkey);
  if (prev && prev.archivedAtMs >= archiveItem.archivedAtMs) return false;

  state.archiveEvents.set(archiveItem.pubkey, archiveItem);

  const scrubIds = [];
  const pk = archiveItem.pubkey;
  const cutoff = archiveItem.archivedAtMs;

  // Scrub all pre-archive messages authored by pk
  for (const [id, m] of [...state.messages.entries()]) {
    const ts = typeof m.tsMs === 'number' ? m.tsMs : (m.createdAt || 0) * 1000;
    if (m.pubkey === pk && ts <= cutoff) {
      state.messages.delete(id);
      state.reactions.delete(id);
      state.verifiedDeletedIds.add(id);
      scrubIds.push(id);
      if (replyTarget && replyTarget.id === id) {
        replyTarget = null;
        renderReplyBar();
      }
    }
  }

  // Scrub all pre-archive nick/name blocks authored by pk (removes their display name everywhere!)
  for (const [id, n] of [...state.nickEvents.entries()]) {
    const ts = typeof n.tsMs === 'number' ? n.tsMs : (n.createdAt || 0) * 1000;
    if (n.pubkey === pk && ts <= cutoff) {
      state.nickEvents.delete(id);
      scrubIds.push(id);
    }
  }

  // Scrub pre-archive read receipts & ephemeral states
  const rcpt = state.readReceipts.get(pk);
  if (rcpt && rcpt.seenAtMs <= cutoff) {
    state.readReceipts.delete(pk);
    scrubIds.push(`read:${state.room.channelId}:${pk}`);
  }
  const pres = state.presence.get(pk);
  if (pres && pres.ts <= cutoff) state.presence.delete(pk);
  const typ = state.typing.get(pk);
  if (typ && typ.ts <= cutoff) state.typing.delete(pk);

  // Remove pk's reactions from other messages in memory
  for (const byEmoji of state.reactions.values()) {
    for (const byUser of byEmoji.values()) {
      byUser.delete(pk);
    }
  }

  await saveMessage(archiveItem);
  if (scrubIds.length > 0) {
    await deleteMessagesByIds(scrubIds);
  }

  rebuildRoomDirectory(state);
  recomputeRoomPreview(state);
  await saveRoom(state.room);
  return true;
}

function scheduleMembershipAnchor(state) {
  if (!state) return;
  const chId = state.room.channelId;
  clearTimeout(membershipAnchorTimers.get(chId));
  const timer = setTimeout(async () => {
    membershipAnchorTimers.delete(chId);
    const curr = roomsState.get(chId);
    if (!curr || !pool || !settings.name) return;
    const myPubkey = curr.identity.pubkeyHex;
    const chain = curr.nameChains.get(myPubkey) || [];
    const hasMyNickBlock = [...curr.nickEvents.values()].some(
      (n) => n.pubkey === myPubkey && !isBlockedByArchive(curr, myPubkey, typeof n.tsMs === 'number' ? n.tsMs : n.createdAt * 1000)
    );
    if (!hasMyNickBlock || (chain.length > 0 && chain[chain.length - 1].name !== settings.name)) {
      await publishNickBlock(curr, settings.name);
      if (chId === activeChannelId) {
        renderMyRoomHandle(curr);
        renderOnlineCount();
      }
    }
  }, 1500);
  membershipAnchorTimers.set(chId, timer);
}

async function publishNickBlock(state, newName, prevNameIfEmpty = null) {
  const cleanNew = String(newName || '').trim().slice(0, 32);
  if (!state || !cleanNew) return null;

  const myPubkey = state.identity.pubkeyHex;
  let chain = rebuildNameChainForPubkey(state, myPubkey);

  // If renaming before sending any messages in this room, anchor the original name first as block #1
  const cleanPrevInit = String(prevNameIfEmpty || '').trim().slice(0, 32);
  if (chain.length === 0 && cleanPrevInit && cleanPrevInit !== cleanNew) {
    await publishNickBlock(state, cleanPrevInit, null);
    chain = rebuildNameChainForPubkey(state, myPubkey);
  }

  const prevBlock = chain.length > 0 ? chain[chain.length - 1] : null;
  if (prevBlock && prevBlock.name === cleanNew && prevBlock.source === 'nick') return prevBlock;

  const seq = prevBlock ? prevBlock.seq + 1 : 1;
  const prevHash = prevBlock ? prevBlock.blockHash : 'GENESIS';
  const prevName = prevBlock && prevBlock.name !== cleanNew ? prevBlock.name : null;
  const archCutoff = state.archiveEvents.get(myPubkey)?.archivedAtMs || 0;
  const ts = Math.max(Date.now(), prevBlock ? prevBlock.ts + 1 : 0, archCutoff + 1);

  const payload = {
    v: 1,
    t: 'nick',
    name: cleanNew,
    prevName,
    seq,
    prevHash,
    ts,
  };

  const content = await encryptRoomPayload(
    state.aesKey,
    myPubkey,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [['e', state.room.channelId, '', 'root']],
      content,
    },
    state.identity.privKeyBytes
  );

  const nickItem = {
    id: ev.id,
    channelId: state.room.channelId,
    type: 'nick',
    pubkey: myPubkey,
    name: cleanNew,
    prevName,
    seq,
    prevHash,
    tsMs: ts,
    createdAt: ev.created_at,
  };

  state.nickEvents.set(nickItem.id, nickItem);
  rebuildRoomDirectory(state);
  await saveMessage(nickItem);
  if (pool) pool.publish(ev, getRoomRelays(state.room));
  return nickItem;
}

async function broadcastNameChangeAcrossRooms(prevName, newName) {
  const cleanPrev = String(prevName || '').trim().slice(0, 32);
  const cleanNew = String(newName || '').trim().slice(0, 32);
  if (!cleanNew || cleanPrev === cleanNew) return;
  for (const state of roomsState.values()) {
    await publishNickBlock(state, cleanNew, cleanPrev);
  }
  if (activeChannelId) {
    const activeState = roomsState.get(activeChannelId);
    if (activeState) {
      renderMyRoomHandle(activeState);
      renderMessages(false);
      renderOnlineCount();
    }
  }
}

function renderActiveRoomRelayBadge(room) {
  const badge = $('activeRoomRelayBadge');
  if (!badge || !room) return;
  if (room.relayMode === 'custom' && room.customRelay) {
    const host = formatRelayHost(room.customRelay);
    const icon = isOnionRelay(room.customRelay) ? '🧅' : '🏠';
    badge.textContent = `${icon} ${host}`;
    badge.title = t('roomLockedToCustom', host);
  } else {
    badge.textContent = `🌐 ${t('relayModePublic')}`;
    badge.title = t('roomLockedToPublic');
  }
}

function selectRoom(channelId) {
  const state = roomsState.get(channelId);
  if (!state) return;

  if (activeChannelId && activeChannelId !== channelId) {
    announcePresence(activeChannelId, 'leave');
  }

  activeChannelId = channelId;
  replyTarget = null;
  renderReplyBar();

  settings.lastRoomId = channelId;
  saveSettings(settings);

  markRoomAsRead(state);

  $('emptyState').classList.add('hidden');
  $('chatView').classList.remove('hidden');
  $('appShell').classList.add('mobile-chat-open');

  $('activeRoomName').textContent = state.room.name;
  renderMyRoomHandle(state);
  renderActiveRoomRelayBadge(state.room);
  handleRelayStatusChange();
  renderRoomList();
  renderMessages(true);
  renderOnlineCount();
  renderTypingBar();
  renderCallUI(callManager?.getActiveCallInfo() || null);
  updateTabTitle();

  announcePresence(channelId, 'online');
  scheduleReadReceipt(state);
  scheduleMembershipAnchor(state);
  if (window.innerWidth > 768) {
    $('messageInput').focus();
  }
}

function scheduleReadReceipt(state) {
  clearTimeout(readReceiptTimer);
  readReceiptTimer = setTimeout(() => {
    sendReadReceiptIfNeeded(state).catch(() => {});
  }, 600);
}

function isSafeHttpsUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function sendReadReceiptIfNeeded(state) {
  if (!state || !pool || !settings.readReceipts) return;
  if (state.room.channelId !== activeChannelId || document.hidden) return;

  // Find newest message in the room
  let latest = null;
  for (const m of state.messages.values()) {
    if (!latest || m.createdAt > latest.createdAt || (m.createdAt === latest.createdAt && m.id > latest.id)) {
      latest = m;
    }
  }
  if (!latest) return;
  // Do not send read receipts for our own latest message
  if (latest.pubkey === state.identity.pubkeyHex) return;
  if (state.lastSentReadMsgId === latest.id) return;

  state.lastSentReadMsgId = latest.id;
  const nowMs = Date.now();

  const payload = {
    v: 1,
    t: 'read',
    msgId: latest.id,
    msgTs: latest.createdAt,
    name: settings.name,
    ts: nowMs,
  };

  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [['e', state.room.channelId, '', 'root']],
      content,
    },
    state.identity.privKeyBytes
  );
  state.ownMetaEventIds.add(ev.id);

  await saveMessage({
    id: `read:${state.room.channelId}:${state.identity.pubkeyHex}`,
    channelId: state.room.channelId,
    type: 'read',
    pubkey: state.identity.pubkeyHex,
    msgId: latest.id,
    msgTs: latest.createdAt,
    name: settings.name,
    seenAtMs: nowMs,
    createdAt: ev.created_at,
  });

  pool.publish(ev, getRoomRelays(state.room));
}

function markRoomAsRead(state) {
  let maxTs = state.room.lastReadAt || 0;
  for (const m of state.messages.values()) {
    if (m.createdAt > maxTs) maxTs = m.createdAt;
  }
  const nowSec = Math.floor(Date.now() / 1000);
  state.room.lastReadAt = Math.max(maxTs, nowSec);
  saveRoom(state.room).catch(() => {});
}

// --- Nostr Sending & Receiving ---

async function sendTextMessage(text, gifObj = null) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const trimmed = String(text || '').trim();
  const validGif = gifObj && isSafeHttpsUrl(gifObj.url)
    ? { url: gifObj.url, title: String(gifObj.title || 'GIF').slice(0, 80) }
    : null;
  if (!trimmed && !validGif) return;

  // Ensure current handle is anchored in this room's verified name chain
  await publishNickBlock(state, settings.name);

  const payload = {
    v: 1,
    t: 'msg',
    name: settings.name,
    text: trimmed,
    ts: Date.now(),
  };
  if (validGif) {
    payload.gif = validGif;
  }
  if (replyTarget) {
    payload.replyTo = {
      id: replyTarget.id,
      pubkey: replyTarget.pubkey || null,
      name: replyTarget.name,
      text: replyTarget.text.slice(0, 120),
    };
  }

  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [
        ['e', state.room.channelId, '', 'root'],
        ['p_notify', '1'],
      ],
      content,
    },
    state.identity.privKeyBytes
  );

  const msgObj = {
    id: ev.id,
    channelId: state.room.channelId,
    type: 'msg',
    pubkey: ev.pubkey,
    name: payload.name,
    text: payload.text,
    gif: validGif,
    replyTo: payload.replyTo || null,
    createdAt: ev.created_at,
    tsMs: payload.ts,
    ackCount: 0,
  };

  state.messages.set(msgObj.id, msgObj);
  rebuildRoomDirectory(state);
  state.room.lastActivity = msgObj.createdAt;
  state.room.lastReadAt = msgObj.createdAt;
  state.room.lastPreview = `${getRoomHandle(state, msgObj.name, msgObj.pubkey)}: ${msgObj.text || '[GIF]'}`;
  await saveMessage(msgObj);
  await saveRoom(state.room);

  replyTarget = null;
  renderReplyBar();
  renderMessages(true);
  renderRoomList();

  const sentTo = pool ? pool.publish(ev, getRoomRelays(state.room)) : 0;
  if (sentTo === 0) {
    showToast(t('errNoRelays'));
  }
  if (settings.ntfyUrl) {
    sendNtfyPing(settings.ntfyUrl, { isCall: false, title: CONFIG.APP_NAME }).catch(() => {});
  }
}

async function toggleReaction(targetMsgId, emoji) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;

  const existing = state.reactions.get(targetMsgId)?.get(emoji);
  const alreadyReacted = existing?.get(state.identity.pubkeyHex)?.active === true;

  const payload = {
    v: 1,
    t: 'react',
    target: targetMsgId,
    emoji,
    remove: alreadyReacted,
    name: settings.name,
    ts: Date.now(),
  };

  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    state.room.channelId,
    payload
  );

  const ev = await signNostrEvent(
    {
      kind: CONFIG.MSG_KIND,
      tags: [['e', state.room.channelId, '', 'root']],
      content,
    },
    state.identity.privKeyBytes
  );

  const reactItem = {
    id: ev.id,
    channelId: state.room.channelId,
    type: 'react',
    pubkey: ev.pubkey,
    target: targetMsgId,
    emoji,
    remove: alreadyReacted,
    createdAt: ev.created_at,
    tsMs: payload.ts,
  };

  applyReactionInMemory(state.reactions, reactItem);
  await saveMessage(reactItem);
  renderMessages(false);

  if (pool) pool.publish(ev, getRoomRelays(state.room));
}

function isDeletedForAuthor(state, msgId, authorPubkey) {
  return state.deletedTargets.get(msgId)?.has(authorPubkey) === true;
}

function recomputeRoomPreview(state) {
  let latest = null;
  for (const m of state.messages.values()) {
    if (!latest || m.createdAt > latest.createdAt || (m.createdAt === latest.createdAt && m.id > latest.id)) {
      latest = m;
    }
  }
  if (latest) {
    state.room.lastActivity = latest.createdAt;
    state.room.lastPreview = `${getRoomHandle(state, latest.name, latest.pubkey)}: ${latest.text || '[GIF]'}`;
  } else {
    state.room.lastPreview = '';
  }
}

async function applyDeletionInRoom(state, targetIds, issuerPubkey) {
  const removedDbIds = [];
  let changed = false;

  for (const tid of targetIds) {
    let issuers = state.deletedTargets.get(tid);
    if (!issuers) {
      issuers = new Set();
      state.deletedTargets.set(tid, issuers);
    }
    issuers.add(issuerPubkey);

    const existing = state.messages.get(tid);
    // Strict cryptographic ownership check: ONLY the original author can delete their message
    if (existing && existing.pubkey === issuerPubkey) {
      state.messages.delete(tid);
      state.reactions.delete(tid);
      state.verifiedDeletedIds.add(tid);
      removedDbIds.push(tid);
      changed = true;
      if (replyTarget && replyTarget.id === tid) {
        replyTarget = null;
        renderReplyBar();
      }
    }
  }

  if (removedDbIds.length > 0) {
    await deleteMessagesByIds(removedDbIds);
    recomputeRoomPreview(state);
    await saveRoom(state.room);
  }
  return changed;
}

// Delete ONLY the current user's own messages across:
// 1) local IndexedDB & UI,
// 2) Nostr relays via standard NIP-09 (kind 5),
// 3) other participants' browsers (live & offline) via encrypted room tombstone (kind 42, t: 'del').
async function deleteOwnMessages(channelId, requestedIds) {
  const state = roomsState.get(channelId);
  if (!state) return 0;

  const myPubkey = state.identity.pubkeyHex;
  const ownIds = [...new Set(requestedIds)].filter((id) => {
    const m = state.messages.get(id);
    return m && m.pubkey === myPubkey;
  });
  if (ownIds.length === 0) return 0;

  // 1. Remove locally right away
  await applyDeletionInRoom(state, ownIds, myPubkey);

  // Batch into chunks of 100 so relays never reject oversized tag lists
  const CHUNK_SIZE = 100;
  for (let i = 0; i < ownIds.length; i += CHUNK_SIZE) {
    const chunk = ownIds.slice(i, i + CHUNK_SIZE);

    // 2. NIP-09 event deletion request for Nostr relays (kind 5)
    const nip09Ev = await signNostrEvent(
      {
        kind: CONFIG.DELETE_KIND,
        tags: [...chunk.map((id) => ['e', id]), ['k', String(CONFIG.MSG_KIND)]],
        content: '',
      },
      state.identity.privKeyBytes
    );
    if (pool) pool.publish(nip09Ev, getRoomRelays(state.room));

    // 3. Encrypted room tombstone so other devices erase their local IndexedDB copies
    const tombstonePayload = {
      v: 1,
      t: 'del',
      targets: chunk,
      ts: Date.now(),
    };
    const encContent = await encryptRoomPayload(
      state.aesKey,
      myPubkey,
      channelId,
      tombstonePayload
    );
    const delEv = await signNostrEvent(
      {
        kind: CONFIG.MSG_KIND,
        tags: [['e', channelId, '', 'root']],
        content: encContent,
      },
      state.identity.privKeyBytes
    );

    await saveMessage({
      id: delEv.id,
      channelId,
      type: 'del',
      pubkey: myPubkey,
      targets: chunk,
      createdAt: delEv.created_at,
    });

    if (pool) pool.publish(delEv, getRoomRelays(state.room));
  }

  if (channelId === activeChannelId) renderMessages(false);
  renderRoomList();
  updateTabTitle();
  return ownIds.length;
}

async function sendRoomEphemeral(channelId, payloadObj) {
  const state = roomsState.get(channelId);
  if (!state || !pool) return;
  const content = await encryptRoomPayload(
    state.aesKey,
    state.identity.pubkeyHex,
    channelId,
    { v: 1, ...payloadObj, ts: Date.now() }
  );
  const tags = [['e', channelId]];
  if (payloadObj.t === 'rtc_join') {
    tags.push(['p_notify', 'call']);
  }
  const ev = await signNostrEvent(
    {
      kind: CONFIG.EPHEMERAL_KIND,
      tags,
      content,
    },
    state.identity.privKeyBytes
  );
  pool.publish(ev, getRoomRelays(state.room));
  if (payloadObj.t === 'rtc_join' && settings.ntfyUrl) {
    sendNtfyPing(settings.ntfyUrl, { isCall: true, title: CONFIG.APP_NAME }).catch(() => {});
  }
}

function announcePresence(channelId, status = 'online') {
  sendRoomEphemeral(channelId, {
    t: 'presence',
    name: settings.name,
    status,
  }).catch(() => {});
}

function sendTypingSignal(channelId) {
  const now = Date.now();
  if (now - lastTypingSentAt < 2800) return;
  lastTypingSentAt = now;
  sendRoomEphemeral(channelId, {
    t: 'typing',
    name: settings.name,
  }).catch(() => {});
}

async function handleIncomingNostrEvent(ev, fromRelayUrl) {
  const eTag = ev.tags.find((tag) => Array.isArray(tag) && tag[0] === 'e' && typeof tag[1] === 'string');
  if (!eTag) return;
  const channelId = eTag[1];
  const state = roomsState.get(channelId);
  if (!state) return;

  // Enforce strict per-room relay isolation on inbound events as well
  if (fromRelayUrl && !getRoomRelays(state.room).includes(fromRelayUrl)) return;

  const payload = await decryptRoomPayload(state.aesKey, ev.pubkey, channelId, ev.content);
  if (!payload || typeof payload.t !== 'string') return;

  // --- Ephemeral events (presence, typing, WebRTC signaling) ---
  if (ev.kind === CONFIG.EPHEMERAL_KIND) {
    if (payload.t === 'presence') {
      if (ev.pubkey === state.identity.pubkeyHex) return;
      const nowMs = Date.now();
      if (isBlockedByArchive(state, ev.pubkey, nowMs)) return;
      if (payload.status === 'leave') {
        state.presence.delete(ev.pubkey);
      } else {
        state.presence.set(ev.pubkey, {
          name: String(payload.name || '?').slice(0, 32),
          ts: nowMs,
        });
      }
      rebuildRoomDirectory(state);
      if (channelId === activeChannelId) {
        renderOnlineCount();
        if (!$('onlineModal').classList.contains('hidden')) openOnlineModal();
      }
      return;
    }

    if (payload.t === 'typing') {
      if (ev.pubkey === state.identity.pubkeyHex) return;
      const nowMs = Date.now();
      if (isBlockedByArchive(state, ev.pubkey, nowMs)) return;
      state.typing.set(ev.pubkey, {
        name: String(payload.name || '?').slice(0, 32),
        ts: nowMs,
      });
      if (channelId === activeChannelId) renderTypingBar();
      return;
    }

    if (payload.t.startsWith('rtc_') && callManager) {
      const isIncomingCallStart =
        payload.t === 'rtc_join' &&
        ev.pubkey !== state.identity.pubkeyHex &&
        callManager.activeChannelId !== channelId;
      await callManager.handleSignal(channelId, ev.pubkey, payload);
      if (isIncomingCallStart) {
        const callerName = String(payload.name || '?').slice(0, 32);
        const callerHandle = getRoomHandle(state, callerName, ev.pubkey);
        startCallRingtone(settings.sound);
        if (settings.notifications) {
          showOsNotification({
            title: state.room.name,
            body: t('incomingCallNotif', callerHandle),
            tag: `decloc-call-${channelId}`,
            channelId,
            requireInteraction: true,
            onClick: () => selectRoom(channelId),
          });
        }
        updateUnreadBadges(getTotalUnreadCount() || 1, CONFIG.APP_NAME, `📞 ${callerHandle} (${state.room.name})`);
      } else if (payload.t === 'rtc_leave' && callManager.getRoomCallParticipants(channelId).length === 0) {
        stopCallRingtone();
      }
      return;
    }
    return;
  }

  // --- Persisted channel messages, reactions, deletions & member archives (kind 42) ---
  if (ev.kind !== CONFIG.MSG_KIND) return;

  if (payload.t === 'archive') {
    const rawLast = isValidHandleTag(payload.lastTag)
      ? payload.lastTag
      : deriveHandleTag(ev.pubkey, channelId, '');
    const reserved = Array.isArray(payload.reservedTags)
      ? [...new Set([rawLast, ...payload.reservedTags.filter(isValidHandleTag)])].slice(0, 20)
      : [rawLast];
    const archivedAtMs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    const archiveItem = {
      id: ev.id,
      channelId,
      type: 'archive',
      pubkey: ev.pubkey,
      lastTag: rawLast,
      reservedTags: reserved,
      archivedAtMs,
      createdAt: ev.created_at,
    };
    const changed = await applyArchiveInRoom(state, archiveItem);
    if (changed) {
      if (channelId === activeChannelId) {
        renderMessages(false);
        renderOnlineCount();
        renderTypingBar();
        if (!$('onlineModal').classList.contains('hidden')) openOnlineModal();
      }
      renderRoomList();
      updateTabTitle();
    }
    return;
  }

  if (payload.t === 'del' && Array.isArray(payload.targets)) {
    const targets = payload.targets
      .filter((x) => typeof x === 'string' && /^[0-9a-f]{64}$/i.test(x))
      .slice(0, 500);
    if (targets.length === 0) return;

    await saveMessage({
      id: ev.id,
      channelId,
      type: 'del',
      pubkey: ev.pubkey,
      targets,
      createdAt: ev.created_at,
    });

    const changed = await applyDeletionInRoom(state, targets, ev.pubkey);
    if (changed) {
      if (channelId === activeChannelId) renderMessages(false);
      renderRoomList();
      updateTabTitle();
    }
    return;
  }

  if (payload.t === 'react' && typeof payload.target === 'string' && typeof payload.emoji === 'string') {
    if (state.verifiedDeletedIds.has(payload.target)) return;
    const reactTs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    if (isBlockedByArchive(state, ev.pubkey, reactTs)) return;
    const reactItem = {
      id: ev.id,
      channelId,
      type: 'react',
      pubkey: ev.pubkey,
      target: payload.target,
      emoji: payload.emoji.slice(0, 8),
      remove: Boolean(payload.remove),
      createdAt: ev.created_at,
      tsMs: reactTs,
    };
    applyReactionInMemory(state.reactions, reactItem);
    await saveMessage(reactItem);
    if (channelId === activeChannelId) renderMessages(false);
    return;
  }

  if (payload.t === 'read' && typeof payload.msgId === 'string') {
    const seenAtMs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    if (isBlockedByArchive(state, ev.pubkey, seenAtMs)) return;
    const msgTs = typeof payload.msgTs === 'number' ? payload.msgTs : ev.created_at;
    const name = String(payload.name || '?').slice(0, 32);
    const prev = state.readReceipts.get(ev.pubkey);
    if (!prev || seenAtMs >= prev.seenAtMs) {
      state.readReceipts.set(ev.pubkey, {
        msgId: payload.msgId,
        msgTs,
        name,
        seenAtMs,
      });
      if (ev.pubkey === state.identity.pubkeyHex) {
        state.lastSentReadMsgId = payload.msgId;
      }
      await saveMessage({
        id: `read:${channelId}:${ev.pubkey}`,
        channelId,
        type: 'read',
        pubkey: ev.pubkey,
        msgId: payload.msgId,
        msgTs,
        name,
        seenAtMs,
        createdAt: ev.created_at,
      });
      rebuildRoomDirectory(state);
      if (channelId === activeChannelId) {
        renderMessages(false);
        renderOnlineCount();
      }
    }
    return;
  }

  if (payload.t === 'nick' && typeof payload.name === 'string') {
    const cleanName = payload.name.trim().slice(0, 32);
    if (!cleanName) return;
    if (state.nickEvents.has(ev.id)) return;
    const tsMs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    if (isBlockedByArchive(state, ev.pubkey, tsMs)) return;
    const nickItem = {
      id: ev.id,
      channelId,
      type: 'nick',
      pubkey: ev.pubkey,
      name: cleanName,
      prevName: typeof payload.prevName === 'string' ? payload.prevName.trim().slice(0, 32) : null,
      seq: Number(payload.seq || 1),
      prevHash: typeof payload.prevHash === 'string' ? payload.prevHash.slice(0, 128) : 'GENESIS',
      tsMs,
      createdAt: ev.created_at,
    };
    state.nickEvents.set(nickItem.id, nickItem);
    rebuildRoomDirectory(state);
    await saveMessage(nickItem);
    if (channelId === activeChannelId) {
      renderMessages(false);
      renderOnlineCount();
      if (!$('onlineModal').classList.contains('hidden')) openOnlineModal();
    }
    return;
  }

  if (payload.t === 'msg' && (typeof payload.text === 'string' || (payload.gif && isSafeHttpsUrl(payload.gif.url)))) {
    if (state.messages.has(ev.id)) return;
    const msgTsMs = typeof payload.ts === 'number' ? payload.ts : ev.created_at * 1000;
    // Drop zombie copies from relays that ignored NIP-09 deletion or from archived departed users
    if (isDeletedForAuthor(state, ev.id, ev.pubkey) || isBlockedByArchive(state, ev.pubkey, msgTsMs)) {
      state.verifiedDeletedIds.add(ev.id);
      return;
    }

    const isOwn = ev.pubkey === state.identity.pubkeyHex;
    const validGif = payload.gif && isSafeHttpsUrl(payload.gif.url)
      ? { url: payload.gif.url, title: String(payload.gif.title || 'GIF').slice(0, 80) }
      : null;
    const msgObj = {
      id: ev.id,
      channelId,
      type: 'msg',
      pubkey: ev.pubkey,
      name: String(payload.name || '?').slice(0, 32),
      text: String(payload.text || '').slice(0, 4000),
      gif: validGif,
      replyTo: payload.replyTo && typeof payload.replyTo.id === 'string'
        ? {
            id: payload.replyTo.id,
            pubkey: typeof payload.replyTo.pubkey === 'string' ? payload.replyTo.pubkey : null,
            name: String(payload.replyTo.name || '?').slice(0, 32),
            text: String(payload.replyTo.text || '').slice(0, 140),
          }
        : null,
      createdAt: ev.created_at,
      tsMs: msgTsMs,
      ackCount: 1,
    };

    state.messages.set(msgObj.id, msgObj);
    rebuildRoomDirectory(state);
    const msgHandle = getRoomHandle(state, msgObj.name, msgObj.pubkey);
    state.typing.delete(ev.pubkey);

    if (msgObj.createdAt >= (state.room.lastActivity || 0)) {
      state.room.lastActivity = msgObj.createdAt;
      state.room.lastPreview = `${msgHandle}: ${msgObj.text || '[GIF]'}`;
    }

    const isViewingRoom = channelId === activeChannelId && !document.hidden && document.hasFocus();
    if (isViewingRoom) {
      state.room.lastReadAt = Math.max(state.room.lastReadAt || 0, msgObj.createdAt);
    }

    await saveMessage(msgObj);
    await saveRoom(state.room);

    if (isViewingRoom && !isOwn) {
      scheduleReadReceipt(state);
    }

    if (channelId === activeChannelId) {
      const container = $('messagesContainer');
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 150;
      renderMessages(nearBottom || isOwn);
      renderTypingBar();
      renderOnlineCount();
    }
    renderRoomList();

    // Notify only for genuinely live incoming messages from others
    const isLive = ev.created_at >= appBootSec - 5;
    if (!isOwn && isLive) {
      const needsAttention = document.hidden || !document.hasFocus() || channelId !== activeChannelId;
      if (settings.sound) {
        playMessageSound();
        vibrateDevice([200, 100, 200]);
      }
      if (needsAttention && settings.notifications) {
        showOsNotification({
          title: `${state.room.name} — ${msgHandle}`,
          body: msgObj.text || '[GIF]',
          tag: `decloc-${channelId}`,
          channelId,
          onClick: () => selectRoom(channelId),
        });
      }
      updateTabTitle(`💬 ${msgHandle}: ${state.room.name}`);
    } else {
      updateTabTitle();
    }
  }
}

function applyReactionInMemory(reactMap, item) {
  // Sort order matters for toggle; track latest per (target, emoji, pubkey)
  let byEmoji = reactMap.get(item.target);
  if (!byEmoji) {
    byEmoji = new Map();
    reactMap.set(item.target, byEmoji);
  }
  let byUser = byEmoji.get(item.emoji);
  if (!byUser) {
    byUser = new Map(); // pubkey -> { active, ts }
    byEmoji.set(item.emoji, byUser);
  }
  const prev = byUser.get(item.pubkey);
  const tsVal = item.tsMs ?? item.createdAt * 1000;
  if (!prev || tsVal >= prev.ts) {
    byUser.set(item.pubkey, { active: !item.remove, ts: tsVal });
  }
}

function handleEventAck(eventId, count) {
  for (const state of roomsState.values()) {
    const m = state.messages.get(eventId);
    if (m) {
      m.ackCount = Math.max(m.ackCount || 0, count);
      saveMessage(m).catch(() => {});
      if (state.room.channelId === activeChannelId) {
        const el = document.querySelector(`[data-ack-id="${eventId}"]`);
        if (el) {
          el.textContent = count >= 2 ? '✓✓' : '✓';
          el.title = t('sentConfirmed', count);
        }
      }
      break;
    }
  }
}

function handleRelayStatusChange() {
  if (!pool) return;
  const activeRoom = activeChannelId ? roomsState.get(activeChannelId)?.room : null;
  const relevantUrls = activeRoom ? getRoomRelays(activeRoom) : null;
  const statuses = pool.getStatuses(relevantUrls);

  const ok = statuses.filter((s) => s.status === 'connected').length;
  const connecting = statuses.some((s) => s.status === 'connecting');
  const total = statuses.length;

  const dot = $('relayStatusDot');
  const txt = $('relayStatusText');
  dot.className = 'dot ' + (ok > 0 ? 'dot-ok' : connecting ? 'dot-warn' : 'dot-err');
  txt.textContent = ok > 0
    ? t('relaysConnected', ok, total)
    : connecting
      ? t('relaysConnecting')
      : t('relaysOffline');

  // Refresh public relay status dots inside Settings modal if open
  if (!$('settingsModal').classList.contains('hidden')) {
    refreshPublicRelayDots();
  }
}

function renderPublicRelaysChecklist() {
  const list = $('publicRelaysChecklist');
  if (!list) return;
  list.textContent = '';
  const enabledSet = new Set(getEnabledPublicRelays());
  const statusMap = new Map((pool ? pool.getStatuses() : []).map((s) => [s.url, s.status]));

  for (const url of CONFIG.DEFAULT_RELAYS) {
    const row = document.createElement('label');
    row.className = 'relay-check-row';

    const left = document.createElement('span');
    left.className = 'relay-check-left';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = url;
    cb.checked = enabledSet.has(url);
    cb.addEventListener('change', () => {
      const checkedCount = list.querySelectorAll('input[type="checkbox"]:checked').length;
      if (checkedCount === 0) {
        cb.checked = true;
        showToast(t('errAtLeastOneRelay'));
      }
      refreshPublicRelayDots();
    });

    const lbl = document.createElement('span');
    lbl.className = 'relay-check-url';
    lbl.textContent = formatRelayHost(url);
    left.append(cb, lbl);

    const dot = document.createElement('span');
    dot.dataset.relayDot = url;
    const st = cb.checked ? statusMap.get(url) : null;
    dot.className = 'dot ' + (!cb.checked ? 'dot-off' : st === 'connected' ? 'dot-ok' : st === 'connecting' ? 'dot-warn' : 'dot-off');

    row.append(left, dot);
    list.appendChild(row);
  }
}

function refreshPublicRelayDots() {
  const list = $('publicRelaysChecklist');
  if (!list || !pool) return;
  const statusMap = new Map(pool.getStatuses().map((s) => [s.url, s.status]));
  list.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    const dot = list.querySelector(`[data-relay-dot="${CSS.escape(cb.value)}"]`);
    if (!dot) return;
    if (!cb.checked) {
      dot.className = 'dot dot-off';
      return;
    }
    const st = statusMap.get(cb.value);
    dot.className = 'dot ' + (st === 'connected' ? 'dot-ok' : st === 'connecting' ? 'dot-warn' : st === 'disconnected' ? 'dot-err' : 'dot-off');
  });
}

function pruneEphemeralStates() {
  const now = Date.now();
  let activeChanged = false;
  for (const [chId, state] of roomsState.entries()) {
    let presenceChanged = false;
    for (const [pk, info] of state.presence.entries()) {
      if (now - info.ts > 50000) {
        state.presence.delete(pk);
        presenceChanged = true;
        if (chId === activeChannelId) activeChanged = true;
      }
    }
    if (presenceChanged) rebuildRoomDirectory(state);
    for (const [pk, info] of state.typing.entries()) {
      if (now - info.ts > 4500) {
        state.typing.delete(pk);
        if (chId === activeChannelId) activeChanged = true;
      }
    }
  }
  if (activeChanged) {
    renderOnlineCount();
    renderTypingBar();
    if (!$('onlineModal').classList.contains('hidden')) openOnlineModal();
  }
}

// --- Rendering ---

function getUnreadCount(state) {
  const readAt = state.room.lastReadAt || 0;
  let count = 0;
  for (const m of state.messages.values()) {
    if (m.pubkey !== state.identity.pubkeyHex && m.createdAt > readAt) {
      count++;
    }
  }
  return count;
}

function getTotalUnreadCount() {
  let totalUnread = 0;
  for (const state of roomsState.values()) {
    totalUnread += getUnreadCount(state);
  }
  return totalUnread;
}

function updateTabTitle(flashMsg = '') {
  updateUnreadBadges(getTotalUnreadCount(), CONFIG.APP_NAME, flashMsg);
}

function renderRoomList() {
  const list = $('roomList');
  list.textContent = '';

  const sorted = [...roomsState.values()].sort(
    (a, b) => (b.room.lastActivity || b.room.joinedAt || 0) - (a.room.lastActivity || a.room.joinedAt || 0)
  );

  if (sorted.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'room-empty-hint';
    empty.textContent = t('noRoomsYet');
    list.appendChild(empty);
    return;
  }

  for (const state of sorted) {
    const { room } = state;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'room-item' + (room.channelId === activeChannelId ? ' active' : '');
    btn.addEventListener('click', () => selectRoom(room.channelId));

    const avatar = document.createElement('div');
    avatar.className = 'room-avatar';
    avatar.style.background = colorFromPubkey(room.channelId);
    avatar.textContent = (room.name[0] || '#').toUpperCase();

    const meta = document.createElement('div');
    meta.className = 'room-meta';

    const top = document.createElement('div');
    top.className = 'room-meta-top';
    const nameEl = document.createElement('span');
    nameEl.className = 'room-item-name';
    const prefix = room.relayMode === 'custom'
      ? (isOnionRelay(room.customRelay) ? '🧅 ' : '🏠 ')
      : '';
    nameEl.textContent = prefix + room.name;
    const timeEl = document.createElement('span');
    timeEl.className = 'room-item-time';
    timeEl.textContent = room.lastActivity ? formatShortTime(room.lastActivity * 1000) : '';
    top.append(nameEl, timeEl);

    const bottom = document.createElement('div');
    bottom.className = 'room-meta-bottom';
    const prevEl = document.createElement('span');
    prevEl.className = 'room-item-preview';
    prevEl.textContent = room.lastPreview || '🔒 ' + t('e2eeBadge');
    bottom.appendChild(prevEl);

    const unread = getUnreadCount(state);
    if (unread > 0) {
      const badge = document.createElement('span');
      badge.className = 'unread-badge';
      badge.textContent = unread > 99 ? '99+' : String(unread);
      bottom.appendChild(badge);
    }

    meta.append(top, bottom);
    btn.append(avatar, meta);
    list.appendChild(btn);
  }
}

function renderMessages(scrollToBottom) {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  const list = $('messagesList');
  list.textContent = '';

  const msgs = [...state.messages.values()].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  );
  const renames = [...state.nickEvents.values()]
    .filter((n) => n.prevName && n.prevName !== n.name)
    .map((n) => ({ ...n, _kind: 'nick', _tsMs: typeof n.tsMs === 'number' ? n.tsMs : n.createdAt * 1000 }));

  const timeline = [
    ...msgs.map((m) => ({
      ...m,
      _kind: 'msg',
      _tsMs: typeof m.tsMs === 'number' ? m.tsMs : m.createdAt * 1000,
    })),
    ...renames,
  ].sort((a, b) => a._tsMs - b._tsMs || (a._kind === b._kind ? a.id.localeCompare(b.id) : a._kind === 'nick' ? -1 : 1));

  if (timeline.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = t('historyEmpty');
    list.appendChild(empty);
    return;
  }

  // Compute read-receipt placement: map each user's latest seen marker to the newest message they reached
  const seenByMsgId = new Map(); // msgId -> Array<{ pubkey, name, seenAtMs }>
  const msgById = new Map(msgs.map((m) => [m.id, m]));
  for (const [pk, receipt] of state.readReceipts.entries()) {
    if (pk === state.identity.pubkeyHex) continue;
    let targetMsg = msgById.get(receipt.msgId);
    if (!targetMsg) {
      // Fallback if the exact message was deleted: find newest message at or before msgTs
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i].createdAt <= receipt.msgTs) {
          targetMsg = msgs[i];
          break;
        }
      }
    }
    if (!targetMsg) continue;
    // Skip attributing a user as having "seen" their own message when no newer messages exist
    if (targetMsg.pubkey === pk) continue;
    let arr = seenByMsgId.get(targetMsg.id);
    if (!arr) {
      arr = [];
      seenByMsgId.set(targetMsg.id, arr);
    }
    arr.push({ pubkey: pk, name: receipt.name, seenAtMs: receipt.seenAtMs });
  }
  for (const arr of seenByMsgId.values()) {
    arr.sort((a, b) => b.seenAtMs - a.seenAtMs);
  }

  let prevDay = '';
  let prevPubkey = '';
  let prevTs = 0;

  for (const entry of timeline) {
    const ms = entry._tsMs;
    const dayKey = new Date(ms).toDateString();
    if (dayKey !== prevDay) {
      const divider = document.createElement('div');
      divider.className = 'date-divider';
      divider.textContent = formatDateHeading(ms);
      list.appendChild(divider);
      prevDay = dayKey;
      prevPubkey = '';
    }

    if (entry._kind === 'nick') {
      prevPubkey = '';
      const oldHandle = getRoomHandle(state, entry.prevName, entry.pubkey);
      const newHandle = getRoomHandle(state, entry.name, entry.pubkey);
      const nickRow = document.createElement('div');
      nickRow.className = 'nick-change-row';
      const pill = document.createElement('button');
      pill.type = 'button';
      pill.className = 'nick-change-pill';
      pill.title = t('clickForHistoryHint');
      pill.textContent = `⛓ ${t('nickChangedInline', oldHandle, newHandle)} · ${formatClock(ms)}`;
      pill.addEventListener('click', () => openUserHistoryModal(state.room.channelId, entry.pubkey));
      nickRow.appendChild(pill);
      list.appendChild(nickRow);
      continue;
    }

    const m = entry;
    const isOwn = m.pubkey === state.identity.pubkeyHex;
    const grouped = m.pubkey === prevPubkey && m.createdAt - prevTs < 180;
    prevPubkey = m.pubkey;
    prevTs = m.createdAt;

    const row = document.createElement('div');
    row.className = `msg-row${isOwn ? ' own' : ''}${grouped ? ' grouped' : ''}`;
    row.dataset.msgId = m.id;

    if (!grouped && !isOwn) {
      const author = document.createElement('div');
      author.className = 'msg-author';
      const authorBtn = document.createElement('button');
      authorBtn.type = 'button';
      authorBtn.className = 'msg-author-btn';
      authorBtn.title = t('clickForHistoryHint');
      authorBtn.addEventListener('click', () => openUserHistoryModal(state.room.channelId, m.pubkey));

      const nameSpan = document.createElement('span');
      nameSpan.className = 'msg-author-name';
      nameSpan.style.color = colorFromPubkey(m.pubkey);
      nameSpan.textContent = m.name;

      const tagSpan = document.createElement('span');
      tagSpan.className = 'msg-author-tag';
      tagSpan.textContent = `-${getRoomTag(state, m.pubkey, m.name)}`;

      authorBtn.append(nameSpan, tagSpan);

      const userChain = state.nameChains.get(m.pubkey);
      if (userChain && userChain.length > 1) {
        const chainBadge = document.createElement('span');
        chainBadge.className = 'msg-author-chain-badge';
        chainBadge.textContent = `⛓ ${userChain.length}`;
        authorBtn.appendChild(chainBadge);
      }

      author.appendChild(authorBtn);
      row.appendChild(author);
    }

    const wrap = document.createElement('div');
    wrap.className = 'msg-bubble-wrap';

    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';

    if (m.replyTo) {
      const archivedAuthor = m.replyTo.pubkey ? state.archivedMembers.get(m.replyTo.pubkey) : null;
      const quoteDeleted =
        Boolean(archivedAuthor) ||
        state.verifiedDeletedIds.has(m.replyTo.id) ||
        (m.replyTo.pubkey && isDeletedForAuthor(state, m.replyTo.id, m.replyTo.pubkey));
      const quote = document.createElement('div');
      quote.className = 'msg-reply-quote';
      if (!quoteDeleted) {
        quote.addEventListener('click', () => jumpToMessage(m.replyTo.id));
      }
      const qAuthor = document.createElement('span');
      qAuthor.className = 'msg-reply-quote-author';
      qAuthor.textContent = archivedAuthor
        ? `archived-${archivedAuthor.lastTag}`
        : m.replyTo.pubkey
          ? getRoomHandle(state, m.replyTo.name, m.replyTo.pubkey)
          : m.replyTo.name;
      const qText = document.createElement('span');
      qText.className = 'msg-reply-quote-text' + (quoteDeleted ? ' msg-reply-deleted' : '');
      qText.textContent = quoteDeleted ? t('deletedQuoteText') : m.replyTo.text;
      quote.append(qAuthor, qText);
      bubble.appendChild(quote);
    }

    if (m.text) {
      const textContainer = document.createElement('span');
      appendLinkifiedText(textContainer, m.text);
      bubble.appendChild(textContainer);
    }

    if (m.gif && isSafeHttpsUrl(m.gif.url)) {
      const img = document.createElement('img');
      img.className = 'msg-gif';
      img.src = m.gif.url;
      img.alt = m.gif.title || 'GIF';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      bubble.appendChild(img);
    }

    // Action buttons (Reply + Quick Reactions + Full Emoji Reaction + Own Message Delete)
    const actions = document.createElement('div');
    actions.className = 'msg-actions';

    const replyBtn = document.createElement('button');
    replyBtn.type = 'button';
    replyBtn.className = 'msg-act-btn';
    replyBtn.title = t('replyAction');
    replyBtn.textContent = '↩';
    replyBtn.addEventListener('click', () => {
      replyTarget = { id: m.id, pubkey: m.pubkey, name: m.name, text: m.text || '[GIF]' };
      renderReplyBar();
      $('messageInput').focus();
    });
    actions.appendChild(replyBtn);

    for (const emoji of REACT_EMOJIS) {
      const rb = document.createElement('button');
      rb.type = 'button';
      rb.className = 'msg-act-btn';
      rb.textContent = emoji;
      rb.addEventListener('click', () => toggleReaction(m.id, emoji));
      actions.appendChild(rb);
    }

    const moreReactBtn = document.createElement('button');
    moreReactBtn.type = 'button';
    moreReactBtn.className = 'msg-act-btn';
    moreReactBtn.title = t('reactMoreAction');
    moreReactBtn.textContent = '＋';
    moreReactBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPicker({ tab: 'emoji', reactTargetMsgId: m.id });
    });
    actions.appendChild(moreReactBtn);

    if (isOwn) {
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'msg-act-btn msg-act-btn-danger';
      delBtn.title = t('deleteMsgAction');
      delBtn.setAttribute('aria-label', t('deleteMsgAction'));
      delBtn.textContent = '🗑';
      delBtn.addEventListener('click', async () => {
        if (!confirm(t('deleteMsgConfirm'))) return;
        const count = await deleteOwnMessages(state.room.channelId, [m.id]);
        if (count > 0) showToast(t('msgDeletedToast'));
      });
      actions.appendChild(delBtn);
    }

    wrap.append(bubble, actions);
    row.appendChild(wrap);

    // Reactions display
    const byEmoji = state.reactions.get(m.id);
    if (byEmoji) {
      const pills = [];
      for (const [emoji, byUser] of byEmoji.entries()) {
        let count = 0;
        let mine = false;
        for (const [pk, st] of byUser.entries()) {
          if (st.active) {
            count++;
            if (pk === state.identity.pubkeyHex) mine = true;
          }
        }
        if (count > 0) pills.push({ emoji, count, mine });
      }
      if (pills.length > 0) {
        const reactBar = document.createElement('div');
        reactBar.className = 'msg-reactions';
        for (const p of pills) {
          const pill = document.createElement('button');
          pill.type = 'button';
          pill.className = 'reaction-pill' + (p.mine ? ' reacted' : '');
          pill.textContent = `${p.emoji} ${p.count}`;
          pill.addEventListener('click', () => toggleReaction(m.id, p.emoji));
          reactBar.appendChild(pill);
        }
        row.appendChild(reactBar);
      }
    }

    // Time & delivery status
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    const timeSpan = document.createElement('span');
    timeSpan.textContent = formatClock(ms);
    meta.appendChild(timeSpan);

    if (isOwn) {
      const ackSpan = document.createElement('span');
      ackSpan.dataset.ackId = m.id;
      const ac = m.ackCount || 0;
      ackSpan.textContent = ac >= 2 ? '✓✓' : ac >= 1 ? '✓' : '…';
      ackSpan.title = ac > 0 ? t('sentConfirmed', ac) : t('sentPending');
      meta.appendChild(ackSpan);
    }
    row.appendChild(meta);
    list.appendChild(row);

    // Render subtle "Nähtud" read receipt row underneath the message
    const viewers = seenByMsgId.get(m.id);
    if (viewers && viewers.length > 0) {
      const seenBtn = document.createElement('button');
      seenBtn.type = 'button';
      seenBtn.className = 'msg-seen-bar';
      seenBtn.style.alignSelf = 'flex-end';
      seenBtn.addEventListener('click', () => openSeenModal(viewers));

      const dotsWrap = document.createElement('span');
      dotsWrap.className = 'seen-dots';
      for (const v of viewers.slice(0, 3)) {
        const dot = document.createElement('span');
        dot.className = 'seen-dot';
        dot.style.background = colorFromPubkey(v.pubkey);
        dot.textContent = (v.name[0] || '?').toUpperCase();
        dotsWrap.appendChild(dot);
      }

      const summary = viewers
        .slice(0, 2)
        .map((v) => `${getRoomHandle(state, v.name, v.pubkey)} ${formatSeenTime(v.seenAtMs)}`)
        .join(', ');
      const extra = viewers.length > 2 ? ` +${viewers.length - 2}` : '';
      const txt = document.createElement('span');
      txt.textContent = `✓✓ ${t('seenPrefix')} ${summary}${extra}`;

      seenBtn.append(dotsWrap, txt);
      list.appendChild(seenBtn);
    }
  }

  if (scrollToBottom) {
    const container = $('messagesContainer');
    container.scrollTop = container.scrollHeight;
  }
}

function appendLinkifiedText(parent, text) {
  const regex = /(https?:\/\/[^\s<>"']+)/g;
  let lastIdx = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parent.appendChild(document.createTextNode(text.slice(lastIdx, match.index)));
    }
    let url = match[0];
    let trailing = '';
    while (/[.,!?;:)\]]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }
    const a = document.createElement('a');
    a.href = url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    parent.appendChild(a);
    if (trailing) parent.appendChild(document.createTextNode(trailing));
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < text.length) {
    parent.appendChild(document.createTextNode(text.slice(lastIdx)));
  }
}

function jumpToMessage(msgId) {
  const el = document.querySelector(`.msg-row[data-msg-id="${CSS.escape(msgId)}"]`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1400);
}

function renderOnlineCount() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  let online = 0;
  for (const m of state.members.values()) {
    if (m.isOnline) online++;
  }
  const total = Math.max(state.members.size, 1);
  $('onlineCountText').textContent = t('onlineCount', Math.max(online, 1), total);
}

function renderTypingBar() {
  const state = roomsState.get(activeChannelId);
  const bar = $('typingBar');
  if (!state || state.typing.size === 0) {
    bar.classList.add('hidden');
    return;
  }
  const names = [...state.typing.entries()].map(([pk, x]) =>
    getRoomHandle(state, x.name, pk)
  );
  bar.textContent =
    names.length === 1
      ? t('typingOne', names[0])
      : names.length === 2
        ? t('typingMany', names[0], names[1])
        : t('typingLots');
  bar.classList.remove('hidden');
}

function renderReplyBar() {
  const bar = $('replyBar');
  if (!replyTarget) {
    bar.classList.add('hidden');
    return;
  }
  const st = activeChannelId ? roomsState.get(activeChannelId) : null;
  const displayAuthor =
    replyTarget.pubkey && st
      ? getRoomHandle(st, replyTarget.name, replyTarget.pubkey)
      : replyTarget.name;
  $('replyBarAuthor').textContent = t('replyingTo', displayAuthor);
  $('replyBarText').textContent = replyTarget.text;
  bar.classList.remove('hidden');
}

// --- WebRTC Call UI (Compact, Grid, Split 50/50, Spotlight + PiP) ---

function getConfiguredIceServers() {
  const servers = [...CONFIG.ICE_SERVERS];
  const rawTurn = String(settings.turnUrl || '').trim();
  if (rawTurn && /^(turns?|stuns?):/i.test(rawTurn)) {
    const entry = { urls: rawTurn };
    if (settings.turnUser) entry.username = settings.turnUser;
    if (settings.turnPass) entry.credential = settings.turnPass;
    servers.push(entry);
  }
  return servers;
}

function resumeAllCallMedia() {
  for (const el of callMediaElCache.values()) {
    if (el.srcObject && typeof el.play === 'function') {
      el.play().catch(() => {});
    }
  }
}

function setCallLayout(nextLayout) {
  if (!['compact', 'grid', 'split', 'spotlight'].includes(nextLayout)) return;
  callLayout = nextLayout;
  if (callLayout === 'compact' && document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
  renderCallUI(callManager?.getActiveCallInfo() || null);
}

function renderCallUI(activeCall) {
  const banner = $('callBanner');
  const panel = $('callPanel');

  if (!activeChannelId) {
    banner.classList.add('hidden');
    panel.classList.add('hidden');
    return;
  }

  // Show incoming call banner if peers in this room are on a call and we aren't
  const activeState = roomsState.get(activeChannelId);
  const roomCallers = callManager ? callManager.getRoomCallParticipants(activeChannelId) : [];
  if (!activeCall && roomCallers.length > 0) {
    const names = roomCallers
      .map((p) => (activeState ? getRoomHandle(activeState, p.name, p.pubkey) : formatUserHandle(p.name, p.pubkey, activeChannelId)))
      .join(', ');
    $('callBannerText').textContent = t('callBanner', names);
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  if (!activeCall || activeCall.channelId !== activeChannelId) {
    panel.classList.add('hidden');
    if (!activeCall) {
      for (const el of callMediaElCache.values()) {
        el.srcObject = null;
      }
      callMediaElCache.clear();
    }
    if (document.fullscreenElement === panel) {
      document.exitFullscreen().catch(() => {});
    }
    return;
  }

  panel.classList.remove('hidden');
  panel.classList.remove('call-layout-compact', 'call-layout-grid', 'call-layout-split', 'call-layout-spotlight');
  panel.classList.add(`call-layout-${callLayout}`);

  // Highlight active layout pill
  document.querySelectorAll('.call-layout-switcher .layout-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.layout === callLayout);
  });

  // Show "Back to chat" button in fullscreen modes
  $('callBackToChatBtn').classList.toggle('hidden', callLayout === 'compact');

  const totalCount = 1 + activeCall.remotePeers.length;
  $('callStatusText').textContent = t('callActive', totalCount);

  const muteBtn = $('toggleMuteBtn');
  const muteLabel = activeCall.audioMuted ? t('unmuteBtn') : t('muteBtn');
  muteBtn.title = muteLabel;
  muteBtn.setAttribute('aria-label', muteLabel);
  muteBtn.classList.toggle('is-off', activeCall.audioMuted);
  $('micOnIcon').classList.toggle('hidden', activeCall.audioMuted);
  $('micOffIcon').classList.toggle('hidden', !activeCall.audioMuted);

  const camBtn = $('toggleCamBtn');
  const camLabel = activeCall.videoEnabled ? t('camOffBtn') : t('camOnBtn');
  camBtn.title = camLabel;
  camBtn.setAttribute('aria-label', camLabel);
  camBtn.classList.toggle('is-off', !activeCall.videoEnabled);
  $('camOnIcon').classList.toggle('hidden', !activeCall.videoEnabled);
  $('camOffIcon').classList.toggle('hidden', activeCall.videoEnabled);
  $('flipCamBtn').classList.toggle('hidden', !activeCall.videoEnabled);

  // Render camera selector dropdown whenever 2+ cameras are available during video call
  const camSelect = $('callCameraSelect');
  const usableCams = (activeCall.cameras || []).filter((c) => Boolean(c.deviceId));
  if (activeCall.videoEnabled && usableCams.length > 1) {
    const sig = usableCams.map((c) => `${c.deviceId}:${c.label}`).join('|');
    if (camSelect.dataset.camSig !== sig) {
      camSelect.textContent = '';
      usableCams.forEach((c, idx) => {
        const opt = document.createElement('option');
        opt.value = c.deviceId;
        if (c.label) {
          opt.textContent = c.label;
        } else if (c.facing === 'user') {
          opt.textContent = t('cameraFrontLabel');
        } else if (c.facing === 'environment') {
          opt.textContent = t('cameraBackLabel');
        } else {
          opt.textContent = t('cameraGenericLabel', idx + 1);
        }
        camSelect.appendChild(opt);
      });
      camSelect.dataset.camSig = sig;
    }
    if (activeCall.activeVideoDeviceId && usableCams.some((c) => c.deviceId === activeCall.activeVideoDeviceId)) {
      camSelect.value = activeCall.activeVideoDeviceId;
    }
    camSelect.classList.remove('hidden');
  } else {
    camSelect.classList.add('hidden');
  }

  const myRoomPk = activeState?.identity.pubkeyHex || '0000';
  const localTileData = {
    key: 'local',
    name: `${activeState ? getRoomHandle(activeState, settings.name, myRoomPk) : formatUserHandle(settings.name, myRoomPk, activeChannelId)} (${t('youTag')})`,
    pubkey: myRoomPk,
    stream: activeCall.localStream,
    muted: true,
    isLocal: true,
    mirror: activeCall.facingMode !== 'environment',
    audioMuted: activeCall.audioMuted,
    hasVideo: activeCall.videoEnabled,
    connState: 'connected',
  };

  const remoteTilesData = activeCall.remotePeers.map((peer) => ({
    key: peer.pubkey,
    name: activeState ? getRoomHandle(activeState, peer.name, peer.pubkey) : formatUserHandle(peer.name, peer.pubkey, activeChannelId),
    pubkey: peer.pubkey,
    stream: peer.stream,
    muted: false,
    isLocal: false,
    mirror: false,
    audioMuted: Boolean(peer.audioMuted),
    hasVideo: Boolean(peer.videoEnabled),
    connState: peer.state || 'connecting',
  }));

  // Prune stale cached media elements for peers who left the call
  const validKeys = new Set(remoteTilesData.map((p) => p.key));
  validKeys.add('local');
  for (const cacheKey of [...callMediaElCache.keys()]) {
    const peerKey = cacheKey.slice(0, cacheKey.lastIndexOf(':'));
    if (!validKeys.has(peerKey)) {
      const stale = callMediaElCache.get(cacheKey);
      if (stale) stale.srcObject = null;
      callMediaElCache.delete(cacheKey);
    }
  }

  const allTiles = [localTileData, ...remoteTilesData];

  // Ensure pinned peer still exists
  if (pinnedCallPeer && pinnedCallPeer !== 'local' && !remoteTilesData.some((p) => p.key === pinnedCallPeer)) {
    pinnedCallPeer = null;
  }

  const grid = $('callMediaGrid');
  const pipSlot = $('callPipSlot');
  const stripSlot = $('callStripSlot');
  grid.textContent = '';
  pipSlot.textContent = '';
  stripSlot.textContent = '';
  pipSlot.classList.add('hidden');
  stripSlot.classList.add('hidden');

  if (callLayout === 'compact') {
    for (const item of allTiles) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }
    return;
  }

  if (callLayout === 'grid') {
    const cols = totalCount <= 1 ? 1 : totalCount <= 4 ? 2 : 3;
    grid.style.setProperty('--grid-cols', String(cols));
    for (const item of allTiles) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }
    return;
  }

  if (callLayout === 'split') {
    // 50/50 split: primary remote peer + your own screen
    const primaryRemote =
      remoteTilesData.find((p) => p.key === pinnedCallPeer) || remoteTilesData[0] || null;
    const splitPair = primaryRemote ? [primaryRemote, localTileData] : [localTileData];

    grid.style.gridTemplateColumns = splitPair.length === 1 ? '1fr' : '';
    for (const item of splitPair) {
      grid.appendChild(
        buildMediaTile(item, () => {
          pinnedCallPeer = item.key;
          setCallLayout('spotlight');
        })
      );
    }

    // Any extra group participants appear in a tappable strip to swap into the 50% slot
    const extras = remoteTilesData.filter((p) => !primaryRemote || p.key !== primaryRemote.key);
    if (extras.length > 0) {
      stripSlot.classList.remove('hidden');
      for (const item of extras) {
        stripSlot.appendChild(
          buildMediaTile(item, () => {
            pinnedCallPeer = item.key;
            renderCallUI(callManager?.getActiveCallInfo() || null);
          })
        );
      }
    }
    return;
  }

  if (callLayout === 'spotlight') {
    // Fullscreen speaker + floating bottom-right PiP (Messenger/WhatsApp style)
    let mainTile;
    let pipTile = null;
    let stripTiles = [];

    if (remoteTilesData.length === 0) {
      mainTile = localTileData;
    } else if (pinnedCallPeer === 'local') {
      mainTile = localTileData;
      pipTile = remoteTilesData[0];
      stripTiles = remoteTilesData.slice(1);
    } else {
      mainTile = remoteTilesData.find((p) => p.key === pinnedCallPeer) || remoteTilesData[0];
      pipTile = localTileData;
      stripTiles = remoteTilesData.filter((p) => p.key !== mainTile.key);
    }

    grid.appendChild(
      buildMediaTile(mainTile, () => {
        // Clicking main spotlight toggles to equal grid when >1 participant
        if (allTiles.length > 1) setCallLayout('grid');
      })
    );

    if (pipTile) {
      pipSlot.classList.remove('hidden');
      pipSlot.appendChild(
        buildMediaTile(pipTile, () => {
          // Clicking PiP swaps who is fullscreen (classic Messenger/WhatsApp gesture!)
          pinnedCallPeer = pipTile.key;
          renderCallUI(callManager?.getActiveCallInfo() || null);
        })
      );
    }

    if (stripTiles.length > 0) {
      stripSlot.classList.remove('hidden');
      for (const item of stripTiles) {
        stripSlot.appendChild(
          buildMediaTile(item, () => {
            pinnedCallPeer = item.key;
            renderCallUI(callManager?.getActiveCallInfo() || null);
          })
        );
      }
    }
  }
}

function buildMediaTile({ key, name, pubkey, stream, muted, isLocal, mirror, audioMuted, hasVideo, connState }, onClick) {
  const tile = document.createElement('div');
  tile.className = 'media-tile' + (isLocal && mirror !== false ? ' is-local' : '');
  tile.title = t('callTapToFocus');
  if (onClick) tile.addEventListener('click', onClick);

  const cacheKey = `${key || pubkey}:${hasVideo ? 'v' : 'a'}`;
  let media = callMediaElCache.get(cacheKey);
  if (!media) {
    media = document.createElement(hasVideo ? 'video' : 'audio');
    media.autoplay = true;
    media.playsInline = true;
    media.setAttribute('autoplay', '');
    media.setAttribute('playsinline', '');
    media.setAttribute('webkit-playsinline', '');
    media.muted = muted;
    if (muted) media.setAttribute('muted', '');
    media.addEventListener('loadedmetadata', () => {
      media.play().catch(() => {});
    });
    callMediaElCache.set(cacheKey, media);
  }
  media.muted = muted;
  if (media.srcObject !== stream) {
    media.srcObject = stream;
  }
  tile.appendChild(media);
  if (stream && typeof media.play === 'function') {
    media.play().catch(() => {});
  }

  if (!hasVideo) {
    const av = document.createElement('div');
    av.className = 'media-tile-avatar';
    av.style.background = colorFromPubkey(pubkey);
    av.textContent = (name[0] || '?').toUpperCase();
    tile.appendChild(av);
  }

  if (!isLocal && connState && connState !== 'connected') {
    const stBadge = document.createElement('span');
    stBadge.className = 'media-tile-conn' + (connState === 'failed' ? ' is-failed' : '');
    stBadge.textContent =
      connState === 'failed'
        ? t('callStateFailed')
        : connState === 'reconnecting'
          ? t('callStateReconnecting')
          : t('callStateConnecting');
    tile.appendChild(stBadge);
  }

  if (audioMuted) {
    const badge = document.createElement('span');
    badge.className = 'media-tile-badge';
    badge.textContent = '🔇';
    tile.appendChild(badge);
  }

  const lbl = document.createElement('span');
  lbl.className = 'media-tile-label';
  lbl.textContent = name;
  tile.appendChild(lbl);
  return tile;
}

async function startRoomCall(withVideo) {
  const state = roomsState.get(activeChannelId);
  if (!state || !callManager) return;
  stopCallRingtone();
  try {
    callLayout = withVideo ? 'spotlight' : 'compact';
    pinnedCallPeer = null;
    await callManager.joinCall(state.room.channelId, state.identity.pubkeyHex, settings.name, {
      video: withVideo,
    });
  } catch {
    showToast(t('callMediaError'), 5000);
  }
}

// --- Modals & Events ---

function showOverlay(id) {
  $(id).classList.remove('hidden');
}

function hideOverlay(id) {
  $(id).classList.add('hidden');
}

// --- Messenger-style Full Emoji & GIF Picker ---

function setupEmojiPopover() {
  renderEmojiCategoryBar();
  renderEmojiGrid();
}

function openPicker({ tab = 'emoji', reactTargetMsgId = null } = {}) {
  pickerReactTargetMsgId = reactTargetMsgId;
  // Hide GIF tab when choosing an emoji reaction for a message
  $('pickerTabGif').classList.toggle('hidden', Boolean(reactTargetMsgId));
  setPickerTab(reactTargetMsgId ? 'emoji' : tab);
  $('emojiPopover').classList.remove('hidden');
  if (pickerTab === 'emoji') {
    $('emojiSearchInput').value = '';
    renderEmojiCategoryBar();
    renderEmojiGrid();
    if (window.innerWidth > 768) $('emojiSearchInput').focus();
  } else {
    loadGiphyGifs($('gifSearchInput').value);
    if (window.innerWidth > 768) $('gifSearchInput').focus();
  }
}

function closePicker() {
  $('emojiPopover').classList.add('hidden');
  pickerReactTargetMsgId = null;
}

function setPickerTab(tab) {
  pickerTab = tab === 'gif' ? 'gif' : 'emoji';
  $('pickerTabEmoji').classList.toggle('active', pickerTab === 'emoji');
  $('pickerTabGif').classList.toggle('active', pickerTab === 'gif');
  $('pickerEmojiPane').classList.toggle('hidden', pickerTab !== 'emoji');
  $('pickerGifPane').classList.toggle('hidden', pickerTab !== 'gif');
  if (pickerTab === 'gif') {
    loadGiphyGifs($('gifSearchInput').value);
  }
}

function renderEmojiCategoryBar() {
  const bar = $('emojiCatBar');
  bar.textContent = '';
  for (const cat of EMOJI_CATEGORIES) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-cat-btn' + (cat.id === activeEmojiCat ? ' active' : '');
    btn.textContent = cat.icon;
    btn.title = settings.lang === 'et' ? cat.labelEt : cat.labelEn;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      activeEmojiCat = cat.id;
      $('emojiSearchInput').value = '';
      renderEmojiCategoryBar();
      renderEmojiGrid();
    });
    bar.appendChild(btn);
  }
}

function renderEmojiGrid() {
  const grid = $('emojiGrid');
  grid.textContent = '';
  const query = $('emojiSearchInput').value.trim();

  let emojis = [];
  if (query) {
    emojis = searchEmojis(query);
  } else if (activeEmojiCat === 'recent') {
    emojis = settings.recentEmojis || [];
  } else {
    const cat = EMOJI_CATEGORIES.find((c) => c.id === activeEmojiCat) || EMOJI_CATEGORIES[1];
    emojis = cat.items.map(([em]) => em);
  }

  if (emojis.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = query ? t('emojiNoneFound') : t('emojiRecentEmpty');
    grid.appendChild(empty);
    return;
  }

  for (const em of emojis) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-btn';
    b.textContent = em;
    b.addEventListener('click', () => handleEmojiSelected(em));
    grid.appendChild(b);
  }
}

function rememberRecentEmoji(em) {
  const next = [em, ...(settings.recentEmojis || []).filter((x) => x !== em)].slice(0, 32);
  settings.recentEmojis = next;
  saveSettings(settings);
}

function handleEmojiSelected(em) {
  rememberRecentEmoji(em);
  if (pickerReactTargetMsgId) {
    const targetId = pickerReactTargetMsgId;
    closePicker();
    toggleReaction(targetId, em);
    return;
  }
  const inp = $('messageInput');
  const start = inp.selectionStart ?? inp.value.length;
  const end = inp.selectionEnd ?? inp.value.length;
  inp.value = inp.value.slice(0, start) + em + inp.value.slice(end);
  const nextPos = start + em.length;
  inp.setSelectionRange(nextPos, nextPos);
  inp.focus();
}

async function loadGiphyGifs(query = '') {
  const grid = $('gifResults');
  const apiKey = (settings.giphyApiKey || CONFIG.GIPHY_API_KEY || '').trim();
  $('gifSearchWrap').classList.toggle('hidden', !apiKey);

  if (!apiKey) {
    grid.textContent = '';
    const note = document.createElement('div');
    note.className = 'picker-empty';
    note.textContent = t('gifNoKeyHint');
    grid.appendChild(note);
    return;
  }

  grid.textContent = '';
  const loading = document.createElement('div');
  loading.className = 'picker-empty';
  loading.textContent = t('gifLoading');
  grid.appendChild(loading);

  try {
    const q = query.trim();
    const endpoint = q
      ? `https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(apiKey)}&q=${encodeURIComponent(q)}&limit=24&rating=g`
      : `https://api.giphy.com/v1/gifs/trending?api_key=${encodeURIComponent(apiKey)}&limit=24&rating=g`;
    const res = await fetch(endpoint);
    if (!res.ok) throw new Error('GIPHY HTTP ' + res.status);
    const json = await res.json();
    const items = Array.isArray(json.data) ? json.data : [];

    grid.textContent = '';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'picker-empty';
      empty.textContent = t('emojiNoneFound');
      grid.appendChild(empty);
      return;
    }

    for (const g of items) {
      const thumbUrl = g.images?.fixed_width_small?.url || g.images?.fixed_width?.url;
      const sendUrl = g.images?.downsized_medium?.url || g.images?.fixed_width?.url || thumbUrl;
      if (!isSafeHttpsUrl(thumbUrl) || !isSafeHttpsUrl(sendUrl)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gif-thumb-btn';
      btn.title = g.title || 'GIF';
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.alt = g.title || 'GIF';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      btn.appendChild(img);
      btn.addEventListener('click', async () => {
        closePicker();
        await sendTextMessage('', { url: sendUrl, title: g.title || 'GIF' });
      });
      grid.appendChild(btn);
    }
  } catch {
    grid.textContent = '';
    const err = document.createElement('div');
    err.className = 'picker-empty';
    err.textContent = t('gifError');
    grid.appendChild(err);
  }
}

function openSeenModal(viewers) {
  const list = $('seenList');
  list.textContent = '';
  const st = activeChannelId ? roomsState.get(activeChannelId) : null;
  for (const v of viewers) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'online-row online-row-btn';
    item.title = t('clickForHistoryHint');
    item.addEventListener('click', () => {
      hideOverlay('seenModal');
      if (activeChannelId) openUserHistoryModal(activeChannelId, v.pubkey);
    });
    const av = document.createElement('div');
    av.className = 'online-avatar';
    av.style.background = colorFromPubkey(v.pubkey);
    av.textContent = (v.name[0] || '?').toUpperCase();
    const info = document.createElement('div');
    const nm = document.createElement('div');
    nm.textContent = st ? getRoomHandle(st, v.name, v.pubkey) : formatUserHandle(v.name, v.pubkey, activeChannelId);
    const tm = document.createElement('div');
    tm.className = 'muted small';
    tm.textContent = formatSeenTime(v.seenAtMs);
    info.append(nm, tm);
    item.append(av, info);
    list.appendChild(item);
  }
  showOverlay('seenModal');
}

function openUserHistoryModal(channelId, pubkey) {
  const state = roomsState.get(channelId);
  if (!state || !pubkey) return;
  if (state.archivedMembers.has(pubkey)) return;

  const isMe = pubkey === state.identity.pubkeyHex;
  const chain = rebuildNameChainForPubkey(state, pubkey);

  // Determine current name (from chain, members, presence, read receipts, or own settings)
  let currentName =
    (isMe && settings.name) ||
    state.members.get(pubkey)?.name ||
    state.presence.get(pubkey)?.name ||
    (chain.length > 0 ? chain[chain.length - 1].name : '') ||
    state.readReceipts.get(pubkey)?.name ||
    '?';

  const currentTag = getRoomTag(state, pubkey, currentName);
  const currentHandle = `${currentName}-${currentTag}`;

  // Build display entries: if user hasn't sent a message/nick block yet, show a live verified entry
  const blocks =
    chain.length > 0
      ? chain
      : [
          {
            seq: 1,
            name: currentName,
            tag: currentTag,
            handle: currentHandle,
            prevHash: 'GENESIS',
            blockHash: computeNameBlockHash({
              channelId,
              pubkey,
              seq: 1,
              name: currentName,
              tag: currentTag,
              prevHash: 'GENESIS',
              ts: 0,
            }),
            ts: Date.now(),
            source: 'live',
            chainLinked: true,
          },
        ];

  const latest = blocks[blocks.length - 1];

  const av = $('userHistoryAvatar');
  av.style.background = colorFromPubkey(pubkey);
  av.textContent = (currentName[0] || '?').toUpperCase();

  $('userHistoryHandle').textContent = isMe ? `${currentHandle} (${t('youTag')})` : currentHandle;
  $('userHistoryStatus').textContent =
    blocks.length > 1 ? t('userHistoryVerified', blocks.length) : t('userHistorySingle');
  $('userHistoryPubkey').textContent = `${pubkey.slice(0, 12)}…${pubkey.slice(-8)}`;

  const list = $('userHistoryChainList');
  list.textContent = '';

  // Display newest block at top down to #1 Genesis (classic blockchain explorer order)
  const reversed = [...blocks].reverse();
  reversed.forEach((b, idx) => {
    const isLatest = idx === 0 && b.name === latest.name;
    const card = document.createElement('div');
    card.className = 'chain-block' + (isLatest ? ' is-current' : '');

    const head = document.createElement('div');
    head.className = 'chain-block-head';

    const title = document.createElement('div');
    title.className = 'chain-block-title';
    const seqSpan = document.createElement('span');
    seqSpan.className = 'chain-block-seq';
    seqSpan.textContent = `#${b.seq}`;
    const handleSpan = document.createElement('span');
    handleSpan.textContent = b.handle;
    title.append(seqSpan, handleSpan);
    head.appendChild(title);

    if (isLatest) {
      const currBadge = document.createElement('span');
      currBadge.className = 'chain-block-current';
      currBadge.textContent = t('userHistoryCurrentBadge');
      head.appendChild(currBadge);
    }

    const meta = document.createElement('div');
    meta.className = 'chain-block-meta';
    const timeEl = document.createElement('span');
    timeEl.textContent = b.ts ? formatSeenTime(b.ts) : '';
    const verEl = document.createElement('span');
    verEl.className = 'chain-block-verified';
    verEl.textContent =
      b.source === 'nick'
        ? b.seq > 1 && b.chainLinked
          ? t('userHistoryChainLinked')
          : t('userHistorySigned')
        : t('userHistoryObserved');
    meta.append(timeEl, verEl);

    const hashes = document.createElement('div');
    hashes.className = 'chain-block-hashes';
    const hashLine = document.createElement('div');
    hashLine.textContent = `hash: ${b.blockHash.slice(0, 16)}…`;
    const prevLine = document.createElement('div');
    prevLine.textContent =
      b.prevHash === 'GENESIS'
        ? t('userHistoryGenesis')
        : `prev: ${String(b.prevHash).slice(0, 16)}…`;
    hashes.append(hashLine, prevLine);

    card.append(head, meta, hashes);
    list.appendChild(card);
  });

  showOverlay('userHistoryModal');
}

function setCreateRelayModeUI(mode, customUrl = '') {
  const isCustom = mode === 'custom';
  $('createRelayPublic').checked = !isCustom;
  $('createRelayCustom').checked = isCustom;
  $('createCustomRelayField').classList.toggle('hidden', !isCustom);
  $('createCustomRelayInput').required = isCustom;
  if (customUrl) $('createCustomRelayInput').value = customUrl;
}

function setJoinRelayModeUI(mode, customUrl = '') {
  const isCustom = mode === 'custom';
  $('joinRelayPublic').checked = !isCustom;
  $('joinRelayCustom').checked = isCustom;
  $('joinCustomRelayField').classList.toggle('hidden', !isCustom);
  $('joinCustomRelayInput').required = isCustom;
  if (customUrl !== undefined) $('joinCustomRelayInput').value = customUrl;
}

function openCreateRoomModal() {
  $('createRoomName').value = '';
  $('createRoomPass').value = generatePassphrase();
  $('createRoomError').classList.add('hidden');
  // When running self-hosted via relay/server.mjs, pre-select this server as custom relay by default
  if (selfHostedRelayUrl) {
    setCreateRelayModeUI('custom', selfHostedRelayUrl);
  } else {
    $('createCustomRelayInput').value = '';
    setCreateRelayModeUI('public');
  }
  showOverlay('createRoomModal');
  $('createRoomName').focus();
}

function openJoinRoomModal() {
  $('joinInvitePaste').value = '';
  $('joinRoomName').value = '';
  $('joinRoomPass').value = '';
  $('joinRoomError').classList.add('hidden');
  if (selfHostedRelayUrl) {
    setJoinRelayModeUI('custom', selfHostedRelayUrl);
  } else {
    setJoinRelayModeUI('public', '');
  }
  showOverlay('joinRoomModal');
  $('joinInvitePaste').focus();
}

function openInviteModal() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;

  const isCustom = state.room.relayMode === 'custom' && Boolean(state.room.customRelay);
  const url = encodeInviteUrl(window.location.href, {
    name: state.room.name,
    passphrase: state.room.passphrase,
    relayMode: isCustom ? 'custom' : 'public',
    customRelay: isCustom ? state.room.customRelay : null,
  });

  invitePassVisible = false;
  $('inviteLinkOutput').value = url;
  $('inviteRoomNameText').textContent = state.room.name;
  $('invitePassText').textContent = '••••••••••••';
  $('togglePassRevealBtn').textContent = t('showPassBtn');
  $('inviteRelayText').textContent = isCustom
    ? state.room.customRelay
    : t('relayModePublic');
  $('inviteMyFingerprint').textContent = getRoomHandle(
    state,
    settings.name,
    state.identity.pubkeyHex
  );

  if (navigator.share) {
    $('shareInviteLinkBtn').classList.remove('hidden');
  } else {
    $('shareInviteLinkBtn').classList.add('hidden');
  }

  showOverlay('inviteModal');
}

function openOnlineModal() {
  const state = roomsState.get(activeChannelId);
  if (!state) return;
  rebuildRoomDirectory(state);

  const list = $('onlineList');
  list.textContent = '';

  // 1. Active room members (Online first, then Offline by most recent activity)
  const membersList = [...state.members.values()].sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
    return (b.lastActiveMs || 0) - (a.lastActiveMs || 0);
  });

  const activeHeading = document.createElement('div');
  activeHeading.className = 'members-section-title';
  activeHeading.textContent = t('membersSectionTitle', membersList.length);
  list.appendChild(activeHeading);

  for (const r of membersList) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'online-row online-row-btn';
    item.title = t('clickForHistoryHint');
    item.addEventListener('click', () => {
      hideOverlay('onlineModal');
      openUserHistoryModal(state.room.channelId, r.pubkey);
    });

    const avWrap = document.createElement('div');
    avWrap.className = 'member-status-wrap';
    const av = document.createElement('div');
    av.className = 'online-avatar';
    av.style.background = colorFromPubkey(r.pubkey);
    av.textContent = (r.name[0] || '?').toUpperCase();
    const stDot = document.createElement('span');
    stDot.className = 'member-status-dot' + (r.isOnline ? ' is-online' : '');
    avWrap.append(av, stDot);

    const info = document.createElement('div');
    const topRow = document.createElement('div');
    topRow.className = 'member-row-top';
    const nm = document.createElement('span');
    const handle = getRoomHandle(state, r.name, r.pubkey);
    nm.textContent = r.isMe ? `${handle} (${t('youTag')})` : handle;
    const badge = document.createElement('span');
    badge.className = 'member-status-badge' + (r.isOnline ? ' is-online' : '');
    badge.textContent = r.isOnline ? t('memberOnlineStatus') : t('memberOfflineStatus');
    topRow.append(nm, badge);

    const sub = document.createElement('div');
    sub.className = 'muted small';
    const chain = state.nameChains.get(r.pubkey) || [];
    const prevHandles = chain
      .filter((b) => b.handle !== handle)
      .map((b) => b.handle);
    if (prevHandles.length > 0) {
      sub.textContent = `⛓ ${t('previouslyKnownAs', [...new Set(prevHandles)].slice(-2).join(', '))}`;
    } else if (!r.isOnline && r.lastActiveMs) {
      sub.textContent = formatSeenTime(r.lastActiveMs);
    } else {
      sub.textContent = `ID: ${shortFingerprint(r.pubkey)}`;
    }

    info.append(topRow, sub);
    item.append(avWrap, info);
    list.appendChild(item);
  }

  if (membersList.length === 1 && state.archivedMembers.size === 0) {
    const note = document.createElement('p');
    note.className = 'hint-text';
    note.textContent = t('noOneOnline');
    list.appendChild(note);
  }

  // 2. Archived members (left & erased their data — display name scrubbed, ONLY last 4-char tag remains!)
  const archivedList = [...state.archivedMembers.values()].sort(
    (a, b) => (b.archivedAtMs || 0) - (a.archivedAtMs || 0)
  );
  if (archivedList.length > 0) {
    const div = document.createElement('div');
    div.className = 'divider';
    list.appendChild(div);

    const archHeading = document.createElement('div');
    archHeading.className = 'members-section-title';
    archHeading.textContent = t('archivedMembersTitle', archivedList.length);
    list.appendChild(archHeading);

    for (const arch of archivedList) {
      const row = document.createElement('div');
      row.className = 'archived-row';
      const av = document.createElement('div');
      av.className = 'archived-avatar';
      av.textContent = '🗄';
      const info = document.createElement('div');
      const codeEl = document.createElement('div');
      codeEl.className = 'archived-handle';
      codeEl.textContent = `archived-${arch.lastTag}`;
      const subEl = document.createElement('div');
      subEl.className = 'muted small';
      subEl.textContent = t('archivedMemberSub', formatSeenTime(arch.archivedAtMs || Date.now()));
      info.append(codeEl, subEl);
      row.append(av, info);
      list.appendChild(row);
    }

    const archHint = document.createElement('p');
    archHint.className = 'hint-text';
    archHint.textContent = t('archivedMembersHint');
    list.appendChild(archHint);
  }

  showOverlay('onlineModal');
}

function renderIdentityStatusPill() {
  const el = $('settingsIdentityStatus');
  if (!el) return;
  const base = settings.hasPasswordIdentity ? t('identityStatusPassword') : t('identityStatusDevice');
  const lock = settings.deviceLockEnabled ? ` · 🔒 ${t('identityStatusLocked')}` : '';
  el.textContent = base + lock;
}

async function rehydrateAllRoomIdentities() {
  for (const state of roomsState.values()) {
    state.identity = await deriveRoomIdentity(activeMasterSeed, state.room.channelId);
    rebuildRoomDirectory(state);
  }
  syncPushRegistration();
  if (activeChannelId) {
    const activeState = roomsState.get(activeChannelId);
    if (activeState) renderMyRoomHandle(activeState);
    announcePresence(activeChannelId, 'online');
    renderMessages(false);
    renderOnlineCount();
  }
  renderRoomList();
}

async function openInfoModal(lang = settings.lang) {
  infoModalLang = lang === 'et' ? 'et' : 'en';
  $('infoLangToggleBtn').textContent = infoModalLang === 'et' ? 'EN' : 'ET';
  const box = $('infoContent');
  box.textContent = t('infoLoading');
  showOverlay('infoModal');

  try {
    if (!cachedReadmeText) {
      const res = await fetch('./README.md');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      cachedReadmeText = await res.text();
    }
    const splitMarker = '# DecLoc Chat — Detsentraliseeritud kohalik vestlus';
    const idx = cachedReadmeText.indexOf(splitMarker);
    let md = cachedReadmeText;
    if (idx > 0) {
      md = infoModalLang === 'et'
        ? cachedReadmeText.slice(idx)
        : cachedReadmeText.slice(0, idx).replace(/\n+---\s*$/, '');
    }
    renderSafeMarkdown(box, md);
    box.scrollTop = 0;
  } catch {
    box.textContent = t('infoLoadError');
  }
}

// Lightweight, 100% XSS-safe Markdown-to-DOM renderer (never uses innerHTML)
function renderSafeMarkdown(container, md) {
  container.textContent = '';
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  function appendInline(parent, text) {
    const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
    let last = 0;
    let m;
    while ((m = tokenRe.exec(text)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const tok = m[0];
      if (tok.startsWith('`')) {
        const code = document.createElement('code');
        code.textContent = tok.slice(1, -1);
        parent.appendChild(code);
      } else if (tok.startsWith('**')) {
        const strong = document.createElement('strong');
        appendInline(strong, tok.slice(2, -2));
        parent.appendChild(strong);
      } else if (tok.startsWith('*')) {
        const em = document.createElement('em');
        appendInline(em, tok.slice(1, -1));
        parent.appendChild(em);
      } else if (tok.startsWith('[')) {
        const splitIdx = tok.indexOf('](');
        const label = tok.slice(1, splitIdx);
        const href = tok.slice(splitIdx + 2, -1).trim();
        if (href.startsWith('https://') || href.startsWith('http://')) {
          const a = document.createElement('a');
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = label;
          parent.appendChild(a);
        } else {
          parent.appendChild(document.createTextNode(label));
        }
      }
      last = m.index + tok.length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }

    // Fenced code block
    if (trimmed.startsWith('```')) {
      i++;
      const codeLines = [];
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = codeLines.join('\n');
      pre.appendChild(code);
      container.appendChild(pre);
      continue;
    }

    // Horizontal rule
    if (/^-{3,}$/.test(trimmed)) {
      container.appendChild(document.createElement('hr'));
      i++;
      continue;
    }

    // Headings
    const hMatch = trimmed.match(/^(#{1,4})\s+(.*)$/);
    if (hMatch) {
      const h = document.createElement(`h${hMatch[1].length}`);
      appendInline(h, hMatch[2]);
      container.appendChild(h);
      i++;
      continue;
    }

    // Blockquote (skip the top in-page language jump banner since modal has a toggle button)
    if (trimmed.startsWith('>')) {
      const bqLines = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        bqLines.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      const joined = bqLines.join('\n');
      if (joined.includes('Jump to Estonian') || joined.includes('Back to English')) continue;
      const bq = document.createElement('blockquote');
      bqLines.forEach((bl, idx) => {
        if (idx > 0) bq.appendChild(document.createElement('br'));
        appendInline(bq, bl);
      });
      container.appendChild(bq);
      continue;
    }

    // Markdown table
    if (trimmed.startsWith('|') && i + 1 < lines.length && /^\|[\s:-]+\|/.test(lines[i + 1].trim())) {
      const splitCells = (rowStr) =>
        rowStr
          .trim()
          .replace(/^\|/, '')
          .replace(/\|$/, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.trim().replace(/\\\|/g, '|'));

      const headers = splitCells(lines[i]);
      i += 2; // skip header & separator
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const trH = document.createElement('tr');
      for (const h of headers) {
        const th = document.createElement('th');
        appendInline(th, h);
        trH.appendChild(th);
      }
      thead.appendChild(trH);
      table.appendChild(thead);

      const tbody = document.createElement('tbody');
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = splitCells(lines[i]);
        const tr = document.createElement('tr');
        for (const c of cells) {
          const td = document.createElement('td');
          appendInline(td, c);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
        i++;
      }
      table.appendChild(tbody);
      container.appendChild(table);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = document.createElement('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(/^\s*[-*]\s+/, ''));
        ul.appendChild(li);
        i++;
      }
      container.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(/^\s*\d+\.\s+/, ''));
        ol.appendChild(li);
        i++;
      }
      container.appendChild(ol);
      continue;
    }

    // Paragraph
    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].trim().startsWith('#') &&
      !lines[i].trim().startsWith('```') &&
      !lines[i].trim().startsWith('>') &&
      !lines[i].trim().startsWith('|') &&
      !/^-{3,}$/.test(lines[i].trim()) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i])
    ) {
      pLines.push(lines[i].trim());
      i++;
    }
    const p = document.createElement('p');
    appendInline(p, pLines.join(' '));
    container.appendChild(p);
  }
}

function openSettingsModal() {
  $('settingsNameInput').value = settings.name;
  $('settingsIdentityPassInput').value = '';
  $('settingsDeviceLockCheck').checked = settings.deviceLockEnabled;
  renderIdentityStatusPill();
  $('settingsThemeSelect').value = settings.theme;
  $('settingsLangSelect').value = settings.lang;
  $('settingsSoundCheck').checked = settings.sound;
  $('settingsNotifyCheck').checked = settings.notifications;
  $('settingsReadReceiptsCheck').checked = settings.readReceipts;
  $('settingsNtfyUrlInput').value = settings.ntfyUrl || '';
  $('settingsTurnUrlInput').value = settings.turnUrl || '';
  $('settingsTurnUserInput').value = settings.turnUser || '';
  $('settingsTurnPassInput').value = settings.turnPass || '';
  $('settingsGiphyKeyInput').value = settings.giphyApiKey || '';
  renderWebPushStatus();
  renderPublicRelaysChecklist();
  showOverlay('settingsModal');
}

function bindEvents() {
  // Close modals on backdrop click or close buttons
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => hideOverlay(btn.dataset.closeModal));
  });
  document.querySelectorAll('.overlay').forEach((ov) => {
    if (ov.id === 'welcomeOverlay' || ov.id === 'gateOverlay' || ov.id === 'unlockOverlay') return;
    ov.addEventListener('click', (e) => {
      if (e.target === ov) hideOverlay(ov.id);
    });
  });

  // Unlock local device vault
  $('unlockForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pass = $('unlockPassInput').value;
    if (!pass) return;
    const btn = $('unlockSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const decrypted = await decryptLocalVault(pass, settings.lockedVault);
      if (!decrypted || typeof decrypted.masterSeed !== 'string' || decrypted.masterSeed.length !== 64) {
        $('unlockError').textContent = t('unlockWrong');
        $('unlockError').classList.remove('hidden');
        return;
      }
      activeMasterSeed = decrypted.masterSeed;
      hideOverlay('unlockOverlay');
      await startApp();
    } finally {
      btn.disabled = false;
      btn.textContent = t('unlockBtn');
    }
  });

  $('unlockResetBtn').addEventListener('click', async () => {
    if (!confirm(t('clearAllConfirm'))) return;
    await clearAllData();
    window.location.reload();
  });

  $('lockAppBtn').addEventListener('click', () => {
    if (callManager) callManager.leaveCall();
    if (activeChannelId) announcePresence(activeChannelId, 'leave');
    window.location.reload();
  });

  // Optional Site Gate
  $('gateForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const hash = await sha256Hex($('gateInput').value);
    if (hash.toLowerCase() === String(CONFIG.SITE_PASSCODE_SHA256).toLowerCase()) {
      settings.gatePassed = true;
      saveSettings(settings);
      hideOverlay('gateOverlay');
      await continueBootAfterGate();
    } else {
      $('gateError').textContent = t('gateWrong');
      $('gateError').classList.remove('hidden');
    }
  });

  // Welcome form (with optional personal password & device lock)
  $('welcomeLangBtn').addEventListener('click', () => {
    settings.lang = settings.lang === 'et' ? 'en' : 'et';
    saveSettings(settings);
    applyI18n();
    openWelcomeOverlay();
  });

  $('welcomePassInput').addEventListener('input', () => {
    const hasPass = $('welcomePassInput').value.length > 0;
    $('welcomeLockRow').classList.toggle('hidden', !hasPass);
    if (!hasPass) $('welcomeLockCheck').checked = false;
  });

  $('welcomeForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('welcomeNameInput').value.trim();
    if (!name) {
      $('welcomeError').textContent = t('errEnterName');
      $('welcomeError').classList.remove('hidden');
      return;
    }
    const userPass = $('welcomePassInput').value;
    const lockDevice = userPass.length > 0 && $('welcomeLockCheck').checked;
    const btn = $('welcomeSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');

    try {
      settings.name = name.slice(0, 32);
      if (userPass.length > 0) {
        activeMasterSeed = await deriveMasterSeedFromPassword(settings.name, userPass);
        settings.hasPasswordIdentity = true;
        if (lockDevice) {
          settings.deviceLockEnabled = true;
          settings.lockedVault = await encryptLocalVault(userPass, { masterSeed: activeMasterSeed });
          settings.masterSeed = null;
        } else {
          settings.deviceLockEnabled = false;
          settings.lockedVault = null;
          settings.masterSeed = activeMasterSeed;
        }
      } else {
        activeMasterSeed = settings.masterSeed || generateMasterSeed();
        settings.masterSeed = activeMasterSeed;
        settings.hasPasswordIdentity = false;
        settings.deviceLockEnabled = false;
        settings.lockedVault = null;
      }
      saveSettings(settings);
      hideOverlay('welcomeOverlay');
      await startApp();
    } finally {
      btn.disabled = false;
      btn.textContent = pendingInvite ? t('joinInvitedBtn') : t('startBtn');
    }
  });

  // Update / set personal password from Settings
  $('applyIdentityBtn').addEventListener('click', async () => {
    const name = $('settingsNameInput').value.trim() || settings.name;
    const userPass = $('settingsIdentityPassInput').value;
    const wantLock = $('settingsDeviceLockCheck').checked;

    if (!userPass && wantLock && !settings.deviceLockEnabled) {
      showToast(t('identityPassNeeded'));
      return;
    }

    const btn = $('applyIdentityBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const prevName = settings.name;
      const prevSeed = activeMasterSeed;
      settings.name = name.slice(0, 32);
      if (userPass.length > 0) {
        activeMasterSeed = await deriveMasterSeedFromPassword(settings.name, userPass);
        settings.hasPasswordIdentity = true;
        if (wantLock) {
          settings.deviceLockEnabled = true;
          settings.lockedVault = await encryptLocalVault(userPass, { masterSeed: activeMasterSeed });
          settings.masterSeed = null;
        } else {
          settings.deviceLockEnabled = false;
          settings.lockedVault = null;
          settings.masterSeed = activeMasterSeed;
        }
        await rehydrateAllRoomIdentities();
      } else if (!wantLock && settings.deviceLockEnabled) {
        // User turned off local device lock while keeping current unlocked identity
        settings.deviceLockEnabled = false;
        settings.lockedVault = null;
        settings.masterSeed = activeMasterSeed;
      }
      saveSettings(settings);
      if (activeMasterSeed === prevSeed && prevName && settings.name !== prevName) {
        await broadcastNameChangeAcrossRooms(prevName, settings.name);
      }
      $('settingsIdentityPassInput').value = '';
      $('sidebarUserName').textContent = settings.name;
      $('lockAppBtn').classList.toggle('hidden', !settings.deviceLockEnabled);
      renderIdentityStatusPill();
      showToast(t('identityUpdatedToast'));
    } finally {
      btn.disabled = false;
      btn.textContent = t('identityUpdateBtn');
    }
  });

  // Sidebar & Empty state buttons
  $('openCreateRoomBtn').addEventListener('click', openCreateRoomModal);
  $('emptyCreateBtn').addEventListener('click', openCreateRoomModal);
  $('openJoinRoomBtn').addEventListener('click', openJoinRoomModal);
  $('emptyJoinBtn').addEventListener('click', openJoinRoomModal);
  $('infoBtn').addEventListener('click', () => openInfoModal(settings.lang));
  $('infoLangToggleBtn').addEventListener('click', () => {
    openInfoModal(infoModalLang === 'et' ? 'en' : 'et');
  });
  $('notifyBtn').addEventListener('click', async () => {
    const currentlyActive =
      settings.notifications && 'Notification' in window && Notification.permission === 'granted';
    if (currentlyActive) {
      settings.notifications = false;
      saveSettings(settings);
      renderNotifyButtonState();
      await syncPushRegistration();
      showToast(t('notifyDisabledToast'));
      return;
    }
    const perm = await requestNotificationPermission();
    if (perm === 'granted') {
      settings.notifications = true;
      saveSettings(settings);
      playMessageSound();
      vibrateDevice([150, 80, 150]);
      renderNotifyButtonState();
      await syncPushRegistration();
      showToast(t('notifyEnabledToast'));
    } else {
      settings.notifications = false;
      saveSettings(settings);
      renderNotifyButtonState();
      showToast(t('notifyDeniedToast'), 4500);
    }
  });
  $('settingsBtn').addEventListener('click', openSettingsModal);
  $('relayStatusBtn').addEventListener('click', openSettingsModal);

  // Mobile back button
  $('mobileBackBtn').addEventListener('click', () => {
    $('appShell').classList.remove('mobile-chat-open');
  });

  // Create room modal
  $('genPassBtn').addEventListener('click', () => {
    $('createRoomPass').value = generatePassphrase();
  });
  $('createRelayPublic').addEventListener('change', () => setCreateRelayModeUI('public'));
  $('createRelayCustom').addEventListener('change', () => setCreateRelayModeUI('custom'));

  $('createRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('createRoomName').value.trim();
    const pass = $('createRoomPass').value;
    const relayMode = $('createRelayCustom').checked ? 'custom' : 'public';
    let customRelay = null;

    if (!name || !pass) {
      $('createRoomError').textContent = t('errFillFields');
      $('createRoomError').classList.remove('hidden');
      return;
    }
    if (relayMode === 'custom') {
      customRelay = normalizeRelayUrl($('createCustomRelayInput').value);
      if (!customRelay) {
        $('createRoomError').textContent = t('errInvalidRelay');
        $('createRoomError').classList.remove('hidden');
        return;
      }
    }

    const btn = $('createRoomSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const chId = await joinOrCreateRoom(name, pass, { relayMode, customRelay });
      hideOverlay('createRoomModal');
      if (chId) {
        selectRoom(chId);
        if (customRelay && isOnionRelay(customRelay)) showToast(t('onionRelayHint'), 5000);
        openInviteModal();
      }
    } finally {
      btn.disabled = false;
      btn.textContent = t('createBtn');
    }
  });

  // Join room modal (auto-fill on invite link paste)
  $('joinRelayPublic').addEventListener('change', () => setJoinRelayModeUI('public'));
  $('joinRelayCustom').addEventListener('change', () => setJoinRelayModeUI('custom'));

  $('joinInvitePaste').addEventListener('input', () => {
    const val = $('joinInvitePaste').value.trim();
    if (!val) return;
    const hashIdx = val.indexOf('#');
    const parsed = decodeInviteHash(hashIdx >= 0 ? val.slice(hashIdx) : val);
    if (parsed) {
      $('joinRoomName').value = parsed.name;
      $('joinRoomPass').value = parsed.passphrase;
      if (parsed.relayMode === 'custom' && parsed.customRelay) {
        setJoinRelayModeUI('custom', parsed.customRelay);
      } else {
        setJoinRelayModeUI('public', '');
      }
      $('joinRoomError').classList.add('hidden');
    }
  });

  $('joinRoomForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    let name = $('joinRoomName').value.trim();
    let pass = $('joinRoomPass').value;
    let relayMode = $('joinRelayCustom').checked ? 'custom' : 'public';
    let customRelay = relayMode === 'custom' ? normalizeRelayUrl($('joinCustomRelayInput').value) : null;

    const pasted = $('joinInvitePaste').value.trim();
    if (pasted && (!name || !pass)) {
      const hashIdx = pasted.indexOf('#');
      const parsed = decodeInviteHash(hashIdx >= 0 ? pasted.slice(hashIdx) : pasted);
      if (!parsed) {
        $('joinRoomError').textContent = t('errInvalidInvite');
        $('joinRoomError').classList.remove('hidden');
        return;
      }
      name = parsed.name;
      pass = parsed.passphrase;
      relayMode = parsed.relayMode;
      customRelay = parsed.customRelay;
    }

    if (!name || !pass) {
      $('joinRoomError').textContent = t('errFillFields');
      $('joinRoomError').classList.remove('hidden');
      return;
    }
    if (relayMode === 'custom' && !customRelay) {
      $('joinRoomError').textContent = t('errInvalidRelay');
      $('joinRoomError').classList.remove('hidden');
      return;
    }

    const btn = $('joinRoomSubmitBtn');
    btn.disabled = true;
    btn.textContent = t('derivingKeys');
    try {
      const chId = await joinOrCreateRoom(name, pass, { relayMode, customRelay });
      hideOverlay('joinRoomModal');
      if (chId) {
        selectRoom(chId);
        if (customRelay && isOnionRelay(customRelay)) showToast(t('onionRelayHint'), 5000);
      }
    } finally {
      btn.disabled = false;
      btn.textContent = t('joinBtn');
    }
  });

  // Chat header actions
  $('inviteRoomBtn').addEventListener('click', openInviteModal);
  $('onlinePillBtn').addEventListener('click', openOnlineModal);
  $('myHandleBtn').addEventListener('click', () => {
    const st = roomsState.get(activeChannelId);
    if (st) openUserHistoryModal(st.room.channelId, st.identity.pubkeyHex);
  });
  $('voiceCallBtn').addEventListener('click', () => startRoomCall(false));
  $('videoCallBtn').addEventListener('click', () => startRoomCall(true));
  $('joinCallAudioBtn').addEventListener('click', () => startRoomCall(false));
  $('joinCallVideoBtn').addEventListener('click', () => startRoomCall(true));
  $('layoutCompactBtn').addEventListener('click', () => setCallLayout('compact'));
  $('layoutGridBtn').addEventListener('click', () => setCallLayout('grid'));
  $('layoutSplitBtn').addEventListener('click', () => setCallLayout('split'));
  $('layoutSpotlightBtn').addEventListener('click', () => setCallLayout('spotlight'));
  $('callBackToChatBtn').addEventListener('click', () => setCallLayout('compact'));
  $('callFullscreenBtn').addEventListener('click', async () => {
    const panel = $('callPanel');
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        if (callLayout === 'compact') setCallLayout('spotlight');
        if (panel.requestFullscreen) await panel.requestFullscreen();
      }
    } catch {
      // Browser may block fullscreen on some mobile Safari builds — CSS fullscreen overlay still works!
    }
  });
  $('toggleMuteBtn').addEventListener('click', () => callManager?.toggleMute());
  $('toggleCamBtn').addEventListener('click', async () => {
    try {
      await callManager?.toggleVideo();
    } catch {
      showToast(t('callMediaError'), 5000);
    }
  });
  $('flipCamBtn').addEventListener('click', async () => {
    try {
      await callManager?.switchCamera();
    } catch {
      showToast(t('callMediaError'), 4000);
    }
  });
  $('callCameraSelect').addEventListener('change', async (e) => {
    const devId = e.target.value;
    if (!devId) return;
    try {
      await callManager?.selectCamera(devId);
    } catch {
      showToast(t('callMediaError'), 4000);
    }
  });
  $('hangupBtn').addEventListener('click', () => {
    stopCallRingtone();
    callManager?.leaveCall();
  });

  function getOwnMessageIdsInRoom(state) {
    const ids = [];
    for (const m of state.messages.values()) {
      if (m.pubkey === state.identity.pubkeyHex) ids.push(m.id);
    }
    return ids;
  }

  async function leaveActiveRoomLocally() {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    clearTimeout(membershipAnchorTimers.get(activeChannelId));
    membershipAnchorTimers.delete(activeChannelId);
    stopCallRingtone();
    if (callManager?.activeChannelId === activeChannelId) {
      await callManager.leaveCall();
    }
    announcePresence(activeChannelId, 'leave');

    await deleteRoom(activeChannelId);
    roomsState.delete(activeChannelId);
    activeChannelId = null;
    syncSubscriptions();
    renderRoomList();
    updateTabTitle();

    if (roomsState.size > 0) {
      selectRoom([...roomsState.keys()][0]);
    } else {
      $('chatView').classList.add('hidden');
      $('emptyState').classList.remove('hidden');
      $('appShell').classList.remove('mobile-chat-open');
    }
  }

  async function archiveAndLeaveActiveRoom() {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const channelId = state.room.channelId;
    const myPubkey = state.identity.pubkeyHex;

    rebuildRoomDirectory(state);
    const chain = state.nameChains.get(myPubkey) || [];
    const currentTag = getRoomTag(state, myPubkey, settings.name);
    const lastTag =
      chain.length > 0 && chain[chain.length - 1].name === settings.name
        ? chain[chain.length - 1].tag
        : currentTag;
    const reservedTags = [...new Set([...chain.map((b) => b.tag), lastTag])]
      .filter(isValidHandleTag)
      .slice(0, 20);

    // 1. Delete all own chat messages (locally + NIP-09 + encrypted tombstone)
    const ownMsgIds = getOwnMessageIdsInRoom(state);
    if (ownMsgIds.length > 0) {
      await deleteOwnMessages(channelId, ownMsgIds);
    }

    // 2. Also send NIP-09 deletion for our own nick/read/react events so relays wipe our display names too
    let latestOwnTs = 0;
    const ownMetaIds = new Set(state.ownMetaEventIds);
    for (const n of state.nickEvents.values()) {
      if (n.pubkey === myPubkey) {
        ownMetaIds.add(n.id);
        latestOwnTs = Math.max(latestOwnTs, typeof n.tsMs === 'number' ? n.tsMs : (n.createdAt || 0) * 1000);
      }
    }
    for (const m of state.messages.values()) {
      if (m.pubkey === myPubkey) {
        latestOwnTs = Math.max(latestOwnTs, typeof m.tsMs === 'number' ? m.tsMs : (m.createdAt || 0) * 1000);
      }
    }
    const metaList = [...ownMetaIds];
    if (metaList.length > 0 && pool) {
      for (let i = 0; i < metaList.length; i += 100) {
        const chunk = metaList.slice(i, i + 100);
        const nip09Meta = await signNostrEvent(
          {
            kind: CONFIG.DELETE_KIND,
            tags: [...chunk.map((id) => ['e', id]), ['k', String(CONFIG.MSG_KIND)]],
            content: '',
          },
          state.identity.privKeyBytes
        );
        pool.publish(nip09Meta, getRoomRelays(state.room));
      }
    }

    // 3. Publish signed encrypted archive record (NO display name — ONLY lastTag + reservedTags!)
    const archiveTs = Math.max(Date.now(), latestOwnTs + 1000);
    const archivePayload = {
      v: 1,
      t: 'archive',
      lastTag,
      reservedTags,
      ts: archiveTs,
    };
    const encArchive = await encryptRoomPayload(
      state.aesKey,
      myPubkey,
      channelId,
      archivePayload
    );
    const archiveEv = await signNostrEvent(
      {
        kind: CONFIG.MSG_KIND,
        tags: [['e', channelId, '', 'root']],
        content: encArchive,
      },
      state.identity.privKeyBytes
    );
    if (pool) pool.publish(archiveEv, getRoomRelays(state.room));

    // Give WebSocket a brief moment to flush before tearing down the room subscription
    await new Promise((r) => setTimeout(r, 150));
    showToast(t('archivedAndLeftToast', lastTag), 4000);
    await leaveActiveRoomLocally();
  }

  $('leaveRoomBtn').addEventListener('click', () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const ownCount = getOwnMessageIdsInRoom(state).length;
    $('leaveRoomDesc').textContent = t('leaveModalDesc', state.room.name, ownCount);
    $('purgeOwnStayBtn').disabled = ownCount === 0;
    // Always allow erasing profile/name & archiving when leaving, even with 0 messages
    $('purgeOwnAndLeaveBtn').disabled = false;
    showOverlay('leaveRoomModal');
  });

  $('leaveLocalOnlyBtn').addEventListener('click', async () => {
    hideOverlay('leaveRoomModal');
    await leaveActiveRoomLocally();
  });

  $('purgeOwnStayBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const ownIds = getOwnMessageIdsInRoom(state);
    hideOverlay('leaveRoomModal');
    if (ownIds.length === 0) {
      showToast(t('noOwnMsgsToast'));
      return;
    }
    const deleted = await deleteOwnMessages(state.room.channelId, ownIds);
    showToast(t('myMsgsDeletedToast', deleted));
  });

  $('purgeOwnAndLeaveBtn').addEventListener('click', async () => {
    hideOverlay('leaveRoomModal');
    await archiveAndLeaveActiveRoom();
  });

  // Invite modal buttons
  $('copyInviteLinkBtn').addEventListener('click', async () => {
    await copyText($('inviteLinkOutput').value);
    showToast(t('copiedToast'));
  });

  $('shareInviteLinkBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state || !navigator.share) return;
    try {
      await navigator.share({
        title: `${CONFIG.APP_NAME} — ${state.room.name}`,
        text: `${state.room.name}`,
        url: $('inviteLinkOutput').value,
      });
    } catch {
      // user cancelled
    }
  });

  $('togglePassRevealBtn').addEventListener('click', () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    invitePassVisible = !invitePassVisible;
    $('invitePassText').textContent = invitePassVisible ? state.room.passphrase : '••••••••••••';
    $('togglePassRevealBtn').textContent = invitePassVisible ? t('hidePassBtn') : t('showPassBtn');
  });

  $('copyCredsBtn').addEventListener('click', async () => {
    const state = roomsState.get(activeChannelId);
    if (!state) return;
    const relayLine = state.room.relayMode === 'custom' && state.room.customRelay
      ? `\n${t('inviteRelayLabel')}: ${state.room.customRelay}`
      : '';
    const text = `${t('roomNameLabel')}: ${state.room.name}\n${t('roomPassLabel')}: ${state.room.passphrase}${relayLine}`;
    await copyText(text);
    showToast(t('copiedToast'));
  });

  // Composer & Reply
  $('cancelReplyBtn').addEventListener('click', () => {
    replyTarget = null;
    renderReplyBar();
  });

  $('emojiPickerBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('emojiPopover');
    if (pop.classList.contains('hidden') || pickerReactTargetMsgId) {
      openPicker({ tab: pickerTab, reactTargetMsgId: null });
    } else {
      closePicker();
    }
  });
  $('pickerTabEmoji').addEventListener('click', () => setPickerTab('emoji'));
  $('pickerTabGif').addEventListener('click', () => setPickerTab('gif'));
  $('emojiSearchInput').addEventListener('input', () => renderEmojiGrid());
  $('gifSearchInput').addEventListener('input', () => {
    clearTimeout(gifSearchTimer);
    gifSearchTimer = setTimeout(() => loadGiphyGifs($('gifSearchInput').value), 350);
  });
  $('gifSendUrlBtn').addEventListener('click', async () => {
    const url = $('gifUrlInput').value.trim();
    if (!isSafeHttpsUrl(url)) {
      showToast(t('gifInvalidUrl'));
      return;
    }
    $('gifUrlInput').value = '';
    closePicker();
    await sendTextMessage('', { url, title: 'GIF' });
  });
  $('gifUrlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      $('gifSendUrlBtn').click();
    }
  });

  $('emojiPopover').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  document.addEventListener('click', (e) => {
    const pop = $('emojiPopover');
    if (!pop.classList.contains('hidden') && !pop.contains(e.target) && e.target !== $('emojiPickerBtn')) {
      closePicker();
    }
  });

  const msgInput = $('messageInput');
  msgInput.addEventListener('input', () => {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 130) + 'px';
    if (activeChannelId && msgInput.value.trim()) {
      sendTypingSignal(activeChannelId);
    }
  });

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 768) {
      e.preventDefault();
      $('composerForm').requestSubmit();
    }
  });

  $('composerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const val = msgInput.value;
    if (!val.trim()) return;
    msgInput.value = '';
    msgInput.style.height = 'auto';
    await sendTextMessage(val);
  });

  // Settings form
  $('resetRelaysBtn').addEventListener('click', () => {
    $('publicRelaysChecklist')
      .querySelectorAll('input[type="checkbox"]')
      .forEach((cb) => {
        cb.checked = true;
      });
    refreshPublicRelayDots();
  });

  $('settingsNotifyCheck').addEventListener('change', async (e) => {
    if (e.target.checked) {
      const perm = await requestNotificationPermission();
      if (perm !== 'granted') {
        e.target.checked = false;
        showToast(t('notifyDeniedToast'), 4500);
      }
    }
  });

  $('testNotifyBtn').addEventListener('click', async () => {
    playMessageSound();
    vibrateDevice([200, 100, 200]);
    if ('Notification' in window) {
      const perm =
        Notification.permission === 'default'
          ? await requestNotificationPermission()
          : Notification.permission;
      if (perm === 'granted') {
        $('settingsNotifyCheck').checked = true;
        if (!settings.notifications) {
          settings.notifications = true;
          saveSettings(settings);
          renderNotifyButtonState();
          syncPushRegistration();
        }
        await showOsNotification({
          title: t('testNotifyTitle'),
          body: t('testNotifyBody'),
          tag: 'decloc-test',
        });
      } else {
        showToast(t('notifyDeniedToast'), 4500);
      }
    }
  });

  $('genNtfyBtn').addEventListener('click', () => {
    $('settingsNtfyUrlInput').value = `https://ntfy.sh/decloc-${generatePassphrase(3, 4)}`;
  });

  $('testNtfyBtn').addEventListener('click', async () => {
    const raw = $('settingsNtfyUrlInput').value;
    const clean = normalizeNtfyUrl(raw);
    if (!clean) {
      showToast(t('ntfyFailedToast'), 4000);
      return;
    }
    $('settingsNtfyUrlInput').value = clean;
    const ok = await sendNtfyPing(clean, {
      isCall: false,
      title: t('testNotifyTitle'),
      body: t('testNotifyBody'),
    });
    showToast(ok ? t('ntfySentToast') : t('ntfyFailedToast'), 3500);
  });

  $('settingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const prevName = settings.name;
    const newName = $('settingsNameInput').value.trim();
    if (newName) settings.name = newName.slice(0, 32);
    settings.theme = $('settingsThemeSelect').value;
    settings.lang = $('settingsLangSelect').value;
    settings.sound = $('settingsSoundCheck').checked;
    settings.notifications = $('settingsNotifyCheck').checked;
    settings.readReceipts = $('settingsReadReceiptsCheck').checked;
    settings.ntfyUrl = normalizeNtfyUrl($('settingsNtfyUrlInput').value);
    settings.turnUrl = $('settingsTurnUrlInput').value.trim();
    settings.turnUser = $('settingsTurnUserInput').value.trim();
    settings.turnPass = $('settingsTurnPassInput').value.trim();
    settings.giphyApiKey = $('settingsGiphyKeyInput').value.trim();

    const selectedPublic = [
      ...$('publicRelaysChecklist').querySelectorAll('input[type="checkbox"]:checked'),
    ].map((cb) => cb.value);
    if (selectedPublic.length > 0) {
      settings.relays = selectedPublic;
    }

    saveSettings(settings);
    applyTheme();
    applyI18n();
    renderNotifyButtonState();
    $('sidebarUserName').textContent = settings.name;
    syncSubscriptions();
    if (prevName && settings.name !== prevName) {
      await broadcastNameChangeAcrossRooms(prevName, settings.name);
    }
    if (activeChannelId) {
      const st = roomsState.get(activeChannelId);
      if (st) {
        renderMyRoomHandle(st);
        renderActiveRoomRelayBadge(st.room);
      }
      announcePresence(activeChannelId, 'online');
      renderOnlineCount();
    }
    renderRoomList();
    hideOverlay('settingsModal');
  });

  // Backup export/import
  $('exportBackupBtn').addEventListener('click', async () => {
    const data = await exportBackup(settings, activeMasterSeed);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `decloc-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });

  $('importBackupBtn').addEventListener('click', () => $('importBackupFile').click());
  $('importBackupFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (data?.format !== 'decloc-backup-v1' || !data.profile?.masterSeed) {
        throw new Error('Bad format');
      }
      settings.name = String(data.profile.name || settings.name || 'User').slice(0, 32);
      activeMasterSeed = data.profile.masterSeed;
      settings.masterSeed = activeMasterSeed;
      settings.hasPasswordIdentity = data.profile.hasPasswordIdentity === true;
      settings.deviceLockEnabled = false;
      settings.lockedVault = null;
      if (Array.isArray(data.profile.relays) && data.profile.relays.length > 0) {
        const validPub = data.profile.relays.filter((r) => CONFIG.DEFAULT_RELAYS.includes(r));
        if (validPub.length > 0) settings.relays = validPub;
      }
      if (typeof data.profile.ntfyUrl === 'string') {
        settings.ntfyUrl = normalizeNtfyUrl(data.profile.ntfyUrl);
      }
      if (typeof data.profile.turnUrl === 'string') settings.turnUrl = data.profile.turnUrl.trim();
      if (typeof data.profile.turnUser === 'string') settings.turnUser = data.profile.turnUser.trim();
      if (typeof data.profile.turnPass === 'string') settings.turnPass = data.profile.turnPass.trim();
      saveSettings(settings);

      roomsState.clear();
      if (Array.isArray(data.rooms)) {
        for (const r of data.rooms) {
          if (r.name && r.passphrase) {
            await joinOrCreateRoom(r.name, r.passphrase, {
              relayMode: r.relayMode === 'custom' && r.customRelay ? 'custom' : 'public',
              customRelay: r.relayMode === 'custom' ? r.customRelay : null,
            });
          }
        }
      }
      syncSubscriptions();
      $('sidebarUserName').textContent = settings.name;
      renderRoomList();
      if (roomsState.size > 0) selectRoom([...roomsState.keys()][0]);
      showToast(t('backupImportedToast'));
      hideOverlay('settingsModal');
    } catch {
      showToast(t('backupInvalidToast'));
    }
  });

  // Clear all data
  $('clearAllBtn').addEventListener('click', async () => {
    if (!confirm(t('clearAllConfirm'))) return;
    if (callManager) callManager.destroy();
    if (pool) pool.destroy();
    await clearAllData();
    window.location.reload();
  });

  // Handle opening an invite hash in an already open tab
  window.addEventListener('hashchange', async () => {
    const inv = consumeInviteFromUrl();
    if (!inv || !settings.name) return;
    const chId = await joinOrCreateRoom(inv.name, inv.passphrase, {
      relayMode: inv.relayMode || 'public',
      customRelay: inv.customRelay || null,
    });
    if (chId) selectRoom(chId);
  });

  // Mark messages read, stop attention alerts, and revive relays + WebRTC calls on unlock / return
  let wasHidden = false;
  const handleAppReturn = (evt) => {
    if (document.hidden) {
      wasHidden = true;
      callManager?.handleAppHidden();
      return;
    }
    const wakingFromSleep = wasHidden || evt?.type === 'online';
    wasHidden = false;
    pool?.reconnectNow(wakingFromSleep);
    if (wakingFromSleep) {
      callManager?.handleAppResume().catch(() => {});
    } else {
      resumeAllCallMedia();
    }
    if (!document.hasFocus()) return;
    stopTitleFlash();
    stopCallRingtone();
    if (activeChannelId) {
      const state = roomsState.get(activeChannelId);
      if (state) {
        markRoomAsRead(state);
        scheduleReadReceipt(state);
        renderRoomList();
        updateTabTitle();
      }
    }
  };
  document.addEventListener('visibilitychange', handleAppReturn);
  window.addEventListener('focus', handleAppReturn);
  window.addEventListener('online', handleAppReturn);

  // Clean presence & call teardown on tab close
  window.addEventListener('pagehide', () => {
    stopCallRingtone();
    if (activeChannelId) announcePresence(activeChannelId, 'leave');
    if (callManager) callManager.leaveCall();
  });
}

// --- Theme, I18n, Formatting, Audio & Clipboard Utilities ---

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === 'light') {
    root.dataset.theme = 'light';
  } else if (settings.theme === 'dark') {
    root.dataset.theme = 'dark';
  } else {
    const prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
    root.dataset.theme = prefersLight ? 'light' : 'dark';
  }
}

function applyI18n() {
  t = createTranslator(settings.lang);
  document.documentElement.lang = settings.lang;
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const val = t(el.dataset.i18n);
    if (typeof val === 'string') el.textContent = val;
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const val = t(el.dataset.i18nPlaceholder);
    if (typeof val === 'string') el.placeholder = val;
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const val = t(el.dataset.i18nTitle);
    if (typeof val === 'string') el.title = val;
  });
  if (pool) handleRelayStatusChange();
  renderNotifyButtonState();
  renderWebPushStatus();
  if (activeChannelId) {
    const st = roomsState.get(activeChannelId);
    if (st) {
      renderMyRoomHandle(st);
      renderActiveRoomRelayBadge(st.room);
      renderOnlineCount();
    }
  }
}

function formatClock(ms) {
  return new Date(ms).toLocaleTimeString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatSeenTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatClock(ms);
  return `${d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'short',
  })} ${formatClock(ms)}`;
}

function formatShortTime(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return formatClock(ms);
  return d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'short',
  });
}

function formatDateHeading(ms) {
  const d = new Date(ms);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return t('today');
  const yest = new Date(today);
  yest.setDate(today.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) return t('yesterday');
  return d.toLocaleDateString(settings.lang === 'et' ? 'et-EE' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

async function copyText(str) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(str);
  } else {
    const ta = document.createElement('textarea');
    ta.value = str;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function showToast(msg, duration = 2600) {
  const box = $('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

init();
