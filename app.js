"use strict";

const get = (id) => document.getElementById(id);
const audio = get("audio");
const video = get("player-video");
const videoFullscreen = get("video-fullscreen");
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
const shuffleToggle = get("shuffle-toggle");
const queueArtwork = get("queue-artwork");
const artwork = get("artwork");
const miniArtwork = get("mini-artwork");
const menu = get("track-menu");
const deleteMode = get("delete-mode");
const deleteDialog = get("delete-dialog");
const folderList = get("folders");
const newFolder = get("new-folder");
const createFolderDialog = get("folder-create");
const selectionBar = get("folder-selection");
const selectionConfirm = get("selection-confirm");
const detailsDialog = get("track-details");
const detailsSave = get("details-save");
const detailsImage = get("details-image");
const folderExclude = get("folder-exclude");
const mobile = matchMedia("(max-width: 730px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const historyScroll = { touchSide: 0, touching: false, touchUntil: 0, lastWheel: -Infinity, wheelSide: 0, wheelStopped: false };
let queueSettleTimer;
const mediaSession = navigator.mediaSession;
const tracks = [];
const folders = [];
let activeFolder = null;
let playbackFolder = null;
let menuFolder = null;
let folderSelection = null;
let customTrackOrder = false;
const queue = new PlaybackQueue();
const historyKey = "otodana-playback-history";
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
let saveToastTimer;
const marqueeRows = new WeakMap();
const marqueeObserver = typeof ResizeObserver === "function"
  ? new ResizeObserver((entries) => entries.forEach(({ target }) => measureMarquee(target))) : null;

function syncLayout() {
  const expanded = document.body.hasAttribute("data-video-expanded") ||
    (mobile.matches && document.body.dataset.view === "player");
  get("library").inert = expanded;
  miniPlayer.inert = expanded;
  player.inert = mobile.matches && !expanded;
  get("theme-color").content = expanded ? "#132a22" : "#000000";
}

function showView(view) {
  if (!mobile.matches || document.body.dataset.view === view) return;
  document.body.dataset.view = view;
  syncLayout();
  if (view === "player") player.scrollTop = 0;
  const focusTarget = view === "player" ? get("library-tab") : (current ? get("player-tab") : picker);
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
  const seconds = canSeek ? media.currentTime : 0;
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

function disposeMarquees(container) {
  for (const element of container.querySelectorAll(".marquee")) marqueeObserver?.unobserve(element);
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
  if (track.thumbnail) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = track.thumbnail;
    thumbnail.append(image);
  }
  const title = document.createElement("span");
  setMarquee(title, trackTitle(track));
  button.append(thumbnail, title);
  button.addEventListener("click", action);
  return button;
}

function renderQueue(anchor = false) {
  cancelQueueGesture();
  const scroll = queuePanel.scrollTop;
  setMarquee(get("queue-now-title"), trackTitle(current));
  setMarquee(get("queue-now-artist"), trackArtist(current), true);
  const history = recordedCurrent ? queue.history.slice(0, -1) : queue.history;
  const historyRows = history.map((track) => {
    const row = document.createElement("li");
    row.append(queueTrackButton(track, () => {
      selectTrack(track);
      queueToggle.focus({ preventScroll: true });
    }));
    return row;
  });
  disposeMarquees(get("history-list"));
  get("history-list").replaceChildren(...historyRows);
  get("history-empty").hidden = history.length > 0;
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
  disposeMarquees(queueList);
  queueList.replaceChildren(...rows);
  get("queue-empty").hidden = Boolean(rows.length);
  if (anchor) {
    historyScroll.touchSide = 0;
    releaseQueueScroll();
  }
  queuePanel.scrollTop = anchor ? queueCurrent.offsetTop : scroll;
  updateHistoryHeading();
}

function updateHistoryHeading() {
  queuePanel.dataset.history = String(queuePanel.scrollTop < queueCurrent.offsetTop - 2);
}

function scrollSide(position) {
  const difference = position - queueCurrent.offsetTop;
  return Math.abs(difference) <= 2 ? 0 : Math.sign(difference);
}

function releaseQueueScroll() {
  clearTimeout(queueSettleTimer);
  delete queuePanel.dataset.settling;
}

function settleAtCurrentTrack(fromTouch = false) {
  historyScroll.touchSide = 0;
  const top = queueCurrent.offsetTop;
  if (fromTouch) {
    // Stop the phone's existing fling; otherwise it can resume after scrollTo.
    queuePanel.dataset.settling = "";
    queuePanel.getBoundingClientRect();
    queueSettleTimer = setTimeout(releaseQueueScroll, 460);
  }
  queuePanel.scrollTo({ top, behavior: reducedMotion.matches ? "auto" : "smooth" });
}

function settleAfterTouch() {
  if (!historyScroll.touchSide || historyScroll.touching || performance.now() > historyScroll.touchUntil) return;
  const side = scrollSide(queuePanel.scrollTop);
  if (side !== historyScroll.touchSide) settleAtCurrentTrack(true);
}

queuePanel.addEventListener("scroll", () => {
  updateHistoryHeading();
  settleAfterTouch();
}, { passive: true });
queuePanel.addEventListener("touchstart", (event) => {
  releaseQueueScroll();
  historyScroll.touching = true;
  historyScroll.touchSide = event.target.closest(".queue-handle") ? 0 : scrollSide(queuePanel.scrollTop);
}, { passive: true });
queuePanel.addEventListener("touchend", (event) => {
  if (event.touches.length) return;
  historyScroll.touching = false;
  historyScroll.touchUntil = performance.now() + 950;
  settleAfterTouch();
}, { passive: true });
queuePanel.addEventListener("touchcancel", () => {
  historyScroll.touching = false;
  historyScroll.touchSide = 0;
}, { passive: true });
queuePanel.addEventListener("wheel", (event) => {
  releaseQueueScroll();
  if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
  const now = performance.now();
  if (now - historyScroll.lastWheel > 140) {
    historyScroll.wheelSide = scrollSide(queuePanel.scrollTop);
    historyScroll.wheelStopped = false;
  }
  historyScroll.lastWheel = now;
  if (historyScroll.wheelStopped) {
    event.preventDefault();
    return;
  }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? queuePanel.clientHeight : 1;
  const end = queuePanel.scrollTop + event.deltaY * unit;
  if (historyScroll.wheelSide && scrollSide(end) !== historyScroll.wheelSide) {
    event.preventDefault();
    historyScroll.wheelStopped = true;
    settleAtCurrentTrack();
  }
}, { passive: false });

function removeQueued(track) {
  queue.skip(track);
  updateSelection();
  tellPlayer("「" + trackTitle(track) + "」を再生待ちから外しました。");
}

const cancelQueueGesture = bindQueueGestures(queueList, queuePanel, {
  reorder: (track, index) => { queue.reorder(track, index); renderQueue(); },
  remove: removeQueued,
}, reducedMotion);

function showQueue(visible) {
  player.dataset.queue = String(visible);
  queueToggle.setAttribute("aria-pressed", String(visible));
  queueToggle.setAttribute("aria-label", visible ? "ジャケット表示に戻る" : "次に再生する曲を表示");
  get("artwork-stage").inert = visible;
  queuePanel.inert = !visible;
  if (visible) renderQueue(true);
  else cancelQueueGesture();
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
  get("next").disabled = !current || !queue.upcoming.length;
  get("mini-next").disabled = get("next").disabled;
  toggle.disabled = !current;
  video.hidden = !isVideo(current);
  playerCover.hidden = !video.hidden;
  player.toggleAttribute("data-video", !video.hidden);
  videoFullscreen.hidden = video.hidden;
  videoFullscreen.disabled = !video.videoWidth;
  miniPlayer.hidden = !current;
  queueToggle.hidden = !current;
  shuffleToggle.setAttribute("aria-pressed", String(queue.shuffled));
  if (player.dataset.queue === "true") {
    if (current) renderQueue();
    else showQueue(false);
  }
  document.body.dataset.hasTrack = String(Boolean(current));
  for (const row of list.children) {
    const button = row.querySelector(".track-select");
    const active = row.track === current;
    if (active === button.hasAttribute("aria-current")) continue;
    if (active) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
    measureMarquee(row.querySelector(".track-name"));
  }
  updatePlayback();
  updateTime();
  updateMediaMetadata();
}

async function play() {
  const request = ++playRequest;
  tellPlayer("");
  try {
    if (media.error) media.load();
    await media.play();
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
  for (const image of [artwork, miniArtwork, queueArtwork]) {
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
  media.pause();
  if (media === video && nextMedia !== video) closeVideoExpanded();
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
    const cover = track.edits?.cover ?? metadata.artwork;
    if (!cover) {
      setBackdrop(null);
      return;
    }
    artworkUrl = URL.createObjectURL(cover);
    artwork.src = artworkUrl;
    await artwork.decode();
    if (request !== artworkRequest) return;
    artwork.hidden = false;
    if (isVideo(track)) video.poster = artworkUrl;
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

function selectTrack(track, followQueue = false) {
  if (!track) return;
  const folder = track.folder ?? null;
  if (!followQueue && (current !== track || playbackFolder !== folder)) {
    playbackFolder = folder;
    queue.start(folder?.tracks ?? rootTracks(), track);
  }
  if (current !== track) {
    const nextMedia = isVideo(track) ? video : audio;
    clearSource(nextMedia);
    current = track;
    media = nextMedia;
    recordedCurrent = false;
    objectUrl = URL.createObjectURL(track.blob);
    media.src = objectUrl;
    showArtwork(track);
  } else if (media.ended) {
    recordedCurrent = false;
    media.currentTime = 0;
  }
  tellLibrary("");
  updateSelection();
  play();
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
  const { edits, plays, lastPlayed } = track;
  if (edits || plays) trackStore.updateDetails(database, track.id, (details) => {
    Object.assign(details, { edits, plays, lastPlayed });
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
  tracks.push(track);
  if (current && !playbackFolder) queue.append([track]);
  if (customTrackOrder) persistLibrary();
  search.value = "";
  tellLibrary("");
  filterLibrary();
  showSaveToast(1, format === "mp4" ? "件" : "曲");
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

async function deleteTrack(track) {
  if (track.busy || !tracks.includes(track)) return;
  if (track.id !== undefined) {
    track.busy = "delete";
    renderTracks();
    try {
      await trackStore.deleteTrack(database, track.id);
    } catch {
      track.busy = null;
      renderTracks();
      trackFeedback(track, "保存した曲を削除できませんでした。アプリを開き直してからお試しください。");
      return;
    }
  }
  const index = tracks.indexOf(track);
  queue.remove(track, current === track);
  saveHistory();
  if (track === current) {
    clearSource();
    setBackdrop(null);
    current = null;
    recordedCurrent = false;
    tellPlayer("");
    showView("library");
  }
  tracks.splice(index, 1);
  if (track.folder) track.folder.tracks = track.folder.tracks.filter((entry) => entry !== track);
  folderSelection?.chosen.delete(track);
  if (customTrackOrder || folders.length) persistLibrary();
  if (track.thumbnail) URL.revokeObjectURL(track.thumbnail);
  renderTracks();
  tellLibrary("「" + trackTitle(track) + "」を音棚から削除しました。");
}

function confirmDeletion(track) {
  if (track.busy || deleteDialog.open) return;
  pendingDeletion = track;
  deleteDialog.returnValue = "";
  get("delete-song").textContent = "「" + trackTitle(track) + "」を音棚から削除します。";
  deleteDialog.showModal();
}

function setDeleteMode(enabled) {
  deleting = enabled;
  list.toggleAttribute("data-deleting", enabled);
  deleteMode.textContent = enabled ? "完了" : "編集";
  folderExclude.hidden = !enabled || !activeFolder;
  cancelLibraryGesture();
}

function openTrackMenu(track) {
  if (!track || menu.open) return;
  menuTrack = track;
  get("menu-title").textContent = trackTitle(track);
  const saved = track.id !== undefined;
  get("menu-status").textContent = saved ? "端末に保存済み" : "このセッションで再生できます";
  get("menu-add").hidden = true;
  get("menu-details").hidden = false;
  get("menu-delete").hidden = false;
  get("menu-save").hidden = saved;
  get("menu-save").disabled = !database || Boolean(track.busy);
  get("menu-delete").disabled = Boolean(track.busy);
  menu.showModal();
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

async function resizeCover(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const scale = Math.min(1, 768 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", .87));
    if (!blob) throw new Error("Artwork encoding failed");
    return blob;
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

async function loadTrackPreview(track) {
  try {
    const metadata = await readMediaMetadata(track);
    updateTrackMetadata(track, metadata);
    const cover = track.edits?.cover ?? metadata.artwork;
    if (!cover || !tracks.includes(track)) return;
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

function updateTrackRow(row) {
  const track = row.track;
  const title = trackTitle(track);
  row.querySelector(".track-name").textContent = title;
  const artist = row.querySelector(".track-artist");
  artist.textContent = trackArtist(track) || trackAlbum(track) || (isVideo(track) ? track.format.toUpperCase() + " 動画" : "");
  artist.hidden = !artist.textContent;
  row.querySelector(".more").setAttribute("aria-label", title + "の操作");
  row.querySelector(".track-delete").setAttribute("aria-label", title + "を削除");
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
    prepareTrackRow(entry.target);
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

function moveIntoFolder(entries, folder) {
  for (const track of entries) {
    if (track.folder) track.folder.tracks = track.folder.tracks.filter((entry) => entry !== track);
    track.folder = folder;
    if (folder) folder.tracks.push(track);
  }
  if (current) {
    const inPlaybackScope = (track) => (track.folder ?? null) === playbackFolder;
    queue.upcoming = queue.upcoming.filter(inPlaybackScope);
    queue.previous = queue.previous.filter(inPlaybackScope);
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
  document.scrollingElement.scrollTop = 0;
  search.value = "";
  tellLibrary("");
  filterLibrary();
}

function openFolderMenu(folder) {
  if (menu.open) return;
  menuFolder = folder;
  get("menu-title").textContent = folder.name;
  get("menu-status").textContent = folder.tracks.length + " 曲";
  get("menu-add").hidden = false;
  get("menu-details").hidden = true;
  get("menu-save").hidden = true;
  get("menu-delete").hidden = true;
  menu.showModal();
}

function renderFolders(query) {
  folderList.replaceChildren();
  if (activeFolder || folderSelection) return;
  for (const folder of folders) {
    if (query && !containsQuery(folder.name, query)) continue;
    const row = document.createElement("li");
    row.className = "track folder-row";
    row.folder = folder;
    const open = document.createElement("button");
    open.type = "button";
    open.className = "track-select";
    open.innerHTML = '<span class="thumb folder-icon" aria-hidden="true"></span><span class="track-copy"><span class="track-name"></span><span class="track-artist"></span></span>';
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
  }
}

function setFolderSelection(folder, removing = false) {
  folderSelection = folder ? { folder, removing, chosen: new Set() } : null;
  get("selection-cancel").disabled = false;
  selectionBar.hidden = !folder;
  if (folder) {
    setDeleteMode(false);
    tellLibrary("");
    get("selection-title").textContent = removing ? "フォルダから曲を除外" : "フォルダへ曲を追加";
    list.dataset.selecting = removing ? "remove" : "add";
    document.scrollingElement.scrollTop = 0;
  } else {
    delete list.dataset.selecting;
  }
  search.value = "";
  filterLibrary();
  if (folder) get("selection-cancel").focus({ preventScroll: true });
  else (deleteMode.disabled ? get("library-title") : deleteMode).focus({ preventScroll: true });
}

function updateSelectionRow(row) {
  const button = row.querySelector(".track-select");
  if (folderSelection) button.setAttribute("aria-pressed", String(folderSelection.chosen.has(row.track)));
}

function renderTracks() {
  cancelLibraryGesture();
  thumbnailObserver?.disconnect();
  newFolder.disabled = !database;
  newFolder.hidden = Boolean(activeFolder || folderSelection);
  list.toggleAttribute("data-folder", Boolean(activeFolder));
  deleteMode.hidden = Boolean(folderSelection);
  get("folder-back").hidden = !activeFolder || Boolean(folderSelection);
  get("storage-summary").hidden = Boolean(activeFolder);
  picker.closest(".import").hidden = Boolean(activeFolder || folderSelection);
  get("download-open").hidden = Boolean(activeFolder || folderSelection);
  list.replaceChildren();
  const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
  renderFolders(query);
  const libraryTracks = visibleLibraryTracks();
  deleteMode.disabled = !libraryTracks.length;
  selectionConfirm.disabled = !folderSelection?.chosen.size;
  if (deleteMode.disabled && deleting) setDeleteMode(false);
  const matches = libraryTracks.filter((track) => !query || [track.title, trackTitle(track), trackArtist(track), trackAlbum(track)]
    .some((value) => value && containsQuery(value, query)));
  for (const track of matches) {
    const row = document.createElement("li");
    row.className = "track queue-row";
    row.track = track;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "track-select";
    select.innerHTML = '<span class="thumb" aria-hidden="true"><img alt="" hidden></span><span class="track-copy"><span class="track-name"></span><span class="track-artist" hidden></span></span>';
    select.addEventListener("click", () => {
      if (folderSelection) {
        if (folderSelection.saving) return;
        const { chosen } = folderSelection;
        if (!chosen.delete(track)) chosen.add(track);
        selectionConfirm.disabled = !chosen.size;
        updateSelectionRow(row);
        return;
      }
      selectTrack(track);
      showView("player");
    });

    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "•••";
    more.addEventListener("click", () => openTrackMenu(track));
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "track-delete";
    remove.disabled = Boolean(track.busy);
    remove.innerHTML = '<span aria-hidden="true"></span>';
    remove.addEventListener("click", () => confirmDeletion(track));
    const handle = document.createElement("button");
    handle.type = "button";
    handle.className = "queue-handle library-handle";
    handle.innerHTML = '<span class="queue-symbol" aria-hidden="true"></span>';
    row.append(select);
    if (track.id !== undefined) {
      const saved = document.createElement("span");
      saved.className = "saved";
      saved.textContent = "↓";
      saved.setAttribute("role", "img");
      saved.setAttribute("aria-label", "端末に保存済み");
      saved.title = "端末に保存済み";
      row.append(saved);
    }
    row.append(more, remove, handle);
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
    : activeFolder ? "ライブラリでフォルダの「•••」から曲を追加できます。" : "「ファイルを追加」からiCloud Driveなどの音楽や動画を選べます。";
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

picker.addEventListener("change", () => {
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
    if (current && !playbackFolder) queue.append(added);
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
  if (clientY < search.closest(".library-search").getBoundingClientRect().bottom) return null;
  return Array.from(folderList.children).find((row) => {
    const { left, top, right, bottom } = row.getBoundingClientRect();
    return clientX >= left && clientX <= right && clientY >= top && clientY <= bottom;
  });
}

const cancelLibraryGesture = bindQueueGestures(list, document.scrollingElement, {
  scrollDrag({ clientY }) {
    const topEdge = search.closest(".library-search").getBoundingClientRect().bottom + 24;
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
    if (current && playbackFolder === activeFolder && (current.folder ?? null) === activeFolder && !queue.shuffled) {
      queue.start(activeFolder?.tracks ?? rootTracks(), current);
      updateSelection();
    }
  },
}, reducedMotion);
deleteMode.addEventListener("click", () => setDeleteMode(!deleting));
folderExclude.addEventListener("click", () => setFolderSelection(activeFolder, true));
get("folder-back").addEventListener("click", () => showFolder(null));
const folderName = get("folder-name");
newFolder.addEventListener("click", () => {
  folderName.value = "";
  folderName.setCustomValidity("");
  createFolderDialog.showModal();
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
  folders.push({ name, tracks: [] });
  persistLibrary();
  createFolderDialog.close();
  search.value = "";
  filterLibrary();
});
get("selection-cancel").addEventListener("click", () => setFolderSelection(null));
selectionConfirm.addEventListener("click", async () => {
  if (!folderSelection) return;
  const selection = folderSelection;
  const { chosen, folder, removing } = selection;
  const entries = visibleLibraryTracks().filter((track) => chosen.has(track));
  selection.saving = true;
  selectionConfirm.disabled = true;
  get("selection-cancel").disabled = true;
  await moveIntoFolder(entries, removing ? null : folder);
  if (folderSelection === selection) setFolderSelection(null);
  else renderTracks();
});
deleteDialog.addEventListener("close", () => {
  const track = pendingDeletion;
  pendingDeletion = null;
  if (track && deleteDialog.returnValue === "delete") {
    deleteTrack(track).then(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        (deleteMode.disabled ? picker : deleteMode).focus({ preventScroll: true });
      }
    });
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
  queue.toggleShuffle(playbackFolder?.tracks ?? rootTracks());
  updateSelection();
});
const playerHeader = get("player-header");
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

playerHeader.addEventListener("pointerdown", (event) => {
  if (!mobile.matches || event.button !== 0 || event.target.closest("button") || playerDrag ||
      player.getBoundingClientRect().top > 2) return;
  clearPlayerMorph?.();
  playerDrag = { id: event.pointerId, start: event.clientY, height: player.clientHeight, distance: 0 };
  playerHeader.setPointerCapture(event.pointerId);
  player.setAttribute("data-dragging", "");
  document.body.setAttribute("data-player-dragging", "");
  paintPlayerDrag();
});
playerHeader.addEventListener("pointermove", (event) => {
  if (event.pointerId !== playerDrag?.id) return;
  playerDrag.distance = Math.min(playerDrag.height, Math.max(0, event.clientY - playerDrag.start));
  if (!playerDragFrame) playerDragFrame = requestAnimationFrame(paintPlayerDrag);
});
function finishPlayerDrag(event) {
  if (event.type === "lostpointercapture" && event.target !== playerHeader) return;
  if (event.pointerId !== playerDrag?.id) return;
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
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
  playerHeader.addEventListener(event, finishPlayerDrag);
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
  if (folder) closeTrackMenu(() => setFolderSelection(folder));
});
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
  if (track) closeTrackMenu(() => confirmDeletion(track));
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
  if (!seek.disabled) media.currentTime = seek.valueAsNumber;
});

function setVideoExpanded(expanded) {
  document.body.toggleAttribute("data-video-expanded", expanded);
  videoFullscreen.textContent = expanded ? "全画面を閉じる" : "動画を全画面";
  syncLayout();
}

function closeVideoExpanded() {
  if (!document.body.hasAttribute("data-video-expanded")) return;
  setVideoExpanded(false);
  if (document.fullscreenElement === player) document.exitFullscreen().catch(() => {});
}

videoFullscreen.addEventListener("click", async () => {
  if (media !== video || !video.videoWidth) return;
  if (document.body.hasAttribute("data-video-expanded")) {
    closeVideoExpanded();
    return;
  }
  if (player.dataset.queue === "true") showQueue(false);
  setVideoExpanded(true);
  if (document.fullscreenEnabled && typeof player.requestFullscreen === "function") {
    try {
      await player.requestFullscreen();
      if (!document.body.hasAttribute("data-video-expanded") && document.fullscreenElement === player) {
        await document.exitFullscreen();
      }
    } catch {
      // Keep the app's full-viewport layout if browser fullscreen is unavailable.
    }
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !document.body.hasAttribute("data-video-expanded")) return;
  closeVideoExpanded();
  videoFullscreen.focus({ preventScroll: true });
});
player.addEventListener("fullscreenchange", () => {
  if (document.fullscreenElement !== player && document.body.hasAttribute("data-video-expanded")) setVideoExpanded(false);
});
video.addEventListener("loadedmetadata", () => {
  if (media === video) videoFullscreen.disabled = !video.videoWidth;
});

function onActiveMedia(event, handler) {
  for (const element of [audio, video]) {
    element.addEventListener(event, () => {
      if (media === element) handler();
    });
  }
}

for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
  onActiveMedia(event, updateTime);
}
for (const event of ["play", "playing", "pause"]) {
  onActiveMedia(event, updatePlayback);
}
onActiveMedia("playing", () => {
  if (!current || recordedCurrent) return;
  recordedCurrent = true;
  recordPlay(current);
  queue.record(current);
  saveHistory();
  if (player.dataset.queue === "true") renderQueue(true);
});
onActiveMedia("ended", () => {
  if (!media.ended || !current) return;
  if (!move(1)) {
    updatePlayback();
    tellPlayer("一覧の最後まで再生しました。");
  }
});
onActiveMedia("error", () => {
  if (!current || !media.error) return;
  tellPlayer(playbackError());
  updatePlayback();
  updateTime();
});

syncLayout();
const storageReady = restoreTracks();
setupMediaDownloads(saveDownloadedMedia);

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
