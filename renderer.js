const playBtn = document.getElementById("playBtn");
const progressFill = document.getElementById("progressFill");
const progressBar = document.getElementById("progressBar");
const progressPreview = document.getElementById("progressPreview");
const progressTooltip = document.getElementById("progressTooltip");
const currentTimeEl = document.getElementById("currentTime");
const durationEl = document.getElementById("duration");
const karaokeToggle = document.getElementById("karaokeToggle");
const contentArea = document.getElementById("contentArea");
const playerCard = document.getElementById("playerCard");
const lyricsEl = document.getElementById("lyrics");
const stage = document.getElementById("stage");
const dragHandle = document.getElementById("dragHandle");

// ── Marquee title ─────────────────────────────────────────────────────────────
const titleEl = document.querySelector(".meta h1");
let currentTitleText = "";
let marqueeTextWidth = 0; // cached plain-text pixel width

function updateMarquee() {
  const isMarquee = titleEl.classList.contains("is-marquee");
  const containerW = titleEl.clientWidth;

  if (isMarquee) {
    // Already running — only exit if it no longer overflows; never restart mid-animation
    if (marqueeTextWidth <= containerW + 1) {
      titleEl.classList.remove("is-marquee");
      titleEl.style.removeProperty("--marquee-duration");
      titleEl.style.removeProperty("--marquee-offset");
      titleEl.textContent = currentTitleText;
    }
    return;
  }

  if (titleEl.scrollWidth <= containerW + 1) return;

  marqueeTextWidth = titleEl.scrollWidth;
  const duration = Math.max(8, marqueeTextWidth / 35); // ~35 px/s, min 8s

  titleEl.innerHTML =
    `<span class="marquee-inner">` +
    `<span class="marquee-text">${currentTitleText}</span>` +
    `<span class="marquee-text" aria-hidden="true">${currentTitleText}</span>` +
    `</span>`;
  titleEl.classList.add("is-marquee");

  // Two rAFs so the browser lays out the flex children before we measure
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const inner     = titleEl.querySelector(".marquee-inner");
    const firstSpan = titleEl.querySelector(".marquee-text");
    if (!inner || !firstSpan) return;
    // offsetWidth gives exact px width of one copy (incl. padding), independent of parent overflow
    const oneUnit = firstSpan.getBoundingClientRect().width;
    titleEl.style.setProperty("--marquee-offset", `-${oneUnit}px`);
    titleEl.style.setProperty("--marquee-duration", `${duration}s`);
    // Restart animation so it picks up the new custom property values
    inner.style.animation = "none";
    void inner.offsetWidth; // force reflow
    inner.style.animation = "";
  }));
}

function setTitle(text) {
  currentTitleText = text;
  marqueeTextWidth = 0;
  titleEl.classList.remove("is-marquee");
  titleEl.style.removeProperty("--marquee-duration");
  titleEl.style.removeProperty("--marquee-offset");
  titleEl.textContent = text;
  requestAnimationFrame(() => requestAnimationFrame(updateMarquee));
}

new ResizeObserver(updateMarquee).observe(titleEl);

// ── Spotify Playback ──────────────────────────────────────────────────────────
let spotifyPlayer = null;
let deviceId = null;
let playerState = null;
let progressRafId = null;
let positionAtLastSync = 0;
let lastSyncedAt = 0;
let isPlaying = false;
let simulatedDuration = 0;

function getSimulatedPosition() {
  if (!isPlaying) return positionAtLastSync;
  return Math.min(simulatedDuration, positionAtLastSync + (Date.now() - lastSyncedAt));
}

function syncPosition(posMs, playing) {
  positionAtLastSync = posMs;
  lastSyncedAt = Date.now();
  isPlaying = playing;
}

function formatTime(seconds) {
  if (!isFinite(seconds)) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

// ── Lyrics ───────────────────────────────────────────────────────────────────
let lyrics = [];
let lyricsMode = "none"; // "synced" | "static" | "none"
let currentTrackId = null;

// ── Romanization ──────────────────────────────────────────────────────────────
function hasNonLatin(text) {
  return /[\u0400-\u04FF\u0600-\u06FF\u0590-\u05FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF\u0900-\u097F\u0E00-\u0E7F\u0370-\u03FF]/.test(text);
}

function isJapanese(text) {
  return /[\u3040-\u30FF]/.test(text);
}

function isKorean(text) {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text);
}

function isChinese(text) {
  return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(text);
}

function romanizeText(text) {
  try {
    if (isKorean(text) && window.hangulRomanization) {
      return window.hangulRomanization.convert(text);
    }
    if (isJapanese(text) && window.wanakana) {
      return window.wanakana.toRomaji(text);
    }
    if (isChinese(text) && window.pinyinPro) {
      return window.pinyinPro.convert(text);
    }
    return window.transliteration?.transliterate(text) ?? null;
  } catch {
    return null;
  }
}

