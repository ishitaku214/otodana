"use strict";

const pcTransferPath = "/api/pc-transfer";
const pcTransferChunk = 16_384;
const pcTransferIdleTimeout = 120_000;
const pcTransferInterrupted = "同期が中断されました。両方で音棚を開き、新しい転送コードで再開してください。保存済みのファイルは再送されません。";
const pcTransferChannel = "otodana-pc-v1";
const pcTransferFolderChannel = "otodana-pc-v2";
const pcLegacyTransferLimit = 128_000_000;
const pcTransferBlobPart = 2 * 1024 * 1024;
const pcTransferDetailsVersion = 1;
const pcTransferDetailsLimit = 256 * 1024;
const pcTransferArtworkLimit = 2_000_000;
const pcTransferArtworkNames = ["sourceCover", "videoThumbnail", "editedCover"];
const pcTransferTextFields = ["title", "artist", "album"];
const pcTransferCode = /^(?:[a-z0-9]{4}|[a-f0-9]{12})$/i;
const pcTransferIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:[1-9]\d*$/;
const pcTransferFolderIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

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

async function waitForPeerConnection(test, signal, timeout, interval = 100, message = "端末同士を接続できませんでした。同じWi-Fiで両方の音棚を開いたままお試しください。") {
  const deadline = performance.now() + timeout;
  while (!test()) {
    if (performance.now() >= deadline) {
      throw new Error(message);
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
  channel.addEventListener("close", () => stop(new Error(pcTransferInterrupted)));
  signal.addEventListener("abort", () => stop(signal.reason), { once: true });
  return async () => {
    signal.throwIfAborted();
    if (messages.length) return messages.shift();
    if (failure) throw failure;
    const data = await new Promise((resolve, reject) => {
      pending = { resolve, reject };
      const timer = setTimeout(() => pending.reject(new Error(pcTransferInterrupted)), pcTransferIdleTimeout);
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
  const fallbackTitle = mediaFormats[format].startsWith("video/") ? "動画" : "曲";
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
    detailsVersion: pcTransferDetailsVersion,
  };
  if (track.edits) {
    entry.edits = {};
    for (const key of pcTransferTextFields) {
      if (typeof track.edits[key] === "string") entry.edits[key] = track.edits[key].slice(0, 300);
    }
  }
  return entry;
}

function validatePCTrack(item) {
  function shortText(text) {
    return typeof text === "string" && text.length <= 300;
  }
  if (item.type !== "item" || !Number.isSafeInteger(item.bytes) || item.bytes < 1 ||
      !shortText(item.title) || !shortText(item.filename) || !item.filename ||
      typeof item.format !== "string" || !Object.hasOwn(mediaFormats, item.format) ||
      typeof item.pcTransferId !== "string" || !pcTransferIdPattern.test(item.pcTransferId)) {
    throw new Error("音棚で扱えないファイル情報を受け取りました。");
  }
  const { title, filename, format, pcTransferId, bytes } = item;
  const edits = {};
  for (const key of pcTransferTextFields) {
    if (shortText(item.edits?.[key])) edits[key] = item.edits[key];
  }
  return { title, filename, format, pcTransferId, bytes, edits: Object.keys(edits).length ? edits : undefined };
}

function pcTransferTextFieldsOf(value, maxLength) {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(pcTransferTextFields
    .filter((key) => typeof value[key] === "string" && value[key].length <= maxLength)
    .map((key) => [key, value[key]]));
}

function isPCArtworkType(type) {
  return ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type);
}

function pcTrackDetails(track, item) {
  const metadata = new Blob([JSON.stringify({
    title: typeof track.title === "string" ? track.title : item.title,
    filename: typeof track.filename === "string" && track.filename.trim() ? track.filename : item.filename,
    addedAt: track.addedAt,
    plays: track.plays,
    lastPlayed: track.lastPlayed,
    durationSeconds: track.durationSeconds,
    metadata: pcTransferTextFieldsOf(track.metadata, 8192),
    edits: pcTransferTextFieldsOf(track.edits, 300),
  })]);
  if (metadata.size > pcTransferDetailsLimit) throw new Error("曲の情報が大きすぎるため転送できません。");
  const covers = [track.sourceCover, track.videoThumbnail, track.edits?.cover];
  const images = [];
  const parts = [metadata];
  for (const [index, cover] of covers.entries()) {
    if (!cover) continue;
    if (!(cover instanceof Blob) || !cover.size || cover.size > pcTransferArtworkLimit || !isPCArtworkType(cover.type)) {
      throw new Error("ジャケット画像の形式または容量を確認してください。");
    }
    images.push({ name: pcTransferArtworkNames[index], bytes: cover.size, mime: cover.type });
    parts.push(cover);
  }
  return { header: { type: "details", bytes: metadata.size, images }, parts };
}

async function receivePCBlob(next, bytes, mime, onChunk) {
  const parts = [];
  let chunks = [];
  let bufferedBytes = 0;
  let received = 0;
  while (received < bytes) {
    const data = await next();
    if (typeof data === "string") pcTransferMessage(data);
    if (!(data instanceof ArrayBuffer) || !data.byteLength || data.byteLength > pcTransferChunk || received + data.byteLength > bytes) {
      throw new Error("転送されたファイルの容量が一致しませんでした。");
    }
    chunks.push(data);
    bufferedBytes += data.byteLength;
    if (bufferedBytes >= pcTransferBlobPart) {
      parts.push(new Blob(chunks));
      chunks = [];
      bufferedBytes = 0;
    }
    received += data.byteLength;
    onChunk(data.byteLength);
  }
  return new Blob([...parts, ...chunks], { type: mime });
}

function validatePCDetailsHeader(header) {
  if (header.type !== "details" || !Number.isSafeInteger(header.bytes) || header.bytes < 1 || header.bytes > pcTransferDetailsLimit ||
      !Array.isArray(header.images) || header.images.length > pcTransferArtworkNames.length) {
    throw new Error("転送された曲の情報を読み込めませんでした。");
  }
  const names = new Set();
  let total = header.bytes;
  for (const image of header.images) {
    if (!pcTransferArtworkNames.includes(image?.name) || names.has(image.name) || !isPCArtworkType(image.mime) ||
        !Number.isSafeInteger(image.bytes) || image.bytes < 1 || image.bytes > pcTransferArtworkLimit) {
      throw new Error("転送されたジャケット画像の情報を読み込めませんでした。");
    }
    names.add(image.name);
    total += image.bytes;
  }
  return total;
}

async function receivePCDetails(header, next, onChunk) {
  const mediaInfo = JSON.parse(await (await receivePCBlob(next, header.bytes, "", onChunk)).text());
  if (!mediaInfo || typeof mediaInfo.title !== "string" || typeof mediaInfo.filename !== "string" || !mediaInfo.filename ||
      mediaInfo.title.length > pcTransferDetailsLimit || mediaInfo.filename.length > pcTransferDetailsLimit) {
    throw new Error("転送された曲名またはファイル名を読み込めませんでした。");
  }
  const { title, filename, addedAt, plays, lastPlayed, durationSeconds } = mediaInfo;
  const details = {
    title, filename,
    addedAt: Number.isSafeInteger(addedAt) && addedAt >= 0 && addedAt <= 8.64e15 ? addedAt : undefined,
    plays: Number.isSafeInteger(plays) && plays >= 0 ? plays : undefined,
    lastPlayed: Number.isSafeInteger(lastPlayed) && lastPlayed >= 0 && lastPlayed <= 8.64e15 ? lastPlayed : undefined,
    durationSeconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : undefined,
    metadata: pcTransferTextFieldsOf(mediaInfo.metadata, 8192),
    edits: pcTransferTextFieldsOf(mediaInfo.edits, 300),
  };
  for (const { name, bytes, mime } of header.images) {
    const image = await receivePCBlob(next, bytes, mime, onChunk);
    if (name === "editedCover") (details.edits ??= {}).cover = image;
    else details[name] = image;
  }
  return details;
}

async function sendPCBlob(channel, blob, signal, onChunk = () => {}) {
  for (let offset = 0; offset < blob.size;) {
    await waitForPeerConnection(() => channel.bufferedAmount <= 512_000 || channel.readyState !== "open", signal, pcTransferIdleTimeout, 30, pcTransferInterrupted);
    if (channel.readyState !== "open") throw new Error(pcTransferInterrupted);
    const bytes = await blob.slice(offset, offset + pcTransferChunk).arrayBuffer();
    signal.throwIfAborted();
    channel.send(bytes);
    offset += bytes.byteLength;
    onChunk(bytes.byteLength);
  }
}

async function sendPCFolder(channel, next, folder, signal) {
  const { name, cover, pcTransferId: id } = folder;
  if (cover && (!cover.size || cover.size > pcTransferArtworkLimit || !isPCArtworkType(cover.type))) {
    throw new Error("フォルダのジャケット画像の形式または容量を確認してください。");
  }
  channel.send(JSON.stringify({ type: "folder", id, name, cover: cover ? { bytes: cover.size, mime: cover.type } : null }));
  if (cover) await sendPCBlob(channel, cover, signal);
  if (pcTransferMessage(await next()).type !== "folder-stored") throw new Error("受け取り先でのフォルダ作成を確認できませんでした。");
}

async function receivePCFolder(message, next, library, signal) {
  const { id, name, cover } = message;
  if (typeof id !== "string" || !pcTransferFolderIdPattern.test(id) || typeof name !== "string" || !name.trim() || name.length > 80 ||
      (cover && (!Number.isSafeInteger(cover.bytes) || cover.bytes < 1 || cover.bytes > pcTransferArtworkLimit || !isPCArtworkType(cover.mime)))) {
    throw new Error("転送されたフォルダ情報を読み込めませんでした。");
  }
  const artwork = cover ? await receivePCBlob(next, cover.bytes, cover.mime, () => {}) : null;
  signal.throwIfAborted();
  return library.saveFolder({ name, cover: artwork, pcTransferId: id });
}

async function sendPCMedia(channel, next, selected, library, signal, showProgress) {
  const deviceKey = "otodana-pc-transfer-device";
  let deviceId = localStorage.getItem(deviceKey);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    localStorage.setItem(deviceKey, deviceId);
  }
  let saved = 0;
  let skipped = 0;
  let updated = 0;
  for (const folder of selected.folders) {
    signal.throwIfAborted();
    await sendPCFolder(channel, next, folder, signal);
  }
  for (const [index, { track, folder }] of selected.items.entries()) {
    signal.throwIfAborted();
    const title = await library.prepareTrack(track);
    signal.throwIfAborted();
    const item = pcTrackInfo(track, deviceId, title);
    if (folder) item.folderId = folder.pcTransferId;
    channel.send(JSON.stringify(item));
    const reply = pcTransferMessage(await next());
    if (reply.type === "skip") {
      skipped++;
      continue;
    }
    if (reply.type !== "ready") throw new Error("受け取り先の応答を確認できませんでした。");
    const details = reply.detailsVersion === pcTransferDetailsVersion ? pcTrackDetails(track, item) : null;
    const metadataOnly = Boolean(details && reply.metadataOnly === true);
    const parts = details ? [...details.parts] : [];
    if (!metadataOnly) parts.push(track.blob);
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    const status = `${index + 1} / ${selected.items.length} 件目「${item.title}」${metadataOnly ? "の曲情報" : ""}を送信中…`;
    showProgress(status, 0);
    if (details) channel.send(JSON.stringify(details.header));
    let sent = 0;
    for (const part of parts) {
      await sendPCBlob(channel, part, signal, (bytes) => {
        sent += bytes;
        showProgress(status, sent / total * 100);
      });
    }
    channel.send(JSON.stringify({ type: "end" }));
    let result = pcTransferMessage(await next());
    while (result.type === "saving") result = pcTransferMessage(await next());
    if (result.type === "stored") saved++;
    else if (result.type === "updated" && metadataOnly) updated++;
    else if (result.type === "skip") skipped++;
    else throw new Error("受け取り先での保存を確認できませんでした。");
  }
  channel.send(JSON.stringify({ type: "done" }));
  let result = pcTransferMessage(await next());
  while (result.type === "saving") result = pcTransferMessage(await next());
  if (result.type !== "complete") throw new Error("転送の完了を確認できませんでした。");
  return { saved, updated, skipped, folders: selected.folders.length };
}

async function receivePCMedia(channel, next, library, signal, showProgress) {
  let saved = 0;
  let skipped = 0;
  let updated = 0;
  const supportsFolders = channel.label === pcTransferFolderChannel;
  const receivedFolders = new Map();
  for (let message = pcTransferMessage(await next()); message.type !== "done"; message = pcTransferMessage(await next())) {
    if (supportsFolders && message.type === "folder") {
      if (receivedFolders.has(message.id)) throw new Error("同じフォルダ情報が重複して届きました。");
      const folder = await receivePCFolder(message, next, library, signal);
      receivedFolders.set(message.id, { folder, order: [] });
      channel.send(JSON.stringify({ type: "folder-stored" }));
      continue;
    }
    const { bytes, ...entry } = validatePCTrack(message);
    const destination = receivedFolders.get(message.folderId);
    if (message.folderId !== undefined && !destination) throw new Error("転送された曲の保存先フォルダを確認できませんでした。");
    const versioned = message.detailsVersion === pcTransferDetailsVersion;
    const existing = await library.hasTrack(entry.pcTransferId);
    if (existing && !versioned) {
      channel.send(JSON.stringify({ type: "skip" }));
      skipped++;
      continue;
    }
    const status = `「${entry.edits?.title || entry.title || entry.filename}」${existing ? "の曲情報" : ""}を受信中…`;
    showProgress(status, 0);
    channel.send(JSON.stringify({ type: "ready", ...(versioned && { detailsVersion: pcTransferDetailsVersion, metadataOnly: existing }) }));
    let total = existing ? 0 : bytes;
    let received = 0;
    const onChunk = (size) => {
      received += size;
      showProgress(status, received / total * 100);
    };
    if (versioned) {
      const header = pcTransferMessage(await next());
      total += validatePCDetailsHeader(header);
      Object.assign(entry, await receivePCDetails(header, next, onChunk));
    }
    const blob = existing ? undefined : await receivePCBlob(next, bytes, mediaFormats[entry.format], onChunk);
    if (pcTransferMessage(await next()).type !== "end") throw new Error("ファイルの最後まで受け取れませんでした。");
    showProgress("端末に保存中…", 100);
    signal.throwIfAborted();
    const save = async () => library.saveTrack({ ...entry, blob }, destination?.folder);
    if (await (supportsFolders ? keepPCSenderWaiting(channel, save) : save())) {
      destination?.order.push(entry.pcTransferId);
      channel.send(JSON.stringify({ type: existing ? "updated" : "stored" }));
      if (existing) updated++;
      else saved++;
    } else {
      channel.send(JSON.stringify({ type: "skip" }));
      skipped++;
    }
  }
  if (receivedFolders.size) {
    await keepPCSenderWaiting(channel, async () => {
      for (const { folder, order } of receivedFolders.values()) await library.orderFolder(folder, order);
    });
  }
  channel.send(JSON.stringify({ type: "complete" }));
  // The sender closes after it receives the final acknowledgement.
  await waitForPeerConnection(() => channel.readyState === "closed", signal, 3000).catch(() => {});
  return { saved, updated, skipped, folders: receivedFolders.size };
}

async function keepPCSenderWaiting(channel, operation) {
  const timer = setInterval(() => {
    if (channel.readyState === "open") channel.send(JSON.stringify({ type: "saving" }));
  }, 8000);
  try { return await operation(); }
  finally { clearInterval(timer); }
}

function canSendPCTrack(track) {
  return track.id !== undefined && Number.isSafeInteger(track.blob?.size) && track.blob.size > 0;
}

function setupPCTransfer(library, setScreenActivity) {
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
  const screenNote = find("screen-note");
  const selection = find("selection");
  const cancel = find("cancel");
  const chosen = new Set();
  const chosenFolders = new Set();
  const visibleChoices = new Map();
  const visibleFolderChoices = new Map();
  let contents = { root: [], folders: [] };
  let folder = null;
  let rangeAnchor = null;
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

  function selectedMedia() {
    const items = contents.folders.flatMap((entry) => entry.tracks.filter((track) => chosen.has(track))
      .map((track) => ({ track, folder: chosenFolders.has(entry) ? entry : null })));
    items.push(...contents.root.filter((track) => chosen.has(track)).map((track) => ({ track })));
    return { items, folders: contents.folders.filter((entry) => chosenFolders.has(entry)) };
  }

  function chooseFolder(entry, checked) {
    if (checked) chosenFolders.add(entry);
    else chosenFolders.delete(entry);
    for (const track of entry.tracks) {
      if (!canSendPCTrack(track)) continue;
      if (checked) chosen.add(track);
      else chosen.delete(track);
    }
  }

  function normalizedCode() {
    const code = input.value.trim().replaceAll("-", "");
    return code.length === 4 ? code.toLowerCase() : code.toUpperCase();
  }

  function updateControls() {
    const busy = Boolean(controller);
    create.disabled = busy || (!chosen.size && !chosenFolders.size);
    connect.disabled = busy || !pcTransferCode.test(normalizedCode());
    const visible = [...visibleChoices.keys()];
    selectAll.disabled = busy || visible.every((track) => chosen.has(track));
    clearAll.disabled = busy || !visible.some((track) => chosen.has(track));
    const count = chosenFolders.size ? `${chosenFolders.size}フォルダ・${chosen.size}件選択中` : chosen.size ? chosen.size + "件選択中" : "";
    if (find("count").textContent !== count) find("count").textContent = count;
    for (const element of [send, receive, input, find("settings"), folderBack, ...list.querySelectorAll("button"), ...visibleChoices.values()]) {
      element.disabled = busy;
    }
    for (const [entry, checkbox] of visibleFolderChoices) {
      checkbox.disabled = busy;
      checkbox.checked = chosenFolders.has(entry);
      checkbox.indeterminate = !checkbox.checked && entry.tracks.some((track) => chosen.has(track));
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
    const row = document.createElement("div");
    row.className = "pc-transfer-folder-row";
    const selectFolder = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.setAttribute("aria-label", entry.name + "をフォルダごと選択");
    selectFolder.append(checkbox);
    visibleFolderChoices.set(entry, checkbox);
    checkbox.addEventListener("change", () => {
      chooseFolder(entry, checkbox.checked);
      updateControls();
    });
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pc-transfer-folder";
    button.innerHTML = '<span class="track-copy"><span class="track-name"></span><span class="track-artist"></span></span><small></small><span aria-hidden="true" class="pc-transfer-chevron">›</span>';
    button.querySelector(".track-name").textContent = entry.name;
    button.querySelector(".track-artist").textContent = entry.tracks.length + " 曲";
    button.querySelector("small").textContent = displayDownloadSize(entry.size);
    button.prepend(choiceArtwork(entry.tracks[0], true));
    button.addEventListener("click", () => {
      folder = entry;
      renderChoices();
      folderBack.focus({ preventScroll: true });
    });
    row.append(selectFolder, button);
    return row;
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
    const canSend = canSendPCTrack(track);
    function updateCopy() {
      title.textContent = library.displayTitle(track) || track.filename || track.blob?.name || "名前のない項目";
      artist.textContent = library.displayArtist(track);
      artist.hidden = !artist.textContent;
    }
    updateCopy();
    row.insertBefore(choiceArtwork(track, false, updateCopy), checkbox.nextElementSibling);
    size.textContent = canSend ? displayDownloadSize(bytes) : "転送できません";
    checkbox.checked = chosen.has(track);
    checkbox.disabled = !canSend;
    if (canSend) {
      visibleChoices.set(track, checkbox);
      row.addEventListener("click", (event) => {
        if (checkbox.disabled) return;
        const range = event.shiftKey && rangeAnchor
          ? library.selectionRange([...visibleChoices.keys()], rangeAnchor, track) : [];
        if (range.length) {
          // Suppress the label's forwarded click. A direct checkbox click has already toggled it.
          if (event.target !== checkbox) {
            event.preventDefault();
            checkbox.focus({ preventScroll: true });
          }
          for (const item of range) {
            chosen.add(item);
            visibleChoices.get(item).checked = true;
          }
          updateControls();
          return;
        }
        if (event.target !== checkbox) return;
        if (checkbox.checked) chosen.add(track);
        else {
          chosen.delete(track);
          if (folder) chosenFolders.delete(folder);
        }
        rangeAnchor = track;
        updateControls();
      });
    }
    return row;
  }

  function renderChoices() {
    artworkObserver?.disconnect();
    visibleChoices.clear();
    visibleFolderChoices.clear();
    rangeAnchor = null;
    find("folder-heading").hidden = !folder;
    find("folder-name").textContent = folder?.name ?? "";
    const entries = folder?.tracks ?? contents.root;
    const folderButtons = folder ? [] : contents.folders.map(folderChoice);
    list.replaceChildren(...folderButtons, ...entries.map(trackChoice));
    list.scrollTop = 0;
    selection.textContent = folder && !entries.length ? "このフォルダに曲がありません。"
      : !folderButtons.length && !entries.length ? "この端末のライブラリに曲がありません。"
      : "送るフォルダやファイルを選んでください。";
    updateControls();
  }

  async function loadChoices() {
    const revision = ++choicesRevision;
    chosen.clear();
    chosenFolders.clear();
    folder = null;
    contents = { root: [], folders: [] };
    renderChoices();
    selection.textContent = "ライブラリを読み込んでいます…";
    selection.setAttribute("data-loading", "");
    try {
      const loaded = await library.getLibrary();
      if (revision !== choicesRevision || sender.hidden || !dialog.open) return;
      contents = loaded;
      renderChoices();
    } catch {
      if (revision === choicesRevision) selection.textContent = "ライブラリを読み込めませんでした。";
    } finally {
      if (revision === choicesRevision) selection.removeAttribute("data-loading");
    }
  }

  function selectVisible(checked) {
    rangeAnchor = null;
    if (!checked && folder) chosenFolders.delete(folder);
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
      selection.removeAttribute("data-loading");
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
    const selected = sending ? selectedMedia() : null;
    const extended = sending && (selected.folders.length > 0 || selected.items.some(({ track }) => track.blob.size > pcLegacyTransferLimit));
    const enteredCode = normalizedCode();
    updateControls();
    status.setAttribute("data-loading", "");
    if (matchMedia("(pointer: coarse)").matches || navigator.standalone === true) {
      screenNote.textContent = "同期が終わるまで、音棚を開いたままにしてください。";
      screenNote.hidden = false;
    }
    setScreenActivity("transfer", true, (locked) => {
      if (screenNote.hidden) return;
      const message = locked
        ? "画面の自動ロックを抑えています。同期が終わるまで音棚を開いてください。"
        : "画面の自動ロックを防げません。同期が終わるまで画面を点灯させてください。";
      if (screenNote.textContent !== message) screenNote.textContent = message;
    });
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
        if (selected.folders.length) await library.prepareFolders(selected.folders);
        useChannel(peer.createDataChannel(extended ? pcTransferFolderChannel : pcTransferChannel));
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
          if ([pcTransferChannel, pcTransferFolderChannel].includes(opened.label) && !channel) useChannel(opened);
          else opened.close();
        });
        await peer.setRemoteDescription({ type: "offer", sdp: offer });
        const answer = await pcLocalDescription(peer, await peer.createAnswer(), signal);
        await request(path, { method: "POST", body: { answer } });
      }
      showProgress("端末同士を接続中…");
      await waitForPeerConnection(() => channel?.readyState === "open" || (extended && channel?.readyState === "closed"), signal, 25_000);
      if (extended && channel.readyState === "closed") throw new Error("フォルダや大きいファイルの同期には、両方の端末で新しい音棚を開いてください。");
      clearTimeout(pairingTimer);
      if (room) {
        // A connected pair no longer needs the server.
        request(room, { method: "DELETE", requestSignal: AbortSignal.timeout(5000) }).catch(() => {});
        room = undefined;
        find("pair").hidden = true;
      }
      const result = sending
        ? await sendPCMedia(channel, next, selected, library, signal, showProgress)
        : await receivePCMedia(channel, next, library, signal, showProgress);
      const summary = [];
      if (result.folders) summary.push(`${result.folders}フォルダを${sending ? "送信" : "同期"}しました。`);
      if (result.saved) summary.push(`${result.saved} 件を${sending ? "送信" : "端末に保存"}しました。`);
      if (result.updated) summary.push(`受け取り先の曲情報を ${result.updated} 件更新しました。`);
      if (result.skipped) summary.push(`すでに保存済みの ${result.skipped} 件を省きました。`);
      showProgress(summary.join(" "));
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
      status.removeAttribute("data-loading");
      setScreenActivity("transfer", false);
      screenNote.hidden = true;
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
    list.children[contents.folders.indexOf(previous)]?.querySelector("button")?.focus({ preventScroll: true });
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
    selection.removeAttribute("data-loading");
    artworkObserver?.disconnect();
    cancel.click();
  });
}
