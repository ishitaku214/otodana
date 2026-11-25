"use strict";

const pcTransferPath = "/api/pc-transfer";
const pcTransferLimit = 128_000_000;
const pcTransferChunk = 16_384;
const pcTransferChannel = "otodana-pc-v1";
const pcTransferCode = /^(?:[a-z0-9]{4}|[a-f0-9]{12})$/i;
const pcTransferIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9]\d*$/;

function waitForPCTransfer(delay, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, delay);
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForPeerConnection(test, signal, timeout, interval = 100) {
  const deadline = performance.now() + timeout;
  while (!test()) {
    if (performance.now() >= deadline) {
      throw new Error("端末同士を接続できませんでした。同じWi-Fiで両方の音棚を開いたままお試しください。");
    }
    await waitForPCTransfer(interval, signal);
  }
  signal.throwIfAborted();
}

async function pcLocalDescription(peer, description, signal) {
  await peer.setLocalDescription(description);
  await waitForPeerConnection(() => peer.iceGatheringState === "complete", signal, 15_000);
  return peer.localDescription.sdp;
}

function pcTransferInbox(channel, signal) {
  const messages = [];
  let pending;
  let failure;
  function stop(error) {
    failure = error;
    pending?.reject(error);
  }
  channel.addEventListener("message", ({ data }) => {
    if (failure) return;
    if (pending) {
      pending.resolve(data);
    } else if (messages.length < 256) {
      messages.push(data);
    } else {
      stop(new Error("受け取りが追いつきませんでした。もう一度お試しください。"));
      channel.close();
    }
  });
  channel.addEventListener("close", () => stop(new Error("転送が切断されました。保存済みの項目はライブラリに残っています。")));
  signal.addEventListener("abort", () => stop(signal.reason), { once: true });
  return async () => {
    signal.throwIfAborted();
    if (messages.length) return messages.shift();
    if (failure) throw failure;
    const data = await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      const timer = setTimeout(() => pending.reject(new Error("転送が止まりました。両方の画面を開いたまま、もう一度お試しください。")), 45_000);
      pending.resolve = (value) => { clearTimeout(timer); pending = null; resolve(value); };
      pending.reject = (error) => { clearTimeout(timer); pending = null; reject(error); };
    });
    return data;
  };
}

function pcTransferMessage(data) {
  if (typeof data !== "string" || data.length > 5000) throw new Error("転送データを読み込めませんでした。");
  const message = JSON.parse(data);
  if (!message || typeof message.type !== "string") throw new Error("転送データを読み込めませんでした。");
  if (message.type === "error") throw new Error(String(message.message || "相手の端末で転送を中止しました。").slice(0, 300));
  return message;
}

function pcTrackInfo(track, deviceId, displayTitle) {
  const storedFilename = typeof track.filename === "string" && track.filename.trim();
  const blobFilename = typeof track.blob.name === "string" && track.blob.name.trim();
  const originalName = storedFilename || blobFilename || "";
  const extension = originalName.match(/\.([a-z0-9]+)$/i)?.[1].toLowerCase();
  let format = track.format;
  if (!Object.hasOwn(mediaFormats, format)) {
    format = Object.hasOwn(mediaFormats, extension) ? extension
      : Object.keys(mediaFormats).find((key) => mediaFormats[key] === track.blob.type) ?? "mp3";
  }
  const fallbackTitle = format === "mp3" ? "曲" : "動画";
  const title = [displayTitle, track.title, originalName.replace(/\.[a-z0-9]+$/i, "")]
    .find((value) => typeof value === "string" && value.trim())?.trim() || fallbackTitle;
  const basename = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim() || fallbackTitle;
  const filename = originalName.slice(0, 300) || basename.slice(0, 299 - format.length) + "." + format;
  const entry = {
    type: "item",
    title: title.slice(0, 300),
    filename,
    bytes: track.blob.size,
    format,
    pcTransferId: track.pcTransferId ?? deviceId + ":" + track.id,
  };
  if (track.edits) {
    entry.edits = {};
    for (const key of ["title", "artist", "album"]) {
      if (typeof track.edits[key] === "string") entry.edits[key] = track.edits[key].slice(0, 300);
    }
  }
  return entry;
}

