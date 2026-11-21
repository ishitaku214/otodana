"use strict";

const coreBase = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/";
const coreFiles = {
  "ffmpeg-core.js": "sha256-smarW5UlVYgd1jEGY5hplKGCrLK3/yXPEKJfejesKyE=",
  "ffmpeg-core.wasm": "sha256-n1eUelvVMNjwDFs/LLKjSS+qfl2CMxU0LWqGVtCmt7c=",
};
const source = "/incoming/media";
const mediaSizeLimit = 128_000_000;

async function loadConverter() {
  const assets = await Promise.all(Object.entries(coreFiles).map(async ([name, integrity]) => {
    const response = await fetch(coreBase + name, { integrity, credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error("Converter asset unavailable");
    return response;
  }));
  const scriptUrl = URL.createObjectURL(new Blob([await assets[0].blob()], { type: "text/javascript" }));
  try {
    importScripts(scriptUrl);
    const wasmBinary = new Uint8Array(await assets[1].arrayBuffer());
    return await self.createFFmpegCore({ wasmBinary });
  } finally {
    URL.revokeObjectURL(scriptUrl);
  }
}

function readStreams(core) {
  const output = "/info.json";
  core.ffprobe("-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format",
    "-of", "json", "-o", output, source);
  core.reset();
  try {
    const information = JSON.parse(core.FS.readFile(output, { encoding: "utf8" }));
    if (information.streams?.length) return information;
  } catch {
    // The converter may leave an empty probe result when the source is invalid.
  }
  throw new Error("動画・音声の内容を読み込めませんでした。");
}

function outputOptions(format, information) {
  const streams = information.streams ?? [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  if (format === "mp3") {
    if (!audio) throw new Error("このファイルに音声がありません。");
    const mono = audio.channels === 1;
    return ["-map", "0:" + audio.index, "-vn", "-c:a", "libmp3lame", "-ac", mono ? "1" : "2",
      "-b:a", mono ? "96k" : "192k"];
  }
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  if (!video) throw new Error("このファイルに映像がありません。音声はMP3で保存できます。");
  if (video.width * video.height > 4096 * 2304) {
    throw new Error("解像度が高いため、変換には4K以下の動画を選んでください。");
  }
  const args = ["-map", "0:" + video.index];
  const [frames, seconds] = (video.avg_frame_rate ?? "").split("/").map(Number);
  const frameRate = frames / seconds;
  const videoBitrate = Number(video.bit_rate ?? information.format?.bit_rate);
  const fitsPhone = Math.max(video.width, video.height) <= 1280 && Math.min(video.width, video.height) <= 720;
  if (video.codec_name === "h264" && video.pix_fmt === "yuv420p" && fitsPhone &&
      video.level > 0 && video.level <= 40 && frameRate > 0 && frameRate <= 30 &&
      videoBitrate > 0 && videoBitrate <= 3_000_000) {
    args.push("-c:v", "copy");
  } else {
    args.push("-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "3M", "-bufsize", "6M",
      "-profile:v", "main", "-level:v", "4.0", "-pix_fmt", "yuv420p", "-fpsmax", "30",
      "-vf", "scale=w='min(iw,if(gte(iw,ih),1280,720))':h='min(ih,if(gte(iw,ih),720,1280))':force_original_aspect_ratio=decrease:force_divisible_by=2");
  }
  if (audio) {
    args.push("-map", "0:" + audio.index);
    const mono = audio.channels === 1;
    if (audio.codec_name === "aac" && audio.profile === "LC" && audio.channels <= 2 &&
        Number(audio.sample_rate) <= 48000 && Number(audio.bit_rate) <= 160_000) {
      args.push("-c:a", "copy");
    } else {
      args.push("-c:a", "aac", "-ac", mono ? "1" : "2", "-b:a", mono ? "96k" : "128k");
    }
  }
  args.push("-movflags", "+faststart");
  return args;
}

self.addEventListener("message", async ({ data: { blob, format } }) => {
  let core;
  const output = "/saved." + format;
  try {
    self.postMessage({ phase: "engine" });
    try {
      core = await loadConverter();
    } catch {
      throw new Error("変換機能を読み込めませんでした。通信状態を確認してもう一度お試しください。");
    }
    self.postMessage({ phase: "convert" });
    core.FS.mkdir("/incoming");
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name: "media", data: blob }] }, "/incoming");
    const information = readStreams(core);
    const options = outputOptions(format, information);
    const duration = Number(information.format?.duration);
    let lastPercent = -1;
    core.setProgress(({ time }) => {
      if (!(duration > 0 && Number.isFinite(time))) return;
      const percent = Math.max(0, Math.min(99, Math.floor(time / 10_000 / duration)));
      if (percent <= lastPercent) return;
      lastPercent = percent;
      self.postMessage({ phase: "convert", percent });
    });
    const result = core.exec("-v", "error", "-protocol_whitelist", "file", "-i", source,
      ...options, "-sn", "-dn", "-fs", String(mediaSizeLimit), output);
    if (result) throw new Error("ファイルを変換できませんでした。別のファイルでお試しください。");
    const { size } = core.FS.stat(output);
    if (size >= mediaSizeLimit) throw new Error("変換したファイルが128MBを超えました。短いファイルで再試行してください。");
    if (!size) throw new Error("変換したファイルが空でした。");
    self.postMessage({ blob: new Blob([core.FS.readFile(output)], { type: format === "mp3" ? "audio/mpeg" : "video/mp4" }) });
  } catch (error) {
    self.postMessage({ error: error.message || "ファイルを変換できませんでした。" });
  }
}, { once: true });