function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split("\n")) {
    const match = raw.match(/^\[(\d{2}):(\d{2})\.(\d{2,3})\](.*)/);
    if (!match) continue;
    const mins = parseInt(match[1], 10);
    const secs = parseInt(match[2], 10);
    const ms   = parseInt(match[3].padEnd(3, "0"), 10);
    const text = match[4].trim();
    if (text) lines.push({ start: mins * 60 + secs + ms / 1000, text });
  }
  return lines;
}

async function fetchLyrics(track) {
  const artist   = track.artists[0]?.name || "";
  const title    = track.name;
  const album    = track.album?.name || "";
  const duration = Math.round(track.duration_ms / 1000);

  // Try lrclib first (synced)
  const params = new URLSearchParams({ artist_name: artist, track_name: title, album_name: album, duration });
  try {
    const res  = await fetch(`https://lrclib.net/api/get?${params}`);
    if (res.ok) {
      const data = await res.json();
      if (data.syncedLyrics) return { lines: parseLrc(data.syncedLyrics), synced: true };
    }
  } catch {}

  // Fallback: Genius (unsynced plain text)
  try {
    const text = await window.genius.fetchLyrics(artist, title);
    if (text) {
      const lines = text.split("\n").map((t) => ({ text: t, start: null }));
      return { lines, synced: false };
    }
  } catch {}

  return null;
}

async function preRomanizeJapanese(lines) {
  if (!window.kuroshiro) return;
  const japanese = lines.filter((l) => l.text && isJapanese(l.text));
  if (!japanese.length) return;
  await Promise.all(japanese.map(async (line) => {
    try {
      const roma = await window.kuroshiro.convert(line.text);
      if (roma && roma !== line.text) line.romanized = roma;
    } catch {}
  }));
}

let activeLineIndex = -1;
let lyricsTopSpacer = null;
let lyricsBottomSpacer = null;

function updateLyricsSpacers() {
  if (lyricsTopSpacer) lyricsTopSpacer.style.height = "0px";
  if (lyricsBottomSpacer) lyricsBottomSpacer.style.height = "0px";
}

new ResizeObserver(updateLyricsSpacers).observe(lyricsEl);

function renderLyrics(message) {
  lyricsEl.innerHTML = "";
  activeLineIndex = -1;

  lyricsTopSpacer = document.createElement("div");
  lyricsTopSpacer.className = "lyrics-spacer";
  lyricsEl.appendChild(lyricsTopSpacer);

  if (message || !lyrics.length) {
    const msg = document.createElement("div");
    msg.className = "line is-upcoming lyrics-message";
    msg.textContent = message || "No lyrics found";
    lyricsEl.appendChild(msg);
  } else {
    if (lyricsMode === "static") {
      const notice = document.createElement("div");
      notice.className = "line is-upcoming lyrics-sync-notice";
      notice.textContent = "Timestamp sync not available";
      lyricsEl.appendChild(notice);
    }

    lyrics.forEach((line, index) => {
      const lineEl = document.createElement("div");
      lineEl.className = "line is-upcoming";
      lineEl.dataset.index = index;
      if (lyricsMode === "synced") lineEl.dataset.start = line.start;
      if (hasNonLatin(line.text)) {
        const roma = line.romanized ?? romanizeText(line.text);
        if (roma && roma !== line.text) {
          lineEl.appendChild(document.createTextNode(line.text));
          const romaSpan = document.createElement("span");
          romaSpan.className = "line-romanized";
          romaSpan.textContent = roma;
          lineEl.appendChild(romaSpan);
        } else {
          lineEl.textContent = line.text;
        }
      } else {
        lineEl.textContent = line.text;
      }
      if (lyricsMode === "synced") {
        lineEl.addEventListener("click", () => {
          const posMs = Math.floor(line.start * 1000);
          syncPosition(posMs, isPlaying);
          spotifyFetch(`/me/player/seek?position_ms=${posMs}`, { method: "PUT" });
        });
      }
      lyricsEl.appendChild(lineEl);
    });
  }

  lyricsBottomSpacer = document.createElement("div");
  lyricsBottomSpacer.className = "lyrics-spacer";
  lyricsEl.appendChild(lyricsBottomSpacer);

  updateLyricsSpacers();
  lyricsEl.scrollTo({ top: 0, behavior: "instant" });
}

