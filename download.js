"use strict";

const downloadLimit = 128_000_000;
const youTubeHome = "https://www.youtube.com/";
const youtubeDownloadHelp = "YouTubeの視聴URLからは取得できません。自分の動画はYouTube Studioから保存し、端末のファイルを選んでください。";

function isYouTubeUrl(url) {
  return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com)$/i.test(url.hostname);
}

function parseDownloadUrl(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("ファイルのURLを入力してください。");
  }
  const local = url.origin === location.origin && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
    throw new Error("配布元のHTTPSで始まるファイルURLを使ってください。");
  }
  return url;
}

function suppliedFilename(url, response) {
  const header = response.headers.get("Content-Disposition") ?? "";
  const encoded = header.match(/filename\*=UTF-8'[^']*'([^;]+)/i)?.[1];
  const literal = header.match(/filename\s*=\s*(?:"([^"]+)"|([^;]+))/i);
  const name = encoded ?? literal?.[1] ?? literal?.[2] ?? url.pathname.split("/").pop();
  try {
    return decodeURIComponent(name || "");
  } catch {
    return name;
  }
}

async function receiveMedia(url, signal, onProgress) {
  let response;
  try {
    response = await fetch(url, { signal, credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store" });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("直接取得できませんでした。ブラウザで配布元のファイルを保存し、「端末のファイルを選ぶ」から取り込めます。");
  }
  function rejectResponse(message) {
    response.body?.cancel().catch(() => {});
    throw new Error(message);
  }
  const sourceUrl = new URL(response.url);
  if (isYouTubeUrl(sourceUrl)) rejectResponse(youtubeDownloadHelp);
  if (!response.ok || response.status === 206) {
    rejectResponse("ファイル全体を取得できませんでした。配布元でリンクをご確認ください。");
  }
  const mime = response.headers.get("Content-Type") ?? "";
  if (/text\/html|application\/xhtml\+xml|mpegurl|dash\+xml/i.test(mime)) {
    rejectResponse("このURLは視聴ページか配信ページです。配布元のファイルURLを指定してください。");
  }
  const total = Number(response.headers.get("Content-Length"));
  const tooLarge = "128MBを超えています。「ファイルを追加」から保存済みファイルを取り込めます。";
  if (total > downloadLimit) rejectResponse(tooLarge);
  if (!response.body) throw new Error("ファイルを受信できませんでした。");
  const reader = response.body.getReader();
  const chunks = [];
  let loaded = 0;
  let lastUpdate = 0;
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (done) break;
      loaded += chunk.value.byteLength;
      if (loaded > downloadLimit) throw new Error(tooLarge);
      chunks.push(chunk.value);
      const time = performance.now();
      if (time - lastUpdate > 140) {
        onProgress(loaded, total);
        lastUpdate = time;
      }
    }
    onProgress(loaded, loaded);
  } finally {
    if (!done) reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return { blob: new Blob(chunks, { type: mime }), name: suppliedFilename(sourceUrl, response) };
}

async function downloadMediaKind(blob) {
  const read = async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer());
  const begins = (bytes, start, text) => Array.from(text).every((letter, index) => bytes[start + index] === letter.charCodeAt(0));
  const mp3Frame = (bytes) => bytes.length >= 4 && bytes[0] === 255 && (bytes[1] & 0xe6) === 0xe2 &&
    (bytes[1] & 0x18) !== 8 && (bytes[2] >> 4) !== 15 && (bytes[2] & 12) !== 12;
  const bytes = await read(0, 16);
  if (mp3Frame(bytes)) return "mp3";
  if (begins(bytes, 0, "ID3") && bytes.length >= 10 && bytes.slice(6, 10).every((value) => value < 128)) {
    const tagSize = bytes.slice(6, 10).reduce((size, value) => size * 128 + value, 0);
    const footerSize = bytes[3] === 4 && (bytes[5] & 16) ? 10 : 0;
    const start = 10 + tagSize + footerSize;
    if (mp3Frame(await read(start, start + 4))) return "mp3";
  }
  if (["ftyp", "moov", "mdat", "wide"].some((type) => begins(bytes, 4, type)) ||
      begins(bytes, 0, "OggS") || begins(bytes, 0, "fLaC") ||
      (begins(bytes, 0, "RIFF") && begins(bytes, 8, "WAVE")) ||
      (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3)) return "convertible";
  throw new Error("このリンクやファイルに対応する動画・音声が見つかりませんでした。");
}

function convertedMedia(blob, format, signal, onProgress) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const worker = new Worker("download-worker.js?v=16");
    const finish = () => {
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      finish();
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = ({ data }) => {
      if (data.phase) {
        onProgress(data);
        return;
      }
      finish();
      if (data.error) reject(new Error(data.error));
      else resolve(data.blob);
    };
    worker.onerror = () => {
      finish();
      reject(new Error("変換機能を実行できませんでした。音棚を開き直してお試しください。"));
    };
    worker.postMessage({ blob, format });
  });
}