function validatePCTrack(item) {
  function shortText(text) {
    return typeof text === "string" && text.length <= 300;
  }
  if (item.type !== "item" || !Number.isSafeInteger(item.bytes) || item.bytes < 1 || item.bytes > pcTransferLimit ||
      !shortText(item.title) || !shortText(item.filename) || !item.filename ||
      typeof item.format !== "string" || !Object.hasOwn(mediaFormats, item.format) ||
      typeof item.pcTransferId !== "string" || !pcTransferIdPattern.test(item.pcTransferId)) {
    throw new Error("音棚で扱えないファイル情報を受け取りました。");
  }
  const { title, filename, format, pcTransferId, bytes } = item;
  const edits = {};
  for (const key of ["title", "artist", "album"]) {
    if (shortText(item.edits?.[key])) edits[key] = item.edits[key];
  }
  return { title, filename, format, pcTransferId, bytes, edits: Object.keys(edits).length ? edits : undefined };
}

async function sendPCMedia(channel, next, selected, readTitle, signal, showProgress) {
  const deviceKey = "otodana-pc-transfer-device";
  let deviceId = localStorage.getItem(deviceKey);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(deviceKey, deviceId);
  }
  let saved = 0;
  let skipped = 0;
  for (const [index, track] of selected.entries()) {
    signal.throwIfAborted();
    const title = await readTitle(track);
    signal.throwIfAborted();
    const item = pcTrackInfo(track, deviceId, title);
    channel.send(JSON.stringify(item));
    const reply = pcTransferMessage(await next());
    if (reply.type === "skip") {
      skipped++;
      continue;
    }
    if (reply.type !== "ready") throw new Error("受け取り先の応答を確認できませんでした。");
    const status = `${index + 1} / ${selected.length} 件目「${item.title}」を送信中…`;
    showProgress(status, 0);
    for (let sent = 0; sent < item.bytes;) {
      await waitForPeerConnection(() => channel.bufferedAmount <= 512_000 || channel.readyState !== "open", signal, 45_000, 30);
      const bytes = await track.blob.slice(sent, sent + pcTransferChunk).arrayBuffer();
      signal.throwIfAborted();
      channel.send(bytes);
      sent += bytes.byteLength;
      showProgress(status, sent / item.bytes * 100);
    }
    channel.send(JSON.stringify({ type: "end" }));
    const result = pcTransferMessage(await next());
    if (result.type === "stored") saved++;
    else if (result.type === "skip") skipped++;
    else throw new Error("受け取り先での保存を確認できませんでした。");
  }
  channel.send(JSON.stringify({ type: "done" }));
  if (pcTransferMessage(await next()).type !== "complete") throw new Error("転送の完了を確認できませんでした。");
  return { saved, skipped };
}

async function receivePCMedia(channel, next, library, signal, showProgress) {
  let saved = 0;
  let skipped = 0;
  for (let message = pcTransferMessage(await next()); message.type !== "done"; message = pcTransferMessage(await next())) {
    const { bytes, ...entry } = validatePCTrack(message);
    if (await library.hasTrack(entry.pcTransferId)) {
      channel.send(JSON.stringify({ type: "skip" }));
      skipped++;
      continue;
    }
    const status = `「${entry.edits?.title || entry.title || entry.filename}」を受信中…`;
    showProgress(status, 0);
    channel.send(JSON.stringify({ type: "ready" }));
    const parts = [];
    let received = 0;
    while (received < bytes) {
      const data = await next();
      if (typeof data === "string") pcTransferMessage(data);
      if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > pcTransferChunk || received + data.byteLength > bytes) {
        throw new Error("転送されたファイルの容量が一致しませんでした。");
      }
      parts.push(data);
      received += data.byteLength;
      showProgress(status, received / bytes * 100);
    }
    if (pcTransferMessage(await next()).type !== "end") throw new Error("ファイルの最後まで受け取れませんでした。");
    showProgress("端末に保存中…", 100);
    signal.throwIfAborted();
    const blob = new Blob(parts, { type: mediaFormats[entry.format] });
    if (await library.saveTrack({ ...entry, blob })) {
      channel.send(JSON.stringify({ type: "stored" }));
      saved++;
    } else {
      channel.send(JSON.stringify({ type: "skip" }));
      skipped++;
    }
  }
  channel.send(JSON.stringify({ type: "complete" }));
  // The sender closes after it receives the final acknowledgement.
  await waitForPeerConnection(() => channel.readyState === "closed", signal, 3000).catch(() => {});
  return { saved, skipped };
}