function updateLyrics() {
  if (lyricsMode !== "synced") return;
  const t = getSimulatedPosition() / 1000;
  const dur = simulatedDuration / 1000 || 1;
  const lines = Array.from(lyricsEl.querySelectorAll(".line"));
  let newActiveIndex = -1;

  lines.forEach((lineEl, index) => {
    const start = Number(lineEl.dataset.start);
    const end = lyrics[index + 1] ? lyrics[index + 1].start : dur;

    if (t >= start && t < end) {
      lineEl.classList.remove("is-past", "is-upcoming");
      lineEl.classList.add("is-active");
      newActiveIndex = index;
    } else if (t >= end) {
      lineEl.classList.remove("is-active", "is-upcoming");
      lineEl.classList.add("is-past");
    } else {
      lineEl.classList.remove("is-active", "is-past");
      lineEl.classList.add("is-upcoming");
    }
  });

  if (newActiveIndex !== activeLineIndex) {
    activeLineIndex = newActiveIndex;
    if (newActiveIndex >= 0) {
      lines[newActiveIndex].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function updateProgress() {
  const posMs = getSimulatedPosition();
  const t = posMs / 1000;
  const dur = simulatedDuration / 1000;
  const percent = dur ? (t / dur) * 100 : 0;
  progressFill.style.width = `${percent}%`;
  currentTimeEl.textContent = formatTime(t);
  durationEl.textContent = formatTime(dur);
  updateLyrics();
}

function startProgressTick() {
  if (progressRafId) cancelAnimationFrame(progressRafId);
  function tick() {
    updateProgress();
    progressRafId = requestAnimationFrame(tick);
  }
  progressRafId = requestAnimationFrame(tick);
}

const artImg = document.querySelector(".art-panel img");

function extractAndApplyColor(imgEl) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext("2d");
  try {
    ctx.drawImage(imgEl, 0, 0, 64, 64);
    const data = ctx.getImageData(0, 0, 64, 64).data;

    // Collect HSL + chroma score for every pixel
    const samples = [];
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255;
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const l = (max + min) / 2;
      const d = max - min;
      let h = 0, s = 0;
      if (d > 0) {
        s = d / (1 - Math.abs(2 * l - 1));
        if (max === r) h = ((g - b) / d + 6) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      samples.push({ h, s, l, chroma: s * (1 - Math.abs(2 * l - 1)) });
    }

    // Average image lightness for the upcoming-lyric opacity heuristic
    const avgImgL = samples.reduce((a, p) => a + p.l, 0) / samples.length;

    // Use the top 20% most chromatic (vivid) pixels to find the dominant hue
    samples.sort((a, b) => b.chroma - a.chroma);
    const top = samples.slice(0, Math.max(1, Math.floor(samples.length * 0.2)));

    // Circular average for hue; arithmetic average for saturation
    let sinSum = 0, cosSum = 0, sSum = 0;
    for (const p of top) {
      const rad = p.h * Math.PI / 180;
      sinSum += Math.sin(rad);
      cosSum += Math.cos(rad);
      sSum += p.s;
    }
    const h = Math.round(((Math.atan2(sinSum, cosSum) * 180 / Math.PI) + 360) % 360);
    const s = Math.min(1, (sSum / top.length) * 1.3); // boost saturation

    // Build all colors in HSL — always vivid
    const sP  = Math.round(s * 100);
    const light    = `hsl(${h},${sP}%,55%)`;
    const dark     = `hsl(${h},${Math.round(s * 90)}%,18%)`;
    const mid      = `hsl(${h},${Math.round(s * 95)}%,30%)`;
    const upcoming = `hsl(${h},${sP}%,62%)`;

    // Light-background heuristic: if the art is overall bright, soften upcoming lyrics
    const upcomingOpacity = avgImgL > 0.60 ? 0.7 : 1;

    contentArea.style.setProperty("--art-color-light", light);
    contentArea.style.setProperty("--art-color-dark", dark);
    contentArea.style.setProperty("--art-color-mid", mid);
    contentArea.style.setProperty("--art-color-upcoming", upcoming);
    contentArea.style.setProperty("--upcoming-lyric-opacity", upcomingOpacity);
  } catch (e) { /* cross-origin guard */ }
}

function setArtUrl(url) {
  if (!url || artImg.src === url) return;
  artImg.crossOrigin = "anonymous";
  artImg.src = url;
  artImg.onload = () => extractAndApplyColor(artImg);
}

function applyPlayerState(state) {
  if (!state) return;
  playerState = state;
  simulatedDuration = state.duration;
  syncPosition(state.position, !state.paused);

  const paused = state.paused;
  playBtn.classList.toggle("is-paused", !paused);

  const track = state.track_window?.current_track;
  if (track) {
    setTitle(track.name);
    document.querySelector(".meta p").textContent =
      track.artists.map((a) => a.name).join(", ");
    setArtUrl(track.album?.images?.[0]?.url);
    simulatedDuration = state.duration;
    durationEl.textContent = formatTime(state.duration / 1000);

    if (track.id !== currentTrackId) {
      currentTrackId = track.id;
      lyrics = [];
      lyricsMode = "none";
      renderLyrics("Loading lyrics…");
      fetchLyrics(track).then(async (fetched) => {
        if (fetched) await preRomanizeJapanese(fetched.lines);
        lyrics = fetched?.lines || [];
        lyricsMode = fetched ? (fetched.synced ? "synced" : "static") : "none";
        renderLyrics(fetched ? null : "No lyrics found for this track");
      });
      checkIfLiked(track.id);
    }
  }

  updateProgress();
}

async function spotifyFetch(path, options = {}) {
  const token = await window.spotify.getToken();
  return fetch(`https://api.spotify.com/v1${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...options.headers },
  });
}

function initSpotifySDK(token) {
  const script = document.createElement("script");
  script.src = "https://sdk.scdn.co/spotify-player.js";
  document.head.appendChild(script);

  window.onSpotifyWebPlaybackSDKReady = () => {
    spotifyPlayer = new Spotify.Player({
      name: "Karaoke App",
      getOAuthToken: (cb) => cb(token),
      volume: 0.8,
    });

    spotifyPlayer.addListener("ready", ({ device_id }) => {
      deviceId = device_id;
      // Transfer playback to this device
      spotifyFetch("/me/player", {
        method: "PUT",
        body: JSON.stringify({ device_ids: [device_id], play: false }),
      });
    });

    spotifyPlayer.addListener("player_state_changed", applyPlayerState);
    spotifyPlayer.connect();
    startProgressTick();
  };
}

// ── Poll currently playing (catches playback on other devices) ────────────────
async function pollCurrentlyPlaying() {
  try {
    const res = await spotifyFetch("/me/player");
    if (res.status === 204 || !res.ok) return; // nothing playing
    const data = await res.json();
    if (!data?.item) return;

    const track = data.item;
    const paused = !data.is_playing;

    playBtn.classList.toggle("is-paused", !paused);
    setTitle(track.name);
    document.querySelector(".meta p").textContent =
      track.artists.map((a) => a.name).join(", ");
    setArtUrl(track.album?.images?.[0]?.url);

    simulatedDuration = track.duration_ms;
    syncPosition(data.progress_ms, data.is_playing);
    durationEl.textContent = formatTime(track.duration_ms / 1000);

    if (track.id !== currentTrackId) {
      currentTrackId = track.id;
      lyrics = [];
      lyricsMode = "none";
      renderLyrics("Loading lyrics…");
      fetchLyrics(track).then(async (fetched) => {
        if (fetched) await preRomanizeJapanese(fetched.lines);
        lyrics = fetched?.lines || [];
        lyricsMode = fetched ? (fetched.synced ? "synced" : "static") : "none";
        renderLyrics(fetched ? null : "No lyrics found for this track");
      });
      checkIfLiked(track.id);
    }

    // Sync shuffle state (skip if user interacted recently)
    if (Date.now() - lastShuffleInteraction > 2000) {
      shuffleDot.classList.toggle("visible", !!data.shuffle_state);
    }

    // Sync repeat state (skip if user interacted recently)
    if (Date.now() - lastRepeatInteraction > 2000) {
      if (data.repeat_state === "track")   applyRepeatState(2);
      else if (data.repeat_state === "context") applyRepeatState(1);
      else applyRepeatState(0);
    }

    updateProgress();
  } catch (e) {
    // silently ignore poll errors
  }
}

// ── Auth init ─────────────────────────────────────────────────────────────────
window.spotify.onTokenReady((token) => {
  initSpotifySDK(token);
  pollCurrentlyPlaying();
  setInterval(pollCurrentlyPlaying, 3000);
});
window.spotify.onTokenRefreshed((token) => {
  if (spotifyPlayer) spotifyPlayer._options.getOAuthToken = (cb) => cb(token);
});

// ── Playback controls ────────────────────────────────────────────────────────
playBtn.addEventListener("click", async () => {
  const playing = playBtn.classList.contains("is-paused");
  if (playing) {
    await spotifyFetch(`/me/player/pause`, { method: "PUT" });
    playBtn.classList.remove("is-paused");
    syncPosition(getSimulatedPosition(), false);
  } else {
    await spotifyFetch(`/me/player/play`, { method: "PUT" });
    playBtn.classList.add("is-paused");
    syncPosition(getSimulatedPosition(), true);
  }
});

progressBar.addEventListener("click", (e) => {
  const rect = progressBar.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;
  const posMs = Math.floor(pct * simulatedDuration);
  syncPosition(posMs, isPlaying);
  spotifyFetch(`/me/player/seek?position_ms=${posMs}`, { method: "PUT" });
});

progressBar.addEventListener("mousemove", (e) => {
  const rect = progressBar.getBoundingClientRect();
  const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const fraction = x / rect.width;
  const hoverTime = fraction * (simulatedDuration / 1000 || 0);

  // Tooltip
  progressTooltip.textContent = formatTime(hoverTime);
  progressTooltip.style.left = `${x}px`;

  // Preview bar — only show ahead of current position
  const currentFraction = simulatedDuration > 0 ? getSimulatedPosition() / simulatedDuration : 0;
  progressPreview.style.width = fraction > currentFraction ? `${fraction * 100}%` : "0%";
});

progressBar.addEventListener("mouseleave", () => {
  progressPreview.style.width = "0%";
});

// ── Playback control buttons ──────────────────────────────────────────────────
document.getElementById("prevBtn").addEventListener("click", () => {
  spotifyFetch(`/me/player/previous`, { method: "POST" });
});
document.getElementById("nextBtn").addEventListener("click", () => {
  spotifyFetch(`/me/player/next`, { method: "POST" });
});
// ── Volume slider ─────────────────────────────────────────────────────────────
const volTrack   = document.getElementById("volTrack");
const volFill    = document.getElementById("volFill");
const volPreview = document.getElementById("volPreview");
const volThumb   = document.getElementById("volThumb");
const volumeBtn  = document.getElementById("volumeBtn");
let currentVolume = 0.8;
let volApiTimer = null;

function applyVolume(v) {
  currentVolume = Math.max(0, Math.min(1, v));
  const pct = currentVolume * 100;
  volFill.style.height  = `${pct}%`;
  volThumb.style.bottom = `${pct}%`;
  volumeBtn.classList.toggle("is-muted", currentVolume === 0);
}

function sendVolumeToSpotify(v) {
  clearTimeout(volApiTimer);
  volApiTimer = setTimeout(() => {
    if (spotifyPlayer) spotifyPlayer.setVolume(v);
    spotifyFetch(`/me/player/volume?volume_percent=${Math.round(v * 100)}`, { method: "PUT" });
  }, 50);
}

applyVolume(0.8);

function volumeFromEvent(e) {
  const rect = volTrack.getBoundingClientRect();
  return Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
}

let volDragging = false;

volTrack.addEventListener("mousemove", (e) => {
  if (volDragging) return;
  const hoverV = volumeFromEvent(e);
  volPreview.style.height = hoverV > currentVolume
    ? `${hoverV * 100}%`
    : "0%";
});

volTrack.addEventListener("mouseleave", () => {
  volPreview.style.height = "0%";
});

volTrack.addEventListener("mousedown", (e) => {
  volDragging = true;
  const v = volumeFromEvent(e);
  applyVolume(v);
  sendVolumeToSpotify(v);
  document.addEventListener("mousemove", onVolMove);
  document.addEventListener("mouseup", onVolUp);
});

function onVolMove(e) {
  if (!volDragging) return;
  const v = volumeFromEvent(e);
  applyVolume(v);
  sendVolumeToSpotify(v);
}

function onVolUp(e) {
  if (!volDragging) return;
  volDragging = false;
  const v = volumeFromEvent(e);
  applyVolume(v);
  sendVolumeToSpotify(v);
  document.removeEventListener("mousemove", onVolMove);
  document.removeEventListener("mouseup", onVolUp);
}

// ── Like confetti ─────────────────────────────────────────────────────────────
const CONFETTI_COLORS = ['#1ed760', '#17b84e', '#25f470', '#0faf40'];

function spawnConfetti(buttonEl) {
  const btnRect   = buttonEl.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();

  // Launch origin: center-top of the button
  const ox = btnRect.left - stageRect.left + btnRect.width  / 2;
  const oy = btnRect.top  - stageRect.top  + btnRect.height * 0.25;

  const COUNT    = 7;
  const DURATION = 300; // ms
  const GRAVITY  = 0.15;

  for (let i = 0; i < COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'confetti-piece ' + (Math.random() > 0.5 ? 'confetti-circle' : 'confetti-rect');
    el.style.background = CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    el.style.left = ox + 'px';
    el.style.top  = oy + 'px';
    stage.appendChild(el);

    // ~300° spread centered around straight-up, so particles don't just fall downward
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * (Math.PI * 5 / 3);
    const speed = 1.4 + Math.random() * 1.2;
    let x = ox, y = oy;
    let vx = Math.cos(angle) * speed;
    let vy = Math.sin(angle) * speed;
    const t0 = performance.now();

    (function tick(now) {
      const progress = (now - t0) / DURATION;
      if (progress >= 1) { el.remove(); return; }
      vy += GRAVITY;
      x  += vx;
      y  += vy;
      el.style.left    = x + 'px';
      el.style.top     = y + 'px';
      el.style.opacity = String(1 - progress);
      requestAnimationFrame(tick);
    })(performance.now());
  }
}

// ── Liked songs ───────────────────────────────────────────────────────────────
const addBtn = document.getElementById("addBtn");
let isLiked = false;

async function checkIfLiked(trackId) {
  if (!trackId) return;
  try {
    const res = await spotifyFetch(`/me/tracks/contains?ids=${trackId}`);
    if (!res.ok) return;
    const data = await res.json();
    isLiked = data[0] || false;
    addBtn.classList.toggle("is-liked", isLiked);
  } catch (e) { /* ignore */ }
}

addBtn.addEventListener("click", async () => {
  if (!currentTrackId) return;
  if (isLiked) {
    await spotifyFetch(`/me/tracks?ids=${currentTrackId}`, { method: "DELETE" });
    isLiked = false;
  } else {
    spawnConfetti(addBtn);
    await spotifyFetch(`/me/tracks?ids=${currentTrackId}`, { method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [currentTrackId] }) });
    isLiked = true;
  }
  addBtn.classList.toggle("is-liked", isLiked);
});

// ── Share / copy link ─────────────────────────────────────────────────────────
const shareTooltip = document.getElementById("shareTooltip");
let shareTooltipTimer = null;

document.getElementById("queueBtn").addEventListener("click", () => {
  if (!currentTrackId) return;
  const url = `https://open.spotify.com/track/${currentTrackId}`;
  navigator.clipboard.writeText(url);
  shareTooltip.classList.add("visible");
  clearTimeout(shareTooltipTimer);
  shareTooltipTimer = setTimeout(() => shareTooltip.classList.remove("visible"), 1000);
});

const shuffleDot = document.getElementById("shuffleDot");
let lastShuffleInteraction = 0;
let shuffleProcessing = false;
document.getElementById("shuffleBtn").addEventListener("click", async () => {
  if (shuffleProcessing) return;
  shuffleProcessing = true;
  lastShuffleInteraction = Date.now();
  const on = !shuffleDot.classList.contains("visible");
  shuffleDot.classList.toggle("visible", on);
  await spotifyFetch(`/me/player/shuffle?state=${on}&device_id=${deviceId}`, { method: "PUT" });
  shuffleProcessing = false;
});
// ── Repeat (3-state) ──────────────────────────────────────────────────────────
const repeatBtn     = document.getElementById("repeatBtn");
const repeatDot     = document.getElementById("repeatDot");
const repeatTooltip = document.getElementById("repeatTooltip");
// 0 = off, 1 = context, 2 = track
let repeatState = 0;
let lastRepeatInteraction = 0;
let repeatProcessing = false;

const REPEAT_STATES = [
  { api: "off",     tooltip: "Enable repeat",     active: false, one: false, dot: false },
  { api: "context", tooltip: "Enable repeat one",  active: true,  one: false, dot: true  },
  { api: "track",   tooltip: "Disable repeat",     active: true,  one: true,  dot: true  },
];

function applyRepeatState(idx) {
  repeatState = idx;
  const s = REPEAT_STATES[idx];
  repeatBtn.classList.toggle("is-active",      s.active);
  repeatBtn.classList.toggle("is-repeat-one",  s.one);
  repeatDot.classList.toggle("visible",        s.dot);
  repeatTooltip.textContent = s.tooltip;
  repeatBtn.setAttribute("aria-label", s.tooltip);
}

repeatBtn.addEventListener("click", async () => {
  if (repeatProcessing) return;
  repeatProcessing = true;
  lastRepeatInteraction = Date.now();
  const next = (repeatState + 1) % 3;
  applyRepeatState(next);
  await spotifyFetch(`/me/player/repeat?state=${REPEAT_STATES[next].api}`, { method: "PUT" });
  repeatProcessing = false;
});

// ── Karaoke toggle ───────────────────────────────────────────────────────────
function setKaraoke(on) {
  contentArea.classList.toggle("karaoke-on", on);
  playerCard.classList.toggle("karaoke-on", on);
  karaokeToggle.setAttribute("aria-expanded", on.toString());
  if (on) {
    activeLineIndex = -1;
    updateLyricsSpacers();
    lyricsEl.scrollTop = 0;
  }
}

karaokeToggle.addEventListener("click", () => setKaraoke(!contentArea.classList.contains("karaoke-on")));
document.getElementById("exitKaraokeBtn").addEventListener("click", () => setKaraoke(false));

// ── Drag to move window ───────────────────────────────────────────────────────
let isDragging = false;
let dragScreenStartX = 0, dragScreenStartY = 0;
let dragWinStartX = 0, dragWinStartY = 0;

dragHandle.addEventListener("mousedown", async (e) => {
  isDragging = true;
  dragScreenStartX = e.screenX;
  dragScreenStartY = e.screenY;
  const [wx, wy] = await window.electronWindow.getPos();
  dragWinStartX = wx;
  dragWinStartY = wy;
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
});

function onDragMove(e) {
  if (!isDragging) return;
  const dx = e.screenX - dragScreenStartX;
  const dy = e.screenY - dragScreenStartY;
  window.electronWindow.setPos(dragWinStartX + dx, dragWinStartY + dy);
}

function onDragEnd() {
  isDragging = false;
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
}

// ── Resize window ─────────────────────────────────────────────────────────────
const MIN_W = 280, MIN_H = 380;
let isResizing = false, resizeDir = "";
let resizeStartX = 0, resizeStartY = 0;
let resizeStartW = 0, resizeStartH = 0;
let resizeWinStartX = 0, resizeWinStartY = 0;

document.querySelectorAll(".resize-edge").forEach(edge => {
  edge.addEventListener("mousedown", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    isResizing = true;
    resizeDir = edge.dataset.dir;
    resizeStartX = e.screenX;
    resizeStartY = e.screenY;
    const [w, h] = await window.electronWindow.getSize();
    const [wx, wy] = await window.electronWindow.getPos();
    resizeStartW = w;
    resizeStartH = h;
    resizeWinStartX = wx;
    resizeWinStartY = wy;
    document.addEventListener("mousemove", onResizeMove);
    document.addEventListener("mouseup", onResizeEnd);
  });
});

function onResizeMove(e) {
  if (!isResizing) return;
  const dx = e.screenX - resizeStartX;
  const dy = e.screenY - resizeStartY;

  let newW = resizeStartW;
  let newH = resizeStartH;
  let newX = resizeWinStartX;
  let newY = resizeWinStartY;

  if (resizeDir.includes("e")) newW = Math.max(MIN_W, resizeStartW + dx);
  if (resizeDir.includes("w")) { newW = Math.max(MIN_W, resizeStartW - dx); newX = resizeWinStartX + (resizeStartW - newW); }
  if (resizeDir.includes("s")) newH = Math.max(MIN_H, resizeStartH + dy);
  if (resizeDir.includes("n")) { newH = Math.max(MIN_H, resizeStartH - dy); newY = resizeWinStartY + (resizeStartH - newH); }

  window.electronWindow.setSize(newW, newH);
  window.electronWindow.setPos(newX, newY);
}

function onResizeEnd() {
  isResizing = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeEnd);
}

