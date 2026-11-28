"use strict";

const get = (id) => document.getElementById(id);
const audio = get("audio");
const video = get("player-video");
const desktopPlaybackVolume = 0.5;
const playbackPlatform = navigator.userAgentData?.platform || navigator.platform;
// iPad Safari can report a Mac platform when requesting desktop websites.
const iPadDesktopMode = /^Mac/i.test(playbackPlatform) && navigator.maxTouchPoints > 1;
const desktopPlayback = /^(Win|Mac|Linux|Chrome OS)/i.test(playbackPlatform) &&
  !iPadDesktopMode && !navigator.userAgentData?.mobile && !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
if (desktopPlayback) audio.volume = video.volume = desktopPlaybackVolume;
const videoStage = get("video-stage");
const videoFullscreen = get("video-fullscreen");
const videoSkip = get("video-skip");
const videoSlot = get("artwork-stage").querySelector(".cover-space");
const videoControls = document.querySelector(".player-controls");
const playerContent = document.querySelector(".player-content");
const fullscreenRoot = document.documentElement;
const playerCover = get("player-cover");
const playerStage = videoStage.parentElement;
let media = audio;
const mediaFormats = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
const picker = get("file-picker");
const importReview = get("import-review");
const importReviewSave = get("import-review-save");
const addTracks = get("add-tracks");
const addDialog = get("add-dialog");
const library = get("library");
const libraryContent = get("library-content");
const librarySearch = get("search").closest(".library-search");
const list = get("tracks");
const search = get("search");
const searchSuggestions = get("search-suggestions");
const seek = get("seek");
const toggle = get("toggle");
const miniToggle = get("mini-toggle");
const miniPlayer = get("mini-player");
const player = get("player");
const queueToggle = get("queue-toggle");
const queuePanel = get("queue-panel");
const queueCurrent = get("queue-current");
const queueList = get("queue-list");
const queueUpcoming = queueList.parentElement;
const historyHeading = get("history-heading");
const historyClear = get("history-clear");
const historyList = get("history-list");
const queueHistory = get("queue-history");
const shuffleToggle = get("shuffle-toggle");
const repeatToggle = get("repeat-toggle");
const queueArtwork = get("queue-artwork");
const queueVideoSlot = queueArtwork.parentElement;
const artwork = get("artwork");
const miniArtwork = get("mini-artwork");
const miniVideo = get("mini-video");
const miniVideoContext = miniVideo.getContext("2d");
const videoPoster = get("video-poster");
const libraryWaveform = createWaveform();
queueVideoSlot.append(createWaveform());
videoStage.append(createWaveform());
const menu = get("track-menu");
const menuActions = Array.from(menu.querySelectorAll(":scope > button"));
const librarySettings = get("library-settings");
const deleteMode = get("delete-mode");
const deleteDialog = get("delete-dialog");
const folderList = get("folders");
const newFolder = get("new-folder");
const createFolderDialog = get("folder-create");
const folderDetailsDialog = get("folder-details");
const folderDetailsForm = get("folder-details-form");
const folderDetailsName = get("folder-details-name");
const folderDetailsImage = get("folder-details-image");
const folderCoverTrack = get("folder-details-cover-track");
const folderDetailsSave = get("folder-details-save");
const folderDetailsClose = get("folder-details-close");
const folderDetailsMessage = get("folder-details-message");
const selectionBar = get("folder-selection");
const selectionTitle = get("selection-title");
const selectionConfirm = get("selection-confirm");
const detailsDialog = get("track-details");
const detailsSave = get("details-save");
const detailsImage = get("details-image");
const mobile = matchMedia("(max-width: 730px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const setScreenActivity = createScreenWakeLock();
let queueTouch;
let queueWheel;
let queueWheelTimer;
let queueSettleTimer;
let queueSettleFrame;
const mediaSession = navigator.mediaSession;
const tracks = [];
const folders = [];
let activeFolder = null;
let playbackFolder = null;
let playbackQuery = "";
let menuFolder = null;
let trackSelection = null;
let customTrackOrder = false;
const queue = new PlaybackQueue();
const historyKey = "otodana-playback-history";
const playbackKey = "otodana-playback-checkpoint";
let database = null;
let current = null;
let objectUrl = null;
let companionVideoUrl = null;
const audioUnsupportedVideos = new WeakSet();
let artworkUrl = null;
let artworkTrack = null;
let artworkRequest = 0;
let playRequest = 0;
let backgroundAdvance = null;
let menuTrack = null;
let pendingDeletion = null;
let deleting = false;
let editSelection = null;
let detailsDraft = null;
let folderDetailsDraft = null;
let detailsCoverUrl = null;
let searchRevision = 0;
let searching = false;
let libraryNavigation;
let searchSuggestionsOpen = false;
let recordedCurrent = false;
let backdrop = null;
let importQueue = Promise.resolve();
let pendingImport = null;
let previewQueue = Promise.resolve();
let saveToastTimer;
let videoLayoutFrame = 0;
let queueArtworkMotion;
let queueVideoMotion;
let miniVideoFrame = 0;
let miniVideoTime = -Infinity;
let activeLibraryButton = null;
let seekDrag = null;
let fullscreenControlsTimer;
let videoSkipTimer;
let videoPointer;
let previousVideoTap;
let landscapeLocked = false;
let resumePosition = null;
let playbackSnapshot = null;
let playbackTracking = false;
let lastCheckpoint = 0;
const marqueeRows = new WeakMap();
const marqueeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => entries.forEach(({ target }) => measureMarquee(target))) : null;

function createScreenWakeLock() {
  if (!navigator.wakeLock?.request) return (_activity, active, report) => { if (active) report?.(false); };
  const touch = matchMedia("(pointer: coarse)");
  const activities = new Map();
  let pageActive = true;
  let sentinel;
  let requesting = false;
  let refreshQueued = false;
  let retryTimer;

  function shouldKeepScreenOn() {
    return pageActive && !document.hidden && (touch.matches || navigator.standalone === true) && activities.size > 0;
  }

  function refreshScreenLock() {
    if (shouldKeepScreenOn() && (activities.has("transfer") || activities.has("playback"))) {
      retryTimer ??= setInterval(refresh, 15_000);
    } else {
      clearInterval(retryTimer);
      retryTimer = undefined;
    }
    refresh();
  }

  function reportScreenLock(locked) {
    for (const report of activities.values()) report?.(locked);
  }

  async function refresh() {
    if (!shouldKeepScreenOn()) {
      const previous = sentinel;
      sentinel = undefined;
      if (previous && !previous.released) await previous.release().catch(() => {});
      return;
    }
    if (sentinel && !sentinel.released) {
      reportScreenLock(true);
      return;
    }
    if (requesting) {
      refreshQueued = true;
      return;
    }
    requesting = true;
    try {
      const lock = await navigator.wakeLock.request("screen");
      if (!lock.released && shouldKeepScreenOn()) {
        sentinel = lock;
        lock.addEventListener("release", () => {
          if (sentinel !== lock) return;
          sentinel = undefined;
          if (shouldKeepScreenOn()) reportScreenLock(false);
        }, { once: true });
        reportScreenLock(true);
      } else if (!lock.released) {
        await lock.release();
      } else if (shouldKeepScreenOn()) {
        reportScreenLock(false);
      }
    } catch {
      if (shouldKeepScreenOn()) reportScreenLock(false);
    } finally {
      requesting = false;
      if (refreshQueued) {
        refreshQueued = false;
        refresh();
      }
    }
  }

  document.addEventListener("visibilitychange", refreshScreenLock);
  document.addEventListener("pointerdown", refresh, { passive: true });
  touch.addEventListener("change", refreshScreenLock);
  window.addEventListener("focus", refresh);
  window.addEventListener("pagehide", () => {
    pageActive = false;
    refreshScreenLock();
  });
  window.addEventListener("pageshow", () => {
    pageActive = true;
    refreshScreenLock();
  });
  return (activity, active, report) => {
    if (active === activities.has(activity)) return;
    if (active) activities.set(activity, report);
    else activities.delete(activity);
    refreshScreenLock();
  };
}

function libraryScrollArea() {
  return mobile.matches ? library : document.scrollingElement;
}

function createWaveform() {
  const waveform = document.createElement("span");
  waveform.className = "track-waveform";
  waveform.setAttribute("aria-hidden", "true");
  waveform.innerHTML = "<i></i>".repeat(6);
  return waveform;
}

function syncLayout() {
  const fullscreen = document.body.hasAttribute("data-video-expanded");
  const expanded = fullscreen || (mobile.matches && document.body.dataset.view === "player");
  library.inert = expanded;
  miniPlayer.inert = expanded;
  player.inert = mobile.matches && !expanded;
  get("theme-color").content = fullscreen ? "#000000" : expanded ? "#121e31" : "#090d15";
  scheduleVideoLayout();
}

function showView(view) {
  if (!mobile.matches || document.body.dataset.view === view) return;
  document.body.dataset.view = view;
  syncLayout();
  if (view === "player") player.scrollTop = 0;
  const focusTarget = view === "player" ? get("library-tab") : (current ? get("player-tab") : addTracks);
  focusTarget.focus({ preventScroll: true });
}

function tellPlayer(message) {
  get("player-message").textContent = message;
  if (message && mobile.matches && document.body.dataset.view === "library") tellLibrary(message);
}

function playbackError() {
  return isVideo(current)
    ? "この動画を再生できません。ファイルが開けるか確認するか、H.264・AACのMP4をお試しください。"
    : "この曲を再生できません。ファイルを確認するか、別の曲を選んでください。";
}

function formatTime(seconds) {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return minutes + ":" + remainder;
}

function updateTime() {
  const canSeek = Boolean(current) && !media.error && Number.isFinite(media.duration) && media.duration > 0;
  const seconds = canSeek ? (seekDrag?.media === media ? seekDrag.time : media.currentTime) : 0;
  const duration = canSeek ? media.duration : 0;
  const progress = duration ? Math.min(100, seconds / duration * 100) : 0;
  document.body.style.setProperty("--progress", progress + "%");
  seek.disabled = !canSeek;
  seek.max = duration || 1;
  seek.value = seconds;
  const elapsedSeconds = Math.floor(Math.min(duration, Math.max(0, seconds)));
  const totalSeconds = Math.floor(duration);
  const elapsed = formatTime(elapsedSeconds);
  const total = formatTime(totalSeconds);
  get("elapsed").textContent = elapsed;
  get("duration").textContent = "−" + formatTime(totalSeconds - elapsedSeconds);
  seek.setAttribute("aria-valuetext", total + "のうち" + elapsed);
}

function updatePlayback() {
  const playing = Boolean(current) && !media.paused && !media.ended && !media.error;
  if (mediaSession && "playbackState" in mediaSession) mediaSession.playbackState = playing ? "playing" : (current ? "paused" : "none");
  setScreenActivity("playback", playing);
  for (const button of [toggle, miniToggle]) {
    button.firstElementChild.dataset.playing = String(playing);
    button.setAttribute("aria-label", playing ? "一時停止" : "再生");
  }
  updateVideoTools();
  activeLibraryButton?.toggleAttribute("data-playing", playing);
  queueCurrent.toggleAttribute("data-playing", playing);
  videoStage.toggleAttribute("data-playing", isVideo(current) && playing);
  videoStage.toggleAttribute("data-ended", isVideo(current) && media.ended);
  scheduleVideoLayout();
}

function trackTitle(track) {
  return track?.edits?.title || track?.metadata?.title || track?.title || "";
}

function displayTrackTitle(track) {
  return track && !track.edits?.title && !track.metadata && !isVideo(track) ? "読み込み中…" : trackTitle(track);
}

function isVideo(track) {
  return mediaFormats[track?.format]?.startsWith("video/") ?? false;
}

function videoAudioType(track) {
  if (desktopPlayback || !isVideo(track) || audioUnsupportedVideos.has(track)) return "";
  const mime = track.format === "webm" ? "audio/webm" : "audio/mp4";
  return audio.canPlayType(mime) ? mime : "";
}

function readMediaMetadata(track, includeArtwork = true) {
  return isVideo(track) ? Promise.resolve({}) : readTrackMetadata(track.blob, includeArtwork);
}

function trackArtist(track) {
  return track?.edits?.artist ?? track?.metadata?.artist ?? "";
}

function trackAlbum(track) {
  return track?.edits?.album ?? track?.metadata?.album ?? "";
}

function measureMarquee(element) {
  const entry = marqueeRows.get(element);
  if (!entry || !element.clientWidth) return;
  const style = getComputedStyle(element);
  const width = element.clientWidth - parseFloat(style.paddingInlineStart) - parseFloat(style.paddingInlineEnd);
  const textWidth = Math.ceil(entry.text.getBoundingClientRect().width);
  const overflow = textWidth > width + 1;
  if (overflow && !entry.track.lastElementChild.hasAttribute("aria-hidden")) {
    const copy = entry.text.cloneNode(true);
    copy.setAttribute("aria-hidden", "true");
    entry.track.append(copy);
  } else if (!overflow && entry.track.children.length > 1) {
    entry.track.lastElementChild.remove();
  }
  entry.track.style.setProperty("--marquee-distance", -(textWidth + 32) + "px");
  entry.track.style.setProperty("--marquee-duration", ((textWidth + 32) / 25 + 2) + "s");
  element.classList.toggle("marquee-overflow", overflow);
}

function setMarquee(element, value, optional = false) {
  const label = value || "";
  if (optional) element.hidden = !label;
  if (marqueeRows.get(element)?.label === label) return;
  const track = document.createElement("span");
  track.className = "marquee-track";
  const text = document.createElement("span");
  text.className = "marquee-text";
  text.textContent = label;
  track.append(text);
  element.replaceChildren(track);
  element.classList.add("marquee");
  element.classList.remove("marquee-overflow");
  marqueeRows.set(element, { label, track, text });
  marqueeObserver?.observe(element);
  if (element.isConnected) measureMarquee(element);
}

function updateMediaMetadata() {
  if (!mediaSession || typeof MediaMetadata !== "function") return;
  mediaSession.metadata = current ? new MediaMetadata({
    title: displayTrackTitle(current),
    artist: trackArtist(current),
    album: trackAlbum(current),
    artwork: artworkTrack === current && artworkUrl ? [{ src: artworkUrl }] : [],
  }) : null;
}

function queueTrackButton(track, action, showArtist = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-track";
  const thumbnail = document.createElement("span");
  thumbnail.className = "thumb";
  thumbnail.toggleAttribute("data-loading", !track.previewReady && !track.thumbnail);
  thumbnail.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = !track.thumbnail;
  if (track.thumbnail) image.src = track.thumbnail;
  thumbnail.append(image);
  thumbnail.track = track;
  const title = document.createElement("span");
  title.className = "queue-name";
  title.textContent = displayTrackTitle(track);
  button.append(thumbnail);
  if (showArtist) {
    const copy = document.createElement("span");
    copy.className = "queue-history-copy";
    const artist = document.createElement("span");
    artist.className = "queue-artist";
    artist.textContent = trackArtist(track);
    artist.hidden = !artist.textContent;
    copy.append(title, artist);
    button.append(copy);
  } else {
    button.append(title);
  }
  button.addEventListener("click", action);
  if (track.preview || !queueThumbnailObserver) showTrackThumbnail(thumbnail);
  else queueThumbnailObserver.observe(thumbnail);
  return button;
}

async function showTrackThumbnail(thumbnail) {
  const track = thumbnail.track;
  track.preview ??= loadTrackPreview(track);
  await track.preview;
  if (!thumbnail.isConnected) return;
  thumbnail.removeAttribute("data-loading");
  const row = thumbnail.parentElement;
  const title = row.querySelector(".queue-name");
  if (title) title.textContent = trackTitle(track);
  const artist = row.querySelector(".queue-artist");
  if (artist) {
    artist.textContent = trackArtist(track);
    artist.hidden = !artist.textContent;
  }
  if (track.thumbnail) {
    const image = thumbnail.firstElementChild;
    image.src = track.thumbnail;
    image.hidden = false;
  }
}

const queueThumbnailObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    queueThumbnailObserver.unobserve(entry.target);
    showTrackThumbnail(entry.target);
  }
}, { root: queuePanel, rootMargin: "64px" }) : null;

