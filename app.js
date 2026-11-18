"use strict";

const get = (id) => document.getElementById(id);
const audio = get("audio");
const picker = get("file-picker");
const list = get("tracks");
const seek = get("seek");
const toggle = get("toggle");
const tracks = [];
let current = null;
let objectUrl = null;
let playRequest = 0;

function showView(view) {
  document.body.dataset.view = view;
  get("library-tab").setAttribute("aria-pressed", String(view === "library"));
  get("player-tab").setAttribute("aria-pressed", String(view === "player"));
}

function tellPlayer(message) {
  get("player-message").textContent = message;
}

function formatTime(seconds) {
  const whole = Math.floor(Math.max(0, seconds));
  const minutes = Math.floor(whole / 60);
  const remainder = String(whole % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function updateTime() {
  const canSeek = Boolean(current) && !audio.error && Number.isFinite(audio.duration) && audio.duration > 0;
  const seconds = canSeek ? audio.currentTime : 0;
  const duration = canSeek ? audio.duration : 0;
  seek.disabled = !canSeek;
  seek.max = duration || 1;
  seek.value = seconds;
  const elapsed = formatTime(seconds);
  const total = formatTime(duration);
  get("elapsed").textContent = elapsed;
  get("duration").textContent = total;
  seek.setAttribute("aria-valuetext", `${total}のうち${elapsed}`);
}

function updatePlayback() {
  const playing = Boolean(current) && !audio.paused && !audio.ended && !audio.error;
  toggle.firstElementChild.textContent = playing ? "Ⅱ" : "▶";
  toggle.setAttribute("aria-label", playing ? "一時停止" : "再生");
}

function updateSelection() {
  const index = tracks.indexOf(current);
  get("now-playing").textContent = current?.title ?? "曲を選んでください";
  get("position-in-list").textContent = current ? `${index + 1} / ${tracks.length} 曲` : "";
  get("previous").disabled = index <= 0;
  get("next").disabled = index < 0 || index + 1 >= tracks.length;
  toggle.disabled = !current;
  for (const [rowIndex, row] of Array.from(list.children).entries()) {
    if (rowIndex === index) row.firstElementChild.setAttribute("aria-current", "true");
    else row.firstElementChild.removeAttribute("aria-current");
  }
  updatePlayback();
  updateTime();
}

async function play() {
  const request = ++playRequest;
  tellPlayer("");
  try {
    if (audio.error) audio.load();
    await audio.play();
  } catch (error) {
    if (request !== playRequest) return;
    if (error.name === "NotAllowedError") {
      tellPlayer("再生ボタンを押して再生を始めてください。");
    } else {
      tellPlayer("この曲を再生できません。ファイルを確認するか、別の曲を選んでください。");
    }
    updatePlayback();
  }
}

function clearSource() {
  ++playRequest;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = null;
}

function selectTrack(track) {
  if (current !== track) {
    clearSource();
    current = track;
    objectUrl = URL.createObjectURL(track.file);
    audio.src = objectUrl;
  } else if (audio.ended) {
    audio.currentTime = 0;
  }
  updateSelection();
  play();
}

function move(offset) {
  if (!current) return false;
  const track = tracks[tracks.indexOf(current) + offset];
  if (!track) return false;
  selectTrack(track);
  return true;
}

function deleteTrack(track) {
  const index = tracks.indexOf(track);
  if (track === current) {
    clearSource();
    current = null;
    tellPlayer("");
  }
  tracks.splice(index, 1);
  renderTracks();
  const focusTarget = list.children[Math.min(index, tracks.length - 1)]?.querySelector(".delete");
  (focusTarget ?? picker).focus();
  get("library-message").textContent = `「${track.title}」を一覧から削除しました。`;
}

function renderTracks() {
  list.replaceChildren();
  for (const [index, track] of tracks.entries()) {
    const row = document.createElement("li");
    row.className = "track";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "track-select";
    const number = document.createElement("span");
    number.className = "track-number";
    number.setAttribute("aria-hidden", "true");
    number.textContent = index + 1;
    const name = document.createElement("span");
    name.className = "track-name";
    name.textContent = track.title;
    select.append(number, name);
    select.addEventListener("click", () => {
      showView("player");
      selectTrack(track);
      if (matchMedia("(max-width: 730px)").matches) toggle.focus();
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "delete";
    remove.textContent = "削除";
    remove.setAttribute("aria-label", `${track.title}を一覧から削除`);
    remove.addEventListener("click", () => deleteTrack(track));
    row.append(select, remove);
    list.append(row);
  }
  get("empty-library").hidden = tracks.length > 0;
  get("track-count").textContent = `${tracks.length} 曲`;
  updateSelection();
}

picker.addEventListener("change", () => {
  let added = 0;
  let invalid = 0;
  for (const file of picker.files) {
    if (!/\.mp3$/i.test(file.name) || file.size === 0) {
      ++invalid;
      continue;
    }
    const title = file.name.slice(0, -4).trim() || file.name;
    tracks.push({ file, title });
    ++added;
  }
  picker.value = "";
  if (added) renderTracks();
  const result = added ? `${added}曲を追加しました。` : "";
  const skipped = invalid ? `${invalid}件を追加できませんでした。空でないMP3ファイルを選んでください。` : "";
  get("library-message").textContent = result + skipped;
});

get("library-tab").addEventListener("click", () => showView("library"));
get("player-tab").addEventListener("click", () => showView("player"));
get("previous").addEventListener("click", () => move(-1));
get("next").addEventListener("click", () => move(1));
toggle.addEventListener("click", () => {
  if (!current) return;
  if (audio.paused || audio.ended || audio.error) {
    if (audio.ended) audio.currentTime = 0;
    play();
  } else {
    ++playRequest;
    audio.pause();
  }
});
seek.addEventListener("input", () => {
  if (!seek.disabled) audio.currentTime = seek.valueAsNumber;
});

for (const event of ["loadedmetadata", "durationchange", "timeupdate", "seeked"]) {
  audio.addEventListener(event, updateTime);
}
for (const event of ["play", "playing", "pause"]) {
  audio.addEventListener(event, updatePlayback);
}
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

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("./sw.js").catch((error) => {
    console.warn("オフライン起動の準備に失敗しました。", error);
  });
}