// ── Picture-in-Picture ────────────────────────────────────────────────────────
const appEl = document.querySelector(".app");
const stylesheetHref = document.querySelector("link[rel='stylesheet']").href;

async function openPiP() {
  if (!window.documentPictureInPicture) return;
  if (window.documentPictureInPicture.window) return;
  try {
    const w = stage.offsetWidth;
    const h = playerCard.offsetHeight;
    const pipWindow = await window.documentPictureInPicture.requestWindow({
      width: w + 24,
      height: h + 24,
      disallowReturnToOpener: false,
    });
    const link = pipWindow.document.createElement("link");
    link.rel = "stylesheet";
    link.href = stylesheetHref;
    pipWindow.document.head.appendChild(link);
    pipWindow.document.body.style.cssText =
      "margin:0;padding:12px;background:#000;display:flex;" +
      "align-items:center;justify-content:flex-end;min-height:100vh;box-sizing:border-box;";
    pipWindow.document.body.appendChild(stage);
    pipWindow.addEventListener("pagehide", () => { appEl.appendChild(stage); });
  } catch (e) { console.warn("PiP unavailable:", e); }
}

document.addEventListener("visibilitychange", () => { if (document.hidden) openPiP(); });

let isDimmed = false;
document.getElementById("opacityBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  isDimmed = !isDimmed;
  window.electronWindow.setOpacity(isDimmed ? 0.5 : 1);
});