function renderQueue(anchor = false) {
  cancelQueueGesture();
  queueThumbnailObserver?.disconnect();
  const scroll = queuePanel.scrollTop;
  setMarquee(get("queue-now-title"), displayTrackTitle(current));
  get("queue-now-artist").textContent = trackArtist(current);
  const history = recordedCurrent ? queue.history.slice(0, -1) : queue.history;
  const historyRows = history.map((track) => {
    const row = document.createElement("li");
    row.append(queueTrackButton(track, () => {
      selectTrack(track);
      queueToggle.focus({ preventScroll: true });
    }, true));
    return row;
  });
  historyList.replaceChildren(...historyRows);
  get("history-empty").hidden = history.length > 0;
  historyClear.disabled = !history.length;
  const rows = queue.upcoming.map((track) => {
    const row = document.createElement("li");
    row.className = "queue-row";
    row.track = track;
    const content = document.createElement("div");
    content.className = "queue-row-content";
    const button = queueTrackButton(track, () => {
      selectTrack(queue.forward(current, track), true);
      queueToggle.focus({ preventScroll: true });
    });
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "queue-handle";
    handle.setAttribute("aria-label", trackTitle(track) + "の再生順を変更");
    handle.title = "ドラッグまたは上下キーで移動・Deleteでキューから外す";
    handle.innerHTML = '<span class="queue-symbol" aria-hidden="true"></span>';
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "queue-remove";
    remove.innerHTML = '<span class="queue-remove-icon" aria-hidden="true"></span>';
    remove.setAttribute("aria-label", trackTitle(track) + "を再生待ちから外す");
    remove.hidden = true;
    remove.addEventListener("click", () => removeQueued(track));
    content.append(button, handle);
    row.append(remove, content);
    return row;
  });
  queueList.replaceChildren(...rows);
  get("queue-empty").hidden = Boolean(rows.length);
  if (anchor) {
    resetQueueScroll();
  }
  queuePanel.scrollTop = anchor ? queueAnchor() : scroll;
  updateQueueViewport();
  scheduleVideoLayout();
}

historyClear.addEventListener("click", () => {
  const playingEntry = recordedCurrent && queue.history.at(-1) === current;
  queue.history = playingEntry ? [current] : [];
  saveHistory();
  renderQueue(true);
  queueCurrent.focus({ preventScroll: true });
});

function queueAnchor() {
  // The current row's offset moves when it sticks to the top or bottom.
  return queueHistory.offsetTop + queueHistory.offsetHeight;
}

function scrollSide(position) {
  const difference = position - queueAnchor();
  return Math.abs(difference) <= 2 ? 0 : Math.sign(difference);
}

function updateQueueViewport() {
  const showingQueue = player.dataset.queue === "true";
  historyHeading.hidden = !showingQueue;
  if (!showingQueue) return;

  const panelTop = queuePanel.getBoundingClientRect().top;
  const pinned = queueCurrent.getBoundingClientRect();
  const history = queueHistory.getBoundingClientRect();
  const upcoming = queueUpcoming.getBoundingClientRect();
  const headingHeight = historyHeading.offsetHeight;
  const showingHistory = headingHeight > 0 && pinned.top - panelTop > headingHeight;
  historyHeading.toggleAttribute("data-visible", showingHistory);
  // Clip against the rendered sticky row, including subpixel scroll positions.
  queuePanel.style.setProperty("--history-start", (panelTop + (showingHistory ? headingHeight : -12) - history.top) + "px");
  queuePanel.style.setProperty("--history-overlap", Math.ceil(Math.max(0, history.bottom - pinned.top)) + "px");
  queuePanel.style.setProperty("--upcoming-overlap", Math.ceil(Math.max(0, pinned.bottom - upcoming.top)) + "px");
}

function unlockQueueScroll() {
  clearTimeout(queueSettleTimer);
  delete queuePanel.dataset.settling;
}

function resetQueueScroll() {
  queueTouch = queueWheel = null;
  clearTimeout(queueWheelTimer);
  cancelAnimationFrame(queueSettleFrame);
  unlockQueueScroll();
}

function settleQueueAt(top, touch = false) {
  if (touch) {
    // Cancel the native fling while the correction animates.
    queuePanel.dataset.settling = "";
    queuePanel.getBoundingClientRect();
    clearTimeout(queueSettleTimer);
    if (!queueTouch?.active) queueSettleTimer = setTimeout(unlockQueueScroll, 420);
  }
  cancelAnimationFrame(queueSettleFrame);
  const from = queuePanel.scrollTop;
  if (reducedMotion.matches || Math.abs(top - from) <= 2) {
    queuePanel.scrollTo({ top, behavior: "instant" });
    return;
  }
  const start = performance.now();
  function animate(now) {
    const progress = Math.min(1, (now - start) / 230);
    const eased = 1 - (1 - progress) ** 3;
    queuePanel.scrollTo({ top: from + (top - from) * eased, behavior: "instant" });
    if (progress < 1) queueSettleFrame = requestAnimationFrame(animate);
  }
  queueSettleFrame = requestAnimationFrame(animate);
}

function settleHistoryEntry(touch) {
  const last = historyList.lastElementChild;
  const anchor = queueAnchor();
  const threshold = last?.previousElementSibling?.offsetTop ??
    (last ? last.offsetTop + last.offsetHeight / 2 : anchor / 2);
  const historyEnd = last
    ? Math.max(0, Math.min(anchor, last.offsetTop + last.offsetHeight + queueCurrent.offsetHeight - queuePanel.clientHeight))
    : 0;
  const target = queuePanel.scrollTop <= threshold ? historyEnd : anchor;
  settleQueueAt(target, touch);
}

queuePanel.addEventListener("scroll", () => {
  updateQueueViewport();
  scheduleVideoLayout();
  const gesture = queueTouch;
  if (!gesture || gesture.stopped || !gesture.side || (!gesture.active && performance.now() > gesture.until)) return;
  if (scrollSide(queuePanel.scrollTop) !== gesture.side) {
    gesture.stopped = true;
    settleQueueAt(queueAnchor(), true);
  }
}, { passive: true });
queuePanel.addEventListener("touchstart", (event) => {
  resetQueueScroll();
  if (event.touches.length === 1 && !event.target.closest(".queue-handle")) {
    queueTouch = { active: true, stopped: false, side: scrollSide(queuePanel.scrollTop) };
  }
}, { passive: true });
function finishQueueTouch(event) {
  if (!queueTouch?.active || event.touches.length) return;
  queueTouch.active = false;
  queueTouch.until = performance.now() + 1000;
  if (queueTouch.stopped) queueSettleTimer = setTimeout(unlockQueueScroll, 420);
  else if (queueTouch.side === 0 && scrollSide(queuePanel.scrollTop) < 0) settleHistoryEntry(true);
}
queuePanel.addEventListener("touchend", finishQueueTouch, { passive: true });
queuePanel.addEventListener("touchcancel", finishQueueTouch, { passive: true });
queuePanel.addEventListener("wheel", (event) => {
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const now = performance.now();
  if (!queueWheel || now - queueWheel.last > 150) {
    cancelAnimationFrame(queueSettleFrame);
    unlockQueueScroll();
    queueTouch = null;
    queueWheel = { side: scrollSide(queuePanel.scrollTop), stopped: false };
  }
  queueWheel.last = now;
  clearTimeout(queueWheelTimer);
  if (queueWheel.stopped) {
    event.preventDefault();
    return;
  }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? queuePanel.clientHeight : 1;
  const end = queuePanel.scrollTop + event.deltaY * unit;
  if (queueWheel.side && scrollSide(end) !== queueWheel.side) {
    event.preventDefault();
    queueWheel.stopped = true;
    settleQueueAt(queueAnchor());
  } else if (!queueWheel.side) {
    queueWheelTimer = setTimeout(() => {
      if (scrollSide(queuePanel.scrollTop) < 0) settleHistoryEntry(false);
    }, 150);
  }
}, { passive: false });

function removeQueued(track) {
  queue.skip(track);
  updateSelection();
  tellPlayer("「" + trackTitle(track) + "」を再生待ちから外しました。");
}

const cancelQueueGesture = bindQueueGestures(queueList, () => queuePanel, {
  reorder: (track, index) => { queue.reorder(track, index); renderQueue(); rememberPlayback(true); },
  remove: removeQueued,
}, reducedMotion);

function animateQueueArtwork(from, visible) {
  const slot = visible ? queueVideoSlot : playerCover;
  const destination = slot.getBoundingClientRect();
  const stage = playerStage.getBoundingClientRect();
  if (!from.width || !destination.width || !stage.width) return;
  const top = visible ? destination.top - queuePanel.getBoundingClientRect().top : destination.top - stage.top;
  const width = Math.max(from.width, destination.width);
  const height = Math.max(from.height, destination.height);
  const overlay = document.createElement("span");
  overlay.className = "queue-artwork-motion";
  overlay.setAttribute("aria-hidden", "true");
  if (!artwork.hidden) {
    const image = new Image();
    image.src = artwork.src;
    image.alt = "";
    overlay.append(image);
  }
  Object.assign(overlay.style, {
    left: "0", top: "0", width: width + "px", height: height + "px",
  });
  playerStage.append(overlay);
  playerStage.setAttribute("data-artwork-transition", "");
  const position = (rect, y) => ({
    transform: `translate(${rect.left - stage.left}px, ${y}px) scale(${rect.width / width}, ${rect.height / height})`,
  });
  const motion = overlay.animate([position(from, from.top - stage.top), position(destination, top)], {
    duration: 290, easing: "cubic-bezier(.22,.8,.24,1)", fill: "both",
  });
  queueArtworkMotion = { overlay, motion };
  motion.finished.then(() => {
    if (queueArtworkMotion?.motion === motion) clearQueueArtworkMotion();
  }, () => {});
}

function clearQueueArtworkMotion() {
  if (!queueArtworkMotion) return;
  queueArtworkMotion.motion.cancel();
  queueArtworkMotion.overlay.remove();
  queueArtworkMotion = null;
  playerStage.removeAttribute("data-artwork-transition");
}

function videoFrameBounds(element, centered) {
  const bounds = element.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight) return bounds;
  const scale = Math.min(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return new DOMRect(bounds.left + (bounds.width - width) / 2,
    bounds.top + (centered ? (bounds.height - height) / 2 : 0), width, height);
}

function clearQueueVideoMotion() {
  if (!queueVideoMotion) return;
  queueVideoMotion.cancel();
  queueVideoMotion = null;
  videoStage.removeAttribute("data-queue-motion");
}

function animateQueueVideo(from, visible) {
  const to = videoFrameBounds(visible ? queueVideoSlot : videoSlot, visible);
  if (!from.width || !from.height || !to.width || !to.height) return;
  const stage = playerStage.getBoundingClientRect();
  const position = (rect, radius) => ({
    left: rect.left - stage.left + "px", top: rect.top - stage.top + "px",
    width: rect.width + "px", height: rect.height + "px", borderRadius: radius,
  });
  videoStage.setAttribute("data-queue-motion", "");
  const motion = videoStage.animate([
    position(from, visible ? "0px" : "8px"), position(to, visible ? "8px" : "0px"),
  ], { duration: 290, easing: "cubic-bezier(.22,.8,.24,1)", fill: "both" });
  queueVideoMotion = motion;
  motion.finished.then(() => {
    if (queueVideoMotion !== motion) return;
    clearQueueVideoMotion();
    updateVideoLayout();
  }, () => {});
}

function showQueue(visible, animate = false) {
  const changing = animate && !reducedMotion.matches && player.dataset.queue !== String(visible);
  const videoPlaying = isVideo(current);
  const from = changing && !videoPlaying && current
    ? (queueArtworkMotion?.overlay ?? (visible ? playerCover : queueVideoSlot)).getBoundingClientRect() : null;
  const videoFrom = changing && videoPlaying && video.readyState >= 2 && !video.error && !media.ended
    ? queueVideoMotion ? videoStage.getBoundingClientRect() : videoFrameBounds(video, !visible) : null;
  clearQueueArtworkMotion();
  clearQueueVideoMotion();
  player.dataset.queue = String(visible);
  queueToggle.setAttribute("aria-pressed", String(visible));
  queueToggle.setAttribute("aria-label", visible ? "ジャケット表示に戻る" : "次に再生する曲を表示");
  get("artwork-stage").inert = visible;
  queuePanel.inert = !visible;
  if (visible) renderQueue(true);
  else {
    resetQueueScroll();
    updateQueueViewport();
    cancelQueueGesture();
    queueThumbnailObserver?.disconnect();
  }
  scheduleVideoLayout();
  if (from) animateQueueArtwork(from, visible);
  if (videoFrom) animateQueueVideo(videoFrom, visible);
}

function updateSelection() {
  const title = displayTrackTitle(current);
  const artist = trackArtist(current);
  setMarquee(get("now-playing"), title || "曲を選んでください");
  setMarquee(get("playing-artist"), artist);
  setMarquee(get("playing-album"), trackAlbum(current));
  setMarquee(get("mini-title"), title);
  setMarquee(get("mini-artist"), artist, true);
  get("previous").disabled = !current || !queue.previous.length;
  get("next").disabled = !current || !queue.hasNext;
  get("mini-next").disabled = get("next").disabled;
  toggle.disabled = !current;
  const currentIsVideo = isVideo(current);
  videoStage.hidden = !currentIsVideo;
  videoFullscreen.hidden = !currentIsVideo;
  playerCover.hidden = currentIsVideo;
  player.toggleAttribute("data-video", currentIsVideo);
  miniPlayer.toggleAttribute("data-video", currentIsVideo);
  miniPlayer.hidden = !current;
  queueToggle.hidden = !current;
  shuffleToggle.setAttribute("aria-pressed", String(queue.shuffled));
  repeatToggle.setAttribute("aria-pressed", String(queue.repeat));
  repeatToggle.disabled = shuffleToggle.disabled = !current;
  if (player.dataset.queue === "true") {
    if (current) renderQueue();
    else showQueue(false);
  }
  document.body.dataset.hasTrack = String(Boolean(current));
  for (const row of folderList.children) row.toggleAttribute("data-current", Boolean(current && row.folder === current.folder));
  activeLibraryButton = null;
  for (const row of list.children) {
    const button = row.querySelector(".track-select");
    const active = row.track === current;
    row.toggleAttribute("data-current", active);
    if (active) {
      button.setAttribute("aria-current", "true");
      activeLibraryButton = button;
    } else {
      button.removeAttribute("aria-current");
      button.removeAttribute("data-playing");
    }
  }
  if (activeLibraryButton) {
    const thumbnail = activeLibraryButton.querySelector(".thumb");
    if (libraryWaveform.parentElement !== thumbnail) thumbnail.append(libraryWaveform);
  } else {
    libraryWaveform.remove();
  }
  updatePlayback();
  updateTime();
  updateMediaMetadata();
  rememberPlayback(true);
}

async function play() {
  playbackTracking = true;
  const request = ++playRequest;
  tellPlayer("");
  try {
    if (media.error) media.load();
    applyResumePosition();
    const started = media.play();
    syncCompanionVideo();
    await started;
    if (request === playRequest) updatePlayback();
  } catch (error) {
    if (request !== playRequest) return;
    if (companionVideoUrl && media.error) {
      const track = current;
      const position = resumePosition ?? media.currentTime;
      const recorded = recordedCurrent;
      audioUnsupportedVideos.add(track);
      loadTrack(track, position);
      recordedCurrent = recorded;
      updateSelection();
      return play();
    }
    if (backgroundAdvance?.track === current && document.hidden && error.name === "NotAllowedError") {
      updatePlayback();
      return;
    }
    tellPlayer(error.name === "NotAllowedError"
      ? "再生ボタンを押して再生を始めてください。"
      : playbackError());
    updatePlayback();
  }
}

function clearArtwork() {
  ++artworkRequest;
  document.body.removeAttribute("data-artwork-loading");
  for (const image of [artwork, miniArtwork, queueArtwork, videoPoster]) {
    image.hidden = true;
    image.removeAttribute("src");
  }
  if (artworkUrl) URL.revokeObjectURL(artworkUrl);
  video.removeAttribute("poster");
  artworkUrl = null;
  artworkTrack = null;
  updateMediaMetadata();
}

function setBackdrop(image) {
  const previous = backdrop;
  backdrop = null;
  if (previous) {
    previous.classList.remove("visible");
    setTimeout(() => {
      URL.revokeObjectURL(previous.src);
      previous.remove();
    }, reducedMotion.matches ? 0 : 500);
  }
  if (!image) {
    player.style.removeProperty("--player-tint");
    return;
  }
  const layer = new Image();
  layer.alt = "";
  layer.src = URL.createObjectURL(image);
  get("player-backdrop").append(layer);
  backdrop = layer;
  layer.decode().then(() => {
    if (backdrop !== layer) return;
    layer.getBoundingClientRect();
    layer.classList.add("visible");
  }).catch(() => {
    if (backdrop === layer) setBackdrop(null);
  });
}

function clearSource(nextIsVideo = false, keepAudioSource = false) {
  clearQueueArtworkMotion();
  clearQueueVideoMotion();
  ++playRequest;
  backgroundAdvance = null;
  seekDrag = null;
  resumePosition = null;
  if (!keepAudioSource) media.pause();
  if (media === video || companionVideoUrl) {
    if (!nextIsVideo) closeVideoExpanded();
    clearVideoTaps();
  }
  if (!keepAudioSource) {
    media.removeAttribute("src");
    media.load();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  if (companionVideoUrl) {
    video.pause();
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(companionVideoUrl);
    companionVideoUrl = null;
  }
  video.removeAttribute("poster");
  videoPoster.hidden = true;
  videoPoster.removeAttribute("src");
}

function tintPlayer(image) {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 12;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return;
  context.drawImage(image, 0, 0, 12, 12);
  const pixels = context.getImageData(0, 0, 12, 12).data;
  const total = [0, 0, 0];
  let weightTotal = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    const [r, g, b, alpha] = pixels.subarray(offset, offset + 4);
    const weight = (alpha / 255) * (0.35 + (Math.max(r, g, b) - Math.min(r, g, b)) / 255);
    total[0] += r * weight;
    total[1] += g * weight;
    total[2] += b * weight;
    weightTotal += weight;
  }
  if (!weightTotal) return;
  const color = total.map((value, channel) => Math.round(value / weightTotal * .38 + [18, 29, 47][channel]));
  player.style.setProperty("--player-tint", "rgb(" + color.join(", ") + ")");
}

