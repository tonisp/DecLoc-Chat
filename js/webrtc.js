import { CONFIG } from '../config.js';

// Resilient P2P Mesh WebRTC Voice & Video Call manager using DecLoc Chat's encrypted ephemeral Nostr signaling.
// Features:
// - Screen Wake Lock API (prevents mobile screens from locking during active calls)
// - Automatic camera/mic track recovery & replaceTrack() hot-swap after OS screen lock or backgrounding
// - W3C Perfect Negotiation (polite rollback avoids SDP glare & black-video deadlocks across browsers)
// - Automatic ICE Restart & peer self-healing on Wi-Fi <-> 4G/5G switch or temporary background suspension
// - Progressive getUserMedia constraint fallbacks (fixes Firefox, Safari, Samsung Internet, older cameras)
// - Optional custom TURN server support via getIceServers()

export class CallManager {
  constructor({ sendSignal, onStateChange, getIceServers, onResumeMedia, onNotice }) {
    this.sendSignal = sendSignal; // async (channelId, payloadObj) => void
    this.onStateChange = onStateChange || (() => {});
    this.getIceServers = getIceServers || (() => CONFIG.ICE_SERVERS);
    this.onResumeMedia = onResumeMedia || (() => {});
    this.onNotice = onNotice || (() => {});

    this.activeChannelId = null;
    this.myPubkey = null;
    this.myName = '';
    this.localStream = null;
    this.audioMuted = false;
    this.videoEnabled = false;
    this.facingMode = 'user'; // 'user' | 'environment'
    this.cameras = []; // Array<{ deviceId, label, facing }>
    this.activeVideoDeviceId = null;

    this.wakeLock = null;
    this._wasHiddenDuringCall = false;
    this._recovering = false;

    this.peers = new Map(); // remotePubkey -> peer record
    this.activeCallsByRoom = new Map(); // channelId -> Map(pubkey -> { name, ts })
    this.heartbeatTimer = null;

    this._onDeviceChange = () => {
      if (this.activeChannelId) {
        this.refreshVideoDevices().then(() => this._emit()).catch(() => {});
      }
    };
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this._onDeviceChange);
    }

    // Periodically expire stale call announcements and ghost disconnected peers
    this.cleanupTimer = setInterval(() => this._pruneStaleAnnouncements(), 5000);
  }

  getActiveCallInfo() {
    if (!this.activeChannelId) return null;
    const remotePeers = [];
    for (const [pubkey, peer] of this.peers.entries()) {
      const videoTracks = peer.stream.getVideoTracks();
      const hasLiveVideoTrack = videoTracks.some((tr) => tr.readyState === 'live' && tr.enabled);
      const rawConn = peer.pc?.connectionState;
      const rawIce = peer.pc?.iceConnectionState;
      let connState = 'connecting';
      if (rawConn === 'connected' || rawIce === 'connected' || rawIce === 'completed') {
        connState = 'connected';
      } else if (rawConn === 'disconnected' || rawIce === 'disconnected' || peer.reconnecting) {
        connState = 'reconnecting';
      } else if (rawConn === 'failed' || rawIce === 'failed') {
        connState = 'failed';
      }
      remotePeers.push({
        pubkey,
        name: peer.name,
        stream: peer.stream,
        videoEnabled:
          peer.videoEnabled !== undefined
            ? peer.videoEnabled && videoTracks.length > 0
            : hasLiveVideoTrack,
        audioMuted: Boolean(peer.audioMuted),
        state: connState,
      });
    }
    return {
      channelId: this.activeChannelId,
      localStream: this.localStream,
      audioMuted: this.audioMuted,
      videoEnabled: this.videoEnabled,
      facingMode: this.facingMode,
      cameras: this.cameras,
      activeVideoDeviceId: this.activeVideoDeviceId,
      wakeLockActive: Boolean(this.wakeLock),
      remotePeers,
    };
  }

  getRoomCallParticipants(channelId) {
    const map = this.activeCallsByRoom.get(channelId);
    if (!map) return [];
    const now = Date.now();
    const out = [];
    for (const [pubkey, info] of map.entries()) {
      if (now - info.ts < 25000) {
        out.push({ pubkey, name: info.name });
      }
    }
    return out;
  }

  async joinCall(channelId, myPubkey, myName, { video = false } = {}) {
    if (this.activeChannelId) {
      await this.leaveCall();
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('MediaDevices API unavailable');
    }

    this.facingMode = 'user';
    this.activeVideoDeviceId = null;
    const { stream, videoActive, cameraFallback } = await this._acquireMedia({
      audio: true,
      video,
      facingMode: this.facingMode,
    });

    this.activeChannelId = channelId;
    this.myPubkey = myPubkey;
    this.myName = myName;
    this.localStream = stream;
    this.audioMuted = false;
    this.videoEnabled = videoActive;
    this._wasHiddenDuringCall = false;

    this._syncActiveCameraMeta(stream.getVideoTracks()[0]);
    await this.refreshVideoDevices();
    this._attachLocalTrackListeners(stream);
    await this._acquireWakeLock();

    if (cameraFallback) {
      this.onNotice('callCameraFallback');
    }

    await this.sendSignal(channelId, {
      t: 'rtc_join',
      name: myName,
      video: this.videoEnabled,
      muted: false,
    });

    this.heartbeatTimer = setInterval(() => {
      if (!this.activeChannelId) return;
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_beacon',
        name: this.myName,
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
    }, 8000);

    this._emit();
  }

  async leaveCall() {
    if (!this.activeChannelId) return;
    const ch = this.activeChannelId;
    this.activeChannelId = null;
    this._wasHiddenDuringCall = false;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;

    await this._releaseWakeLock();

    for (const peer of this.peers.values()) {
      clearTimeout(peer.disconnectTimer);
      try {
        peer.pc.close();
      } catch {
        // ignore
      }
    }
    this.peers.clear();

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.onended = null;
        track.stop();
      }
      this.localStream = null;
    }

    try {
      await this.sendSignal(ch, { t: 'rtc_leave', name: this.myName });
    } catch {
      // ignore
    }

    this._emit();
  }

  toggleMute() {
    if (!this.localStream) return false;
    this.audioMuted = !this.audioMuted;
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !this.audioMuted;
    }
    if (this.activeChannelId) {
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_media',
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
    }
    this._emit();
    return this.audioMuted;
  }

  async toggleVideo() {
    if (!this.localStream || !this.activeChannelId) return false;
    const liveVideos = this.localStream.getVideoTracks().filter((t) => t.readyState === 'live');
    if (liveVideos.length > 0) {
      this.videoEnabled = !this.videoEnabled;
      for (const t of liveVideos) t.enabled = this.videoEnabled;
      this.sendSignal(this.activeChannelId, {
        t: 'rtc_media',
        video: this.videoEnabled,
        muted: this.audioMuted,
      }).catch(() => {});
      this._emit();
      this.onResumeMedia();
      return this.videoEnabled;
    }

    // Remove any dead/ended video tracks and acquire a fresh camera track
    for (const dead of this.localStream.getVideoTracks()) {
      dead.onended = null;
      dead.stop();
      this.localStream.removeTrack(dead);
    }

    const { stream: camStream } = await this._acquireMedia({
      audio: false,
      video: true,
      facingMode: this.facingMode,
    });
    const videoTrack = camStream.getVideoTracks()[0];
    if (!videoTrack) throw new Error('No video track');
    this.localStream.addTrack(videoTrack);
    this._syncActiveCameraMeta(videoTrack);
    await this.refreshVideoDevices();
    this._attachLocalTrackListeners(this.localStream);
    this.videoEnabled = true;

    await this._replaceOrAddTrackOnAllPeers('video', videoTrack);

    this.sendSignal(this.activeChannelId, {
      t: 'rtc_media',
      video: true,
      muted: this.audioMuted,
    }).catch(() => {});
    this._emit();
    this.onResumeMedia();
    return true;
  }

  async refreshVideoDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return this.cameras;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const vids = all.filter((d) => d.kind === 'videoinput');
      this.cameras = vids.map((d) => {
        const lbl = String(d.label || '').trim();
        let facing = null;
        if (/\b(back|rear|environment|world|taga)\b/i.test(lbl)) facing = 'environment';
        else if (/\b(front|user|selfie|facetime|ees)\b/i.test(lbl)) facing = 'user';
        return { deviceId: d.deviceId, label: lbl, facing };
      });
      const liveTrack = this.localStream?.getVideoTracks().find((t) => t.readyState === 'live');
      if (liveTrack) {
        this._syncActiveCameraMeta(liveTrack);
      }
    } catch {
      // ignore enumeration errors
    }
    return this.cameras;
  }

  _syncActiveCameraMeta(videoTrack) {
    if (!videoTrack) return;
    const st = typeof videoTrack.getSettings === 'function' ? videoTrack.getSettings() : {};
    if (st.deviceId) this.activeVideoDeviceId = st.deviceId;
    if (st.facingMode === 'environment' || st.facingMode === 'user') {
      this.facingMode = st.facingMode;
      return;
    }
    const lbl = String(videoTrack.label || '').trim();
    if (/\b(back|rear|environment|world|taga)\b/i.test(lbl)) {
      this.facingMode = 'environment';
    } else if (/\b(front|user|selfie|facetime|ees)\b/i.test(lbl)) {
      this.facingMode = 'user';
    }
  }

  async selectCamera(deviceId) {
    if (!this.localStream || !this.activeChannelId || !this.videoEnabled || !deviceId) return false;
    if (deviceId === this.activeVideoDeviceId && this.localStream.getVideoTracks().some((t) => t.readyState === 'live')) {
      return true;
    }

    const prevDeviceId = this.activeVideoDeviceId;
    const prevFacing = this.facingMode;

    // IMPORTANT: Stop existing video tracks FIRST so Android single-camera HAL does not throw NotReadableError!
    for (const old of this.localStream.getVideoTracks()) {
      old.onended = null;
      old.stop();
      this.localStream.removeTrack(old);
    }

    let camStream = null;
    try {
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          },
          audio: false,
        });
      } catch {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: deviceId } },
          audio: false,
        });
      }
    } catch (err) {
      // Restore previous camera if switching to the selected lens failed
      try {
        const { stream: restored } = await this._acquireMedia({
          audio: false,
          video: true,
          facingMode: prevFacing,
          deviceId: prevDeviceId,
        });
        const oldBack = restored.getVideoTracks()[0];
        if (oldBack) {
          this.localStream.addTrack(oldBack);
          this._syncActiveCameraMeta(oldBack);
          this._attachLocalTrackListeners(this.localStream);
          await this._replaceOrAddTrackOnAllPeers('video', oldBack);
        }
      } catch {
        // ignore
      }
      this._emit();
      throw err;
    }

    const newTrack = camStream.getVideoTracks()[0];
    if (!newTrack) return false;

    this.localStream.addTrack(newTrack);
    this.activeVideoDeviceId = deviceId;
    const knownCam = this.cameras.find((c) => c.deviceId === deviceId);
    if (knownCam?.facing) this.facingMode = knownCam.facing;
    this._syncActiveCameraMeta(newTrack);
    await this.refreshVideoDevices();
    this._attachLocalTrackListeners(this.localStream);

    await this._replaceOrAddTrackOnAllPeers('video', newTrack);
    this._emit();
    this.onResumeMedia();
    return true;
  }

  async switchCamera() {
    if (!this.localStream || !this.activeChannelId || !this.videoEnabled) return false;
    await this.refreshVideoDevices();

    // If multiple cameras are enumerated, cycle cleanly to the next camera (works on multi-lens phones & 2-webcam PCs!)
    const usable = this.cameras.filter((c) => Boolean(c.deviceId));
    if (usable.length > 1) {
      const curIdx = usable.findIndex((c) => c.deviceId === this.activeVideoDeviceId);
      const nextCam = usable[(curIdx + 1) % usable.length];
      return this.selectCamera(nextCam.deviceId);
    }

    // Fallback when browser hides individual deviceIds: stop old track first, then toggle facingMode
    const prevFacing = this.facingMode;
    const nextFacing = this.facingMode === 'user' ? 'environment' : 'user';
    for (const old of this.localStream.getVideoTracks()) {
      old.onended = null;
      old.stop();
      this.localStream.removeTrack(old);
    }

    let camStream = null;
    try {
      try {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { exact: nextFacing },
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: false,
        });
      } catch {
        camStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: nextFacing } },
          audio: false,
        });
      }
    } catch (err) {
      // Restore previous camera if flip failed
      try {
        const { stream: restored } = await this._acquireMedia({ audio: false, video: true, facingMode: prevFacing });
        const rt = restored.getVideoTracks()[0];
        if (rt) {
          this.localStream.addTrack(rt);
          this._attachLocalTrackListeners(this.localStream);
          await this._replaceOrAddTrackOnAllPeers('video', rt);
        }
      } catch {
        // ignore
      }
      throw err;
    }

    const newTrack = camStream.getVideoTracks()[0];
    if (!newTrack) return false;

    this.localStream.addTrack(newTrack);
    this.facingMode = nextFacing;
    this._syncActiveCameraMeta(newTrack);
    await this.refreshVideoDevices();
    this._attachLocalTrackListeners(this.localStream);

    await this._replaceOrAddTrackOnAllPeers('video', newTrack);
    this._emit();
    this.onResumeMedia();
    return true;
  }

  handleAppHidden() {
    if (!this.activeChannelId) return;
    this._wasHiddenDuringCall = true;
  }

  // Called when unlocking phone screen, returning from another app/tab, or regaining internet
  async handleAppResume() {
    if (!this.activeChannelId || this._recovering) return;
    this._recovering = true;
    try {
      await this._acquireWakeLock();
      await this._recoverLocalTracksIfNeeded();

      // Re-announce presence in call immediately
      if (this.activeChannelId) {
        this.sendSignal(this.activeChannelId, {
          t: 'rtc_beacon',
          name: this.myName,
          video: this.videoEnabled,
          muted: this.audioMuted,
        }).catch(() => {});
      }

      // Heal any peers that went disconnected/failed while in background or during network switch
      for (const [remotePubkey, peer] of [...this.peers.entries()]) {
        const cs = peer.pc?.connectionState;
        const ics = peer.pc?.iceConnectionState;
        if (
          cs === 'disconnected' ||
          cs === 'failed' ||
          cs === 'closed' ||
          ics === 'disconnected' ||
          ics === 'failed' ||
          ics === 'closed'
        ) {
          await this._healPeer(remotePubkey, peer, true);
        }
      }

      this._wasHiddenDuringCall = false;
      this._emit();
      this.onResumeMedia();
    } finally {
      this._recovering = false;
    }
  }

  async handleSignal(channelId, fromPubkey, payload) {
    if (!payload || typeof payload.t !== 'string') return;
    if (fromPubkey === this.myPubkey) return;

    // Record active call announcements for banner display
    if (payload.t === 'rtc_join' || payload.t === 'rtc_beacon') {
      let map = this.activeCallsByRoom.get(channelId);
      if (!map) {
        map = new Map();
        this.activeCallsByRoom.set(channelId, map);
      }
      const hadPeer = map.has(fromPubkey);
      map.set(fromPubkey, { name: String(payload.name || '?').slice(0, 40), ts: Date.now() });
      if (!hadPeer && this.activeChannelId !== channelId) {
        this._emit();
      }
    } else if (payload.t === 'rtc_leave') {
      const map = this.activeCallsByRoom.get(channelId);
      if (map) {
        map.delete(fromPubkey);
        if (map.size === 0) this.activeCallsByRoom.delete(channelId);
      }
      if (this.activeChannelId === channelId) {
        this._removePeer(fromPubkey);
      }
      this._emit();
      return;
    }

    // Ignore WebRTC signaling if we are not actively in this room's call
    if (this.activeChannelId !== channelId) return;

    // Targeted signals not meant for us
    if (payload.to && payload.to !== this.myPubkey) return;

    // Track last heard timestamp on existing peer
    const existingPeer = this.peers.get(fromPubkey);
    if (existingPeer) existingPeer.lastSeenAt = Date.now();

    if (payload.t === 'rtc_media') {
      if (existingPeer) {
        if (typeof payload.video === 'boolean') existingPeer.videoEnabled = payload.video;
        if (typeof payload.muted === 'boolean') existingPeer.audioMuted = payload.muted;
        this._emit();
        this.onResumeMedia();
      }
      return;
    }

    if (payload.t === 'rtc_beacon') {
      // Auto-heal: if a peer is still in the call but we lost their RTCPeerConnection, reconnect automatically!
      if (!existingPeer || existingPeer.pc.connectionState === 'closed') {
        const rebuilt = this._ensurePeer(fromPubkey, payload.name, true);
        if (typeof payload.video === 'boolean') rebuilt.videoEnabled = payload.video;
        if (typeof payload.muted === 'boolean') rebuilt.audioMuted = payload.muted;
        if (this.myPubkey > fromPubkey) {
          await this._sendOffer(fromPubkey, rebuilt, { iceRestart: false });
        } else {
          await this.sendSignal(channelId, {
            t: 'rtc_hello',
            to: fromPubkey,
            name: this.myName,
            video: this.videoEnabled,
            muted: this.audioMuted,
          });
        }
        this._emit();
        return;
      }

      let changed = false;
      if (typeof payload.video === 'boolean' && existingPeer.videoEnabled !== payload.video) {
        existingPeer.videoEnabled = payload.video;
        changed = true;
      }
      if (typeof payload.muted === 'boolean' && existingPeer.audioMuted !== payload.muted) {
        existingPeer.audioMuted = payload.muted;
        changed = true;
      }
      if (changed) {
        this._emit();
        this.onResumeMedia();
      }
      return;
    }

    if (payload.t === 'rtc_reconnect') {
      const peer = this._ensurePeer(fromPubkey, payload.name, existingPeer?.pc.connectionState === 'closed');
      if (this.myPubkey > fromPubkey) {
        await this._sendOffer(fromPubkey, peer, { iceRestart: true });
      }
      return;
    }

    if (payload.t === 'rtc_join' || payload.t === 'rtc_hello') {
      const shouldReset = Boolean(
        existingPeer &&
          (existingPeer.pc.connectionState === 'failed' ||
            existingPeer.pc.connectionState === 'closed' ||
            existingPeer.pc.iceConnectionState === 'failed')
      );
      const peer = this._ensurePeer(fromPubkey, payload.name, shouldReset);
      if (typeof payload.video === 'boolean') peer.videoEnabled = payload.video;
      if (typeof payload.muted === 'boolean') peer.audioMuted = payload.muted;
      if (this.myPubkey > fromPubkey) {
        await this._sendOffer(fromPubkey, peer, { iceRestart: Boolean(existingPeer && !shouldReset) });
      } else if (payload.t === 'rtc_join') {
        await this.sendSignal(channelId, {
          t: 'rtc_hello',
          to: fromPubkey,
          name: this.myName,
          video: this.videoEnabled,
          muted: this.audioMuted,
        });
      }
      this._emit();
      return;
    }

    if (payload.t === 'rtc_offer' && payload.sdp) {
      const peer = this._ensurePeer(fromPubkey, payload.name, existingPeer?.pc.connectionState === 'closed');
      if (typeof payload.video === 'boolean') peer.videoEnabled = payload.video;
      if (typeof payload.muted === 'boolean') peer.audioMuted = payload.muted;
      try {
        // W3C Perfect Negotiation: polite peer rolls back colliding local offer; impolite peer ignores collision
        const offerCollision = peer.makingOffer || peer.pc.signalingState !== 'stable';
        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        if (offerCollision) {
          await peer.pc.setLocalDescription({ type: 'rollback' }).catch(() => {});
        }

        await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
        await this._flushPendingIce(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        await this.sendSignal(channelId, {
          t: 'rtc_answer',
          to: fromPubkey,
          name: this.myName,
          video: this.videoEnabled,
          muted: this.audioMuted,
          sdp: peer.pc.localDescription,
        });
      } catch {
        // retry on next beacon/heal tick if transient
      }
      return;
    }

    if (payload.t === 'rtc_answer' && payload.sdp) {
      const peer = this.peers.get(fromPubkey);
      if (!peer) return;
      if (typeof payload.video === 'boolean') peer.videoEnabled = payload.video;
      if (typeof payload.muted === 'boolean') peer.audioMuted = payload.muted;
      try {
        if (peer.pc.signalingState === 'have-local-offer') {
          await peer.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          await this._flushPendingIce(peer);
        }
      } catch {
        // ignore
      }
      return;
    }

    if (payload.t === 'rtc_ice' && payload.candidate) {
      const peer = this.peers.get(fromPubkey);
      if (!peer || peer.ignoreOffer) return;
      if (peer.pc.remoteDescription) {
        try {
          await peer.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch {
          // ignore stale ICE candidates
        }
      } else {
        peer.pendingIce.push(payload.candidate);
      }
    }
  }

  destroy() {
    clearInterval(this.cleanupTimer);
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this._onDeviceChange);
    }
    this.leaveCall();
  }

  // --- Internal Media, Wake Lock & Peer Healing Helpers ---

  async _acquireWakeLock() {
    try {
      if (!this.activeChannelId || document.hidden) return;
      if (this.wakeLock || !('wakeLock' in navigator) || typeof navigator.wakeLock?.request !== 'function') return;
      const lock = await navigator.wakeLock.request('screen');
      this.wakeLock = lock;
      lock.addEventListener('release', () => {
        if (this.wakeLock === lock) this.wakeLock = null;
      });
    } catch {
      // Wake Lock unsupported or denied (e.g. battery saver mode)
    }
  }

  async _releaseWakeLock() {
    if (!this.wakeLock) return;
    const lock = this.wakeLock;
    this.wakeLock = null;
    try {
      await lock.release();
    } catch {
      // ignore
    }
  }

  async _acquireMedia({ audio = true, video = false, facingMode = 'user', deviceId = null }) {
    const audioConstraints = audio
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false;
    const videoConstraints = video
      ? deviceId
        ? {
            deviceId: { ideal: deviceId },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          }
        : {
            facingMode: { ideal: facingMode },
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 24, max: 30 },
          }
      : false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: videoConstraints,
      });
      return { stream, videoActive: video && stream.getVideoTracks().length > 0, cameraFallback: false };
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'PermissionDeniedError') {
        throw err;
      }
      // Fallback 1: relaxed constraints (fixes OverconstrainedError on Firefox, older Android & webcams)
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: Boolean(audio),
          video: Boolean(video),
        });
        return { stream, videoActive: video && stream.getVideoTracks().length > 0, cameraFallback: false };
      } catch (err2) {
        // Fallback 2: if user asked for audio+video and camera failed/missing/busy, still connect voice!
        if (audio && video && err2?.name !== 'NotAllowedError' && err2?.name !== 'PermissionDeniedError') {
          const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
          return { stream: audioOnly, videoActive: false, cameraFallback: true };
        }
        throw err2;
      }
    }
  }

  _attachLocalTrackListeners(stream) {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      track.onended = () => {
        // Mobile OS ended camera/mic track on sleep or interruption — recover automatically once visible
        if (this.activeChannelId && !document.hidden) {
          this.handleAppResume().catch(() => {});
        }
      };
    }
  }

  async _recoverLocalTracksIfNeeded() {
    if (!this.localStream || !this.activeChannelId) return;

    // 1. Recover local video track if camera was killed or frozen by screen lock / app switch
    if (this.videoEnabled) {
      const vTracks = this.localStream.getVideoTracks();
      const needsVideoRecovery =
        vTracks.length === 0 ||
        vTracks.some((t) => t.readyState !== 'live' || t.muted) ||
        this._wasHiddenDuringCall;

      if (needsVideoRecovery) {
        try {
          // Stop old tracks first so Android camera HAL releases hardware cleanly
          for (const old of this.localStream.getVideoTracks()) {
            old.onended = null;
            old.stop();
            this.localStream.removeTrack(old);
          }
          const { stream: freshCam } = await this._acquireMedia({
            audio: false,
            video: true,
            facingMode: this.facingMode,
            deviceId: this.activeVideoDeviceId,
          });
          const newVTrack = freshCam.getVideoTracks()[0];
          if (newVTrack) {
            newVTrack.enabled = this.videoEnabled;
            this.localStream.addTrack(newVTrack);
            this._syncActiveCameraMeta(newVTrack);
            this._attachLocalTrackListeners(this.localStream);
            await this._replaceOrAddTrackOnAllPeers('video', newVTrack);
          }
        } catch {
          // Camera temporarily busy; keep audio alive
        }
      }
    }

    // 2. Recover local audio track if ended by OS phone call / interruption
    const aTracks = this.localStream.getAudioTracks();
    if (aTracks.length === 0 || aTracks.some((t) => t.readyState !== 'live')) {
      try {
        const { stream: freshMic } = await this._acquireMedia({ audio: true, video: false });
        const newATrack = freshMic.getAudioTracks()[0];
        if (newATrack) {
          for (const old of this.localStream.getAudioTracks()) {
            old.onended = null;
            old.stop();
            this.localStream.removeTrack(old);
          }
          newATrack.enabled = !this.audioMuted;
          this.localStream.addTrack(newATrack);
          this._attachLocalTrackListeners(this.localStream);
          await this._replaceOrAddTrackOnAllPeers('audio', newATrack);
        }
      } catch {
        // ignore
      }
    }
  }

  async _replaceOrAddTrackOnAllPeers(kind, newTrack) {
    for (const [remotePubkey, peer] of this.peers.entries()) {
      if (!peer.pc || peer.pc.connectionState === 'closed') continue;
      const senders = peer.pc.getSenders ? peer.pc.getSenders() : [];
      const matchingSender = senders.find(
        (s) => s.track?.kind === kind || (s.track === null && peer.senderKinds?.get(s) === kind)
      );
      if (matchingSender && typeof matchingSender.replaceTrack === 'function') {
        try {
          await matchingSender.replaceTrack(newTrack);
          continue;
        } catch {
          // fall through to addTrack + renegotiate
        }
      }
      try {
        const sender = peer.pc.addTrack(newTrack, this.localStream);
        peer.senderKinds.set(sender, kind);
        await this._sendOffer(remotePubkey, peer);
      } catch {
        // ignore
      }
    }
  }

  _ensurePeer(remotePubkey, name, forceRecreate = false) {
    const existing = this.peers.get(remotePubkey);
    if (existing && !forceRecreate && existing.pc.connectionState !== 'closed') {
      if (name) existing.name = String(name).slice(0, 40);
      existing.lastSeenAt = Date.now();
      return existing;
    }

    if (existing) {
      clearTimeout(existing.disconnectTimer);
      try {
        existing.pc.close();
      } catch {
        // ignore
      }
    }

    const iceServers = this.getIceServers() || CONFIG.ICE_SERVERS;
    const pc = new RTCPeerConnection({
      iceServers,
      iceCandidatePoolSize: 2,
    });
    const remoteStream = new MediaStream();
    const peer = {
      pc,
      stream: remoteStream,
      name: String(name || existing?.name || '?').slice(0, 40),
      videoEnabled: existing?.videoEnabled,
      audioMuted: existing?.audioMuted || false,
      pendingIce: [],
      senderKinds: new Map(),
      polite: this.myPubkey < remotePubkey,
      makingOffer: false,
      ignoreOffer: false,
      reconnecting: false,
      healAttempts: 0,
      lastHealAt: 0,
      disconnectTimer: null,
      lastSeenAt: Date.now(),
    };
    this.peers.set(remotePubkey, peer);

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        const sender = pc.addTrack(track, this.localStream);
        peer.senderKinds.set(sender, track.kind);
      }
    }

    pc.onicecandidate = (evt) => {
      if (evt.candidate && this.activeChannelId) {
        this.sendSignal(this.activeChannelId, {
          t: 'rtc_ice',
          to: remotePubkey,
          candidate: evt.candidate.toJSON(),
        }).catch(() => {});
      }
    };

    pc.ontrack = (evt) => {
      const tracks = evt.streams && evt.streams[0] ? evt.streams[0].getTracks() : [];
      const list = tracks.includes(evt.track) ? tracks : [...tracks, evt.track];
      for (const t of list) {
        if (!t) continue;
        // Replace any stale ended track of the same kind cleanly
        for (const old of remoteStream.getTracks()) {
          if (old.kind === t.kind && old.id !== t.id && old.readyState === 'ended') {
            remoteStream.removeTrack(old);
          }
        }
        if (!remoteStream.getTracks().some((rt) => rt.id === t.id)) {
          remoteStream.addTrack(t);
        }
        t.onunmute = () => {
          this._emit();
          this.onResumeMedia();
        };
        t.onmute = () => this._emit();
        t.onended = () => this._emit();
      }
      this._emit();
      this.onResumeMedia();
    };

    const handleStateUpdate = () => {
      if (this.peers.get(remotePubkey) !== peer) return;
      const cs = pc.connectionState;
      const ics = pc.iceConnectionState;

      if (cs === 'connected' || ics === 'connected' || ics === 'completed') {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
        peer.reconnecting = false;
        peer.healAttempts = 0;
        peer.lastSeenAt = Date.now();
        this._emit();
        this.onResumeMedia();
        return;
      }

      if (cs === 'disconnected' || ics === 'disconnected') {
        peer.reconnecting = true;
        this._emit();
        if (!peer.disconnectTimer) {
          peer.disconnectTimer = setTimeout(() => {
            peer.disconnectTimer = null;
            if (this.peers.get(remotePubkey) !== peer || !this.activeChannelId) return;
            const curCs = peer.pc.connectionState;
            const curIcs = peer.pc.iceConnectionState;
            if (curCs === 'disconnected' || curCs === 'failed' || curIcs === 'disconnected' || curIcs === 'failed') {
              this._healPeer(remotePubkey, peer, false).catch(() => {});
            }
          }, 2500);
        }
        return;
      }

      if (cs === 'failed' || ics === 'failed') {
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = null;
        peer.reconnecting = true;
        this._emit();
        this._healPeer(remotePubkey, peer, false).catch(() => {});
      }
    };

    pc.onconnectionstatechange = handleStateUpdate;
    pc.oniceconnectionstatechange = handleStateUpdate;

    this._emit();
    return peer;
  }

  async _healPeer(remotePubkey, peer, force = false) {
    if (!this.activeChannelId || this.peers.get(remotePubkey) !== peer) return;
    const now = Date.now();
    if (!force && now - peer.lastHealAt < 3500) return;
    peer.lastHealAt = now;
    peer.healAttempts++;
    peer.reconnecting = true;

    // After 2 failed ICE restarts (or if closed), rebuild a clean RTCPeerConnection
    if (peer.pc.connectionState === 'closed' || peer.healAttempts >= 3) {
      const rebuilt = this._ensurePeer(remotePubkey, peer.name, true);
      rebuilt.reconnecting = true;
      if (this.myPubkey > remotePubkey) {
        await this._sendOffer(remotePubkey, rebuilt, { iceRestart: false });
      } else {
        await this.sendSignal(this.activeChannelId, {
          t: 'rtc_reconnect',
          to: remotePubkey,
          name: this.myName,
        }).catch(() => {});
      }
      return;
    }

    if (this.myPubkey > remotePubkey) {
      try {
        if (typeof peer.pc.restartIce === 'function') peer.pc.restartIce();
      } catch {
        // ignore
      }
      await this._sendOffer(remotePubkey, peer, { iceRestart: true });
    } else {
      await this.sendSignal(this.activeChannelId, {
        t: 'rtc_reconnect',
        to: remotePubkey,
        name: this.myName,
      }).catch(() => {});
    }
  }

  async _sendOffer(remotePubkey, peer, { iceRestart = false } = {}) {
    if (!this.activeChannelId || !peer?.pc || peer.pc.connectionState === 'closed') return;
    try {
      peer.makingOffer = true;
      const offer = await peer.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
      if (peer.pc.signalingState !== 'stable') return;
      await peer.pc.setLocalDescription(offer);
      await this.sendSignal(this.activeChannelId, {
        t: 'rtc_offer',
        to: remotePubkey,
        name: this.myName,
        video: this.videoEnabled,
        muted: this.audioMuted,
        sdp: peer.pc.localDescription,
      });
    } catch {
      // ignore transient offer errors; healed on next beacon/retry
    } finally {
      peer.makingOffer = false;
    }
  }

  async _flushPendingIce(peer) {
    const queue = peer.pendingIce.splice(0);
    for (const c of queue) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(c));
      } catch {
        // ignore
      }
    }
  }

  _removePeer(remotePubkey) {
    const peer = this.peers.get(remotePubkey);
    if (!peer) return;
    clearTimeout(peer.disconnectTimer);
    try {
      peer.pc.close();
    } catch {
      // ignore
    }
    this.peers.delete(remotePubkey);
  }

  _pruneStaleAnnouncements() {
    const now = Date.now();
    let changed = false;
    for (const [ch, map] of this.activeCallsByRoom.entries()) {
      for (const [pk, info] of map.entries()) {
        if (now - info.ts >= 25000) {
          map.delete(pk);
          changed = true;
        }
      }
      if (map.size === 0) {
        this.activeCallsByRoom.delete(ch);
      }
    }

    // Remove ghost peers only if disconnected/failed AND silent for > 45 seconds
    if (this.activeChannelId) {
      for (const [pk, peer] of [...this.peers.entries()]) {
        const connected =
          peer.pc.connectionState === 'connected' ||
          peer.pc.iceConnectionState === 'connected' ||
          peer.pc.iceConnectionState === 'completed';
        if (!connected && now - peer.lastSeenAt > 45000) {
          this._removePeer(pk);
          changed = true;
        }
      }
    }

    if (changed) this._emit();
  }

  _emit() {
    this.onStateChange(this.getActiveCallInfo());
  }
}
