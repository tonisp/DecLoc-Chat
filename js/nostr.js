import { CONFIG } from '../config.js';
import { verifyNostrEvent } from './crypto.js';

// Resilient multi-relay Nostr WebSocket pool.
// Handles auto-reconnection, event deduplication, signature verification,
// multi-room subscription, and delivery acknowledgements (OK).

export class RelayPool {
  constructor(relayUrls, { onEvent, onStatusChange, onAck } = {}) {
    this.onEvent = onEvent || (() => {});
    this.onStatusChange = onStatusChange || (() => {});
    this.onAck = onAck || (() => {});

    this.relays = new Map(); // url -> { ws, status, retries, timer, subId, subKey, outbox }
    this.seenIds = new Set();
    this.channelIds = new Set();
    this.relayChannels = new Map(); // url -> Set(channelId) for strict per-room routing
    this.useChannelRoutes = false;
    this.ackCounts = new Map(); // eventId -> Set(relayUrls)
    this.probes = new Map(); // probeSubId -> { onEvent, onDone }
    this.subCounter = 0;
    this.destroyed = false;

    this.setRelays(relayUrls);
  }

  setRelays(urls) {
    const clean = [...new Set(urls.map((u) => u.trim()).filter((u) => u.startsWith('wss://') || u.startsWith('ws://')))];

    // Close removed relays
    for (const [url, state] of this.relays.entries()) {
      if (!clean.includes(url)) {
        clearTimeout(state.timer);
        if (state.ws) {
          state.ws.onclose = null;
          state.ws.close();
        }
        this.relays.delete(url);
      }
    }

    // Add new relays
    for (const url of clean) {
      if (!this.relays.has(url)) {
        const state = { url, ws: null, status: 'connecting', retries: 0, timer: null, subId: null, subKey: '', outbox: [] };
        this.relays.set(url, state);
        this._connect(state);
      }
    }
    this._emitStatus();
  }

  // Strict per-room relay routing: each relay subscribes ONLY to channels explicitly routed to it.
  // routesMap: Map<channelId, string[]>, keepAliveUrls: optional relay URLs to keep connected for status display.
  setChannelRoutes(routesMap, keepAliveUrls = []) {
    this.useChannelRoutes = true;
    const nextRelayChannels = new Map();
    const neededRelays = new Set();

    for (const url of keepAliveUrls) {
      const u = String(url || '').trim();
      if (u.startsWith('wss://') || u.startsWith('ws://')) neededRelays.add(u);
    }

    for (const [channelId, urls] of routesMap.entries()) {
      for (const raw of urls) {
        const u = String(raw || '').trim();
        if (!u.startsWith('wss://') && !u.startsWith('ws://')) continue;
        neededRelays.add(u);
        let set = nextRelayChannels.get(u);
        if (!set) {
          set = new Set();
          nextRelayChannels.set(u, set);
        }
        set.add(channelId);
      }
    }

    this.relayChannels = nextRelayChannels;
    this.setRelays([...neededRelays]);

    // Update subscriptions only on relays whose assigned channels actually changed
    for (const state of this.relays.values()) {
      const assigned = this._getChannelsForRelay(state.url);
      const nextKey = assigned.sort().join(',');
      if (state.ws && state.ws.readyState === WebSocket.OPEN && nextKey !== state.subKey) {
        this._subscribe(state);
      }
    }
  }