function makeBackdrop(image) {
  // Store a tiny image so the moving player can be composited without a live blur.
  const canvas = document.createElement("canvas");
  canvas.width = 7;
  canvas.height = 9;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

function updateTrackMetadata(track, metadata) {
  if (track.metadata && (!metadata || isVideo(track))) return;
  const next = { title: metadata?.title, artist: metadata?.artist, album: metadata?.album };
  if (track.metadata && Object.keys(next).every((key) => next[key] === track.metadata[key])) return;
  track.metadata = next;
  if (metadata && !isVideo(track) && database && track.id !== undefined && track.busy !== "delete") {
    trackStore.updateDetails(database, track.id, (details) => { details.metadata = next; }).catch(() => {});
  }
  if (current === track) updateSelection();
}

async function showArtwork(track) {
  const request = ++artworkRequest;
  let pendingUrl;
  document.body.setAttribute("data-artwork-loading", "");
  try {
    const metadata = await readMediaMetadata(track);
    if (request !== artworkRequest) return;
    updateTrackMetadata(track, metadata);
    const cover = track.edits?.cover ?? track.sourceCover ?? (isVideo(track) ? await getVideoThumbnail(track) : metadata.artwork);
    if (request !== artworkRequest) return;
    if (!cover) {
      clearArtwork();
      setBackdrop(null);
      return;
    }
    // Decode before replacing the previous image, including when loading a smaller copy.
    const image = new Image();
    pendingUrl = URL.createObjectURL(cover);
    image.src = pendingUrl;
    await image.decode();
    if (request !== artworkRequest) return;
    if (Math.max(image.naturalWidth, image.naturalHeight) > 768) {
      const resized = await encodeCover(image).catch(() => null);
      if (request !== artworkRequest) return;
      if (resized) {
        URL.revokeObjectURL(pendingUrl);
        pendingUrl = URL.createObjectURL(resized);
        image.src = pendingUrl;
        await image.decode();
        if (request !== artworkRequest) return;
      }
    }
    const previousUrl = artworkUrl;
    artworkUrl = pendingUrl;
    artworkTrack = track;
    pendingUrl = null;
    for (const target of [artwork, miniArtwork, queueArtwork]) {
      target.src = artworkUrl;
      target.hidden = false;
    }
    if (isVideo(track)) {
      video.poster = artworkUrl;
      videoPoster.src = artworkUrl;
      videoPoster.hidden = false;
    }
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    document.body.removeAttribute("data-artwork-loading");
    updateMediaMetadata();
    try {
      tintPlayer(image);
    } catch {
      // Artwork can still be shown when pixel access is restricted.
    }
    const softImage = await makeBackdrop(image).catch(() => null);
    if (request === artworkRequest) setBackdrop(softImage);
  } catch {
    if (request === artworkRequest) {
      updateTrackMetadata(track, null);
      clearArtwork();
      setBackdrop(null);
    }
  } finally {
    if (pendingUrl) URL.revokeObjectURL(pendingUrl);
  }
}

function selectTrack(track, followQueue = false, scope, query = "", automatic = false) {
  if (!track) return;
  const folder = track.folder ?? null;
  if (!followQueue) {
    playbackFolder = folder;
    playbackQuery = query;
    queue.start(scope ?? folder?.tracks ?? rootTracks(), track);
  }
  const changed = current !== track;
  backgroundAdvance = null;
  if (changed) {
    loadTrack(track, null, automatic);
  } else if (media.ended || followQueue) {
    recordedCurrent = false;
    media.currentTime = 0;
  }
  playbackTracking = true;
  const playBeforeRender = automatic && media === audio;
  if (playBeforeRender) {
    if (document.hidden) backgroundAdvance = { track, checking: false };
    // Keep the audio hand-off in the media event before any artwork or list work.
    play();
  }
  if (automatic && changed) showArtwork(track);
  tellLibrary("");
  updateSelection();
  if (!playBeforeRender) play();
}

function loadTrack(track, position = null, automatic = false) {
  const videoTrack = isVideo(track);
  const audioType = videoAudioType(track);
  const nextMedia = videoTrack && !audioType ? video : audio;
  const keepAudioSource = automatic && media === audio && nextMedia === audio && Boolean(objectUrl);
  const previousUrl = keepAudioSource ? objectUrl : null;
  clearSource(videoTrack, keepAudioSource);
  current = track;
  media = nextMedia;
  recordedCurrent = false;
  resumePosition = position;
  video.muted = Boolean(audioType);
  // Start the audio element on the first tap so it can continue when iOS hides the video.
  if (audioType) {
    companionVideoUrl = URL.createObjectURL(track.blob);
    video.src = companionVideoUrl;
  }
  const source = audioType ? track.blob.slice(0, track.blob.size, audioType) : track.blob;
  objectUrl = URL.createObjectURL(source);
  media.src = objectUrl;
  if (previousUrl) URL.revokeObjectURL(previousUrl);
  if (!automatic) showArtwork(track);
}

function alignCompanionVideo() {
  if (!companionVideoUrl || document.hidden || video.readyState < 1 || video.seeking) return;
  const time = resumePosition ?? audio.currentTime;
  if (Math.abs(video.currentTime - time) > .25) video.currentTime = time;
}

function syncCompanionVideo() {
  if (!companionVideoUrl) return;
  if (document.hidden) {
    video.pause();
    return;
  }
  alignCompanionVideo();
  if (audio.paused || audio.ended || audio.error) video.pause();
  else if (video.paused) video.play().catch(() => {});
}
function move(offset, automatic = false) {
  if (!current) return false;
  const track = offset < 0 ? queue.back(current) : queue.forward(current);
  if (!track) return false;
  selectTrack(track, true, undefined, "", automatic);
  return true;
}

function advanceAfterEnd() {
  if (!current || !media.ended) return false;
  if (!move(1, true)) {
    syncCompanionVideo();
    updatePlayback();
    rememberPlayback();
  }
  return true;
}

function resumeAudioOnReturn() {
  if (document.hidden) return;
  if (media === audio && advanceAfterEnd()) return;
  const advance = backgroundAdvance;
  if (advance?.track !== current || advance.checking || media !== audio) return;
  if (audio.currentTime > .05 && !audio.paused) {
    backgroundAdvance = null;
    return;
  }
  advance.checking = true;
  play();
  const request = playRequest;
  setTimeout(() => {
    if (backgroundAdvance !== advance || request !== playRequest) return;
    advance.checking = false;
    if (document.hidden) return;
    backgroundAdvance = null;
    if (audio.currentTime > .05 && !audio.paused) return;
    audio.load();
    play();
  }, 2500);
}

function togglePlayback() {
  if (!current) return;
  backgroundAdvance = null;
  if (media.paused || media.ended || media.error) {
    if (media.ended) {
      recordedCurrent = false;
      media.currentTime = 0;
    }
    play();
  } else {
    pause();
  }
}

function pause() {
  ++playRequest;
  backgroundAdvance = null;
  media.pause();
  syncCompanionVideo();
}

function tellLibrary(message) {
  get("library-message").textContent = message;
}

function showSaveToast(saved, unit = "曲") {
  const toast = get("save-toast");
  clearTimeout(saveToastTimer);
  toast.textContent = saved + unit + "を追加して端末に保存しました。";
  toast.dataset.visible = "";
  saveToastTimer = setTimeout(() => {
    delete toast.dataset.visible;
  }, 5000);
}

function restoreHistory(savedTracks) {
  try {
    const ids = JSON.parse(localStorage.getItem(historyKey) || "[]");
    if (!Array.isArray(ids)) return;
    const entries = new Map(savedTracks.map((track) => [track.id, track]));
    queue.history = ids.map((id) => entries.get(id)).filter(Boolean).concat(queue.history).slice(-100);
  } catch {
    // Playback history is optional if browser storage is unavailable.
  }
}

function saveHistory() {
  if (!database) return;
  try {
    const ids = queue.history.filter((track) => track.id !== undefined).map((track) => track.id);
    localStorage.setItem(historyKey, JSON.stringify(ids));
  } catch {
    // Playback can continue with the history for this session.
  }
}

function rememberPlayback(updateQueue = false) {
  if (!playbackTracking) return;
  try {
    if (current?.id === undefined || current.busy === "delete") {
      if (updateQueue) {
        playbackSnapshot = null;
        localStorage.removeItem(playbackKey);
      }
      return;
    }
    if (updateQueue || playbackSnapshot?.id !== current.id) {
      const ids = (entries) => entries.flatMap((track) => track.id === undefined ? [] : [track.id]);
      playbackSnapshot = {
        id: current.id, query: playbackQuery, scope: ids(queue.scope),
        previous: ids(queue.previous), upcoming: ids(queue.upcoming),
        shuffled: queue.shuffled, repeat: queue.repeat,
      };
    }
    const position = resumePosition ?? (media.ended || !Number.isFinite(media.currentTime) ? 0 : media.currentTime);
    localStorage.setItem(playbackKey, JSON.stringify({ ...playbackSnapshot, position, recorded: recordedCurrent }));
    lastCheckpoint = performance.now();
  } catch {
    // A blocked or full browser store must never interrupt playback.
    lastCheckpoint = performance.now();
  }
}

function restorePlayback(saved) {
  if (current) return;
  let state;
  try {
    state = JSON.parse(localStorage.getItem(playbackKey));
  } catch {
    return;
  }
  const track = saved.get(state?.id);
  if (!track) return;
  const resolve = (ids) => Array.isArray(ids) ? ids.map((id) => saved.get(id)).filter(Boolean) : [];
  playbackFolder = track.folder ?? null;
  playbackQuery = typeof state.query === "string" ? state.query : "";
  queue.shuffled = state.shuffled === true;
  queue.repeat = state.repeat === true;
  const scope = resolve(state.scope);
  if (scope.includes(track)) {
    queue.scope = scope;
    queue.previous = resolve(state.previous);
    queue.upcoming = resolve(state.upcoming);
  } else {
    queue.start(playbackFolder?.tracks ?? rootTracks(), track);
  }
  loadTrack(track, Number.isFinite(state.position) ? Math.max(0, state.position) : 0);
  recordedCurrent = state.recorded === true && queue.history.at(-1) === track;
}

function applyResumePosition() {
  if (resumePosition === null || !Number.isFinite(media.duration) || media.duration <= 0) return;
  const position = Math.min(resumePosition, Math.max(0, media.duration - .05));
  try {
    if (position !== media.currentTime) media.currentTime = position;
    resumePosition = null;
  } catch {
    // Some browsers defer seeking until the media is ready or playback is requested.
  }
}

async function restoreTracks() {
  try {
    const connection = await trackStore.open();
    try {
      const [saved, layout, details] = await Promise.all([
        trackStore.run(connection, "readonly", (store) => store.getAll()),
        trackStore.run(connection, "readonly", (store) => store.get("library"), "settings"),
        trackStore.run(connection, "readonly", (store) => store.getAll(), "trackDetails"),
      ]);
      const savedById = new Map(saved.map((track) => [track.id, track]));
      for (const entry of details) {
        const track = savedById.get(entry.id);
        if (track) {
          track.edits = entry.edits;
          track.metadata = entry.metadata;
          track.plays = entry.plays;
          track.lastPlayed = entry.lastPlayed;
          track.videoThumbnail = entry.videoThumbnail;
          track.durationSeconds = entry.durationSeconds;
        }
      }
      if (layout) {
        const order = new Map(layout.order.map((id, index) => [id, index]));
        saved.sort((first, second) => (order.get(first.id) ?? Infinity) - (order.get(second.id) ?? Infinity) || first.id - second.id);
        customTrackOrder = order.size > 0;
        for (const { name, ids, cover, pcTransferId } of layout.folders) {
          const folder = { name, cover, pcTransferId, tracks: [] };
          for (const id of ids) {
            const track = savedById.get(id);
            if (!track || track.folder) continue;
            track.folder = folder;
            folder.tracks.push(track);
          }
          folders.push(folder);
        }
      }
      tracks.unshift(...saved);
      database = connection;
      restoreHistory(saved);
      restorePlayback(savedById);
    } catch (error) {
      connection.close();
      throw error;
    }
  } catch (error) {
    console.warn("保存した曲を読み込めませんでした。", error);
  } finally {
    filterLibrary();
  }
}

function libraryLayout(folderEdit, addedTrack, addedId, destination = addedTrack?.folder, removal) {
  const savedIds = (entries) => entries.flatMap((track) => {
    const id = track === addedTrack ? addedId : track.id;
    return id === undefined || removal?.tracks.has(track) ? [] : [id];
  });
  const order = customTrackOrder ? savedIds(tracks) : [];
  if (customTrackOrder && addedTrack && !tracks.includes(addedTrack)) order.push(addedId);
  const entries = removal ? folders.filter((folder) => !removal.folders.has(folder))
    : folderEdit && !folders.includes(folderEdit.folder) ? [...folders, folderEdit.folder] : folders;
  return {
    order,
    folders: entries.map((folder) => {
      const edit = folderEdit?.folder === folder ? folderEdit : null;
      const { name, cover } = edit ?? folder;
      const pcTransferId = edit?.pcTransferId ?? folder.pcTransferId;
      const members = edit?.tracks ?? folder.tracks;
      const ids = savedIds(addedTrack && folder !== destination ? members.filter((track) => track !== addedTrack) : members);
      if (addedTrack && destination === folder && !members.includes(addedTrack)) ids.push(addedId);
      return { name, ids, ...(cover && { cover }), ...(pcTransferId && { pcTransferId }) };
    }),
  };
}

function writeLibraryLayout(folderEdit) {
  const layout = libraryLayout(folderEdit);
  return trackStore.run(database, "readwrite", (store) => store.put(layout, "library"), "settings");
}

function persistLibrary() {
  if (!database) return;
  return writeLibraryLayout()
    .catch(() => tellLibrary("フォルダや曲順の変更を端末に保存できませんでした。"));
}

function trackFeedback(track, message) {
  tellLibrary(message);
  if (document.body.dataset.view === "player" && track === current) tellPlayer(message);
}

async function saveTrack(track) {
  if (!database || track.busy || track.id !== undefined) return;
  track.busy = "save";
  renderTracks();
  trackFeedback(track, "「" + trackTitle(track) + "」を端末に保存しています…");
  try {
    await persistTrack(track);
    if (customTrackOrder && !track.folder) persistLibrary();
    trackFeedback(track, "「" + trackTitle(track) + "」を端末に保存しました。");
  } catch (error) {
    trackFeedback(track, error?.name === "QuotaExceededError"
      ? "保存容量が足りません。不要な保存済みの曲を削除してからお試しください。"
      : "端末に保存できませんでした。曲を選び直してお試しください。");
  } finally {
    track.busy = null;
    renderTracks();
  }
}

async function persistTrack(track) {
  const { blob, title, filename, addedAt, format, sourceCover } = track;
  const entry = { blob, title, filename, addedAt, format, ...(sourceCover && { sourceCover }) };
  const { edits, plays, lastPlayed, videoThumbnail, metadata, durationSeconds } = track;
  const layoutForTrack = track.folder ? (id) => libraryLayout(null, track, id) : undefined;
  track.id = layoutForTrack || edits || plays || videoThumbnail || metadata || durationSeconds
    ? await trackStore.saveMedia(database, entry, { edits, plays, lastPlayed, videoThumbnail, metadata, durationSeconds }, layoutForTrack)
    : await trackStore.run(database, "readwrite", (store) => store.add(entry));
  if (queue.history.includes(track)) saveHistory();
}

async function saveDownloadedMedia(blob, filename, format, sourceCover, edits, folder = null) {
  await storageReady;
  if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
  if (folder && !folders.includes(folder)) throw new Error("保存先のフォルダを開き直してお試しください。");
  const title = filename.slice(0, -(format.length + 1));
  const track = { blob, title, filename, format, addedAt: Date.now(), sourceCover, edits, folder };
  try {
    await persistTrack(track);
  } catch (error) {
    throw new Error(error?.name === "QuotaExceededError"
      ? "端末の空き容量が足りません。空き容量を増やしてお試しください。"
      : "端末に保存できませんでした。音棚を開き直してお試しください。");
  }
  addSavedMediaToLibrary(track);
  showSaveToast(1, format === "mp4" ? "件" : "曲");
}

function addSavedMediaToLibrary(track) {
  tracks.push(track);
  track.folder?.tracks.push(track);
  if (current && (track.folder ?? null) === playbackFolder && !playbackQuery) queue.append([track]);
  if (customTrackOrder && !track.folder) persistLibrary();
  search.value = "";
  tellLibrary("");
  filterLibrary();
}

async function savePCTrack({ blob, title, filename, format, pcTransferId, addedAt, sourceCover, edits, metadata, plays, lastPlayed, videoThumbnail, durationSeconds }, folder) {
  await storageReady;
  if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
  const existing = blob ? null : tracks.find((track) => track.pcTransferId === pcTransferId);
  if (existing) {
    await existing.preview;
    await existing.videoThumbnailRequest;
  }
  const entry = { ...(blob && { blob }), title, filename, format, pcTransferId, addedAt: addedAt ?? Date.now(), sourceCover };
  const details = { edits, metadata, plays, lastPlayed, videoThumbnail, durationSeconds };
  const track = existing ?? { ...entry, ...details, folder };
  const layoutForTrack = folder ? (id) => libraryLayout(null, track, id, folder) : undefined;
  let id;
  try {
    id = await trackStore.saveMedia(database, entry, details, layoutForTrack);
  } catch (error) {
    if (error?.name === "ConstraintError") return false;
    throw new Error(error?.name === "QuotaExceededError"
      ? "端末の空き容量が足りません。保存済みの項目はライブラリに残っています。"
      : "端末に保存できませんでした。音棚を開き直してお試しください。");
  }
  if (id === undefined) throw new Error("同期中に受け取り先の曲が削除されました。もう一度送信してください。");
  if (blob) {
    track.id = id;
    addSavedMediaToLibrary(track);
  } else if (existing && tracks.includes(existing)) {
    if (folder && existing.folder !== folder) moveIntoFolder([existing], folder, false);
    if (existing.thumbnail) URL.revokeObjectURL(existing.thumbnail);
    Object.assign(existing, entry, details, { thumbnail: null, videoThumbnailRequest: null });
    existing.preview = loadTrackPreview(existing);
    filterLibrary();
    if (current === existing) {
      updateSelection();
      showArtwork(existing);
    } else if (player.dataset.queue === "true") {
      renderQueue();
    }
  }
  return true;
}

async function savePCFolder({ name, cover, pcTransferId }) {
  await storageReady;
  if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
  const existing = folders.find((folder) => folder.pcTransferId === pcTransferId);
  const folder = existing ?? { tracks: [] };
  await writeLibraryLayout({ folder, name, cover, pcTransferId });
  if (folder.coverUrl && folder.cover !== cover) {
    URL.revokeObjectURL(folder.coverUrl);
    folder.coverUrl = null;
  }
  Object.assign(folder, { name, cover, pcTransferId });
  if (!existing) folders.push(folder);
  if (activeFolder === folder) get("library-title").textContent = name;
  renderTracks();
  return folder;
}

async function orderPCFolder(folder, ids) {
  const byId = new Map(folder.tracks.map((track) => [track.pcTransferId, track]));
  const ordered = new Set(ids.map((id) => byId.get(id)).filter(Boolean));
  const tracks = Array.from(new Set([...ordered, ...folder.tracks]));
  if (tracks.every((track, index) => track === folder.tracks[index])) return;
  await writeLibraryLayout({ folder, name: folder.name, cover: folder.cover, tracks });
  folder.tracks = tracks;
  if (playbackFolder === folder && current) {
    const scope = matchingTracks(tracks, playbackQuery);
    if (queue.shuffled) queue.updateScope(scope);
    else queue.start(scope, current);
  }
  renderTracks();
}

async function saveImportedTracks(added, invalid) {
  await storageReady;
  let saved = 0;
  let full = false;
  for (const track of added) {
    try {
      if (database) {
        await persistTrack(track);
        ++saved;
      }
    } catch (error) {
      full ||= error?.name === "QuotaExceededError";
    } finally {
      track.busy = null;
    }
    // On quota failure, a smaller file in the same batch can still fit.
  }
  if (saved && customTrackOrder && added.some((track) => !track.folder)) persistLibrary();
  renderTracks();
  const failed = added.length - saved;
  const message = [
    failed ? failed + "曲は端末に保存できませんでした。この画面では再生できます。" : "",
    failed && (full ? "空き容量を増やしてから「端末に保存」で再試行できます。" :
      database ? "曲の「端末に保存」から再試行できます。" : "音棚を開き直してから再試行してください。"),
    invalid ? invalid + "件は追加できませんでした。対応する音楽・動画ファイルを選んでください。" : "",
  ];
  tellLibrary(message.filter(Boolean).join(" "));
  if (saved) showSaveToast(saved);
}

async function deleteLibraryItems({ entries, folderMembers }) {
  for (const [folder, members] of folderMembers) {
    if (!folders.includes(folder) || folder.tracks.length !== members.size || folder.tracks.some((track) => !members.has(track))) {
      tellLibrary("フォルダの内容が変わりました。削除する項目をもう一度選んでください。");
      return false;
    }
  }
  if (entries.some((track) => track.busy || !tracks.includes(track))) {
    tellLibrary("処理中の曲が含まれています。完了後にもう一度お試しください。");
    return false;
  }
  const savedIds = entries.filter((track) => track.id !== undefined).map((track) => track.id);
  const removed = new Set(entries);
  for (const track of entries) track.busy = "delete";
  try {
    const layout = database && (customTrackOrder || folders.length)
      ? libraryLayout(null, undefined, undefined, undefined, { tracks: removed, folders: folderMembers }) : undefined;
    if (savedIds.length || layout) await trackStore.deleteTracks(database, savedIds, layout);
  } catch {
    for (const track of entries) track.busy = null;
    tellLibrary("選んだ項目を削除できませんでした。アプリを開き直してからお試しください。");
    return false;
  }
  for (const track of entries) {
    queue.remove(track, current === track);
    if (track.thumbnail) URL.revokeObjectURL(track.thumbnail);
  }
  saveHistory();
  if (removed.has(current)) {
    clearSource();
    clearArtwork();
    setBackdrop(null);
    current = null;
    playbackTracking = true;
    rememberPlayback(true);
    playbackTracking = false;
    recordedCurrent = false;
    tellPlayer("");
    showView("library");
  }
  for (let index = tracks.length - 1; index >= 0; --index) {
    if (removed.has(tracks[index])) tracks.splice(index, 1);
  }
  for (const folder of folderMembers.keys()) {
    if (folder.coverUrl) URL.revokeObjectURL(folder.coverUrl);
    folders.splice(folders.indexOf(folder), 1);
  }
  for (const folder of folders) folder.tracks = folder.tracks.filter((track) => !removed.has(track));
  if (folderMembers.has(playbackFolder)) playbackFolder = null;
  clearEditedTracks(entries);
  renderTracks();
  const description = folderMembers.size
    ? [`${folderMembers.size}フォルダ`, ...(entries.length ? [deletionMediaCount(entries)] : [])].join("と")
    : entries.length === 1 ? `「${trackTitle(entries[0])}」` : deletionMediaCount(entries);
  tellLibrary(description + "を音棚から削除しました。");
  return true;
}

function deletionMediaCount(entries) {
  return entries.some(isVideo) ? `${entries.length}件の曲・動画` : `${entries.length}曲`;
}

function confirmDeletion(individualTracks, selectedFolders = []) {
  if ((!individualTracks.length && !selectedFolders.length) || deleteDialog.open) return;
  const folderMembers = new Map(selectedFolders.map((folder) => [folder, new Set(folder.tracks)]));
  const nested = [...new Set(selectedFolders.flatMap((folder) => folder.tracks))];
  const entries = [...new Set([...individualTracks, ...nested])];
  if (entries.some((track) => track.busy)) return;
  const folderName = selectedFolders.length === 1 ? `「${selectedFolders[0].name}」` : `${selectedFolders.length}フォルダ`;
  const folderText = nested.length ? `${folderName}と、フォルダ内の${deletionMediaCount(nested)}をすべて削除します。`
    : `${folderName}を削除します。フォルダ内の曲・動画は0件です。`;
  pendingDeletion = { entries, folderMembers, saving: false };
  get("delete-song").textContent = selectedFolders.length
    ? folderText + (individualTracks.length ? ` 個別に選んだ${deletionMediaCount(individualTracks)}も削除します。` : "")
    : entries.length > 1 || trackSelection?.mode === "delete" ? deletionMediaCount(entries) + "を音棚から削除します。"
    : `「${trackTitle(entries[0])}」を音棚から削除します。`;
  deleteDialog.showModal();
}

function setDeleteMode(enabled) {
  deleting = enabled;
  editSelection = enabled ? { chosen: new Set(), anchor: null } : null;
  list.toggleAttribute("data-deleting", enabled);
  folderList.toggleAttribute("data-deleting", enabled);
  deleteMode.setAttribute("aria-pressed", String(enabled));
  deleteMode.setAttribute("aria-label", enabled ? "編集を完了" : "曲を編集");
  cancelLibraryGesture();
  for (const row of list.children) updateSelectionRow(row);
}

function editedTracksFor(track) {
  if (!editSelection?.chosen.has(track)) return [track];
  return visibleLibraryTracks().filter((item) => editSelection.chosen.has(item));
}

function clearEditedTracks(entries) {
  if (!editSelection) return;
  for (const track of entries) editSelection.chosen.delete(track);
  if (entries.includes(editSelection.anchor)) editSelection.anchor = null;
}

function showTrackMenuActions(...ids) {
  for (const button of menuActions) button.hidden = !ids.includes(button.id);
  menu.showModal();
}

function openTrackMenu(track) {
  if (!track || menu.open) return;
  menuTrack = track;
  const entries = editedTracksFor(track);
  const multiple = entries.length > 1;
  const busy = entries.some((item) => item.busy);
  get("menu-title").textContent = multiple ? entries.length + "曲を選択中" : trackTitle(track);
  const saved = track.id !== undefined;
  get("menu-status").textContent = multiple ? "" : saved ? "端末に保存済み" : "このセッションで再生できます";
  get("menu-save").disabled = !database || Boolean(track.busy);
  get("menu-details").disabled = (editSelection?.chosen.size ?? 0) > 1;
  get("menu-delete").disabled = busy;
  get("menu-move-out").disabled = busy;
  showTrackMenuActions("menu-details", "menu-delete", ...(!multiple && !saved ? ["menu-save"] : []), ...(track.folder ? ["menu-move-out"] : []));
}

function closeTrackMenu(afterClose) {
  if (!menu.open || menu.hasAttribute("data-closing")) return;
  const finish = () => {
    menu.close();
    menu.removeAttribute("data-closing");
    menuTrack = null;
    menuFolder = null;
    afterClose?.();
  };
  if (reducedMotion.matches) finish();
  else {
    menu.setAttribute("data-closing", "");
    setTimeout(finish, 170);
  }
}

function displayDetailsDate(value) {
  return value ? new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(value) : "—";
}

function updateDetailsStats(track) {
  get("details-plays").textContent = (track.plays ?? 0).toLocaleString("ja") + "回";
  get("details-last").textContent = displayDetailsDate(track.lastPlayed);
}

function previewDetailsCover(draft) {
  if (detailsCoverUrl) URL.revokeObjectURL(detailsCoverUrl);
  const image = get("details-artwork");
  const cover = draft.cover ?? draft.originalCover;
  detailsCoverUrl = cover ? URL.createObjectURL(cover) : null;
  if (detailsCoverUrl) image.src = detailsCoverUrl;
  else image.removeAttribute("src");
  image.hidden = !detailsCoverUrl;
  get("details-reset-cover").hidden = !draft.cover;
}

function rememberTrackDuration(track, seconds) {
  if (!track || !Number.isFinite(seconds) || seconds <= 0) return null;
  if (track.durationSeconds !== seconds) {
    track.durationSeconds = seconds;
    if (database && track.id !== undefined && track.busy !== "delete") {
      trackStore.updateDetails(database, track.id, (details) => { details.durationSeconds = seconds; }).catch(() => {});
    }
  }
  return seconds;
}

async function readTrackDuration(track, signal) {
  if (signal.aborted) return null;
  const activeDuration = current === track ? rememberTrackDuration(track, media.duration) : null;
  if (activeDuration ?? track.durationSeconds) return activeDuration ?? track.durationSeconds;
  return new Promise((resolve) => {
    const probe = document.createElement(isVideo(track) ? "video" : "audio");
    const url = URL.createObjectURL(track.blob);
    const finish = () => {
      const seconds = signal.aborted ? null : rememberTrackDuration(track, probe.duration);
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      probe.onloadedmetadata = probe.onerror = null;
      probe.removeAttribute("src");
      probe.load();
      URL.revokeObjectURL(url);
      resolve(seconds);
    };
    const timer = setTimeout(finish, 5000);
    signal.addEventListener("abort", finish, { once: true });
    probe.preload = "metadata";
    probe.onloadedmetadata = probe.onerror = finish;
    probe.src = url;
  });
}

async function openTrackDetails(track) {
  if (!tracks.includes(track) || detailsDialog.open) return;
  const draft = { track, entries: track.folder?.tracks ?? rootTracks(), cover: track.edits?.cover ?? null,
    coverRequest: 0, durationLookup: new AbortController() };
  detailsDraft = draft;
  get("details-form").reset();
  get("details-message").textContent = "";
  get("details-duration").textContent = "—";
  get("details-added").textContent = displayDetailsDate(track.addedAt);
  get("details-file").textContent = track.filename ?? track.title + ".mp3";
  const size = track.blob.size;
  const unit = size >= 1_000_000 ? "MB" : "KB";
  const amount = new Intl.NumberFormat("ja", { maximumFractionDigits: 2 }).format(size / (unit === "MB" ? 1_000_000 : 1000));
  get("details-size").textContent = (track.format ?? "mp3").toUpperCase() + " · " + amount + " " + unit;
  updateDetailsStats(track);
  previewDetailsCover(draft);
  get("details-name").value = trackTitle(track);
  get("details-artist").value = trackArtist(track);
  get("details-album").value = trackAlbum(track);
  get("details-form").inert = true;
  detailsImage.disabled = true;
  detailsDialog.showModal();
  loadDetailsChoices(draft);
  readTrackDuration(track, draft.durationLookup.signal).then((duration) => {
    if (detailsDraft === draft && duration !== null) get("details-duration").textContent = formatTime(duration);
  });
  const metadata = await readMediaMetadata(track).catch(() => null);
  if (detailsDraft !== draft) return;
  updateTrackMetadata(track, metadata);
  draft.originalCover = track.sourceCover ?? (isVideo(track) ? await getVideoThumbnail(track) : metadata?.artwork);
  if (detailsDraft !== draft) return;
  previewDetailsCover(draft);
  get("details-name").value = trackTitle(track);
  get("details-artist").value = trackArtist(track);
  get("details-album").value = trackAlbum(track);
  get("details-form").inert = false;
  detailsSave.disabled = Boolean(track.busy);
  detailsImage.disabled = Boolean(track.busy);
}

async function encodeCover(image) {
  const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .87));
  if (!blob) throw new Error("Artwork encoding failed");
  return blob;
}