document.querySelector(".dot").addEventListener("click", (e) => {
  e.stopPropagation();
  window.electronWindow.minimize();
});

// ── Timing helper ────────────────────────────────────────────────────────────
const TIMING_LYRICS = [
  "Again, had to call it off again",
  "Again, guess we're better off as friends",
  "Wait, give me space, I said, \"Boy, get out my face\"",
  "It's okay, you can't relate, yeah, had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "(Had to call it off again)",
  "It's like you're tongue-tied, tied, tied",
  "And you act out of your mind",
  "'Cause your vision of us shattered right in front of your eyes",
  "Speak your truth, don't hold back",
  "Long as it ain't behind my back",
  "I know it's hard being sincere when it feels like it's all bad (like it's all bad)",
  "Just smile, the world is watching",
  "They seem so concerned",
  "But they can't tell me nothin'",
  "I might just let it burn",
  "You lost that fire for me (for me)",
  "I know I let you go (you go)",
  "Still at the same old place",
  "I'm just a call away",
  "Again, had to call it off again",
  "Again, guess we're better off as friends",
  "Wait, give me space, I said, \"Boy, get out my face\"",
  "It's okay, you can't relate, yeah, had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "(Had to call it off again)",
  "You've been on my mind",
  "It's a kind reminder to let you know (I'm gonna let you know)",
  "If I compromised, would you press rewind and just take it slow?",
  "I couldn't count the times, how many times did we lose control?",
  "Maybe this time we'll be cautious (aright), just tell me it's alright",
  "My heart's gettin' heavy (whoo!)",
  "Your attitude's cold, but I like when you check me",
  "I'm keen for your lovin'",
  "And every time you trip, it just happens in public",
  "Girl, you have this habit where you call me out my name",
  "It's like you're the final boss, and I'm just tryna beat these games",
  "Again, had to call it off again",
  "Again, guess we better off as friends",
  "Wait, give me space, I said, \"Boy, get out my face\"",
  "It's okay, you can't relate, yeah, had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "Had to call it off again",
  "(Had to call it off again)",
  "Ooh-ooh-ooh-hoo (call it off)",
  "Ooh-ooh-hoo (again), ooh-ooh-ooh, ooh",
  "Ooh-ooh-ooh-hoo (call it off)",
  "Ooh-ooh-hoo (again), ooh-ooh-ooh, ooh",
];

