"use strict";

const get = (id) => document.getElementById(id);
const audio = get("audio");
const picker = get("file-picker");
const list = get("tracks");
const search = get("search");
const seek = get("seek");
const toggle = get("toggle");
const miniToggle = get("mini-toggle");
const miniPlayer = get("mini-player");
const player = get("player");
const volume = get("volume");
const queueToggle = get("queue-toggle");
const queuePanel = get("queue-panel");
const queueCurrent = get("queue-current");
const queueList = get("queue-list");
const shuffleToggle = get("shuffle-toggle");
const queueArtwork = get("queue-artwork");
const artwork = get("artwork");
const miniArtwork = get("mini-artwork");
const menu = get("track-menu");
const mobile = matchMedia("(max-width: 730px)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const historyScroll = { touchSide: 0, touching: false, touchUntil: 0, lastWheel: -Infinity, wheelSide: 0, wheelStopped: false };
let queueSettleTimer;
const mediaSession = navigator.mediaSession;
const tracks = [];
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
let searchRevision = 0;
let searching = false;
let recordedCurrent = false;
let backdrop = null;
let importQueue = Promise.resolve();
let saveToastTimer;

function syncLayout() {
  const expanded = mobile.matches && document.body.dataset.view === "player";
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

function setupVolume() {
  const appleMobile = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
  let adjustable = false;
  if (!appleMobile) {
    const probe = document.createElement("audio");
    try {
      probe.volume = .5;
      adjustable = probe.volume === .5;
    } catch {
      // Show the device controls if the browser does not expose volume.
    }
  }
  get("volume-control").hidden = !adjustable;
  get("system-volume").hidden = adjustable;
  if (!adjustable) return;
  const updateVolume = () => {
    const percent = Math.round(audio.volume * 100);
    volume.value = percent;
    document.body.style.setProperty("--volume-progress", percent + "%");
    get("volume-value").value = percent + "%";
  };
  volume.addEventListener("input", () => { audio.volume = volume.valueAsNumber / 100; });
  audio.addEventListener("volumechange", updateVolume);
  updateVolume();
}

function tellPlayer(message) {
  get("player-message").textContent = message;
  if (message && mobile.matches && document.body.dataset.view === "library") tellLibrary(message);
}

function formatTime(seconds) {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return minutes + ":" + remainder;
}

function updateTime() {
  const canSeek = Boolean(current) && !audio.error && Number.isFinite(audio.duration) && audio.duration > 0;
  const seconds = canSeek ? audio.currentTime : 0;
  const duration = canSeek ? audio.duration : 0;
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
  const playing = Boolean(current) && !audio.paused && !audio.ended && !audio.error;
  for (const button of [toggle, miniToggle]) {
    button.firstElementChild.dataset.playing = String(playing);
    button.setAttribute("aria-label", playing ? "一時停止" : "再生");
  }
}

function trackTitle(track) {
  return track?.metadata?.title || track?.title || "";
}

function setOptionalText(id, value) {
  const element = get(id);
  element.textContent = value || "";
  element.hidden = !value;
}

function updateMediaMetadata() {
  if (!mediaSession || typeof MediaMetadata !== "function") return;
  mediaSession.metadata = current ? new MediaMetadata({
    title: trackTitle(current),
    artist: current.metadata?.artist || "",
    album: current.metadata?.album || "",
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
  title.textContent = trackTitle(track);
  button.append(thumbnail, title);
  button.addEventListener("click", action);
  return button;
}

function renderQueue(anchor = false) {
  cancelQueueGesture();
  const scroll = queuePanel.scrollTop;
  get("queue-now-title").textContent = trackTitle(current);
  get("queue-now-artist").textContent = current?.metadata?.artist || "";
  const history = recordedCurrent ? queue.history.slice(0, -1) : queue.history;
  const historyRows = history.map((track) => {
    const row = document.createElement("li");
    row.append(queueTrackButton(track, () => {
      selectTrack(track);
      queueToggle.focus({ preventScroll: true });
    }));
    return row;
  });
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
  const artist = current?.metadata?.artist;
  get("now-playing").textContent = title || "曲を選んでください";
  setOptionalText("playing-artist", artist);
  setOptionalText("playing-album", current?.metadata?.album);
  get("mini-title").textContent = title;
  get("mini-artist").textContent = artist || "再生画面を開く";
  get("previous").disabled = !current || !queue.previous.length;
  get("next").disabled = !current || !queue.upcoming.length;
  get("mini-next").disabled = get("next").disabled;
  toggle.disabled = !current;
  miniPlayer.hidden = !current;
  get("player-actions").hidden = !current;
  queueToggle.hidden = !current;
  shuffleToggle.setAttribute("aria-pressed", String(queue.shuffled));
  if (player.dataset.queue === "true") {
    if (current) renderQueue();
    else showQueue(false);
  }
  document.body.dataset.hasTrack = String(Boolean(current));
  for (const row of list.children) {
    const button = row.querySelector(".track-select");
    if (row.track === current) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  }
  updatePlayback();
  updateTime();
  updateMediaMetadata();
}

async function play() {
  const request = ++playRequest;
  tellPlayer("");
  try {
    if (audio.error) audio.load();
    await audio.play();
  } catch (error) {
    if (request !== playRequest) return;
    tellPlayer(error.name === "NotAllowedError"
      ? "再生ボタンを押して再生を始めてください。"
      : "この曲を再生できません。ファイルを確認するか、別の曲を選んでください。");
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
    }, reducedMotion.matches ? 0 : 460);
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

function clearSource() {
  ++playRequest;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
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

function updateTrackMetadata(track, metadata) {
  track.metadata = { title: metadata.title, artist: metadata.artist, album: metadata.album };
  if (current === track) updateSelection();
}

async function showArtwork(track) {
  const request = artworkRequest;
  try {
    const metadata = await readTrackMetadata(track.blob);
    if (request !== artworkRequest) return;
    updateTrackMetadata(track, metadata);
    if (!metadata.artwork) {
      setBackdrop(null);
      return;
    }
    artworkUrl = URL.createObjectURL(metadata.artwork);
    artwork.src = artworkUrl;
    await artwork.decode();
    if (request !== artworkRequest) return;
    artwork.hidden = false;
    miniArtwork.src = artworkUrl;
    miniArtwork.hidden = false;
    queueArtwork.src = artworkUrl;
    queueArtwork.hidden = false;
    setBackdrop(metadata.artwork);
    updateMediaMetadata();
    try {
      tintPlayer(artwork);
    } catch {
      // Artwork can still be shown when pixel access is restricted.
    }
  } catch {
    if (request === artworkRequest) {
      clearArtwork();
      setBackdrop(null);
    }
  }
}

function selectTrack(track, followQueue = false) {
  if (!track) return;
  if (current !== track) {
    if (!followQueue) queue.start(tracks, track);
    clearSource();
    current = track;
    recordedCurrent = false;
    objectUrl = URL.createObjectURL(track.blob);
    audio.src = objectUrl;
    showArtwork(track);
  } else if (audio.ended) {
    audio.currentTime = 0;
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
  if (audio.paused || audio.ended || audio.error) {
    if (audio.ended) audio.currentTime = 0;
    play();
  } else {
    pause();
  }
}

function pause() {
  ++playRequest;
  audio.pause();
}

function tellLibrary(message) {
  get("library-message").textContent = message;
}

function showSaveToast(saved) {
  const toast = get("save-toast");
  clearTimeout(saveToastTimer);
  toast.textContent = saved + "曲を追加して端末に保存しました。";
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
      const saved = await trackStore.run(connection, "readonly", (store) => store.getAll());
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
  const { blob, title } = track;
  track.id = await trackStore.run(database, "readwrite", (store) => store.add({ blob, title }));
  if (queue.history.includes(track)) saveHistory();
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
  renderTracks();
  const failed = added.length - saved;
  const message = [
    failed ? failed + "曲は端末に保存できませんでした。この画面では再生できます。" : "",
    failed && (full ? "空き容量を増やしてから「端末に保存」で再試行できます。" :
      database ? "曲の「端末に保存」から再試行できます。" : "音棚を開き直してから再試行してください。"),
    invalid ? invalid + "件は追加できませんでした。空でないMP3を選んでください。" : "",
  ];
  tellLibrary(message.filter(Boolean).join(" "));
  if (saved) showSaveToast(saved);
}

async function deleteTrack(track) {
  if (track.busy) return;
  if (track.id !== undefined) {
    track.busy = "delete";
    renderTracks();
    try {
      await trackStore.run(database, "readwrite", (store) => store.delete(track.id));
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
  if (track.thumbnail) URL.revokeObjectURL(track.thumbnail);
  renderTracks();
  tellLibrary("「" + trackTitle(track) + "」を音棚から削除しました。");
}

function openTrackMenu(track) {
  if (!track || menu.open) return;
  menuTrack = track;
  get("menu-title").textContent = trackTitle(track);
  const saved = track.id !== undefined;
  get("menu-status").textContent = saved ? "端末に保存済み" : "このセッションで再生できます";
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
    afterClose?.();
  };
  if (reducedMotion.matches) finish();
  else {
    menu.setAttribute("data-closing", "");
    setTimeout(finish, 170);
  }
}

async function loadTrackPreview(track) {
  try {
    const metadata = await readTrackMetadata(track.blob);
    updateTrackMetadata(track, metadata);
    if (!metadata.artwork || !tracks.includes(track)) return;
    const image = new Image();
    const url = URL.createObjectURL(metadata.artwork);
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
  artist.textContent = track.metadata?.artist || track.metadata?.album || "";
  artist.hidden = !artist.textContent;
  row.querySelector(".more").setAttribute("aria-label", title + "の操作");
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

function renderTracks() {
  thumbnailObserver?.disconnect();
  list.replaceChildren();
  const query = search.value.trim().normalize("NFKC").toLocaleLowerCase("ja");
  const matches = tracks.filter((track) => !query || [track.title, track.metadata?.title, track.metadata?.artist]
    .some((value) => value && containsQuery(value, query)));
  for (const track of matches) {
    const row = document.createElement("li");
    row.className = "track";
    row.track = track;
    const select = document.createElement("button");
    select.type = "button";
    select.className = "track-select";
    select.innerHTML = '<span class="thumb" aria-hidden="true"><img alt="" hidden></span><span class="track-copy"><span class="track-name"></span><span class="track-artist" hidden></span></span>';
    select.addEventListener("click", () => selectTrack(track));

    const more = document.createElement("button");
    more.type = "button";
    more.className = "more";
    more.textContent = "•••";
    more.addEventListener("click", () => openTrackMenu(track));
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
    row.append(more);
    updateTrackRow(row);
    list.append(row);
    if (!track.preview && thumbnailObserver) thumbnailObserver.observe(row);
    else prepareTrackRow(row);
  }
  get("empty-library").hidden = matches.length > 0;
  get("empty-title").textContent = searching ? "曲を検索しています…" : query ? "該当する曲がありません" : "曲がありません";
  get("empty-help").textContent = searching ? "" : query
    ? "別の曲名やアーティスト名で探してください。"
    : "「MP3を追加」からiCloud Driveなどの曲を選べます。";
  get("track-count").textContent = query ? matches.length + " / " + tracks.length + " 曲" : tracks.length + " 曲";
  updateStorageSummary();
  updateSelection();
}

async function filterLibrary() {
  const revision = ++searchRevision;
  const unchecked = search.value.trim() ? tracks.filter((track) => !track.metadata) : [];
  searching = unchecked.length > 0;
  renderTracks();
  for (const track of unchecked) {
    if (revision !== searchRevision) return;
    if (track.metadata || !tracks.includes(track)) continue;
    track.searchMetadata ??= track.preview ?? readTrackMetadata(track.blob, false)
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
    if (!/\.mp3$/i.test(file.name) || file.size === 0) {
      ++invalid;
      continue;
    }
    const title = file.name.slice(0, -4).trim() || file.name;
    added.push({ blob: file.slice(0, file.size, "audio/mpeg"), title, busy: "save" });
  }
  picker.value = "";
  if (added.length) {
    tracks.push(...added);
    if (current) queue.append(added);
    search.value = "";
    filterLibrary();
    tellLibrary(added.length + "曲を端末に保存しています…");
    importQueue = importQueue.then(() => saveImportedTracks(added, invalid));
  } else if (invalid) {
    tellLibrary(invalid + "件は追加できませんでした。空でないMP3を選んでください。");
  }
});

search.addEventListener("input", filterLibrary);
get("library-tab").addEventListener("click", () => showView("library"));
get("player-tab").addEventListener("click", () => showView("player"));
mobile.addEventListener("change", syncLayout);
queueToggle.addEventListener("click", () => showQueue(player.dataset.queue !== "true"));
queueCurrent.addEventListener("click", () => {
  showQueue(false);
  queueToggle.focus({ preventScroll: true });
});
shuffleToggle.addEventListener("click", () => {
  queue.toggleShuffle(tracks);
  updateSelection();
});
const playerHeader = get("player-header");
let playerDrag = null;
playerHeader.addEventListener("pointerdown", (event) => {
  if (!mobile.matches || event.button !== 0 ||
      event.target.closest("button") || playerDrag) return;
  playerDrag = { id: event.pointerId, start: event.clientY };
  playerHeader.setPointerCapture(event.pointerId);
  player.setAttribute("data-dragging", "");
});
playerHeader.addEventListener("pointermove", (event) => {
  if (event.pointerId !== playerDrag?.id || reducedMotion.matches) return;
  player.style.setProperty("--player-drag", Math.max(0, event.clientY - playerDrag.start) + "px");
});
function finishPlayerDrag(event) {
  if (event.pointerId !== playerDrag?.id) return;
  const dismiss = event.type === "pointerup" && event.clientY - playerDrag.start >= 66;
  playerDrag = null;
  player.removeAttribute("data-dragging");
  player.style.removeProperty("--player-drag");
  if (dismiss) showView("library");
}
for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) {
  playerHeader.addEventListener(event, finishPlayerDrag);
}
get("player-actions").addEventListener("click", () => openTrackMenu(current));
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
get("menu-delete").addEventListener("click", () => {
  const track = menuTrack;
  if (track) closeTrackMenu(() => deleteTrack(track));
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
  if (!seek.disabled) audio.currentTime = seek.valueAsNumber;
});

for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
  audio.addEventListener(event, updateTime);
}
for (const event of ["play", "playing", "pause"]) {
  audio.addEventListener(event, updatePlayback);
}
audio.addEventListener("playing", () => {
  if (!current || recordedCurrent) return;
  recordedCurrent = true;
  queue.record(current);
  saveHistory();
  if (player.dataset.queue === "true") renderQueue(true);
});
audio.addEventListener("ended", () => {
  if (!audio.ended || !current) return;
  if (!move(1)) {
    updatePlayback();
    tellPlayer("一覧の最後まで再生しました。");
  }
});
audio.addEventListener("error", () => {
  if (!current || !audio.error) return;
  tellPlayer("この曲を再生できません。ファイルを確認するか、別の曲を選んでください。");
  updatePlayback();
  updateTime();
});

syncLayout();
setupVolume();
const storageReady = restoreTracks();

if (mediaSession) {
  const actions = {
    play: () => { if (audio.paused || audio.ended) togglePlayback(); },
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