async function resizeCover(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return await encodeCover(image);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function recordPlay(track) {
  const time = Date.now();
  track.plays = (track.plays ?? 0) + 1;
  track.lastPlayed = time;
  if (detailsDraft?.track === track) updateDetailsStats(track);
  if (track.folder && folderDetailsDraft?.folder === track.folder) updateFolderPlayStats(track.folder);
  if (track.id !== undefined && track.busy !== "delete") {
    trackStore.updateDetails(database, track.id, (details) => {
      details.plays = (details.plays ?? 0) + 1;
      details.lastPlayed = Math.max(time, details.lastPlayed ?? 0);
    }).catch(() => {});
  }
}

function loadTrackPreview(track) {
  track.previewReady = false;
  const preview = previewQueue.then(() => tracks.includes(track) ? decodeTrackPreview(track) : undefined)
    .finally(() => { track.previewReady = true; });
  previewQueue = preview;
  return preview;
}

async function decodeTrackPreview(track) {
  try {
    const metadata = await readMediaMetadata(track);
    updateTrackMetadata(track, metadata);
    const cover = track.edits?.cover ?? track.sourceCover ?? (isVideo(track) ? await getVideoThumbnail(track) : metadata.artwork);
    if (!cover || !tracks.includes(track)) return;
    if (cover === track.videoThumbnail) {
      track.thumbnail = URL.createObjectURL(cover);
      return;
    }
    const image = new Image();
    const url = URL.createObjectURL(cover);
    try {
      image.src = url;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 96;
      const context = canvas.getContext("2d");
      if (!context) return;
      const side = Math.min(image.naturalWidth, image.naturalHeight);
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2,
        side, side, 0, 0, 96, 96);
      const thumbnail = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .83));
      if (thumbnail && tracks.includes(track)) track.thumbnail = URL.createObjectURL(thumbnail);
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    // Unreadable metadata does not prevent playback.
    updateTrackMetadata(track, null);
  }
}

function getVideoThumbnail(track) {
  if (track.videoThumbnail) return track.videoThumbnail;
  track.videoThumbnailRequest ??= readVideoThumbnail(track.blob).then((thumbnail) => {
    if (!thumbnail || !tracks.includes(track)) return null;
    track.videoThumbnail = thumbnail;
    if (track.id !== undefined && track.busy !== "delete" && database) {
      trackStore.updateDetails(database, track.id, (details) => {
        details.videoThumbnail = thumbnail;
      }).catch(() => {});
    }
    return thumbnail;
  }).catch(() => null);
  return track.videoThumbnailRequest;
}