const timerOverlay   = document.getElementById("timerOverlay");
const timerScreen    = document.getElementById("timerScreen");
const timerResults   = document.getElementById("timerResults");
const timerProgress  = document.getElementById("timerProgress");
const timerTimestamp = document.getElementById("timerTimestamp");
const timerCurrent   = document.getElementById("timerCurrent");
const timerNext      = document.getElementById("timerNext");
const timerOutput    = document.getElementById("timerOutput");
const timerCopyBtn   = document.getElementById("timerCopyBtn");
const timerCloseBtn  = document.getElementById("timerCloseBtn");

let timingMode = false;
let timingIndex = 0;
let timingMarks = []; // { start, text }
let timingRaf = null;

function timerTick() {
  if (!timingMode) return;
  timerTimestamp.textContent = formatTime(getSimulatedPosition() / 1000);
  timingRaf = requestAnimationFrame(timerTick);
}

function openTimingMode() {
  timingMode = true;
  timingIndex = 0;
  timingMarks = [];

  timerScreen.classList.remove("hidden");
  timerResults.classList.add("hidden");
  timerOverlay.classList.remove("hidden");

  refreshTimerUI();
  timingRaf = requestAnimationFrame(timerTick);
}

function closeTimingMode() {
  timingMode = false;
  cancelAnimationFrame(timingRaf);
  timerOverlay.classList.add("hidden");
}

