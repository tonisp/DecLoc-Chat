// Rich multi-channel notification manager for DecLoc Chat:
// - Autoplay-safe Web Audio chimes & incoming call ringtone
// - ServiceWorker OS notifications (works on Android Chrome, iOS PWA 16.4+, Desktop)
// - Dynamic red-dot favicon badge + blinking browser tab title
// - PWA App Badging API (navigator.setAppBadge)
// - Mobile Vibration API
// - Native VAPID Web Push subscription (when self-hosted on relay/server.mjs)
// - Optional ntfy.sh privacy-safe push ping (works even on static GitHub Pages)

let audioCtx = null;
let titleFlashTimer = null;
let titleFlashFlip = false;
let callRingTimer = null;
let baseTitle = 'DecLoc Chat';
let flashHeadline = '';
let lastUnreadCount = 0;

function ensureAudioContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!audioCtx) audioCtx = new Ctx();
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

// Unlock Web Audio on the very first user interaction so Safari/Chrome/Firefox allow sound later
export function initAudioUnlock() {
  const unlock = () => {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    try {
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
    } catch {
      // ignore
    }
    if (ctx.state === 'running') {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('touchstart', unlock, true);
    }
  };
  window.addEventListener('pointerdown', unlock, true);
  window.addEventListener('keydown', unlock, true);
  window.addEventListener('touchstart', unlock, true);
}

// Crisp, clearly audible 2-note message alert chime
export function playMessageSound() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    const notes = [
      { freq: 587.33, start: 0, dur: 0.14 },    // D5
      { freq: 880.0, start: 0.095, dur: 0.24 }, // A5
    ];

    for (const n of notes) {
      const osc = ctx.createOscillator();
      const overtone = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      overtone.type = 'sine';
      osc.frequency.setValueAtTime(n.freq, now + n.start);
      overtone.frequency.setValueAtTime(n.freq * 2, now + n.start);

      gain.gain.setValueAtTime(0.0001, now + n.start);
      gain.gain.exponentialRampToValueAtTime(0.22, now + n.start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.start + n.dur);

      osc.connect(gain);
      overtone.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now + n.start);
      overtone.start(now + n.start);
      osc.stop(now + n.start + n.dur + 0.02);
      overtone.stop(now + n.start + n.dur + 0.02);
    }
  } catch {
    // ignore audio restrictions
  }
}

// Distinct phone-style dual-tone ring pulse for incoming P2P voice/video calls
export function playCallRingBurst() {
  try {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    for (const offset of [0, 0.24]) {
      const osc1 = ctx.createOscillator();
      const osc2 = ctx.createOscillator();
      const gain = ctx.createGain();
      osc1.type = 'sine';
      osc2.type = 'sine';
      osc1.frequency.setValueAtTime(659.25, now + offset); // E5
      osc2.frequency.setValueAtTime(783.99, now + offset); // G5

      gain.gain.setValueAtTime(0.0001, now + offset);
      gain.gain.exponentialRampToValueAtTime(0.2, now + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.19);

      osc1.connect(gain);
      osc2.connect(gain);
      gain.connect(ctx.destination);
      osc1.start(now + offset);
      osc2.start(now + offset);
      osc1.stop(now + offset + 0.21);
      osc2.stop(now + offset + 0.21);
    }
  } catch {
    // ignore
  }
}

export function startCallRingtone(enabled = true) {
  stopCallRingtone();
  if (!enabled) return;
  let rings = 0;
  playCallRingBurst();
  vibrateDevice([300, 150, 300]);
  callRingTimer = setInterval(() => {
    rings++;
    if (rings >= 5) {
      stopCallRingtone();
      return;
    }
    playCallRingBurst();
    vibrateDevice([300, 150, 300]);
  }, 1800);
}

export function stopCallRingtone() {
  if (callRingTimer) {
    clearInterval(callRingTimer);
    callRingTimer = null;
  }
}

export function vibrateDevice(pattern = [200, 100, 200]) {
  try {
    if (typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // ignore
  }
}

// --- Dynamic Favicon Badge + Blinking Tab Title + PWA App Badging API ---

function updateFaviconBadge(count) {
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    link.type = 'image/svg+xml';
    document.head.appendChild(link);
  }
  if (!count || count <= 0) {
    link.href = './icon.svg';
    return;
  }
  const label = count > 9 ? '9+' : String(count);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">` +
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4f46e5"/><stop offset="100%" stop-color="#0ea5e9"/></linearGradient></defs>` +
    `<rect width="128" height="128" rx="30" fill="url(#bg)"/>` +
    `<path d="M32 42c0-9.94 8.06-18 18-18h28c9.94 0 18 8.06 18 18v24c0 9.94-8.06 18-18 18H56l-16 14a3 3 0 0 1-5-2.24V83.1A17.95 17.95 0 0 1 32 66V42z" fill="#fff" fill-opacity="0.95"/>` +
    `<circle cx="96" cy="34" r="30" fill="#ef4444" stroke="#ffffff" stroke-width="6"/>` +
    `<text x="96" y="45" text-anchor="middle" fill="#ffffff" font-family="sans-serif" font-weight="800" font-size="34">${label}</text>` +
    `</svg>`;
  link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
}