function updateTrackRow(row) {
  const track = row.track;
  const title = displayTrackTitle(track);
  row.querySelector(".track-name").textContent = title;
  const artist = row.querySelector(".track-artist");
  artist.textContent = trackArtist(track) || trackAlbum(track);
  artist.hidden = !artist.textContent;
  row.querySelector(".more").setAttribute("aria-label", title + "の操作");
  row.querySelector(".library-handle").setAttribute("aria-label", title + "を並べ替え");
  const image = row.querySelector("img");
  image.parentElement.toggleAttribute("data-loading", !track.previewReady && !track.thumbnail);
  if (track.thumbnail) image.src = track.thumbnail;
  image.hidden = !track.thumbnail;
}

function prepareTrackRow(row) {
  const track = row.track;
  track.preview ??= loadTrackPreview(track);
  track.preview.then(() => {
    if (row.isConnected) updateTrackRow(row);
  });
}

const thumbnailObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    thumbnailObserver.unobserve(entry.target);
    if (entry.target.classList.contains("folder-icon")) showTrackThumbnail(entry.target);
    else prepareTrackRow(entry.target);
  }
}, { rootMargin: "64px" }) : null;

function containsQuery(value, query) {
  return value.normalize("NFKC").toLocaleLowerCase("ja").includes(query);
}

function metadataChoices(entries, readValue) {
  const values = new Set(entries.map((track) => readValue(track).trim()).filter(Boolean));
  return Array.from(values).sort((a, b) => a.localeCompare(b, "ja"));
}

function ensureSearchMetadata(track) {
  if (track.metadata || !tracks.includes(track)) return;
  track.searchMetadata ??= track.preview ?? readMediaMetadata(track, false)
    .then((metadata) => updateTrackMetadata(track, metadata))
    .catch(() => updateTrackMetadata(track, null));
  return track.searchMetadata;
}

async function loadDetailsChoices(draft) {
  for (const track of draft.entries) {
    if (detailsDraft !== draft || !detailsDialog.open) return;
    await ensureSearchMetadata(track);
  }
  if (detailsDraft === draft && detailsDialog.open) {
    for (const field of detailsSuggestions) field.render();
  }
}