function setupPCTransfer(library) {
  const find = (id) => document.getElementById("pc-transfer-" + id);
  const dialog = find("dialog");
  const send = find("send");
  const receive = find("receive");
  const sender = find("sender");
  const list = find("tracks");
  const selectAll = find("select-all");
  const clearAll = find("clear-all");
  const folderBack = find("folder-back");
  const create = find("create");
  const connect = find("connect");
  const input = find("input");
  const codeDisplay = find("code");
  const progress = find("progress");
  const status = find("status");
  const cancel = find("cancel");
  const chosen = new Set();
  const visibleChoices = new Map();
  let contents = { root: [], folders: [] };
  let folder = null;
  let choicesRevision = 0;
  let controller;
  let lastProgress = 0;

  const artworkObserver = "IntersectionObserver" in window ? new IntersectionObserver((entries, observer) => {
    for (const { target, isIntersecting } of entries) {
      if (!isIntersecting) continue;
      observer.unobserve(target);
      target.loadArtwork();
    }
  }, { root: list, rootMargin: "64px" }) : null;

  function showProgress(message, value) {
    if (typeof value !== "number" || status.textContent !== message || value === 100 || performance.now() - lastProgress > 100) {
      if (status.textContent !== message) status.textContent = message;
      progress.hidden = typeof value !== "number";
      if (!progress.hidden) progress.value = value;
      lastProgress = performance.now();
    }
  }

  function selectedTracks() {
    return [...contents.folders.flatMap((entry) => entry.tracks), ...contents.root].filter((track) => chosen.has(track));
  }

  function normalizedCode() {
    const code = input.value.trim().replaceAll("-", "");
    return code.length === 4 ? code.toLowerCase() : code.toUpperCase();
  }

  function updateControls() {
    const busy = Boolean(controller);
    create.disabled = busy || !chosen.size;
    connect.disabled = busy || !pcTransferCode.test(normalizedCode());
    const visible = [...visibleChoices.keys()];
    selectAll.disabled = busy || visible.every((track) => chosen.has(track));
    clearAll.disabled = busy || !visible.some((track) => chosen.has(track));
    const count = chosen.size ? chosen.size + "件選択中" : "";
    if (find("count").textContent !== count) find("count").textContent = count;
    for (const element of [send, receive, input, find("settings"), folderBack, ...list.querySelectorAll("button"), ...visibleChoices.values()]) {
      element.disabled = busy;
    }
    cancel.hidden = !busy;
  }

  function choiceArtwork(track, forFolder = false, updateCopy) {
    const artwork = document.createElement("span");
    artwork.className = forFolder ? "thumb folder-icon" : "thumb";
    artwork.setAttribute("aria-hidden", "true");
    const image = new Image();
    image.alt = "";
    image.hidden = !track?.thumbnail;
    if (track?.thumbnail) image.src = track.thumbnail;
    artwork.append(image);
    if (track) {
      artwork.track = track;
      artwork.loadArtwork = async () => {
        await library.showThumbnail(artwork);
        if (artwork.isConnected) updateCopy?.();
      };
      if (artworkObserver && !track.preview) artworkObserver.observe(artwork);
      else artwork.loadArtwork();
    }
    return artwork;
  }

  function folderChoice(entry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pc-transfer-folder";
    button.innerHTML = '<span class="track-copy"><span class="track-name"></span><span class="track-artist"></span></span><span aria-hidden="true" class="pc-transfer-chevron">›</span>';
    button.querySelector(".track-name").textContent = entry.name;
    button.querySelector(".track-artist").textContent = entry.tracks.length + " 曲";
    button.prepend(choiceArtwork(entry.tracks[0], true));
    button.addEventListener("click", () => {
      folder = entry;
      renderChoices();
      folderBack.focus({ preventScroll: true });
    });
    return button;
  }

  function trackChoice(track) {
    const row = document.createElement("label");
    row.className = "pc-transfer-track";
    row.innerHTML = '<input type="checkbox"><span class="track-copy"><span class="track-name"></span><span class="track-artist" hidden></span></span><small></small>';
    const checkbox = row.firstElementChild;
    const title = row.querySelector(".track-name");
    const artist = row.querySelector(".track-artist");
    const size = row.querySelector("small");
    const bytes = track.blob?.size;
    const canSend = track.id !== undefined && bytes > 0 && bytes <= pcTransferLimit;
    function updateCopy() {
      title.textContent = library.displayTitle(track) || track.filename || track.blob?.name || "名前のない項目";
      artist.textContent = library.displayArtist(track);
      artist.hidden = !artist.textContent;
    }
    updateCopy();
    row.insertBefore(choiceArtwork(track, false, updateCopy), checkbox.nextElementSibling);
    size.textContent = canSend ? (bytes / 1_000_000).toFixed(1) + " MB"
      : bytes > pcTransferLimit ? "容量上限を超過" : "転送できません";
    checkbox.checked = chosen.has(track);
    checkbox.disabled = !canSend;
    if (canSend) {
      visibleChoices.set(track, checkbox);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) chosen.add(track);
        else chosen.delete(track);
        updateControls();
      });
    }
    return row;
  }

  function renderChoices() {
    artworkObserver?.disconnect();
    visibleChoices.clear();
    find("folder-heading").hidden = !folder;
    find("folder-name").textContent = folder?.name ?? "";
    const entries = folder?.tracks ?? contents.root;
    const folderButtons = folder ? [] : contents.folders.map(folderChoice);
    list.replaceChildren(...folderButtons, ...entries.map(trackChoice));
    list.scrollTop = 0;
    find("selection").textContent = folder && !entries.length ? "このフォルダに曲がありません。"
      : !folderButtons.length && !entries.length ? "この端末のライブラリに曲がありません。"
      : "送るファイルを選んでください。1件128 MBまで。";
    updateControls();
  }

  async function loadChoices() {
    const revision = ++choicesRevision;
    chosen.clear();
    folder = null;
    contents = { root: [], folders: [] };
    renderChoices();
    find("selection").textContent = "ライブラリを読み込んでいます…";
    try {
      const loaded = await library.getLibrary();
      if (revision !== choicesRevision || sender.hidden || !dialog.open) return;
      contents = loaded;
      renderChoices();
    } catch {
      if (revision === choicesRevision) find("selection").textContent = "ライブラリを読み込めませんでした。";
    }
  }

  function selectVisible(checked) {
    for (const [track, checkbox] of visibleChoices) {
      checkbox.checked = checked;
      if (checked) chosen.add(track);
      else chosen.delete(track);
    }
    updateControls();
  }

  function selectMode(sending) {
    if (sending && !sender.hidden) return;
    sender.hidden = !sending;
    find("receiver").hidden = sending;
    send.setAttribute("aria-pressed", sending);
    receive.setAttribute("aria-pressed", !sending);
    showProgress("");
    if (sending) loadChoices();
    else {
      choicesRevision++;
      artworkObserver?.disconnect();
    }
  }

  async function run(sending) {
    if (controller) return;
    if (!window.isSecureContext || location.protocol === "file:" || !window.RTCPeerConnection) {
      showProgress("同期するには、公開版の音棚を対応するブラウザで開いてください。");
      return;
    }
    const session = new AbortController();
    controller = session;
    const { signal } = session;
    let peer;
    let channel;
    let next;
    let request;
    let room;
    let pairingTimer;
    const selected = sending ? selectedTracks() : [];
    const enteredCode = normalizedCode();
    updateControls();
    function useChannel(opened) {
      channel = opened;
      channel.binaryType = "arraybuffer";
      next = pcTransferInbox(channel, signal);
    }
    try {
      showProgress("接続先を確認中…");
      request = await createDownloadRequest(readDownloadConnection(), signal, showProgress);
      peer = new RTCPeerConnection({ iceServers: [] });
      pairingTimer = setTimeout(() => session.abort(new Error("接続の待ち時間が過ぎました。新しいコードでお試しください。")), 180_000);
      if (sending) {
        useChannel(peer.createDataChannel(pcTransferChannel));
        const offer = await pcLocalDescription(peer, await peer.createOffer(), signal);
        const created = await request(pcTransferPath, { method: "POST", body: { offer, shortCode: true } });
        const { code } = await created.json();
        if (typeof code !== "string" || !pcTransferCode.test(code)) throw new Error("転送コードを発行できませんでした。");
        room = pcTransferPath + "/" + code;
        codeDisplay.value = code.toLowerCase().match(/.{4}/g).join("-");
        find("pair").hidden = false;
        dialog.scrollTop = 0;
        showProgress("受け取る端末でコードを入力してください。");
        while (true) {
          const pending = await request(room);
          const { answer } = await pending.json();
          if (answer) {
            await peer.setRemoteDescription({ type: "answer", sdp: answer });
            break;
          }
          await waitForPCTransfer(1200, signal);
        }
      } else {
        const path = pcTransferPath + "/" + enteredCode;
        const invitation = await request(path);
        const { offer } = await invitation.json();
        if (typeof offer !== "string") throw new Error("転送コードを確認できませんでした。");
        peer.addEventListener("datachannel", ({ channel: opened }) => {
          if (opened.label === pcTransferChannel && !channel) useChannel(opened);
          else opened.close();
        });
        await peer.setRemoteDescription({ type: "offer", sdp: offer });
        const answer = await pcLocalDescription(peer, await peer.createAnswer(), signal);
        await request(path, { method: "POST", body: { answer } });
      }
      showProgress("端末同士を接続中…");
      await waitForPeerConnection(() => channel?.readyState === "open", signal, 25_000);
      clearTimeout(pairingTimer);
      if (room) {
        // A connected pair no longer needs the server.
        request(room, { method: "DELETE", requestSignal: AbortSignal.timeout(5000) }).catch(() => {});
        room = undefined;
        find("pair").hidden = true;
      }
      const result = sending
        ? await sendPCMedia(channel, next, selected, library.readTitle, signal, showProgress)
        : await receivePCMedia(channel, next, library, signal, showProgress);
      const skipped = result.skipped ? ` すでに保存済みの ${result.skipped} 件を省きました。` : "";
      showProgress(`${result.saved} 件を${sending ? "送信" : "端末に保存"}しました。` + skipped);
    } catch (error) {
      const message = String(signal.aborted ? signal.reason?.message : error?.message || "転送に失敗しました。");
      if (!signal.aborted && channel?.readyState === "open") {
        channel.send(JSON.stringify({ type: "error", message: message.slice(0, 300) }));
      }
      if (dialog.open) showProgress(message);
    } finally {
      clearTimeout(pairingTimer);
      channel?.close();
      peer?.close();
      if (room) request(room, { method: "DELETE", requestSignal: AbortSignal.timeout(5000) }).catch(() => {});
      controller = null;
      find("pair").hidden = true;
      updateControls();
    }
  }

  find("open").addEventListener("click", () => {
    document.getElementById("add-dialog").close();
    input.value = "";
    selectMode(false);
    dialog.showModal();
    updateControls();
  });
  send.addEventListener("click", () => selectMode(true));
  receive.addEventListener("click", () => selectMode(false));
  selectAll.addEventListener("click", () => selectVisible(true));
  clearAll.addEventListener("click", () => selectVisible(false));
  folderBack.addEventListener("click", () => {
    const previous = folder;
    folder = null;
    renderChoices();
    list.children[contents.folders.indexOf(previous)]?.focus({ preventScroll: true });
  });
  input.addEventListener("input", updateControls);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !connect.disabled) connect.click();
  });
  create.addEventListener("click", () => run(true));
  connect.addEventListener("click", () => run(false));
  cancel.addEventListener("click", () => controller?.abort(new Error("転送を中止しました。保存済みの項目はライブラリに残っています。")));
  dialog.addEventListener("close", () => {
    choicesRevision++;
    artworkObserver?.disconnect();
    cancel.click();
  });
}