export function updateUnreadBadges(totalUnread, appName, flashMsg = '') {
  lastUnreadCount = totalUnread;
  baseTitle = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  updateFaviconBadge(totalUnread);

  // PWA App Badging API (Home screen / taskbar red unread count)
  try {
    if (totalUnread > 0 && typeof navigator.setAppBadge === 'function') {
      navigator.setAppBadge(totalUnread).catch(() => {});
    } else if (totalUnread === 0 && typeof navigator.clearAppBadge === 'function') {
      navigator.clearAppBadge().catch(() => {});
    }
  } catch {
    // ignore unsupported browsers
  }

  if (flashMsg && (document.hidden || !document.hasFocus())) {
    flashHeadline = flashMsg;
    startTitleFlash();
  } else if (totalUnread === 0) {
    stopTitleFlash();
    document.title = baseTitle;
  } else if (!titleFlashTimer) {
    document.title = baseTitle;
  }
}

export function startTitleFlash() {
  if (titleFlashTimer || !flashHeadline) return;
  titleFlashFlip = true;
  document.title = flashHeadline;
  titleFlashTimer = setInterval(() => {
    if (!document.hidden && document.hasFocus()) {
      stopTitleFlash();
      return;
    }
    titleFlashFlip = !titleFlashFlip;
    document.title = titleFlashFlip ? flashHeadline : baseTitle;
  }, 1300);
}

export function stopTitleFlash() {
  if (titleFlashTimer) {
    clearInterval(titleFlashTimer);
    titleFlashTimer = null;
  }
  flashHeadline = '';
  document.title = baseTitle;
}

// --- OS Notifications (ServiceWorker-first so Android Chrome works!) ---

export async function requestNotificationPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}

export async function showOsNotification({ title, body, tag = 'decloc-msg', channelId = null, requireInteraction = false, onClick = null }) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;

  const opts = {
    body: String(body || '').slice(0, 180),
    icon: './icon.svg',
    badge: './icon.svg',
    tag,
    renotify: true,
    vibrate: [200, 100, 200],
    requireInteraction,
    data: { channelId },
  };

  // Prefer ServiceWorker registration.showNotification (REQUIRED on Android Chrome & PWAs!)
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(title, opts);
        return true;
      }
    }
  } catch {
    // fallback below
  }

  try {
    const n = new Notification(title, {
      body: opts.body,
      icon: opts.icon,
      tag: opts.tag,
    });
    n.onclick = () => {
      window.focus();
      if (onClick) onClick();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

// --- Native VAPID Web Push Subscription (Self-hosted relay/server.mjs) ---

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function syncServerWebPush({ vapidPublicKey, enabled, channels, senderPubkeys }) {
  if (!vapidPublicKey || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    return false;
  }
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!reg || !reg.pushManager) return false;

    let sub = await reg.pushManager.getSubscription();

    if (!enabled) {
      if (sub) {
        const endpoint = sub.endpoint;
        await sub.unsubscribe().catch(() => {});
        await fetch('./api/push/unsubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint }),
        }).catch(() => {});
      }
      return false;
    }

    if (Notification.permission !== 'granted') return false;

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      });
    }

    const res = await fetch('./api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: sub.toJSON(),
        channels,
        senderPubkeys,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- Optional ntfy.sh Privacy-Safe Background Ping (Works on GitHub Pages too!) ---

export function normalizeNtfyUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  let withProto = raw;
  if (!raw.startsWith('https://') && !raw.startsWith('http://')) {
    withProto = raw.includes('/') ? 'https://' + raw : 'https://ntfy.sh/' + raw;
  }
  try {
    const u = new URL(withProto);
    if (u.protocol !== 'https:') return '';
    if (!u.pathname || u.pathname === '/') return '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

// Sends ONLY a generic alert (NEVER sends plaintext message content, sender name, or room name!)
export async function sendNtfyPing(ntfyUrl, { isCall = false, title = 'DecLoc Chat', body = '' } = {}) {
  const cleanUrl = normalizeNtfyUrl(ntfyUrl);
  if (!cleanUrl) return false;
  try {
    const res = await fetch(cleanUrl, {
      method: 'POST',
      headers: {
        Title: title,
        Priority: isCall ? 'urgent' : 'high',
        Tags: isCall ? 'telephone_receiver' : 'speech_balloon',
      },
      body: body || (isCall ? 'Incoming call in DecLoc Chat' : 'New encrypted message in DecLoc Chat'),
    });
    return res.ok;
  } catch {
    return false;
  }
}
