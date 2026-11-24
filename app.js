"use strict";

const get = (id) => document.getElementById(id);
const audio = get("audio");
const video = get("player-video");
const videoStage = get("video-stage");
const videoFullscreen = get("video-fullscreen");
const videoSkip = get("video-skip");
const videoSlot = get("artwork-stage").querySelector(".cover-space");
const videoControls = document.querySelector(".player-controls");
const playerContent = document.querySelector(".player-content");
const fullscreenRoot = document.documentElement;
const playerCover = get("player-cover");
let media = audio;
const mediaFormats = {
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
};
const picker = get("file-picker");
const addTracks = get("add-tracks");
const addDialog = get("add-dialog");
const library = get("library");
const librarySearch = get("search").closest(".library-search");
const list = get("tracks");
const search = get("search");
const seek = get("seek");
const toggle = get("toggle");
const miniToggle = get("mini-toggle");
const miniPlayer = get("mini-player");
const player = get("player");
const queueToggle = get("queue-toggle");
const queuePanel = get("queue-panel");
const queueCurrent = get("queue-current");
const queueList = get("queue-list");
const historyHeading = get("history-heading");
const historyClear = get("history-clear");
const historyList = get("history-list");
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
const selectionBar = get("folder-selection");
const selectionTitle = get("selection-title");
const selectionConfirm = get("selection-confirm");
const detailsDialog = get("track-details");
const detailsSave = get("details-save");
const detailsImage = get("details-image");
const mobile = matchMedia("(max-width: 730px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
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
let checkingStorage = true;
let current = null;
let objectUrl = null;
let artworkUrl = null;
let artworkRequest = 0;
let playRequest = 0;
let menuTrack = null;
let pendingDeletion = null;
let deleting = false;
let detailsDraft = null;
let detailsCoverUrl = null;
let searchRevision = 0;
let searching = false;
let recordedCurrent = false;
let backdrop = null;
let importQueue = Promise.resolve();
let previewQueue = Promise.resolve();
let saveToastTimer;
let videoLayoutFrame = 0;
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
  get("theme-color").content = expanded && !fullscreen ? "#132a22" : "#000000";
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
  const elapsed = formatTime(seconds);
  const total = formatTime(duration);
  get("elapsed").textContent = elapsed;
  get("duration").textContent = "−" + formatTime(Math.ceil(duration - seconds));
  seek.setAttribute("aria-valuetext", total + "のうち" + elapsed);
}

function updatePlayback() {
  const playing = Boolean(current) && !media.paused && !media.ended && !media.error;
  for (const button of [toggle, miniToggle]) {
    button.firstElementChild.dataset.playing = String(playing);
    button.setAttribute("aria-label", playing ? "一時停止" : "再生");
  }
  updateVideoTools();
  activeLibraryButton?.toggleAttribute("data-playing", playing);
  queueCurrent.toggleAttribute("data-playing", playing);
  videoStage.toggleAttribute("data-ended", media === video && video.ended);
  scheduleVideoLayout();
}

function trackTitle(track) {
  return track?.edits?.title || track?.metadata?.title || track?.title || "";
}

function isVideo(track) {
  return Boolean(track?.format && track.format !== "mp3");
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
    title: trackTitle(current),
    artist: trackArtist(current),
    album: trackAlbum(current),
    artwork: artworkUrl ? [{ src: artworkUrl }] : [],
  }) : null;
}

function queueTrackButton(track, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "queue-track";
  const thumbnail = document.createElement("span");
  thumbnail.className = "thumb";
  thumbnail.setAttribute("aria-hidden", "true");
  const image = document.createElement("img");
  image.alt = "";
  image.hidden = !track.thumbnail;
  if (track.thumbnail) image.src = track.thumbnail;
  thumbnail.append(image);
  thumbnail.track = track;
  const title = document.createElement("span");
  title.className = "queue-name";
  title.textContent = queueTrackTitle(track);
  button.append(thumbnail, title);
  button.addEventListener("click", action);
  if (track.preview || !queueThumbnailObserver) showTrackThumbnail(thumbnail);
  else queueThumbnailObserver.observe(thumbnail);
  return button;
}

function queueTrackTitle(track) {
  return track.metadata || track.edits?.title || isVideo(track) ? trackTitle(track) : "読み込み中…";
}