function setupMediaDownloads(saveMedia) {
  const find = (id) => document.getElementById(id);
  const dialog = find("download-dialog");
  const urlField = find("download-url");
  const fileField = find("download-file");
  const fileName = find("download-file-name");
  const sourceLink = find("download-open-source");
  const menu = find("download-options");
  const showOptions = find("download-formats");
  const progress = find("download-progress");
  const message = find("download-message");
  const cancel = find("download-cancel");
  const close = find("download-close");
  const formats = Array.from(menu.querySelectorAll("button"));
  let job;

  function showProgress(text, percent) {
    progress.hidden = false;
    if (Number.isFinite(percent)) progress.value = percent;
    else progress.removeAttribute("value");
    message.textContent = text;
  }

  function clearFeedback() {
    progress.hidden = true;
    message.textContent = "";
  }

  function toggleRunning(running) {
    for (const element of [urlField, fileField, showOptions, ...formats]) element.disabled = running;
    cancel.hidden = !running;
    cancel.disabled = close.disabled = false;
  }

  find("download-open").addEventListener("click", () => {
    if (dialog.open) return;
    dialog.showModal();
    window.open(youTubeHome, "_blank", "noopener,noreferrer");
  });
  close.addEventListener("click", () => {
    if (job) job.abort();
    dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    if (close.disabled) event.preventDefault();
    else job?.abort();
  });
  cancel.addEventListener("click", () => job?.abort());
  function refreshSourceLink() {
    try {
      sourceLink.href = parseDownloadUrl(urlField.value).href;
      sourceLink.hidden = false;
    } catch {
      sourceLink.hidden = true;
      sourceLink.removeAttribute("href");
    }
  }
  urlField.addEventListener("input", () => {
    fileField.value = "";
    fileName.textContent = "";
    refreshSourceLink();
    clearFeedback();
  });
  fileField.addEventListener("change", () => {
    const file = fileField.files[0];
    if (file) urlField.value = "";
    fileName.textContent = file?.name ?? "";
    refreshSourceLink();
    clearFeedback();
  });
  showOptions.addEventListener("click", () => {
    menu.hidden = !menu.hidden;
    showOptions.setAttribute("aria-expanded", String(!menu.hidden));
  });

  async function run(format) {
    if (job) return;
    clearFeedback();
    const controller = new AbortController();
    job = controller;
    const { signal } = controller;
    toggleRunning(true);
    try {
      if (!/^https?:$/.test(location.protocol)) {
        throw new Error("この機能はGitHub Pagesの公開ページか、Windowsのローカルサーバーで使えます。");
      }
      const file = fileField.files[0];
      let input;
      if (file) {
        if (!file.size || file.size > downloadLimit) throw new Error("変換するファイルは128MB以下のものを選んでください。");
        input = { blob: file, name: file.name };
      } else {
        const url = parseDownloadUrl(urlField.value);
        if (isYouTubeUrl(url)) throw new Error(youtubeDownloadHelp);
        showProgress("ダウンロードを開始しています…");
        input = await receiveMedia(url, signal, (loaded, total) => {
          const bytes = (loaded / 1_000_000).toFixed(1) + " MB";
          const percent = total ? Math.min(100, Math.floor(loaded / total * 100)) : undefined;
          showProgress(percent === undefined ? "ダウンロード中 · " + bytes : "ダウンロード中 · " + percent + "%", percent);
        });
      }
      const kind = await downloadMediaKind(input.blob);
      const output = kind === "mp3" && format === "mp3"
        ? input.blob.slice(0, input.blob.size, "audio/mpeg")
        : await convertedMedia(input.blob, format, signal, ({ phase, percent }) => {
          if (phase === "engine") showProgress("変換機能を読み込んでいます…");
          else showProgress("端末内で" + format.toUpperCase() + "に変換中…" +
            (percent === undefined ? "" : " " + percent + "%"), percent);
        });
      if (signal.aborted) throw signal.reason;
      cancel.disabled = close.disabled = true;
      showProgress("ライブラリに保存しています…");
      const name = (input.name ?? "").replace(/\.[a-z0-9]{1,6}$/i, "").replace(/[\\/:*?"<>|\p{Cc}]+/gu, " ").trim();
      await saveMedia(output, (name.slice(0, 180) || "ダウンロード") + "." + format, format);
      urlField.value = fileField.value = "";
      fileName.textContent = "";
      refreshSourceLink();
      clearFeedback();
      dialog.close();
    } catch (error) {
      progress.hidden = true;
      message.textContent = signal.aborted ? "中止しました。" : error.message;
    } finally {
      job = null;
      toggleRunning(false);
    }
  }

  for (const format of formats) format.addEventListener("click", () => run(format.value));
}