function showSuggestions(input, suggestions, options) {
  suggestions.replaceChildren(...options.map(({ value, label }, index) => {
    const item = document.createElement("li");
    item.id = `${suggestions.id}-${index}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", "false");
    item.dataset.value = value;
    const name = document.createElement("span");
    name.textContent = value;
    item.append(name);
    if (label) {
      const kind = document.createElement("small");
      kind.textContent = label;
      item.append(kind);
    }
    return item;
  }));
  suggestions.hidden = !options.length;
  input.removeAttribute("aria-activedescendant");
  input.setAttribute("aria-expanded", String(!suggestions.hidden));
}

function hideSuggestions(input, suggestions) {
  suggestions.hidden = true;
  input.removeAttribute("aria-activedescendant");
  input.setAttribute("aria-expanded", "false");
}

function handleSuggestionKeys(event, suggestions, open, hide, choose) {
  if (event.isComposing) return;
  const input = event.currentTarget;
  if (event.key === "Escape" && !suggestions.hidden) {
    event.preventDefault();
    hide();
    return;
  }
  const options = Array.from(suggestions.children);
  const index = options.findIndex((item) => item.id === input.getAttribute("aria-activedescendant"));
  if (event.key === "Enter" && index >= 0 && !suggestions.hidden) {
    event.preventDefault();
    choose(options[index]);
  } else if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    if (suggestions.hidden) open();
    const { children } = suggestions;
    if (!children.length || suggestions.hidden) return;
    event.preventDefault();
    options[index]?.setAttribute("aria-selected", "false");
    const next = event.key === "ArrowDown" ? index + 1 : (index < 0 ? -1 : index - 1);
    const selected = children[(next + children.length) % children.length];
    selected.setAttribute("aria-selected", "true");
    input.setAttribute("aria-activedescendant", selected.id);
    selected.scrollIntoView({ block: "nearest" });
  }
}

function renderSearchSuggestions() {
  if (!searchSuggestionsOpen) return;
  const entries = visibleLibraryTracks();
  const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
  const groups = [["アーティスト", trackArtist]];
  if (query) groups.push(["アルバム", trackAlbum]);
  const options = [];
  for (const [label, readValue] of groups) {
    for (const value of metadataChoices(entries, readValue)) {
      if (containsQuery(value, query)) options.push({ value, label });
    }
  }
  showSuggestions(search, searchSuggestions, options);
}

function hideSearchSuggestions() {
  searchSuggestionsOpen = false;
  hideSuggestions(search, searchSuggestions);
}

function chooseSearchSuggestion(item) {
  search.value = item.dataset.value;
  hideSearchSuggestions();
  search.blur();
  filterLibrary();
}

async function openSearchSuggestions() {
  if (searchSuggestionsOpen) return;
  searchSuggestionsOpen = true;
  renderSearchSuggestions();
  const entries = visibleLibraryTracks();
  for (const track of entries) {
    if (!searchSuggestionsOpen || visibleLibraryTracks()[0] !== entries[0]) return;
    await ensureSearchMetadata(track);
  }
  renderSearchSuggestions();
}

function rootTracks() {
  return tracks.filter((track) => !track.folder);
}

function visibleLibraryTracks() {
  return activeFolder?.tracks ?? rootTracks();
}

function matchingTracks(entries, query) {
  return entries.filter((track) => !query || [track.title, trackTitle(track), trackArtist(track), trackAlbum(track)]
    .some((value) => value && containsQuery(value, query)));
}

function selectionRange(entries, anchor, target) {
  const first = entries.indexOf(anchor);
  const last = entries.indexOf(target);
  if (first < 0 || last < 0) return [];
  return entries.slice(Math.min(first, last), Math.max(first, last) + 1);
}

function moveIntoFolder(entries, folder, saveLayout = true) {
  for (const track of entries) {
    if (track.folder) track.folder.tracks = track.folder.tracks.filter((entry) => entry !== track);
    track.folder = folder;
    if (folder) folder.tracks.push(track);
  }
  clearEditedTracks(entries);
  if (current) {
    const folder = current.folder ?? null;
    if (folder !== playbackFolder) {
      playbackFolder = folder;
      const scope = matchingTracks(folder?.tracks ?? rootTracks(), playbackQuery);
      queue.start(scope.includes(current) ? scope : [current], current);
    } else {
      const available = folder?.tracks ?? rootTracks();
      queue.updateScope(playbackQuery ? available.filter((track) => queue.scope.includes(track)) : available);
    }
  }
  if (saveLayout) return persistLibrary();
}

function showFolder(folder) {
  if (folder === activeFolder) return;
  libraryNavigation?.cancel();
  activeFolder = folder;
  if (deleting) setDeleteMode(false);
  get("library-title").textContent = folder?.name ?? "ライブラリ";
  get("folder-back").hidden = !folder;
  get("library-title").tabIndex = -1;
  get("library-title").focus({ preventScroll: true });
  libraryScrollArea().scrollTop = 0;
  search.value = "";
  tellLibrary("");
  filterLibrary();
  if (!reducedMotion.matches) {
    libraryNavigation = libraryContent.animate([
      { transform: `translateX(${folder ? 32 : -24}px)`, opacity: .45 },
      { transform: "translateX(0)", opacity: 1 },
    ], { duration: 260, easing: "cubic-bezier(.22,.8,.24,1)" });
  }
}

function openFolderMenu(folder) {
  if (menu.open) return;
  menuFolder = folder;
  get("menu-title").textContent = folder.name;
  get("menu-status").textContent = folder.tracks.length + " 曲";
  get("menu-rename-folder").disabled = !database;
  get("menu-delete-folder").disabled = folder.tracks.some((track) => track.busy);
  showTrackMenuActions("menu-add", "menu-folder-details", "menu-rename-folder", ...(deleting ? ["menu-delete-folder"] : []));
}

function updateFolderPlayStats(folder) {
  let plays = 0;
  let lastPlayed = 0;
  for (const track of folder.tracks) {
    plays += track.plays ?? 0;
    lastPlayed = Math.max(lastPlayed, track.lastPlayed ?? 0);
  }
  get("folder-details-plays").textContent = plays.toLocaleString("ja") + "回";
  get("folder-details-last").textContent = displayDetailsDate(lastPlayed);
}

async function showFolderDuration(draft) {
  const { durationLookup: { signal }, entries } = draft;
  const label = get("folder-details-duration");
  let total = 0;
  let unknown = 0;
  for (const [index, track] of entries.entries()) {
    label.textContent = `確認中… ${index + 1} / ${entries.length}`;
    const duration = await readTrackDuration(track, signal);
    if (signal.aborted) return;
    if (duration === null) unknown++;
    else total += duration;
  }
  const hours = Math.floor(total / 3600);
  const time = hours ? `${hours}:${formatTime(total % 3600).padStart(5, "0")}` : formatTime(total);
  label.textContent = unknown ? `${time}（確認できた分、未確認 ${unknown} 件）` : time;
  if (unknown && unknown === entries.length) label.textContent = "確認できませんでした";
}

async function previewFolderCover(draft) {
  if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  const cover = draft.cover;
  draft.previewUrl = cover ? URL.createObjectURL(cover) : null;
  const image = get("folder-details-artwork");
  get("folder-details-reset").hidden = !cover;
  if (draft.previewUrl) {
    image.src = draft.previewUrl;
    image.hidden = false;
    return;
  }
  image.removeAttribute("src");
  image.hidden = true;
  const first = draft.entries[0];
  if (!first) return;
  first.preview ??= loadTrackPreview(first);
  await first.preview;
  if (folderDetailsDraft !== draft || !folderDetailsDialog.open || draft.cover || !first.thumbnail) return;
  image.src = first.thumbnail;
  image.hidden = false;
}

function updateFolderEditorControls(draft) {
  folderDetailsSave.disabled = !database || draft.loadingCover || draft.saving;
  for (const element of [folderDetailsName, folderDetailsImage, folderCoverTrack, get("folder-details-reset"), folderDetailsClose]) {
    element.disabled = draft.saving;
  }
}

function openFolderDetails(folder) {
  if (!folders.includes(folder) || folderDetailsDialog.open) return;
  const entries = [...folder.tracks];
  const draft = {
    folder, entries, cover: folder.cover ?? null, coverRequest: 0, loadingCover: false, saving: false,
    durationLookup: new AbortController(),
  };
  folderDetailsDraft = draft;
  folderDetailsName.value = folder.name;
  folderDetailsName.setCustomValidity("");
  folderDetailsMessage.textContent = "";
  folderCoverTrack.replaceChildren(new Option("フォルダ内の曲から選ぶ", ""),
    ...entries.map((track, index) => new Option(trackTitle(track), String(index))));
  folderCoverTrack.hidden = !entries.length;
  const videos = entries.filter(isVideo).length;
  get("folder-details-count").textContent = `音楽 ${entries.length - videos} 曲 · 動画 ${videos} 件`;
  get("folder-details-size").textContent = displayDownloadSize(folderSize(folder));
  updateFolderPlayStats(folder);
  updateFolderEditorControls(draft);
  fitFolderEditor();
  folderViewport?.addEventListener("resize", fitFolderEditor);
  folderViewport?.addEventListener("scroll", fitFolderEditor);
  folderDetailsDialog.showModal();
  previewFolderCover(draft);
  showFolderDuration(draft);
}

async function changeFolderCover(loadCover, errorMessage) {
  const draft = folderDetailsDraft;
  if (!draft || draft.saving) return;
  const request = ++draft.coverRequest;
  const isLatest = () => folderDetailsDraft === draft && folderDetailsDialog.open && request === draft.coverRequest;
  draft.loadingCover = true;
  folderDetailsMessage.textContent = "";
  updateFolderEditorControls(draft);
  try {
    const cover = await loadCover();
    if (!isLatest()) return;
    if (!cover) {
      folderDetailsMessage.textContent = errorMessage;
      return;
    }
    draft.cover = cover;
    previewFolderCover(draft);
  } catch {
    if (isLatest()) folderDetailsMessage.textContent = errorMessage;
  } finally {
    if (isLatest()) {
      draft.loadingCover = false;
      updateFolderEditorControls(draft);
    }
  }
}

function openLibraryMenu() {
  if (menu.open) return;
  const available = visibleLibraryTracks();
  get("menu-title").textContent = activeFolder ? activeFolder.name + "の設定" : "ライブラリの設定";
  get("menu-status").textContent = available.length + " 曲";
  get("menu-bulk-out").disabled = !available.length;
  const canDeleteFolder = !activeFolder && folders.some((folder) => folder.tracks.every((track) => !track.busy));
  get("menu-bulk-delete").disabled = !canDeleteFolder && !available.some((track) => !track.busy);
  showTrackMenuActions("menu-bulk-delete", ...(activeFolder ? ["menu-bulk-out"] : []));
}

function libraryMediaSize(bytes) {
  const label = document.createElement("span");
  label.className = "library-media-size";
  label.textContent = bytes ? displayDownloadSize(bytes) : "0 MB";
  return label;
}

function folderSize(folder) {
  return folder.tracks.reduce((total, track) => total + track.blob.size, 0);
}

function renderFolders(query) {
  folderList.replaceChildren();
  if (activeFolder || (trackSelection && trackSelection.mode !== "delete")) return;
  for (const folder of folders) {
    if (query && !containsQuery(folder.name, query)) continue;
    const row = document.createElement("li");
    row.className = "track folder-row";
    row.folder = folder;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "track-select";
    open.innerHTML = '<span class="thumb folder-icon" aria-hidden="true"><img alt="" hidden></span><span class="track-copy"><span class="track-name"></span><span class="track-artist"></span></span>';
    open.querySelector(".track-name").textContent = folder.name;
    open.querySelector(".track-artist").textContent = folder.tracks.length + " 曲";
    open.addEventListener("click", (event) => {
      if (trackSelection?.mode === "delete") selectLibraryRow(row, event);
      else showFolder(folder);
    });
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "•••";
    more.setAttribute("aria-label", folder.name + "の操作");
    more.addEventListener("click", () => openFolderMenu(folder));
    const actions = document.createElement("div");
    actions.className = "folder-actions";
    actions.append(more, libraryMediaSize(folderSize(folder)));
    row.append(open, actions);
    if (trackSelection?.mode === "delete") updateSelectionRow(row);
    folderList.append(row);
    const thumbnail = open.querySelector(".folder-icon");
    const first = folder.tracks[0];
    if (folder.cover) {
      folder.coverUrl ??= URL.createObjectURL(folder.cover);
      thumbnail.firstElementChild.src = folder.coverUrl;
      thumbnail.firstElementChild.hidden = false;
    } else if (first) {
      thumbnail.track = first;
      if (first.thumbnail || !thumbnailObserver) showTrackThumbnail(thumbnail);
      else thumbnailObserver.observe(thumbnail);
    }
  }
}

function setTrackSelection(mode, folder = activeFolder) {
  trackSelection = mode ? { folder, mode, chosen: new Set(), anchor: null } : null;
  get("selection-cancel").disabled = false;
  selectionBar.hidden = !mode;
  selectionTitle.hidden = !mode;
  if (mode) {
    setDeleteMode(false);
    tellLibrary("");
    selectionTitle.textContent = { add: "フォルダへ一括追加", remove: "フォルダから一括で出す", delete: "一括削除" }[mode];
    selectionConfirm.textContent = mode === "delete" ? "削除" : "確定";
    selectionConfirm.classList.toggle("action-danger", mode === "delete");
    list.dataset.selecting = mode;
    libraryScrollArea().scrollTop = 0;
  } else {
    delete list.dataset.selecting;
  }
  if (mode === "delete") folderList.dataset.selecting = mode;
  else delete folderList.dataset.selecting;
  search.value = "";
  filterLibrary();
  (mode ? get("selection-cancel") : librarySettings).focus({ preventScroll: true });
}

function updateSelectionRow(row) {
  const button = row.querySelector(".track-select");
  const selection = trackSelection ?? editSelection;
  const selected = Boolean(selection?.chosen.has(row.track ?? row.folder));
  row.toggleAttribute("data-selected", selected);
  if (selection) button.setAttribute("aria-pressed", String(selected));
  else button.removeAttribute("aria-pressed");
}

function selectLibraryRow(row, event) {
  const selection = trackSelection ?? editSelection;
  const { chosen, anchor, saving } = selection;
  const entry = row.track ?? row.folder;
  const canSelect = (item) => item.track
    ? !(selection === editSelection || selection.mode === "delete") || !item.track.busy
    : item.folder.tracks.every((track) => !track.busy);
  if (saving || !canSelect(row)) return;
  const visibleRows = event.shiftKey && anchor
    ? [...(selection.mode === "delete" ? folderList.children : []), ...list.children] : [];
  const range = selectionRange(visibleRows, visibleRows.find((item) => (item.track ?? item.folder) === anchor), row);
  if (range.length) {
    const selecting = selection !== editSelection || chosen.has(anchor);
    for (const item of range) {
      if (!canSelect(item)) continue;
      const entry = item.track ?? item.folder;
      if (selecting) chosen.add(entry);
      else chosen.delete(entry);
      updateSelectionRow(item);
    }
  } else {
    if (!chosen.delete(entry)) chosen.add(entry);
    selection.anchor = entry;
    updateSelectionRow(row);
  }
  selectionConfirm.disabled = !chosen.size;
}

function renderTracks() {
  cancelLibraryGesture();
  thumbnailObserver?.disconnect();
  newFolder.disabled = !database;
  newFolder.hidden = Boolean(activeFolder || trackSelection);
  deleteMode.hidden = librarySettings.hidden = Boolean(trackSelection);
  librarySettings.setAttribute("aria-label", activeFolder ? "フォルダの設定" : "ライブラリの設定");
  get("folder-back").hidden = !activeFolder || Boolean(trackSelection);
  addTracks.hidden = Boolean(trackSelection);
  list.replaceChildren();
  const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
  renderFolders(query);
  const libraryTracks = visibleLibraryTracks();
  deleteMode.disabled = !libraryTracks.length && !folderList.childElementCount;
  selectionConfirm.disabled = !trackSelection?.chosen.size || Boolean(trackSelection?.saving);
  if (deleteMode.disabled && deleting) setDeleteMode(false);
  const matches = matchingTracks(libraryTracks, query);
  for (const track of matches) {
    const row = document.createElement("li");
    row.className = "track queue-row";
    row.track = track;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "track-select";
    select.innerHTML = '<span class="thumb" aria-hidden="true"><img alt="" hidden></span><span class="track-copy"><span class="track-name"></span><span class="track-artist" hidden></span></span>';
    select.addEventListener("click", (event) => {
      if (trackSelection || editSelection) return selectLibraryRow(row, event);
      selectTrack(track, false, matches, query);
      showView("player");
    });

    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "•••";
    more.addEventListener("click", () => openTrackMenu(track));
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "queue-handle library-handle";
    handle.innerHTML = '<span class="queue-symbol" aria-hidden="true"></span>';
    const actions = document.createElement("div");
    actions.className = "track-actions";
    actions.append(more, handle, libraryMediaSize(track.blob.size));
    row.append(select, actions);
    updateSelectionRow(row);
    updateTrackRow(row);
    list.append(row);
    if (!track.preview && thumbnailObserver) thumbnailObserver.observe(row);
    else prepareTrackRow(row);
  }
  get("empty-library").hidden = matches.length > 0 || folderList.childElementCount > 0;
  get("empty-title").textContent = searching ? "曲を検索しています…" : query ? "該当する曲がありません" : "曲がありません";
  get("empty-help").textContent = searching ? "" : query
    ? "別の曲名やアーティスト名で探してください。"
    : activeFolder ? "「♪」からこのフォルダに曲を追加できます。" : "「♪」からiCloud Driveなどの音楽や動画を追加できます。";
  get("track-count").textContent = query ? matches.length + " / " + libraryTracks.length + " 曲" : libraryTracks.length + " 曲";
  const storageSummary = get("storage-summary");
  storageSummary.hidden = Boolean(activeFolder) || !database;
  if (!storageSummary.hidden) {
    const saved = tracks.filter((track) => track.id !== undefined);
    const bytes = saved.reduce((total, track) => total + track.blob.size, 0);
    const capacity = bytes ? displayDownloadSize(bytes).replace(" ", "") : "0MB";
    storageSummary.textContent = saved.length + "曲[" + capacity + "]";
  }
  renderSearchSuggestions();
  updateSelection();
}

async function filterLibrary() {
  const revision = ++searchRevision;
  const unchecked = search.value.trim() ? visibleLibraryTracks().filter((track) => !track.metadata) : [];
  searching = unchecked.length > 0;
  renderTracks();
  for (const track of unchecked) {
    if (revision !== searchRevision) return;
    await ensureSearchMetadata(track);
  }
  if (revision === searchRevision && searching) {
    searching = false;
    renderTracks();
  }
}

addTracks.addEventListener("click", () => addDialog.showModal());
picker.addEventListener("change", async () => {
  const folder = activeFolder;
  addDialog.close();
  const added = [];
  let invalid = 0;
  for (const file of picker.files) {
    const extension = /\.([a-z0-9]+)$/i.exec(file.name);
    const format = extension?.[1].toLowerCase();
    if (!Object.hasOwn(mediaFormats, format) || file.size === 0) {
      ++invalid;
      continue;
    }
    const title = file.name.slice(0, extension.index).trim() || file.name;
    added.push({ blob: file.slice(0, file.size, mediaFormats[format]), title, filename: file.name, addedAt: Date.now(), format, folder });
  }
  picker.value = "";
  if (!added.length) {
    if (invalid) tellLibrary("対応する音楽・動画ファイルを選んでください。");
    return;
  }
  const review = { added, invalid, urls: new Map(), rows: [], reading: true, coverReads: 0 };
  pendingImport = review;
  const list = get("import-review-list");
  const template = get("import-review-row");
  list.replaceChildren();
  for (const [index, track] of added.entries()) {
    const row = template.content.firstElementChild.cloneNode(true);
    row.querySelector(".import-filename").textContent = track.filename;
    for (const field of row.querySelectorAll("input[data-field]")) {
      field.setAttribute("aria-label", `${index + 1}件目の${field.placeholder}`);
      field.addEventListener("input", () => { field.dataset.edited = ""; });
    }
    const coverInput = row.querySelector('input[type="file"]');
    coverInput.setAttribute("aria-label", `${index + 1}件目のジャケット画像を変更`);
    coverInput.addEventListener("change", () => changeImportCover(review, row, track, coverInput));
    row.querySelector('[data-field="title"]').value = track.title;
    review.rows.push(row);
    list.append(row);
  }
  importReviewSave.disabled = true;
  const feedback = get("import-review-message");
  feedback.textContent = "ファイルの情報を読み込んでいます…";
  feedback.dataset.loading = "";
  importReview.showModal();
  for (const [index, track] of added.entries()) {
    if (pendingImport !== review || !importReview.open) return;
    const metadata = await (["mp4", "m4v", "mov"].includes(track.format) ? readMp4Metadata(track.blob) : readMediaMetadata(track)).catch(() => null);
    const cover = isVideo(track) ? await readVideoThumbnail(track.blob).catch(() => null) : metadata?.artwork;
    if (pendingImport !== review || !importReview.open) return;
    if (isVideo(track)) track.videoThumbnail = cover;
    const row = review.rows[index];
    for (const field of row.querySelectorAll("input[data-field]")) {
      const value = metadata?.[field.dataset.field];
      if (value && !("edited" in field.dataset)) field.value = value;
    }
    if (cover && !track.edits?.cover) showImportCover(review, row, cover);
  }
  feedback.removeAttribute("data-loading");
  feedback.textContent = invalid ? invalid + "件は対応するファイル形式ではありません。" : "";
  review.reading = false;
  importReviewSave.disabled = review.coverReads > 0;
});

function showImportCover(review, row, cover) {
  const previous = review.urls.get(row);
  if (previous) URL.revokeObjectURL(previous);
  const url = URL.createObjectURL(cover);
  review.urls.set(row, url);
  const image = row.querySelector("img");
  image.src = url;
  image.hidden = false;
}

async function changeImportCover(review, row, track, input) {
  const file = input.files[0];
  input.value = "";
  if (!file || pendingImport !== review || !importReview.open) return;
  input.disabled = true;
  review.coverReads++;
  importReviewSave.disabled = true;
  const feedback = get("import-review-message");
  try {
    const cover = await resizeCover(file);
    if (pendingImport !== review || !importReview.open) return;
    track.edits = { cover };
    showImportCover(review, row, cover);
  } catch {
    if (pendingImport === review && importReview.open) feedback.textContent = "画像を開けませんでした。別の画像を選んでください。";
  } finally {
    input.disabled = false;
    review.coverReads--;
    if (pendingImport === review) importReviewSave.disabled = review.reading || review.coverReads > 0;
  }
}

function readMediaEdits(container) {
  return Object.fromEntries(Array.from(container.querySelectorAll("input[data-field]"), (input) => [input.dataset.field, input.value.trim()]));
}

get("import-review-cancel").addEventListener("click", () => importReview.close());
importReview.addEventListener("close", () => {
  if (importReview.open || !pendingImport) return;
  pendingImport.urls.forEach((url) => URL.revokeObjectURL(url));
  pendingImport = null;
  get("import-review-list").replaceChildren();
});
importReviewSave.addEventListener("click", () => {
  if (!pendingImport || importReviewSave.disabled) return;
  const { added, invalid, rows } = pendingImport;
  for (const [index, track] of added.entries()) {
    track.edits = { ...track.edits, ...readMediaEdits(rows[index]) };
    if (!track.edits.title) track.edits.title = track.title;
    track.busy = "save";
  }
  importReview.close();
  tracks.push(...added);
  const { folder } = added[0];
  folder?.tracks.push(...added);
  if (current && folder === playbackFolder && !playbackQuery) queue.append(added);
  search.value = "";
  filterLibrary();
  tellLibrary(added.length + "曲を端末に保存しています…");
  importQueue = importQueue.then(() => saveImportedTracks(added, invalid));
});

search.addEventListener("focus", openSearchSuggestions);
search.addEventListener("click", openSearchSuggestions);
search.addEventListener("blur", hideSearchSuggestions);
search.addEventListener("input", () => {
  searchSuggestionsOpen = true;
  filterLibrary();
});
searchSuggestions.addEventListener("mousedown", (event) => event.preventDefault());
searchSuggestions.addEventListener("click", (event) => {
  const item = event.target.closest("[role=option]");
  if (item) chooseSearchSuggestion(item);
});
search.addEventListener("keydown", (event) => handleSuggestionKeys(event, searchSuggestions,
  openSearchSuggestions, hideSearchSuggestions, chooseSearchSuggestion));
function folderAtPointer(event) {
  if (!event || !deleting) return null;
  const { clientX, clientY } = event;
  if (clientY < librarySearch.getBoundingClientRect().bottom) return null;
  return Array.from(folderList.children).find((row) => {
    const { left, top, right, bottom } = row.getBoundingClientRect();
    return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  });
}

function libraryReorderTarget(track, target) {
  if (!deleting || !list.children[target]) return null;
  const entries = editedTracksFor(track);
  if (!entries.length || entries.some((item) => item.busy)) return null;
  const rows = Array.from(list.children);
  const from = rows.findIndex((row) => row.track === track);
  if (from < 0) return null;
  const direction = Math.sign(target - from);
  const moving = new Set(entries);
  while (target !== from && moving.has(rows[target].track)) target -= direction;
  return target === from ? null : { entries, neighbor: rows[target], direction, moving, rows };
}

let libraryInsertLine = null;

function showLibraryInsertLine(edge) {
  if (edge === libraryInsertLine?.edge) return;
  if (libraryInsertLine) {
    const { element, appearance } = libraryInsertLine;
    if (reducedMotion.matches) element.remove();
    else {
      const opacity = getComputedStyle(element).opacity;
      appearance?.cancel();
      element.animate([{ opacity }, { opacity: 0 }], { duration: 125, easing: "ease-out", fill: "forwards" })
        .finished.then(() => element.remove(), () => element.remove());
    }
    libraryInsertLine = null;
  }
  if (edge === undefined) return;
  const element = document.createElement("span");
  element.className = "library-insert-line";
  element.style.top = edge + "px";
  get("library-insert-lines").append(element);
  const appearance = reducedMotion.matches ? null
    : element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 125, easing: "ease-out" });
  libraryInsertLine = { element, appearance, edge };
}

const cancelLibraryGesture = bindQueueGestures(list, libraryScrollArea, {
  group: editedTracksFor,
  shiftNeighbors: false,
  scrollDrag({ clientY }) {
    const topEdge = librarySearch.getBoundingClientRect().bottom + 24;
    const bottom = mobile.matches && !miniPlayer.hidden ? miniPlayer.getBoundingClientRect().top : window.innerHeight;
    const bottomEdge = bottom - 34;
    if (clientY < topEdge) return -Math.min(14, Math.ceil((topEdge - clientY) / 3));
    if (clientY > bottomEdge) return Math.min(14, Math.ceil((clientY - bottomEdge) / 3));
    return 0;
  },
  previewDrop(event) {
    const destination = folderAtPointer(event);
    for (const row of folderList.children) row.toggleAttribute("data-drop-target", row === destination);
  },
  previewReorder(track, target, event, offset) {
    const insertion = track && !folderAtPointer(event) ? libraryReorderTarget(track, target) : null;
    if (!insertion) {
      showLibraryInsertLine();
      return;
    }
    const { neighbor, direction, moving, rows } = insertion;
    const remaining = rows.filter((row) => !moving.has(row.track));
    const next = remaining[remaining.indexOf(neighbor) + Number(direction > 0)];
    const first = rows[0];
    const last = rows.at(-1);
    if (next && next !== remaining[0]) {
      showLibraryInsertLine(next.offsetTop + next.clientTop);
      return;
    }
    const movedRows = rows.filter((row) => moving.has(row.track));
    if (next) {
      showLibraryInsertLine(first.offsetTop);
      return Math.max(offset, first.offsetTop - movedRows[0].offsetTop);
    }
    // The list reserves a gutter immediately below its last row.
    const bottom = last.offsetTop + last.offsetHeight;
    showLibraryInsertLine(list.clientHeight);
    const movedLast = movedRows.at(-1);
    return Math.min(offset, bottom - movedLast.offsetTop - movedLast.offsetHeight);
  },
  drop(track, event) {
    if (activeFolder) return false;
    if (track.folder) return true;
    const destination = folderAtPointer(event);
    if (!destination) return false;
    const entries = editedTracksFor(track);
    if (entries.some((item) => item.busy)) return true;
    Promise.resolve(moveIntoFolder(entries, destination.folder)).then(renderTracks);
    return true;
  },
  reorder(track, target) {
    const insertion = libraryReorderTarget(track, target);
    if (!insertion) return;
    const { entries, neighbor, direction, moving, rows } = insertion;
    const order = activeFolder?.tracks ?? tracks;
    for (let index = order.length - 1; index >= 0; index--) {
      if (moving.has(order[index])) order.splice(index, 1);
    }
    order.splice(order.indexOf(neighbor.track) + Number(direction > 0), 0, ...entries);
    const movedRows = rows.filter((row) => moving.has(row.track));
    if (direction > 0) neighbor.after(...movedRows);
    else neighbor.before(...movedRows);
    if (!activeFolder) customTrackOrder = true;
    persistLibrary();
    if (current && playbackFolder === activeFolder) {
      const available = visibleLibraryTracks();
      const scope = playbackQuery ? available.filter((entry) => queue.scope.includes(entry)) : available;
      if (queue.shuffled) queue.updateScope(scope);
      else queue.start(scope, current);
      updateSelection();
    }
  },
}, reducedMotion);
deleteMode.addEventListener("click", () => setDeleteMode(!deleting));
librarySettings.addEventListener("click", openLibraryMenu);
get("folder-back").addEventListener("click", () => showFolder(null));
const folderName = get("folder-name");
const folderSubmit = get("folder-submit");
const folderViewport = window.visualViewport;
let folderToRename = null;

function fitFolderEditor() {
  if (!folderViewport) return;
  for (const dialog of [createFolderDialog, folderDetailsDialog]) {
    dialog.style.setProperty("--folder-visible-top", folderViewport.offsetTop + "px");
    dialog.style.setProperty("--folder-visible-height", folderViewport.height + "px");
  }
}

function openFolderEditor(folder = null) {
  folderToRename = folder;
  get("folder-create-title").textContent = folder ? "フォルダ名を変更" : "フォルダを作成";
  folderSubmit.textContent = folder ? "保存" : "作成";
  folderName.value = folder?.name ?? "";
  folderName.setCustomValidity("");
  fitFolderEditor();
  folderViewport?.addEventListener("resize", fitFolderEditor);
  folderViewport?.addEventListener("scroll", fitFolderEditor);
  createFolderDialog.showModal();
}
newFolder.addEventListener("click", () => openFolderEditor());
createFolderDialog.addEventListener("close", () => {
  folderToRename = null;
  folderViewport?.removeEventListener("resize", fitFolderEditor);
  folderViewport?.removeEventListener("scroll", fitFolderEditor);
});
folderName.addEventListener("input", () => folderName.setCustomValidity(""));
createFolderDialog.querySelector("form").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = folderName.value.trim();
  if (!name) {
    folderName.setCustomValidity("フォルダ名を入力してください。");
    folderName.reportValidity();
    return;
  }
  if (folderToRename) folderToRename.name = name;
  else folders.push({ name, tracks: [] });
  persistLibrary();
  createFolderDialog.close();
  search.value = "";
  filterLibrary();
});
get("selection-cancel").addEventListener("click", () => setTrackSelection(null));
selectionConfirm.addEventListener("click", async () => {
  if (!trackSelection || trackSelection.saving) return;
  const selection = trackSelection;
  const { chosen, folder, mode } = selection;
  const entries = visibleLibraryTracks().filter((track) => chosen.has(track));
  if (mode === "delete") {
    confirmDeletion(entries, activeFolder ? [] : folders.filter((entry) => chosen.has(entry)));
    return;
  }
  selection.saving = true;
  selectionConfirm.disabled = true;
  get("selection-cancel").disabled = true;
  await moveIntoFolder(entries, mode === "remove" ? null : folder);
  if (trackSelection === selection) setTrackSelection(null);
  else renderTracks();
});
deleteDialog.addEventListener("close", () => {
  if (!deleteDialog.open) pendingDeletion = null;
});
deleteDialog.addEventListener("cancel", (event) => {
  if (pendingDeletion?.saving) event.preventDefault();
});
deleteDialog.querySelector("form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel" && !pendingDeletion?.saving) return;
  event.preventDefault();
  const deletion = pendingDeletion;
  if (!deletion || deletion.saving) return;
  deletion.saving = true;
  const buttons = deleteDialog.querySelectorAll("button");
  for (const button of buttons) button.disabled = true;
  selectionConfirm.disabled = true;
  const selection = trackSelection;
  let deleted;
  try {
    deleted = await deleteLibraryItems(deletion);
  } finally {
    deleteDialog.close();
    pendingDeletion = null;
    for (const button of buttons) button.disabled = false;
  }
  if (selection && trackSelection === selection) {
    if (deleted) setTrackSelection(null);
    else selectionConfirm.disabled = !selection.chosen.size;
  } else if (document.activeElement === document.body) {
    (deleteMode.disabled ? librarySettings : deleteMode).focus({ preventScroll: true });
  }
});
get("library-tab").addEventListener("click", () => showView("library"));
get("player-tab").addEventListener("click", () => showView("player"));
mobile.addEventListener("change", syncLayout);
queueToggle.addEventListener("click", () => showQueue(player.dataset.queue !== "true", true));
queueCurrent.addEventListener("click", () => {
  showQueue(false, true);
  queueToggle.focus({ preventScroll: true });
});
shuffleToggle.addEventListener("click", () => {
  queue.toggleShuffle();
  updateSelection();
});
repeatToggle.addEventListener("click", () => {
  queue.repeat = !queue.repeat;
  updateSelection();
});
let playerDrag = null;
let playerDragFrame = 0;
let clearPlayerMorph = null;

function startPlayerMorph(height) {
  if (reducedMotion.matches || miniPlayer.hidden || isVideo(current)) return null;
  const source = player.dataset.queue === "true" ? queueCurrent.querySelector(".thumb") : get("artwork-stage").querySelector(".cover");
  const target = miniPlayer.querySelector(".thumb");
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  const card = miniPlayer.getBoundingClientRect();
  if (!from.width || !to.width) return null;
  const jacket = source.cloneNode(true);
  jacket.removeAttribute("id");
  jacket.querySelector("img")?.removeAttribute("id");
  jacket.classList.add("moving-jacket");
  jacket.setAttribute("aria-hidden", "true");
  jacket.style.width = from.width + "px";
  jacket.style.height = from.height + "px";
  jacket.style.transform = `translate3d(${from.left}px, ${from.top}px, 0) scale(1)`;
  jacket.style.borderRadius = getComputedStyle(source).borderRadius;
  source.setAttribute("data-moving", "");
  document.body.append(jacket);
  const corner = player.style.getPropertyValue("--player-corner");
  player.style.setProperty("--morph-radius", `${corner} ${corner} 0px 0px`);
  document.body.setAttribute("data-player-morph", "");
  player.setAttribute("data-morph", "");
  jacket.getBoundingClientRect();
  return {
    source, jacket, from, to, card, height, width: player.getBoundingClientRect().width,
    toRadius: parseFloat(getComputedStyle(target).borderTopLeftRadius),
  };
}

function collapsePlayer(morph) {
  const { jacket, from, to, card, width, height, toRadius } = morph;
  const scale = to.width / from.width;
  const radius = getComputedStyle(miniPlayer).borderRadius;
  const duration = parseFloat(getComputedStyle(player).getPropertyValue("--player-collapse-time"));
  jacket.style.transform = `translate3d(${to.left}px, ${to.top}px, 0) scale(${scale})`;
  jacket.style.borderRadius = toRadius / scale + "px";
  player.style.setProperty("--player-drag", card.top + "px");
  player.style.setProperty("--morph-left", card.left + "px");
  player.style.setProperty("--morph-right", (width - card.right) + "px");
  player.style.setProperty("--morph-bottom", (height - card.height) + "px");
  player.style.setProperty("--morph-radius", radius);
  player.style.setProperty("--morph-opacity", "1");
  const timer = setTimeout(() => endPlayerMorph(morph), duration + 20);
  clearPlayerMorph = () => {
    clearTimeout(timer);
    endPlayerMorph(morph);
  };
}

function endPlayerMorph(morph) {
  morph.jacket.remove();
  morph.source.removeAttribute("data-moving");
  document.body.removeAttribute("data-player-morph");
  player.removeAttribute("data-morph");
  for (const property of ["--player-drag", "--morph-left", "--morph-right", "--morph-bottom", "--morph-radius", "--morph-opacity"]) {
    player.style.removeProperty(property);
  }
  clearPlayerMorph = null;
}

function paintPlayerDrag() {
  playerDragFrame = 0;
  if (!playerDrag || reducedMotion.matches) return;
  const { distance, height } = playerDrag;
  player.style.setProperty("--player-drag", distance + "px");
  player.style.setProperty("--player-corner", Math.min(32, distance * .48) + "px");
  document.body.style.setProperty("--library-shade", String(.38 * (1 - distance / height)));
}

player.addEventListener("pointerdown", (event) => {
  const bounds = player.getBoundingClientRect();
  if (!mobile.matches || !event.isPrimary || event.button !== 0 || playerDrag ||
      document.body.hasAttribute("data-video-expanded") || bounds.top > 2 ||
      event.clientY > bounds.top + bounds.height / 2 || event.target.closest("button, input, .queue-panel")) return;
  playerDrag = { id: event.pointerId, x: event.clientX, start: event.clientY, height: bounds.height, distance: 0, active: false };
});
player.addEventListener("pointermove", (event) => {
  if (event.pointerId !== playerDrag?.id) return;
  const distance = event.clientY - playerDrag.start;
  if (!playerDrag.active) {
    const sideways = Math.abs(event.clientX - playerDrag.x);
    if (distance < -8 || (sideways > 8 && sideways > distance)) {
      playerDrag = null;
      return;
    }
    if (distance < 8) return;
    clearPlayerMorph?.();
    playerDrag.active = true;
    player.setPointerCapture(event.pointerId);
    if (isVideo(current)) clearVideoTaps();
    player.setAttribute("data-dragging", "");
    document.body.setAttribute("data-player-dragging", "");
  }
  playerDrag.distance = Math.min(playerDrag.height, Math.max(0, distance));
  if (!playerDragFrame) playerDragFrame = requestAnimationFrame(paintPlayerDrag);
});
function finishPlayerDrag(event) {
  if (event.type === "lostpointercapture" && event.target !== player) return;
  if (event.pointerId !== playerDrag?.id) return;
  if (!playerDrag.active) {
    playerDrag = null;
    return;
  }
  const released = event.type === "pointerup";
  if (released) playerDrag.distance = Math.min(playerDrag.height, Math.max(0, event.clientY - playerDrag.start));
  const dismiss = released && playerDrag.distance >= playerDrag.height * .4;
  cancelAnimationFrame(playerDragFrame);
  paintPlayerDrag();
  const morph = dismiss ? startPlayerMorph(playerDrag.height) : null;
  player.getBoundingClientRect();
  playerDrag = null;
  player.removeAttribute("data-dragging");
  player.style.removeProperty("--player-corner");
  document.body.removeAttribute("data-player-dragging");
  document.body.style.removeProperty("--library-shade");
  if (morph) collapsePlayer(morph);
  else player.style.removeProperty("--player-drag");
  if (dismiss) showView("library");
}
for (const event of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"]) {
  player.addEventListener(event, finishPlayerDrag);
}

// Older WebKit versions can still zoom on a second tap on the empty panel.
let playerTouch = null;
let previousPlayerTap = null;
player.addEventListener("touchstart", (event) => {
  playerTouch = event.touches.length === 1 && !event.target.closest("button, input") ? event.touches[0] : null;
}, { passive: true });
player.addEventListener("touchend", (event) => {
  const end = event.changedTouches[0];
  const start = playerTouch;
  playerTouch = null;
  if (!start || !end || event.touches.length ||
      Math.hypot(end.clientX - start.clientX, end.clientY - start.clientY) > 12) {
    previousPlayerTap = null;
    return;
  }
  const time = performance.now();
  const tap = previousPlayerTap;
  if (tap && time - tap.time < 350 && Math.hypot(end.clientX - tap.x, end.clientY - tap.y) < 30) {
    if (event.cancelable) event.preventDefault();
    previousPlayerTap = null;
  } else previousPlayerTap = { time, x: end.clientX, y: end.clientY };
}, { passive: false });
player.addEventListener("touchcancel", () => {
  playerTouch = null;
  previousPlayerTap = null;
}, { passive: true });
get("menu-close").addEventListener("click", () => closeTrackMenu());
menu.addEventListener("cancel", (event) => {
  event.preventDefault();
  closeTrackMenu();
});
menu.addEventListener("click", (event) => {
  if (event.target !== menu) return;
  const bounds = menu.getBoundingClientRect();
  if (event.clientX < bounds.left || event.clientX > bounds.right ||
      event.clientY < bounds.top || event.clientY > bounds.bottom) closeTrackMenu();
});
get("menu-save").addEventListener("click", () => {
  const track = menuTrack;
  if (track) closeTrackMenu(() => saveTrack(track));
});
get("menu-add").addEventListener("click", () => {
  const folder = menuFolder;
  if (folder) closeTrackMenu(() => setTrackSelection("add", folder));
});
get("menu-rename-folder").addEventListener("click", () => {
  const folder = menuFolder;
  if (folder) closeTrackMenu(() => openFolderEditor(folder));
});
get("menu-folder-details").addEventListener("click", () => {
  const folder = menuFolder;
  if (folder) closeTrackMenu(() => openFolderDetails(folder));
});
folderDetailsDialog.addEventListener("cancel", (event) => {
  if (folderDetailsDraft?.saving) event.preventDefault();
});
folderDetailsClose.addEventListener("click", () => folderDetailsDialog.close());
folderDetailsDialog.addEventListener("close", () => {
  if (folderDetailsDialog.open) return;
  const draft = folderDetailsDraft;
  draft?.durationLookup.abort();
  if (draft?.previewUrl) URL.revokeObjectURL(draft.previewUrl);
  folderDetailsDraft = null;
  get("folder-details-artwork").removeAttribute("src");
  folderViewport?.removeEventListener("resize", fitFolderEditor);
  folderViewport?.removeEventListener("scroll", fitFolderEditor);
});
folderDetailsImage.addEventListener("change", () => {
  const file = folderDetailsImage.files[0];
  folderDetailsImage.value = "";
  if (file) changeFolderCover(() => resizeCover(file), "この画像を開けませんでした。別の画像を選んでください。");
});
folderCoverTrack.addEventListener("change", () => {
  if (folderCoverTrack.value === "") return;
  const track = folderDetailsDraft?.entries[Number(folderCoverTrack.value)];
  folderCoverTrack.value = "";
  if (!track) return;
  changeFolderCover(async () => {
    const cover = track.edits?.cover ?? track.sourceCover ??
      (isVideo(track) ? await getVideoThumbnail(track) : (await readMediaMetadata(track))?.artwork);
    return cover ? resizeCover(cover) : null;
  }, "この曲のジャケットを読み込めませんでした。別の曲か画像を選んでください。");
});
get("folder-details-reset").addEventListener("click", () => {
  const draft = folderDetailsDraft;
  if (!draft || draft.saving) return;
  ++draft.coverRequest;
  draft.cover = null;
  draft.loadingCover = false;
  folderDetailsMessage.textContent = "";
  previewFolderCover(draft);
  updateFolderEditorControls(draft);
});
folderDetailsName.addEventListener("input", () => folderDetailsName.setCustomValidity(""));
folderDetailsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = folderDetailsDraft;
  if (!draft || folderDetailsSave.disabled) return;
  const { folder, cover } = draft;
  const name = folderDetailsName.value.trim();
  if (!name) {
    folderDetailsName.setCustomValidity("フォルダ名を入力してください。");
    folderDetailsName.reportValidity();
    return;
  }
  draft.saving = true;
  folderDetailsMessage.textContent = "";
  updateFolderEditorControls(draft);
  try {
    await writeLibraryLayout({ folder, name, cover });
    if (folder.coverUrl && folder.cover !== cover) {
      URL.revokeObjectURL(folder.coverUrl);
      folder.coverUrl = null;
    }
    folder.name = name;
    folder.cover = cover;
    folderDetailsDialog.close();
    filterLibrary();
  } catch {
    folderDetailsMessage.textContent = "フォルダの変更を保存できませんでした。空き容量を確認して、もう一度お試しください。";
  } finally {
    draft.saving = false;
    if (folderDetailsDraft === draft) updateFolderEditorControls(draft);
  }
});
get("menu-move-out").addEventListener("click", () => {
  const track = menuTrack;
  if (!track?.folder) return;
  const entries = editedTracksFor(track);
  closeTrackMenu(async () => {
    if (entries.some((item) => !tracks.includes(item) || item.busy)) return;
    await moveIntoFolder(entries, null);
    filterLibrary();
  });
});
get("menu-bulk-out").addEventListener("click", () => closeTrackMenu(() => setTrackSelection("remove")));
get("menu-bulk-delete").addEventListener("click", () => closeTrackMenu(() => setTrackSelection("delete")));
get("menu-details").addEventListener("click", () => {
  const track = menuTrack;
  if (track && !get("menu-details").disabled) closeTrackMenu(() => openTrackDetails(track));
});
const detailsSuggestions = [["artist", trackArtist], ["album", trackAlbum]].map(([field, readValue]) => {
  const input = get(`details-${field}`);
  const suggestions = get(`details-${field}-suggestions`);
  let opened = false;
  let query = "";
  function render() {
    if (!opened || !detailsDraft) return;
    const options = metadataChoices(detailsDraft.entries, readValue)
      .filter((value) => containsQuery(value, query)).map((value) => ({ value }));
    showSuggestions(input, suggestions, options);
  }
  function open() {
    if (opened) return;
    opened = true;
    query = "";
    render();
  }
  function hide() {
    opened = false;
    hideSuggestions(input, suggestions);
  }
  function choose(item) {
    input.value = item.dataset.value;
    hide();
    input.blur();
  }
  input.addEventListener("focus", open);
  input.addEventListener("click", open);
  input.addEventListener("blur", hide);
  input.addEventListener("input", () => {
    opened = true;
    query = input.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
    render();
  });
  input.addEventListener("keydown", (event) => handleSuggestionKeys(event, suggestions, open, hide, choose));
  suggestions.addEventListener("mousedown", (event) => event.preventDefault());
  suggestions.addEventListener("click", (event) => {
    const item = event.target.closest('[role="option"]');
    if (item) choose(item);
  });
  return { render, hide };
});
detailsDialog.addEventListener("cancel", (event) => {
  if (detailsDraft?.saving) event.preventDefault();
});
get("details-cancel").addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("close", () => {
  if (detailsDialog.open) return;
  detailsDraft?.durationLookup.abort();
  detailsDraft = null;
  for (const field of detailsSuggestions) field.hide();
  if (detailsCoverUrl) URL.revokeObjectURL(detailsCoverUrl);
  detailsCoverUrl = null;
  get("details-artwork").removeAttribute("src");
});
detailsImage.addEventListener("change", async () => {
  const draft = detailsDraft;
  const file = detailsImage.files[0];
  detailsImage.value = "";
  if (!draft || !file || draft.saving) return;
  const request = ++draft.coverRequest;
  const feedback = get("details-message");
  feedback.textContent = "";
  detailsSave.disabled = true;
  try {
    const cover = await resizeCover(file);
    if (detailsDraft !== draft || request !== draft.coverRequest) return;
    draft.cover = cover;
    previewDetailsCover(draft);
  } catch {
    if (detailsDraft === draft && request === draft.coverRequest) {
      feedback.textContent = "この画像を開けませんでした。別の画像を選んでください。";
    }
  } finally {
    if (detailsDraft === draft && request === draft.coverRequest) detailsSave.disabled = Boolean(draft.track.busy);
  }
});
get("details-reset-cover").addEventListener("click", () => {
  const draft = detailsDraft;
  if (!draft || draft.saving) return;
  ++draft.coverRequest;
  draft.cover = null;
  previewDetailsCover(draft);
  detailsSave.disabled = Boolean(draft.track.busy);
  get("details-message").textContent = "";
});
get("details-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const draft = detailsDraft;
  const track = draft?.track;
  if (!track || track.busy || detailsSave.disabled || !tracks.includes(track)) return;
  const edits = {
    title: get("details-name").value.trim(),
    artist: get("details-artist").value.trim(),
    album: get("details-album").value.trim(),
    cover: draft.cover,
  };
  const changedCover = edits.cover !== (track.edits?.cover ?? null);
  draft.saving = true;
  detailsSave.disabled = detailsImage.disabled = get("details-cancel").disabled = true;
  try {
    if (track.id !== undefined) {
      await trackStore.updateDetails(database, track.id, (details) => { details.edits = edits; });
    }
    track.edits = edits;
    if (changedCover) {
      await track.preview;
      if (track.thumbnail) URL.revokeObjectURL(track.thumbnail);
      track.thumbnail = null;
      track.preview = loadTrackPreview(track);
      if (current === track) {
        showArtwork(track);
      }
    }
    detailsDialog.close();
    filterLibrary();
    if (track.id === undefined) tellLibrary("曲を端末に保存すると、編集内容も次回に引き継がれます。");
  } catch {
    get("details-message").textContent = "編集内容を保存できませんでした。空き容量を確認して、もう一度「保存」を押してください。";
  } finally {
    draft.saving = false;
    detailsSave.disabled = detailsImage.disabled = get("details-cancel").disabled = false;
  }
});
get("menu-delete").addEventListener("click", () => {
  const track = menuTrack;
  if (track) {
    const entries = editedTracksFor(track);
    closeTrackMenu(() => confirmDeletion(entries));
  }
});
get("menu-delete-folder").addEventListener("click", () => {
  const folder = menuFolder;
  if (folder) closeTrackMenu(() => confirmDeletion([], [folder]));
});
get("previous").addEventListener("click", () => move(-1));
get("next").addEventListener("click", () => move(1));
get("mini-next").addEventListener("click", () => move(1));
toggle.addEventListener("click", () => {
  if (!reducedMotion.matches) {
    const ripple = document.createElement("span");
    ripple.className = "play-ripple";
    ripple.setAttribute("aria-hidden", "true");
    ripple.addEventListener("animationend", () => ripple.remove(), { once: true });
    toggle.append(ripple);
  }
  togglePlayback();
});
miniToggle.addEventListener("click", togglePlayback);
seek.addEventListener("input", () => {
  if (!seek.disabled) {
    playbackTracking = true;
    media.currentTime = seek.valueAsNumber;
  }
});

function previewSeek(event) {
  const drag = seekDrag;
  const pointer = drag.rotated ? event.clientY : event.clientX;
  const fraction = Math.max(0, Math.min(1, (pointer - drag.start) / drag.length));
  drag.time = fraction * media.duration;
  updateTime();
  revealFullscreenControls();
}

seek.addEventListener("pointerdown", (event) => {
  if (seek.disabled || !event.isPrimary || event.button !== 0) return;
  const bounds = seek.getBoundingClientRect();
  const rotated = document.body.hasAttribute("data-video-expanded") && getComputedStyle(playerContent).transform !== "none";
  const length = (rotated ? bounds.height : bounds.width) - 13;
  if (length <= 0) return;
  event.preventDefault();
  seek.focus({ preventScroll: true });
  seek.setPointerCapture(event.pointerId);
  seekDrag = { id: event.pointerId, media, rotated, length, start: (rotated ? bounds.top : bounds.left) + 6.5 };
  previewSeek(event);
});
seek.addEventListener("pointermove", (event) => {
  if (seekDrag?.id === event.pointerId) previewSeek(event);
});
seek.addEventListener("pointerup", (event) => {
  if (seekDrag?.id !== event.pointerId) return;
  previewSeek(event);
  const time = seekDrag.time;
  playbackTracking = true;
  seekDrag = null;
  media.currentTime = time;
  updateTime();
});
for (const type of ["pointercancel", "lostpointercapture"]) {
  seek.addEventListener(type, (event) => {
    if (seekDrag?.id !== event.pointerId) return;
    seekDrag = null;
    updateTime();
  });
}

document.addEventListener("pointerdown", () => fullscreenRoot.removeAttribute("data-keyboard-focus"), true);
document.addEventListener("keydown", (event) => {
  if (event.key === "Tab") fullscreenRoot.setAttribute("data-keyboard-focus", "");
}, true);
document.addEventListener("contextmenu", (event) => {
  if (event.target.closest("#player, #mini-player, #tracks, #folders") && !event.target.closest("input:not([type=range]), textarea")) {
    event.preventDefault();
  }
});

function scheduleVideoLayout() {
  if (videoLayoutFrame) return;
  videoLayoutFrame = requestAnimationFrame(updateVideoLayout);
}

function paintMiniVideo() {
  cancelAnimationFrame(miniVideoFrame);
  miniVideoFrame = 0;
  const showingInLibrary = mobile.matches && document.body.dataset.view === "library" && !miniPlayer.inert &&
    isVideo(current) && video.readyState >= 2 && video.videoWidth && video.videoHeight &&
    !media.ended && !video.error;
  if (!miniVideoContext || !showingInLibrary) {
    miniVideo.hidden = true;
    miniVideoTime = -Infinity;
    return;
  }
  // Sample the active video so the mini player never starts a second media stream.
  const time = video.currentTime;
  if (miniVideo.hidden || (video.paused ? time !== miniVideoTime : Math.abs(time - miniVideoTime) >= 1 / 30)) {
    const scale = Math.min(miniVideo.width / video.videoWidth, miniVideo.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    try {
      miniVideoContext.clearRect(0, 0, miniVideo.width, miniVideo.height);
      miniVideoContext.drawImage(video, (miniVideo.width - width) / 2, (miniVideo.height - height) / 2, width, height);
      miniVideo.hidden = false;
      miniVideoTime = time;
    } catch {
      miniVideo.hidden = true;
    }
  }
  if (!video.paused) miniVideoFrame = requestAnimationFrame(paintMiniVideo);
}

function updateVideoLayout() {
  videoLayoutFrame = 0;
  paintMiniVideo();
  if (videoStage.hidden) return;
  if (document.body.hasAttribute("data-video-expanded")) return;
  const queued = player.dataset.queue === "true";
  const stage = videoStage.parentElement.getBoundingClientRect();
  const target = (queued ? queueVideoSlot : videoSlot).getBoundingClientRect();
  const panel = queued ? queuePanel.getBoundingClientRect() : null;
  let clipTop = 0;
  let clipBottom = 0;
  if (queued) {
    clipTop = Math.max(0, panel.top - target.top);
    clipBottom = Math.max(0, target.bottom - panel.bottom);
  }
  const preview = queued && !media.ended && !video.error && video.readyState >= 2 &&
    target.height > clipTop + clipBottom;
  videoStage.toggleAttribute("data-queue-preview", preview);
  for (const [key, value] of Object.entries({
    x: target.left - stage.left, y: target.top - stage.top,
    w: target.width, h: target.height, "clip-top": clipTop, "clip-bottom": clipBottom,
  })) {
    videoStage.style.setProperty("--video-" + key, value + "px");
  }
  // Inline video is top-aligned inside a slot that can be taller than the frame.
  const { videoWidth, videoHeight } = video;
  const frameHeight = videoWidth && videoHeight ? Math.min(target.height, target.width * videoHeight / videoWidth) : target.height;
  videoStage.style.setProperty("--video-skip-bottom", Math.max(0, target.height - frameHeight) + "px");
}

if (typeof ResizeObserver === "function") {
  const videoResize = new ResizeObserver(scheduleVideoLayout);
  for (const target of [videoStage.parentElement, videoSlot, queueVideoSlot, videoControls]) videoResize.observe(target);
}
window.addEventListener("resize", () => {
  clearQueueArtworkMotion();
  clearQueueVideoMotion();
  updateQueueViewport();
  scheduleVideoLayout();
});

function updateVideoTools() {
  videoFullscreen.disabled = !isVideo(current) || video.readyState < 1 || !video.videoWidth;
}

function hideFullscreenControls() {
  clearTimeout(fullscreenControlsTimer);
  document.body.removeAttribute("data-video-controls");
}

function revealFullscreenControls() {
  if (!document.body.hasAttribute("data-video-expanded")) return;
  document.body.setAttribute("data-video-controls", "");
  clearTimeout(fullscreenControlsTimer);
  fullscreenControlsTimer = setTimeout(() => {
    if (seekDrag) revealFullscreenControls();
    else hideFullscreenControls();
  }, 5000);
}

function setVideoExpanded(expanded) {
  hideFullscreenControls();
  document.body.toggleAttribute("data-video-expanded", expanded);
  videoFullscreen.setAttribute("aria-label", expanded ? "動画を縮小" : "動画を全画面");
  videoFullscreen.setAttribute("aria-pressed", String(expanded));
  clearVideoTaps();
  if (!expanded && landscapeLocked) {
    screen.orientation?.unlock();
    landscapeLocked = false;
  }
  syncLayout();
}

function closeVideoExpanded() {
  if (!document.body.hasAttribute("data-video-expanded")) return;
  setVideoExpanded(false);
  if (document.fullscreenElement === fullscreenRoot) document.exitFullscreen().catch(() => {});
}

videoFullscreen.addEventListener("click", async () => {
  if (!isVideo(current) || !video.videoWidth) return;
  if (document.body.hasAttribute("data-video-expanded")) {
    closeVideoExpanded();
    return;
  }
  if (player.dataset.queue === "true") showQueue(false);
  setVideoExpanded(true);
  if (!document.fullscreenElement && document.fullscreenEnabled && typeof fullscreenRoot.requestFullscreen === "function") {
    try {
      await fullscreenRoot.requestFullscreen();
      if (!document.body.hasAttribute("data-video-expanded") && document.fullscreenElement === fullscreenRoot) {
        await document.exitFullscreen();
      } else if (mobile.matches && document.fullscreenElement === fullscreenRoot && typeof screen.orientation?.lock === "function") {
        try {
          await screen.orientation.lock("landscape");
          if (document.body.hasAttribute("data-video-expanded")) landscapeLocked = true;
          else screen.orientation.unlock();
        } catch {
          // The portrait viewport uses the sideways fullscreen layout.
        }
      }
    } catch {
      // Keep the app's full-viewport layout if browser fullscreen is unavailable.
    }
  }
});
document.addEventListener("keydown", (event) => {
  if (!document.body.hasAttribute("data-video-expanded")) return;
  if (event.key === "Escape") {
    closeVideoExpanded();
    videoFullscreen.focus({ preventScroll: true });
  } else if (event.key === "Tab") {
    revealFullscreenControls();
  }
});
document.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement !== fullscreenRoot && document.body.hasAttribute("data-video-expanded")) setVideoExpanded(false);
});
for (const event of ["loadedmetadata", "loadeddata", "resize", "seeked", "emptied"]) {
  video.addEventListener(event, () => {
    updateVideoTools();
    scheduleVideoLayout();
  });
}
video.addEventListener("loadedmetadata", alignCompanionVideo);

const videoDoubleTapTime = 350;

function clearVideoTaps() {
  videoPointer = null;
  previousVideoTap = null;
  clearTimeout(videoSkipTimer);
  videoSkip.removeAttribute("data-direction");
  videoSkip.textContent = "";
}

videoStage.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.button !== 0) return;
  const seconds = Number(event.target.dataset?.seconds);
  if (seconds) videoPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, seconds };
});
videoStage.addEventListener("pointercancel", clearVideoTaps);
videoStage.addEventListener("pointerup", (event) => {
  const start = videoPointer;
  videoPointer = null;
  if (start?.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 16) return;
  const time = performance.now();
  const previous = previousVideoTap;
  const fullscreen = document.body.hasAttribute("data-video-expanded");
  if (!previous || time - previous.time > videoDoubleTapTime || previous.seconds !== start.seconds ||
      Math.hypot(previous.x - start.x, previous.y - start.y) > 80) {
    const controlsVisible = document.body.hasAttribute("data-video-controls");
    previousVideoTap = { ...start, time, controlsVisible };
    if (fullscreen) {
      if (controlsVisible) hideFullscreenControls();
      else revealFullscreenControls();
    }
    return;
  }
  previousVideoTap = null;
  if (fullscreen) {
    if (previous.controlsVisible) revealFullscreenControls();
    else hideFullscreenControls();
  }
  if (!isVideo(current) || !Number.isFinite(media.duration) || !media.duration) return;
  media.currentTime = Math.min(media.duration, Math.max(0, media.currentTime + start.seconds));
  videoSkip.dataset.direction = start.seconds > 0 ? "next" : "previous";
  videoSkip.textContent = start.seconds > 0 ? "＋10秒" : "−10秒";
  clearTimeout(videoSkipTimer);
  videoSkipTimer = setTimeout(() => {
    videoSkip.removeAttribute("data-direction");
    videoSkip.textContent = "";
  }, 650);
});
videoControls.addEventListener("pointerdown", revealFullscreenControls);
seek.addEventListener("input", revealFullscreenControls);

function onActiveMedia(event, handler) {
  for (const element of [audio, video]) {
    element.addEventListener(event, () => {
      if (media === element) handler();
    });
  }
}

onActiveMedia("loadedmetadata", () => {
  applyResumePosition();
  rememberTrackDuration(current, media.duration);
  alignCompanionVideo();
});
for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
  onActiveMedia(event, updateTime);
}
for (const event of ["play", "playing", "pause"]) {
  onActiveMedia(event, () => {
    if (event === "pause" && media === audio && advanceAfterEnd()) return;
    syncCompanionVideo();
    updatePlayback();
  });
}
onActiveMedia("waiting", () => { if (companionVideoUrl) video.pause(); });
onActiveMedia("seeking", alignCompanionVideo);
onActiveMedia("seeked", syncCompanionVideo);
onActiveMedia("seeked", updatePlayback);
onActiveMedia("seeked", () => rememberPlayback());
onActiveMedia("pause", () => rememberPlayback());
onActiveMedia("timeupdate", () => {
  if (backgroundAdvance && !media.paused && media.currentTime > .05) backgroundAdvance = null;
  if (!video.paused) alignCompanionVideo();
  if (!media.paused && performance.now() - lastCheckpoint >= 2000) rememberPlayback();
});
onActiveMedia("playing", () => {
  if (!current) return;
  if (recordedCurrent) {
    rememberPlayback();
    return;
  }
  recordedCurrent = true;
  recordPlay(current);
  queue.record(current);
  saveHistory();
  rememberPlayback();
  if (player.dataset.queue === "true") renderQueue(true);
});
onActiveMedia("ended", advanceAfterEnd);
onActiveMedia("error", () => {
  if (!current || !media.error) return;
  syncCompanionVideo();
  tellPlayer(playbackError());
  updatePlayback();
  updateTime();
});

document.addEventListener("visibilitychange", () => {
  syncCompanionVideo();
  if (document.hidden) rememberPlayback();
  else resumeAudioOnReturn();
});
window.addEventListener("pageshow", (event) => { if (event.persisted) resumeAudioOnReturn(); });
if (!desktopPlayback && navigator.audioSession) {
  const audioSession = navigator.audioSession;
  audioSession.type = "playback";
  audioSession.addEventListener("statechange", () => {
    if (current && audioSession.state === "interrupted") pause();
  });
}
window.addEventListener("pagehide", () => rememberPlayback());
syncLayout();
const storageReady = restoreTracks();
setupMediaDownloads(saveDownloadedMedia, setScreenActivity, () => activeFolder);
setupPCTransfer({
  async getLibrary() {
    await storageReady;
    return {
      root: rootTracks(),
      folders: folders.map((folder) => ({
        name: folder.name,
        tracks: [...folder.tracks],
        size: folderSize(folder),
        cover: folder.cover,
        source: folder,
      })),
    };
  },
  async hasTrack(pcTransferId) {
    await storageReady;
    if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
    return (await trackStore.run(database, "readonly", (store) => store.index("pcTransferId").getKey(pcTransferId))) !== undefined;
  },
  saveTrack: savePCTrack,
  saveFolder: savePCFolder,
  orderFolder: orderPCFolder,
  async prepareFolders(entries) {
    for (const entry of entries) {
      entry.source.pcTransferId ??= crypto.randomUUID();
      entry.pcTransferId = entry.source.pcTransferId;
    }
    await writeLibraryLayout();
  },
  selectionRange,
  displayTitle: trackTitle,
  displayArtist: trackArtist,
  showThumbnail: showTrackThumbnail,
  async prepareTrack(track) {
    if (!track.metadata) {
      const metadata = await readMediaMetadata(track, false).catch(() => null);
      updateTrackMetadata(track, metadata);
    }
    if (isVideo(track) && !track.sourceCover && !track.edits?.cover) await getVideoThumbnail(track);
    return trackTitle(track);
  },
}, setScreenActivity);

if (mediaSession) {
  const actions = {
    play: () => { if (media.paused || media.ended) togglePlayback(); },
    pause,
    previoustrack: () => move(-1, document.hidden),
    nexttrack: () => move(1, document.hidden),
  };
  for (const [action, handler] of Object.entries(actions)) {
    try {
      mediaSession.setActionHandler(action, handler);
    } catch {
      // The system decides which playback controls are available.
    }
  }
}

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("オフライン起動の準備に失敗しました。", error);
  });
}