  setSubscribedChannels(channelIds) {
    this.useChannelRoutes = false;
    const next = new Set(channelIds);
    const changed = next.size !== this.channelIds.size || [...next].some((id) => !this.channelIds.has(id));
    this.channelIds = next;
    if (!changed) return;

    for (const state of this.relays.values()) {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        this._subscribe(state);
      }
    }
  }

  getStatuses(filterUrls = null) {
    const list = [];
    if (Array.isArray(filterUrls)) {
      for (const url of filterUrls) {
        const st = this.relays.get(url);
        list.push({ url, status: st ? st.status : 'disconnected' });
      }
      return list;
    }
    for (const [url, st] of this.relays.entries()) {
      list.push({ url, status: st.status });
    }
    return list;
  }

  getConnectedCount(filterUrls = null) {
    return this.getStatuses(filterUrls).filter((s) => s.status === 'connected').length;
  }

  // Immediately wake up disconnected relays after mobile screen unlock / network switch
  reconnectNow(refreshOpenSubs = false) {
    if (this.destroyed) return;
    for (const state of this.relays.values()) {
      if (!state.ws || state.ws.readyState === WebSocket.CLOSED || state.ws.readyState === WebSocket.CLOSING) {
        clearTimeout(state.timer);
        state.retries = 0;
        this._connect(state);
      } else if (refreshOpenSubs && state.ws.readyState === WebSocket.OPEN) {
        // Refresh ephemeral subscription window after waking from mobile background sleep
        this._subscribe(state);
      }
    }
  }

  publish(event, targetRelayUrls = null) {
    this._rememberId(event.id);
    const payload = JSON.stringify(['EVENT', event]);
    const allowSet = Array.isArray(targetRelayUrls) ? new Set(targetRelayUrls) : null;
    let sentTo = 0;
    for (const [url, state] of this.relays.entries()) {
      if (allowSet && !allowSet.has(url)) continue;
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        try {
          state.ws.send(payload);
          sentTo++;
        } catch {
          // ignore send errors; reconnect loop handles it
        }
      } else if (state.status === 'connecting' || (state.ws && state.ws.readyState === WebSocket.CONNECTING)) {
        // Queue events (e.g. room creator 'init' anchor) so they flush immediately once socket opens
        if (!Array.isArray(state.outbox)) state.outbox = [];
        if (state.outbox.length < 40) state.outbox.push(payload);
      }
    }
    return sentTo;
  }

  // Probe target relays for stored kind:42 events belonging to channelId (used to verify if a room exists before joining/creating).
  // Reuses already-open pooled WebSockets or opens temporary probe sockets; never pollutes seenIds.
  async probeChannel(channelId, targetRelayUrls, { timeoutMs = 4500, limit = 100 } = {}) {
    const cleanUrls = [
      ...new Set(
        (Array.isArray(targetRelayUrls) ? targetRelayUrls : [])
          .map((u) => String(u || '').trim())
          .filter((u) => u.startsWith('wss://') || u.startsWith('ws://'))
      ),
    ];
    if (!channelId || cleanUrls.length === 0) {
      return { events: [], respondedRelays: 0, totalRelays: 0 };
    }

    const eventsById = new Map();
    const verifyPromises = [];
    let respondedRelays = 0;

    const collectEvent = (ev) => {
      if (!ev || typeof ev.id !== 'string' || eventsById.has(ev.id)) return;
      eventsById.set(ev.id, null); // placeholder to dedupe concurrent relays
      const p = verifyNostrEvent(ev)
        .then((valid) => {
          if (valid) eventsById.set(ev.id, ev);
          else eventsById.delete(ev.id);
        })
        .catch(() => {
          eventsById.delete(ev.id);
        });
      verifyPromises.push(p);
    };

    const probeOne = (url) =>
      new Promise((resolve) => {
        const probeSubId = `probe_${++this.subCounter}_${Math.random().toString(36).slice(2, 7)}`;
        const filter = { kinds: [CONFIG.MSG_KIND], '#e': [channelId], limit };
        let done = false;
        let tempWs = null;
        let timer = null;

        const finish = (responded) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          if (responded) respondedRelays++;
          this.probes.delete(probeSubId);
          const pooled = this.relays.get(url);
          if (!tempWs && pooled?.ws && pooled.ws.readyState === WebSocket.OPEN) {
            try {
              pooled.ws.send(JSON.stringify(['CLOSE', probeSubId]));
            } catch {
              // ignore
            }
          }
          if (tempWs) {
            try {
              if (tempWs.readyState === WebSocket.OPEN) {
                tempWs.send(JSON.stringify(['CLOSE', probeSubId]));
              }
              tempWs.onclose = null;
              tempWs.onerror = null;
              tempWs.onmessage = null;
              tempWs.close();
            } catch {
              // ignore
            }
          }
          resolve();
        };

        timer = setTimeout(() => finish(false), timeoutMs);

        // Reuse existing open socket in the pool if available (completes in ~10-40ms!)
        const existing = this.relays.get(url);
        if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
          this.probes.set(probeSubId, {
            onEvent: collectEvent,
            onDone: () => finish(true),
          });
          try {
            existing.ws.send(JSON.stringify(['REQ', probeSubId, filter]));
            return;
          } catch {
            this.probes.delete(probeSubId);
          }
        }

        // Otherwise open a clean temporary WebSocket strictly for this probe
        try {
          tempWs = new WebSocket(url);
        } catch {
          finish(false);
          return;
        }
        tempWs.onopen = () => {
          if (done) return;
          try {
            tempWs.send(JSON.stringify(['REQ', probeSubId, filter]));
          } catch {
            finish(false);
          }
        };
        tempWs.onmessage = (evt) => {
          let msg;
          try {
            msg = JSON.parse(evt.data);
          } catch {
            return;
          }
          if (!Array.isArray(msg) || msg[1] !== probeSubId) return;
          if (msg[0] === 'EVENT' && msg[2]) {
            collectEvent(msg[2]);
          } else if (msg[0] === 'EOSE' || msg[0] === 'CLOSED') {
            finish(true);
          }
        };
        tempWs.onerror = () => finish(false);
        tempWs.onclose = () => finish(false);
      });

    await Promise.all(cleanUrls.map(probeOne));
    await Promise.all(verifyPromises);

    const verifiedEvents = [...eventsById.values()].filter(Boolean);
    return {
      events: verifiedEvents,
      respondedRelays,
      totalRelays: cleanUrls.length,
    };
  }

  destroy() {
    this.destroyed = true;
    for (const state of this.relays.values()) {
      clearTimeout(state.timer);
      if (state.ws) {
        state.ws.onclose = null;
        state.ws.close();
      }
    }
    this.relays.clear();
  }

  _connect(state) {
    if (this.destroyed) return;
    clearTimeout(state.timer);
    state.status = 'connecting';
    this._emitStatus();

    let ws;
    try {
      ws = new WebSocket(state.url);
    } catch {
      state.status = 'disconnected';
      this._scheduleReconnect(state);
      return;
    }
    state.ws = ws;

    const connectTimeout = setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 8000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      state.status = 'connected';
      state.retries = 0;
      this._emitStatus();
      this._subscribe(state);
      if (Array.isArray(state.outbox) && state.outbox.length > 0) {
        const queued = state.outbox.splice(0, state.outbox.length);
        for (const payload of queued) {
          try {
            ws.send(payload);
          } catch {
            // ignore
          }
        }
      }
    };

    ws.onmessage = (evt) => {
      this._handleMessage(state, evt.data);
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (state.ws !== ws) return;
      state.ws = null;
      state.status = 'disconnected';
      this._emitStatus();
      this._scheduleReconnect(state);
    };
  }

  _scheduleReconnect(state) {
    if (this.destroyed || !this.relays.has(state.url)) return;
    const delay = Math.min(30000, 1200 * Math.pow(1.8, state.retries)) + Math.floor(Math.random() * 600);
    state.retries++;
    state.timer = setTimeout(() => this._connect(state), delay);
  }

  _getChannelsForRelay(url) {
    if (this.useChannelRoutes) {
      const set = this.relayChannels.get(url);
      return set ? [...set] : [];
    }
    return [...this.channelIds];
  }

  _subscribe(state) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    if (state.subId) {
      try {
        state.ws.send(JSON.stringify(['CLOSE', state.subId]));
      } catch {
        // ignore
      }
      state.subId = null;
    }

    const ids = this._getChannelsForRelay(state.url).sort();
    state.subKey = ids.join(',');
    if (ids.length === 0) return;

    const subId = `decloc_${++this.subCounter}`;
    state.subId = subId;

    const historyFilter = {
      kinds: [CONFIG.MSG_KIND],
      '#e': ids,
      limit: CONFIG.HISTORY_LIMIT,
    };
    const ephemeralFilter = {
      kinds: [CONFIG.EPHEMERAL_KIND],
      '#e': ids,
      since: Math.floor(Date.now() / 1000) - 30,
    };

    try {
      state.ws.send(JSON.stringify(['REQ', subId, historyFilter, ephemeralFilter]));
    } catch {
      // ignore
    }
  }

  async _handleMessage(state, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length < 2) return;

    const type = msg[0];
    // Route one-shot probe replies without polluting seenIds or live handlers
    if ((type === 'EVENT' || type === 'EOSE' || type === 'CLOSED') && typeof msg[1] === 'string' && this.probes.has(msg[1])) {
      const probe = this.probes.get(msg[1]);
      if (type === 'EVENT' && msg[2]) {
        probe.onEvent(msg[2]);
      } else {
        probe.onDone();
      }
      return;
    }

    if (type === 'EVENT' && msg[2]) {
      const ev = msg[2];
      if (!ev || typeof ev.id !== 'string') return;
      if (this.seenIds.has(ev.id)) return;
      this._rememberId(ev.id);

      const valid = await verifyNostrEvent(ev);
      if (!valid) return;

      this.onEvent(ev, state.url);
    } else if (type === 'OK' && typeof msg[1] === 'string') {
      const eventId = msg[1];
      const accepted = Boolean(msg[2]);
      if (accepted) {
        let set = this.ackCounts.get(eventId);
        if (!set) {
          set = new Set();
          this.ackCounts.set(eventId, set);
          if (this.ackCounts.size > 500) {
            const first = this.ackCounts.keys().next().value;
            this.ackCounts.delete(first);
          }
        }
        set.add(state.url);
        this.onAck(eventId, set.size, state.url);
      }
    }
  }

  _rememberId(id) {
    this.seenIds.add(id);
    if (this.seenIds.size > 5000) {
      const first = this.seenIds.values().next().value;
      this.seenIds.delete(first);
    }
  }

  _emitStatus() {
    this.onStatusChange(this.getStatuses());
  }
}