function refreshTimerUI() {
  const total = TIMING_LYRICS.length;
  timerProgress.textContent = `Line ${timingIndex + 1} of ${total}`;
  timerCurrent.textContent = TIMING_LYRICS[timingIndex] ?? "";
  timerNext.textContent = TIMING_LYRICS[timingIndex + 1] ?? "—";
}

function markLine() {
  if (timingIndex >= TIMING_LYRICS.length) return;

  timingMarks.push({
    start: parseFloat((getSimulatedPosition() / 1000).toFixed(2)),
    text: TIMING_LYRICS[timingIndex],
  });
  timingIndex++;

  if (timingIndex >= TIMING_LYRICS.length) {
    finishTiming();
  } else {
    refreshTimerUI();
  }
}

function redoLastLine() {
  if (timingIndex === 0) return;
  timingIndex--;
  timingMarks.pop();
  refreshTimerUI();
}

function finishTiming() {
  cancelAnimationFrame(timingRaf);

  const lines = timingMarks
    .map((m) => `  { start: ${m.start.toFixed(2)}, text: "${m.text.replace(/"/g, '\\"')}" }`)
    .join(",\n");
  const output = `const lyrics = [\n${lines}\n];`;

  timerOutput.textContent = output;
  timerScreen.classList.add("hidden");
  timerResults.classList.remove("hidden");
}

timerCopyBtn.addEventListener("click", () => {
  navigator.clipboard.writeText(timerOutput.textContent).then(() => {
    timerCopyBtn.textContent = "Copied!";
    setTimeout(() => (timerCopyBtn.textContent = "Copy to clipboard"), 2000);
  });
});

timerCloseBtn.addEventListener("click", closeTimingMode);

// Press T anywhere (outside inputs) to open timing mode
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;

  if (!timingMode) {
    if (e.key === "t" || e.key === "T") openTimingMode();
    return;
  }

  if (e.key === "Escape") {
    closeTimingMode();
  } else if (e.key === " ") {
    e.preventDefault();
    markLine();
  } else if (e.key === "r" || e.key === "R") {
    redoLastLine();
  }
});

// ── Init ─────────────────────────────────────────────────────────────────────
renderLyrics();
updateProgress();
