"use strict";

const pcTransferPath = "/api/pc-transfer";
const pcTransferLimit = 128_000_000;
const pcTransferChunk = 16_384;
const pcTransferChannel = "otodana-pc-v1";
const pcTransferCode = /^[A-F0-9]{12}$/;
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

function pcTrackInfo(track, deviceId) {
  const entry = {
    type: "item",
    title: track.title.slice(0, 300),
    filename: track.filename.slice(0, 300),
    bytes: track.blob.size,
    format: track.format ?? "mp3",
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

async function sendPCMedia(channel, next, selected, signal, showProgress) {
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
    const item = pcTrackInfo(track, deviceId);
    channel.send(JSON.stringify(item));
    const reply = pcTransferMessage(await next());
    if (reply.type === "skip") {
      skipped++;
      continue;
    }
    if (reply.type !== "ready") throw new Error("受け取り先の応答を確認できませんでした。");
    const status = `${index + 1} / ${selected.length} 件目を送信中…`;
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
  const list = find("tracks");
  const create = find("create");
  const connect = find("connect");
  const input = find("input");
  const codeDisplay = find("code");
  const progress = find("progress");
  const status = find("status");
  const cancel = find("cancel");
  let available = [];
  let controller;
  let lastProgress = 0;

  function showProgress(message, value) {
    if (typeof value !== "number" || status.textContent !== message || value === 100 || performance.now() - lastProgress > 100) {
      if (status.textContent !== message) status.textContent = message;
      progress.hidden = typeof value !== "number";
      if (!progress.hidden) progress.value = value;
      lastProgress = performance.now();
    }
  }

  function selectedTracks() {
    return [...list.querySelectorAll("input:checked")].map((checkbox) => available[Number(checkbox.value)]);
  }

  function normalizedCode() {
    return input.value.trim().replaceAll("-", "").toUpperCase();
  }

  function updateControls() {
    const busy = Boolean(controller);
    create.disabled = busy || !selectedTracks().length;
    connect.disabled = busy || !pcTransferCode.test(normalizedCode());
    for (const element of [send, receive, input, find("settings"), ...list.querySelectorAll("input")]) {
      element.disabled = busy;
    }
    cancel.hidden = !busy;
  }

  async function loadChoices() {
    available = (await library.getTracks()).filter((track) => track.blob.size > 0 && track.blob.size <= pcTransferLimit);
    list.replaceChildren(...available.map((track, index) => {
      const row = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = index;
      const title = document.createElement("span");
      title.textContent = library.displayTitle(track) || track.filename;
      const size = document.createElement("small");
      size.textContent = (track.blob.size / 1_000_000).toFixed(1) + " MB";
      row.append(checkbox, title, size);
      return row;
    }));
    find("selection").textContent = available.length ? "送るファイルを選んでください。1件128 MBまで。" :
      "送れる項目がありません。この端末のライブラリにファイルを追加してください（1件128 MBまで）。";
    updateControls();
  }

  function selectMode(sending) {
    find("sender").hidden = !sending;
    find("receiver").hidden = sending;
    send.setAttribute("aria-pressed", sending);
    receive.setAttribute("aria-pressed", !sending);
    showProgress("");
    if (sending) loadChoices();
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
        const created = await request(pcTransferPath, { method: "POST", body: { offer } });
        const { code } = await created.json();
        if (!pcTransferCode.test(code)) throw new Error("転送コードを発行できませんでした。");
        room = pcTransferPath + "/" + code;
        codeDisplay.value = code.match(/.{4}/g).join("-");
        find("pair").hidden = false;
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
        ? await sendPCMedia(channel, next, selected, signal, showProgress)
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
  list.addEventListener("change", updateControls);
  input.addEventListener("input", updateControls);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !connect.disabled) connect.click();
  });
  create.addEventListener("click", () => run(true));
  connect.addEventListener("click", () => run(false));
  cancel.addEventListener("click", () => controller?.abort(new Error("転送を中止しました。保存済みの項目はライブラリに残っています。")));
  dialog.addEventListener("close", () => cancel.click());
}