async function showTrackThumbnail(thumbnail) {
  const track = thumbnail.track;
  track.preview ??= loadTrackPreview(track);
  await track.preview;
  if (!thumbnail.isConnected) return;
  const title = thumbnail.parentElement.querySelector(".queue-name");
  if (title) title.textContent = trackTitle(track);
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
  get("queue-now-title").textContent = trackTitle(current);
  get("queue-now-artist").textContent = trackArtist(current);
  const history = recordedCurrent ? queue.history.slice(0, -1) : queue.history;
  const historyRows = history.map((track) => {
    const row = document.createElement("li");
    row.append(queueTrackButton(track, () => {
      selectTrack(track);
      queueToggle.focus({ preventScroll: true });
    }));
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
  updateHistoryHeading();
  scheduleVideoLayout();
}

historyClear.addEventListener("click", () => {
  const playingEntry = recordedCurrent && queue.history.at(-1) === current;
  queue.history = playingEntry ? [current] : [];
  saveHistory();
  renderQueue();
  queuePanel.scrollTop = 0;
});

function queueAnchor() {
  return queueCurrent.offsetTop;
}

function scrollSide(position) {
  const difference = position - queueAnchor();
  return Math.abs(difference) <= 2 ? 0 : Math.sign(difference);
}

function updateHistoryHeading() {
  historyHeading.hidden = player.dataset.queue !== "true" || scrollSide(queuePanel.scrollTop) >= 0;
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
  const historyEnd = last ? Math.max(0, last.offsetTop + last.offsetHeight - queuePanel.clientHeight) : 0;
  const target = queuePanel.scrollTop <= threshold ? historyEnd : anchor;
  settleQueueAt(target, touch);
}

queuePanel.addEventListener("scroll", () => {
  updateHistoryHeading();
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

function showQueue(visible) {
  player.dataset.queue = String(visible);
  queueToggle.setAttribute("aria-pressed", String(visible));
  queueToggle.setAttribute("aria-label", visible ? "ジャケット表示に戻る" : "次に再生する曲を表示");
  get("artwork-stage").inert = visible;
  queuePanel.inert = !visible;
  if (visible) renderQueue(true);
  else {
    resetQueueScroll();
    updateHistoryHeading();
    cancelQueueGesture();
    queueThumbnailObserver?.disconnect();
  }
  scheduleVideoLayout();
}

function updateSelection() {
  const title = trackTitle(current);
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
    await media.play();
    if (request === playRequest) updatePlayback();
  } catch (error) {
    if (request !== playRequest) return;
    tellPlayer(error.name === "NotAllowedError"
      ? "再生ボタンを押して再生を始めてください。"
      : playbackError());
    updatePlayback();
  }
}

function clearArtwork() {
  ++artworkRequest;
  for (const image of [artwork, miniArtwork, queueArtwork, videoPoster]) {
    image.hidden = true;
    image.removeAttribute("src");
  }
  if (artworkUrl) URL.revokeObjectURL(artworkUrl);
  video.removeAttribute("poster");
  artworkUrl = null;
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

function clearSource(nextMedia = audio) {
  ++playRequest;
  seekDrag = null;
  resumePosition = null;
  media.pause();
  if (media === video) {
    if (nextMedia !== video) closeVideoExpanded();
    clearVideoTaps();
  }
  media.removeAttribute("src");
  media.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
  clearArtwork();
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
  const color = total.map((value, channel) => Math.round(value / weightTotal * .38 + [20, 36, 28][channel]));
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
  track.metadata = { title: metadata.title, artist: metadata.artist, album: metadata.album };
  if (current === track) updateSelection();
}

async function showArtwork(track) {
  const request = artworkRequest;
  try {
    const metadata = await readMediaMetadata(track);
    if (request !== artworkRequest) return;
    updateTrackMetadata(track, metadata);
    const cover = track.edits?.cover ?? (isVideo(track) ? await getVideoThumbnail(track) : metadata.artwork);
    if (request !== artworkRequest) return;
    if (!cover) {
      setBackdrop(null);
      return;
    }
    artworkUrl = URL.createObjectURL(cover);
    artwork.src = artworkUrl;
    await artwork.decode();
    if (request !== artworkRequest) return;
    if (Math.max(artwork.naturalWidth, artwork.naturalHeight) > 768) {
      const resized = await encodeCover(artwork).catch(() => null);
      if (request !== artworkRequest) return;
      if (resized) {
        URL.revokeObjectURL(artworkUrl);
        artworkUrl = URL.createObjectURL(resized);
        artwork.src = artworkUrl;
        await artwork.decode();
        if (request !== artworkRequest) return;
      }
    }
    artwork.hidden = false;
    if (isVideo(track)) {
      video.poster = artworkUrl;
      videoPoster.src = artworkUrl;
      videoPoster.hidden = false;
    }
    miniArtwork.src = artworkUrl;
    miniArtwork.hidden = false;
    queueArtwork.src = artworkUrl;
    queueArtwork.hidden = false;
    updateMediaMetadata();
    try {
      tintPlayer(artwork);
    } catch {
      // Artwork can still be shown when pixel access is restricted.
    }
    const softImage = await makeBackdrop(artwork).catch(() => null);
    if (request === artworkRequest) setBackdrop(softImage);
  } catch {
    if (request === artworkRequest) {
      clearArtwork();
      setBackdrop(null);
    }
  }
}

function selectTrack(track, followQueue = false, scope, query = "") {
  if (!track) return;
  const folder = track.folder ?? null;
  if (!followQueue) {
    playbackFolder = folder;
    playbackQuery = query;
    queue.start(scope ?? folder?.tracks ?? rootTracks(), track);
  }
  if (current !== track) {
    loadTrack(track);
  } else if (media.ended || followQueue) {
    recordedCurrent = false;
    media.currentTime = 0;
  }
  playbackTracking = true;
  tellLibrary("");
  updateSelection();
  play();
}

function loadTrack(track, position = null) {
  const nextMedia = isVideo(track) ? video : audio;
  clearSource(nextMedia);
  current = track;
  media = nextMedia;
  recordedCurrent = false;
  resumePosition = position;
  objectUrl = URL.createObjectURL(track.blob);
  media.src = objectUrl;
  showArtwork(track);
}
function move(offset) {
  if (!current) return false;
  const track = offset < 0 ? queue.back(current) : queue.forward(current);
  if (!track) return false;
  selectTrack(track, true);
  return true;
}

function togglePlayback() {
  if (!current) return;
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
  media.pause();
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

function updateStorageSummary() {
  const summary = get("storage-summary");
  if (checkingStorage) return;
  if (!database) {
    summary.textContent = "端末保存を利用できません。";
    return;
  }
  const saved = tracks.filter((track) => track.id !== undefined);
  const bytes = saved.reduce((total, track) => total + track.blob.size, 0);
  const amount = bytes >= 1_000_000 ? bytes / 1_000_000 : bytes / 1_000;
  const unit = bytes === 0 || bytes >= 1_000_000 ? "MB" : "KB";
  const formatted = new Intl.NumberFormat("ja", { maximumFractionDigits: 1 }).format(amount);
  summary.textContent = "端末に保存済み " + saved.length + "曲[" + formatted + unit + "]";
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
          track.plays = entry.plays;
          track.lastPlayed = entry.lastPlayed;
          track.videoThumbnail = entry.videoThumbnail;
        }
      }
      if (layout) {
        const order = new Map(layout.order.map((id, index) => [id, index]));
        saved.sort((first, second) => (order.get(first.id) ?? Infinity) - (order.get(second.id) ?? Infinity) || first.id - second.id);
        customTrackOrder = order.size > 0;
        for (const { name, ids } of layout.folders) {
          const folder = { name, tracks: [] };
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
    checkingStorage = false;
    filterLibrary();
  }
}

function persistLibrary() {
  if (!database) return;
  const savedIds = (entries) => entries.flatMap((track) => track.id === undefined ? [] : [track.id]);
  const layout = {
    order: customTrackOrder ? savedIds(tracks) : [],
    folders: folders.map((folder) => ({ name: folder.name, ids: savedIds(folder.tracks) })),
  };
  return trackStore.run(database, "readwrite", (store) => store.put(layout, "library"), "settings")
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
    if (customTrackOrder || track.folder) persistLibrary();
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
  const { blob, title, filename, addedAt, format } = track;
  track.id = await trackStore.run(database, "readwrite", (store) => store.add({ blob, title, filename, addedAt, format }));
  const { edits, plays, lastPlayed, videoThumbnail } = track;
  if (edits || plays || videoThumbnail) trackStore.updateDetails(database, track.id, (details) => {
    if (edits || plays) Object.assign(details, { edits, plays, lastPlayed });
    if (videoThumbnail) details.videoThumbnail = videoThumbnail;
  }).catch(() => trackFeedback(track, "曲の情報を保存できませんでした。"));
  if (queue.history.includes(track)) saveHistory();
}

async function saveDownloadedMedia(blob, filename, format) {
  await storageReady;
  if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
  const title = filename.slice(0, -(format.length + 1));
  const track = { blob, title, filename, format, addedAt: Date.now() };
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
  if (current && !playbackFolder && !playbackQuery) queue.append([track]);
  if (customTrackOrder) persistLibrary();
  search.value = "";
  tellLibrary("");
  filterLibrary();
}

async function savePCTrack({ blob, title, filename, format, pcTransferId, edits }) {
  await storageReady;
  if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
  const entry = { blob, title, filename, format, pcTransferId, addedAt: Date.now() };
  try {
    const id = await trackStore.addTransfer(database, entry, edits);
    addSavedMediaToLibrary({ ...entry, id, edits });
    return true;
  } catch (error) {
    if (error?.name === "ConstraintError") return false;
    throw new Error(error?.name === "QuotaExceededError"
      ? "端末の空き容量が足りません。保存済みの項目はライブラリに残っています。"
      : "端末に保存できませんでした。音棚を開き直してお試しください。");
  }
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
  if (saved && (customTrackOrder || folders.length)) persistLibrary();
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

async function deleteTracks(entries) {
  if (entries.some((track) => track.busy || !tracks.includes(track))) {
    tellLibrary("処理中の曲が含まれています。完了後にもう一度お試しください。");
    return false;
  }
  const savedIds = entries.filter((track) => track.id !== undefined).map((track) => track.id);
  for (const track of entries) track.busy = "delete";
  renderTracks();
  try {
    if (savedIds.length) await trackStore.deleteTracks(database, savedIds);
  } catch {
    for (const track of entries) track.busy = null;
    renderTracks();
    tellLibrary("保存した曲を削除できませんでした。アプリを開き直してからお試しください。");
    return false;
  }
  const removed = new Set(entries);
  for (const track of entries) {
    queue.remove(track, current === track);
    if (track.thumbnail) URL.revokeObjectURL(track.thumbnail);
  }
  saveHistory();
  if (removed.has(current)) {
    clearSource();
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
  for (const folder of folders) folder.tracks = folder.tracks.filter((track) => !removed.has(track));
  renderTracks();
  tellLibrary(entries.length === 1 ? "「" + trackTitle(entries[0]) + "」を音棚から削除しました。"
    : entries.length + "曲を音棚から削除しました。");
  if (customTrackOrder || folders.length) await persistLibrary();
  return true;
}

function confirmDeletion(entries) {
  if (!entries.length || entries.some((track) => track.busy) || deleteDialog.open) return;
  pendingDeletion = entries;
  deleteDialog.returnValue = "";
  get("delete-song").textContent = trackSelection?.mode === "delete"
    ? entries.length + "曲を音棚から削除します。"
    : "「" + trackTitle(entries[0]) + "」を音棚から削除します。";
  deleteDialog.showModal();
}

function setDeleteMode(enabled) {
  deleting = enabled;
  list.toggleAttribute("data-deleting", enabled);
  deleteMode.setAttribute("aria-pressed", String(enabled));
  deleteMode.setAttribute("aria-label", enabled ? "編集を完了" : "曲を編集");
  cancelLibraryGesture();
}

function showTrackMenuActions(...ids) {
  for (const button of menuActions) button.hidden = !ids.includes(button.id);
  menu.showModal();
}

function openTrackMenu(track) {
  if (!track || menu.open) return;
  menuTrack = track;
  get("menu-title").textContent = trackTitle(track);
  const saved = track.id !== undefined;
  get("menu-status").textContent = saved ? "端末に保存済み" : "このセッションで再生できます";
  get("menu-save").disabled = !database || Boolean(track.busy);
  get("menu-delete").disabled = Boolean(track.busy);
  get("menu-move-out").disabled = Boolean(track.busy);
  showTrackMenuActions("menu-details", "menu-delete", ...(saved ? [] : ["menu-save"]), ...(track.folder ? ["menu-move-out"] : []));
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

function readDetailsDuration(draft) {
  const { track } = draft;
  const show = (duration) => {
    if (detailsDraft === draft && Number.isFinite(duration) && duration > 0) {
      get("details-duration").textContent = formatTime(duration);
    }
  };
  if (current === track && Number.isFinite(media.duration)) {
    show(media.duration);
    return;
  }
  const probe = document.createElement(isVideo(track) ? "video" : "audio");
  const url = URL.createObjectURL(track.blob);
  const finish = () => {
    show(probe.duration);
    clearTimeout(timer);
    probe.onloadedmetadata = probe.onerror = null;
    probe.removeAttribute("src");
    probe.load();
    URL.revokeObjectURL(url);
  };
  const timer = setTimeout(finish, 5000);
  probe.preload = "metadata";
  probe.onloadedmetadata = probe.onerror = finish;
  probe.src = url;
}

async function openTrackDetails(track) {
  if (!tracks.includes(track) || detailsDialog.open) return;
  const draft = { track, cover: track.edits?.cover ?? null, coverRequest: 0 };
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
  readDetailsDuration(draft);
  const metadata = await readMediaMetadata(track).catch(() => ({}));
  if (detailsDraft !== draft) return;
  updateTrackMetadata(track, metadata);
  draft.originalCover = metadata.artwork;
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
  if (track.id !== undefined && track.busy !== "delete") {
    trackStore.updateDetails(database, track.id, (details) => {
      details.plays = (details.plays ?? 0) + 1;
      details.lastPlayed = Math.max(time, details.lastPlayed ?? 0);
    }).catch(() => {});
  }
}

function loadTrackPreview(track) {
  const preview = previewQueue.then(() => tracks.includes(track) ? decodeTrackPreview(track) : undefined);
  previewQueue = preview;
  return preview;
}

async function decodeTrackPreview(track) {
  try {
    const metadata = await readMediaMetadata(track);
    updateTrackMetadata(track, metadata);
    const cover = track.edits?.cover ?? (isVideo(track) ? await getVideoThumbnail(track) : metadata.artwork);
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
  const title = trackTitle(track);
  row.querySelector(".track-name").textContent = title;
  const artist = row.querySelector(".track-artist");
  artist.textContent = trackArtist(track) || trackAlbum(track);
  artist.hidden = !artist.textContent;
  row.querySelector(".more").setAttribute("aria-label", title + "の操作");
  row.querySelector(".library-handle").setAttribute("aria-label", title + "を並べ替え");
  const image = row.querySelector("img");
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

function moveIntoFolder(entries, folder) {
  for (const track of entries) {
    if (track.folder) track.folder.tracks = track.folder.tracks.filter((entry) => entry !== track);
    track.folder = folder;
    if (folder) folder.tracks.push(track);
  }
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
  return persistLibrary();
}

function showFolder(folder) {
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
}

function openFolderMenu(folder) {
  if (menu.open) return;
  menuFolder = folder;
  get("menu-title").textContent = folder.name;
  get("menu-status").textContent = folder.tracks.length + " 曲";
  get("menu-rename-folder").disabled = !database;
  showTrackMenuActions("menu-add", "menu-rename-folder");
}

function openLibraryMenu() {
  if (menu.open) return;
  const available = visibleLibraryTracks();
  get("menu-title").textContent = activeFolder ? activeFolder.name + "の設定" : "ライブラリの設定";
  get("menu-status").textContent = available.length + " 曲";
  get("menu-bulk-out").disabled = !available.length;
  get("menu-bulk-delete").disabled = !available.some((track) => !track.busy);
  showTrackMenuActions("menu-bulk-delete", ...(activeFolder ? ["menu-bulk-out"] : []));
}

function renderFolders(query) {
  folderList.replaceChildren();
  if (activeFolder || trackSelection) return;
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
    open.addEventListener("click", () => showFolder(folder));
    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "•••";
    more.setAttribute("aria-label", folder.name + "の操作");
    more.addEventListener("click", () => openFolderMenu(folder));
    row.append(open, more);
    folderList.append(row);
    const thumbnail = open.querySelector(".folder-icon");
    const first = folder.tracks[0];
    if (first) {
      thumbnail.track = first;
      if (first.thumbnail || !thumbnailObserver) showTrackThumbnail(thumbnail);
      else thumbnailObserver.observe(thumbnail);
    }
  }
}

function setTrackSelection(mode, folder = activeFolder) {
  trackSelection = mode ? { folder, mode, chosen: new Set() } : null;
  get("selection-cancel").disabled = false;
  selectionBar.hidden = !mode;
  selectionTitle.hidden = !mode;
  if (mode) {
    setDeleteMode(false);
    tellLibrary("");
    selectionTitle.textContent = { add: "フォルダへ一括追加", remove: "フォルダから一括で出す", delete: "一括削除" }[mode];
    selectionConfirm.textContent = mode === "delete" ? "削除" : "確定";
    list.dataset.selecting = mode;
    libraryScrollArea().scrollTop = 0;
  } else {
    delete list.dataset.selecting;
  }
  search.value = "";
  filterLibrary();
  (mode ? get("selection-cancel") : librarySettings).focus({ preventScroll: true });
}

function updateSelectionRow(row) {
  const button = row.querySelector(".track-select");
  if (trackSelection) button.setAttribute("aria-pressed", String(trackSelection.chosen.has(row.track)));
}

function renderTracks() {
  cancelLibraryGesture();
  thumbnailObserver?.disconnect();
  newFolder.disabled = !database;
  newFolder.hidden = Boolean(activeFolder || trackSelection);
  deleteMode.hidden = librarySettings.hidden = Boolean(trackSelection);
  librarySettings.setAttribute("aria-label", activeFolder ? "フォルダの設定" : "ライブラリの設定");
  get("folder-back").hidden = !activeFolder || Boolean(trackSelection);
  get("storage-summary").hidden = Boolean(activeFolder);
  addTracks.hidden = Boolean(activeFolder || trackSelection);
  list.replaceChildren();
  const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
  renderFolders(query);
  const libraryTracks = visibleLibraryTracks();
  deleteMode.disabled = !libraryTracks.length;
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
    select.addEventListener("click", () => {
      if (trackSelection) {
        if (trackSelection.saving || (trackSelection.mode === "delete" && track.busy)) return;
        const { chosen } = trackSelection;
        if (!chosen.delete(track)) chosen.add(track);
        selectionConfirm.disabled = !chosen.size;
        updateSelectionRow(row);
        return;
      }
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
    actions.append(more, handle);
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
    : activeFolder ? "ライブラリでフォルダの「•••」を開き、「フォルダへ一括追加」を選べます。" : "「♪」からiCloud Driveなどの音楽や動画を追加できます。";
  get("track-count").textContent = query ? matches.length + " / " + libraryTracks.length + " 曲" : libraryTracks.length + " 曲";
  updateStorageSummary();
  updateSelection();
}

async function filterLibrary() {
  const revision = ++searchRevision;
  const unchecked = search.value.trim() ? visibleLibraryTracks().filter((track) => !track.metadata) : [];
  searching = unchecked.length > 0;
  renderTracks();
  for (const track of unchecked) {
    if (revision !== searchRevision) return;
    if (track.metadata || !tracks.includes(track)) continue;
    track.searchMetadata ??= track.preview ?? readMediaMetadata(track, false)
      .then((metadata) => updateTrackMetadata(track, metadata))
      .catch(() => { track.metadata = {}; });
    await track.searchMetadata;
  }
  if (revision === searchRevision && searching) {
    searching = false;
    renderTracks();
  }
}

addTracks.addEventListener("click", () => addDialog.showModal());
picker.addEventListener("change", () => {
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
    added.push({ blob: file.slice(0, file.size, mediaFormats[format]), title, filename: file.name, addedAt: Date.now(), format, busy: "save" });
  }
  picker.value = "";
  if (added.length) {
    tracks.push(...added);
    if (current && !playbackFolder && !playbackQuery) queue.append(added);
    search.value = "";
    filterLibrary();
    tellLibrary(added.length + "曲を端末に保存しています…");
    importQueue = importQueue.then(() => saveImportedTracks(added, invalid));
  } else if (invalid) {
    tellLibrary(invalid + "件は追加できませんでした。MP3、MP4、M4V、MOV、WebMのファイルを選んでください。");
  }
});

search.addEventListener("input", filterLibrary);
function folderAtPointer(event) {
  if (!event || !deleting) return null;
  const { clientX, clientY } = event;
  if (clientY < librarySearch.getBoundingClientRect().bottom) return null;
  return Array.from(folderList.children).find((row) => {
    const { left, top, right, bottom } = row.getBoundingClientRect();
    return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  });
}

const cancelLibraryGesture = bindQueueGestures(list, libraryScrollArea, {
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
  drop(track, event) {
    if (activeFolder) return false;
    if (track.folder) return true;
    const destination = folderAtPointer(event);
    if (!destination) return false;
    Promise.resolve(moveIntoFolder([track], destination.folder)).then(renderTracks);
    return true;
  },
  reorder(track, target) {
    const neighbor = list.children[target];
    if (!deleting || !neighbor || neighbor.track === track) return;
    const row = Array.from(list.children).find((entry) => entry.track === track);
    const order = activeFolder?.tracks ?? tracks;
    const from = order.indexOf(track);
    const to = order.indexOf(neighbor.track);
    if (from < 0 || to < 0) return;
    order.splice(from, 1);
    order.splice(to, 0, track);
    if (from < to) neighbor.after(row);
    else neighbor.before(row);
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
let folderToRename = null;
function openFolderEditor(folder = null) {
  folderToRename = folder;
  get("folder-create-title").textContent = folder ? "フォルダ名を変更" : "フォルダを作成";
  folderSubmit.textContent = folder ? "保存" : "作成";
  folderName.value = folder?.name ?? "";
  folderName.setCustomValidity("");
  createFolderDialog.showModal();
}
newFolder.addEventListener("click", () => openFolderEditor());
createFolderDialog.addEventListener("close", () => {
  folderToRename = null;
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
    confirmDeletion(entries);
    return;
  }
  selection.saving = true;
  selectionConfirm.disabled = true;
  get("selection-cancel").disabled = true;
  await moveIntoFolder(entries, mode === "remove" ? null : folder);
  if (trackSelection === selection) setTrackSelection(null);
  else renderTracks();
});
deleteDialog.addEventListener("close", async () => {
  const entries = pendingDeletion;
  pendingDeletion = null;
  if (!entries || deleteDialog.returnValue !== "delete") return;
  const selection = trackSelection;
  if (selection) {
    selection.saving = true;
    get("selection-cancel").disabled = true;
  }
  const deleted = await deleteTracks(entries);
  if (selection && trackSelection === selection) {
    if (deleted) setTrackSelection(null);
    else {
      selection.saving = false;
      get("selection-cancel").disabled = false;
      renderTracks();
    }
  } else if (document.activeElement === document.body) {
    (deleteMode.disabled ? librarySettings : deleteMode).focus({ preventScroll: true });
  }
});
get("library-tab").addEventListener("click", () => showView("library"));
get("player-tab").addEventListener("click", () => showView("player"));
mobile.addEventListener("change", syncLayout);
queueToggle.addEventListener("click", () => showQueue(player.dataset.queue !== "true"));
queueCurrent.addEventListener("click", () => {
  showQueue(false);
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
  if (reducedMotion.matches || miniPlayer.hidden || media === video) return null;
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
    if (media === video) clearVideoTaps();
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
get("menu-move-out").addEventListener("click", () => {
  const track = menuTrack;
  if (!track?.folder || track.busy) return;
  closeTrackMenu(async () => {
    if (!tracks.includes(track) || track.busy) return;
    await moveIntoFolder([track], null);
    filterLibrary();
  });
});
get("menu-bulk-out").addEventListener("click", () => closeTrackMenu(() => setTrackSelection("remove")));
get("menu-bulk-delete").addEventListener("click", () => closeTrackMenu(() => setTrackSelection("delete")));
get("menu-details").addEventListener("click", () => {
  const track = menuTrack;
  if (track) closeTrackMenu(() => openTrackDetails(track));
});
detailsDialog.addEventListener("cancel", (event) => {
  if (detailsDraft?.saving) event.preventDefault();
});
get("details-cancel").addEventListener("click", () => detailsDialog.close());
detailsDialog.addEventListener("close", () => {
  if (detailsDialog.open) return;
  detailsDraft = null;
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
        clearArtwork();
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
  if (track) closeTrackMenu(() => confirmDeletion([track]));
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
  const playingInLibrary = mobile.matches && document.body.dataset.view === "library" && !miniPlayer.inert &&
    media === video && video.readyState >= 2 && video.videoWidth && video.videoHeight &&
    !video.paused && !video.ended && !video.error;
  if (!miniVideoContext || !playingInLibrary) {
    miniVideo.hidden = true;
    miniVideoTime = -Infinity;
    return;
  }
  // Sample the active video so the mini player never starts a second media stream.
  const time = video.currentTime;
  if (miniVideo.hidden || Math.abs(time - miniVideoTime) >= 1 / 30) {
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
  miniVideoFrame = requestAnimationFrame(paintMiniVideo);
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
  const preview = queued && !video.paused && !video.ended && !video.error && video.readyState >= 2 &&
    target.height > clipTop + clipBottom;
  videoStage.toggleAttribute("data-queue-preview", preview);
  for (const [key, value] of Object.entries({
    x: target.left - stage.left, y: target.top - stage.top,
    w: target.width, h: target.height, "clip-top": clipTop, "clip-bottom": clipBottom,
  })) {
    videoStage.style.setProperty("--video-" + key, value + "px");
  }
}

if (typeof ResizeObserver === "function") {
  const videoResize = new ResizeObserver(scheduleVideoLayout);
  for (const target of [videoStage.parentElement, videoSlot, queueVideoSlot, videoControls]) videoResize.observe(target);
}
window.addEventListener("resize", scheduleVideoLayout);

function updateVideoTools() {
  videoFullscreen.disabled = media !== video || video.readyState < 1 || !video.videoWidth;
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
  if (media !== video || !video.videoWidth) return;
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
for (const event of ["loadedmetadata", "loadeddata", "emptied"]) {
  video.addEventListener(event, () => {
    updateVideoTools();
    scheduleVideoLayout();
  });
}

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
  if (media !== video || !Number.isFinite(video.duration) || !video.duration) return;
  video.currentTime = Math.min(video.duration, Math.max(0, video.currentTime + start.seconds));
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

onActiveMedia("loadedmetadata", applyResumePosition);
for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
  onActiveMedia(event, updateTime);
}
for (const event of ["play", "playing", "pause"]) {
  onActiveMedia(event, updatePlayback);
}
onActiveMedia("seeked", updatePlayback);
onActiveMedia("seeked", () => rememberPlayback());
onActiveMedia("pause", () => rememberPlayback());
onActiveMedia("timeupdate", () => {
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
onActiveMedia("ended", () => {
  if (!media.ended || !current) return;
  if (!move(1)) {
    updatePlayback();
    rememberPlayback();
  }
});
onActiveMedia("error", () => {
  if (!current || !media.error) return;
  tellPlayer(playbackError());
  updatePlayback();
  updateTime();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) rememberPlayback();
});
window.addEventListener("pagehide", () => rememberPlayback());
syncLayout();
const storageReady = restoreTracks();
setupMediaDownloads(saveDownloadedMedia);
setupPCTransfer({
  async getTracks() {
    await storageReady;
    return tracks.filter((track) => track.id !== undefined);
  },
  async hasTrack(pcTransferId) {
    await storageReady;
    if (!database) throw new Error("このブラウザでは端末保存を利用できません。");
    return (await trackStore.run(database, "readonly", (store) => store.index("pcTransferId").getKey(pcTransferId))) !== undefined;
  },
  saveTrack: savePCTrack,
  displayTitle: trackTitle,
});

if (mediaSession) {
  const actions = {
    play: () => { if (media.paused || media.ended) togglePlayback(); },
    pause,
    previoustrack: () => move(-1),
    nexttrack: () => move(1),
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
