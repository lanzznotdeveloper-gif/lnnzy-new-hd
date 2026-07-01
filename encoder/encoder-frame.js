import { createFFmpeg, fetchFile } from './ffmpeg/ffmpeg.js';

function isTikTokOrigin(origin) {
  if (origin === 'https://tiktok.com') return true;
  return /^https:\/\/[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.tiktok\.com$/.test(origin);
}

function detectParentOrigin() {
  try {
    if (document.referrer) {
      const url = new URL(document.referrer);
      if (isTikTokOrigin(url.origin)) return url.origin;
    }
  } catch (_) {}
  return '*';
}

let _parentOrigin = detectParentOrigin();

function postToParent(msg, transfer = []) {
  window.parent.postMessage(msg, '*', transfer);
}

let ffmpeg       = null;
let ffmpegLoaded = false;

async function ensureFFmpegLoaded() {
  if (ffmpegLoaded) return;

  const coreBaseURL = chrome.runtime.getURL('encoder/core');

  ffmpeg = createFFmpeg({
    log: false,
    corePath:   `${coreBaseURL}/ffmpeg-core.js`,
    wasmPath:   `${coreBaseURL}/ffmpeg-core.wasm`,
    workerPath: `${coreBaseURL}/ffmpeg-core.worker.js`,
    logger: ({ type, message }) => {
      postToParent({ type: 'ENCODE_LOG', message: `[${type}] ${message}` });
    },
    progress: ({ ratio }) => {
      if (typeof ratio === 'number' && ratio >= 0 && isFinite(ratio)) {
        postToParent({ type: 'ENCODE_PROGRESS', ratio });
      }
    },
  });

  await ffmpeg.load();
  ffmpegLoaded = true;
}

function guessInputName(file) {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '.mp4';
  return 'input' + ext;
}

function buildRemuxArgs(inputName, outputName) {
  return [
    '-i',        inputName,
    '-c',        'copy',
    '-movflags', '+faststart',
    outputName,
  ];
}

function buildReencodeArgs(inputName, outputName) {
  return [
    '-i',        inputName,
    '-preset',   'ultrafast',
    '-crf',      '18',
    '-threads',  '0',
    '-movflags', '+faststart',
    outputName,
  ];
}

async function handleEncode(file, mode) {
  try {
    await ensureFFmpegLoaded();

    const inputName  = guessInputName(file);
    const outputName = 'output.mp4';

    ffmpeg.FS('writeFile', inputName, await fetchFile(file));

    const args = mode === 'reencode'
      ? buildReencodeArgs(inputName, outputName)
      : buildRemuxArgs(inputName, outputName);

    postToParent({
      type:    'ENCODE_LOG',
      message: `[Senzeyn][mode=${mode}] $ ffmpeg ${args.join(' ')}`,
    });

    await ffmpeg.run(...args);

    const data = ffmpeg.FS('readFile', outputName);

    try { ffmpeg.FS('unlink', inputName);  } catch (_) {}
    try { ffmpeg.FS('unlink', outputName); } catch (_) {}

    const mime = 'video/mp4';
    const safeBytes    = data.slice(0);
    const blob         = new Blob([safeBytes], { type: mime });
    const baseName     = file.name.replace(/\.[^/.]+$/, '');
    const arrayBuffer  = await blob.arrayBuffer();

    postToParent({
      type:        'ENCODE_DONE',
      arrayBuffer,
      fileName:    `${baseName}-Senzeyn.mp4`,
      mimeType:    mime,
      mode,
    });
  } catch (err) {
    postToParent({
      type:    'ENCODE_ERROR',
      message: err?.message ?? String(err),
    });
  }
}

let _bootAcked = false;

window.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'BOOT_ACK') {
    _bootAcked = true;
  }
});

window.addEventListener('message', (event) => {
  if (!isTikTokOrigin(event.origin)) return;

  if (_parentOrigin === '*') _parentOrigin = event.origin;

  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'BOOT_ACK') return;

  if (msg.type === 'ENCODE_START') {
    const mode = msg.mode === 'reencode' ? 'reencode' : 'remux';

    if (msg.ab instanceof ArrayBuffer) {
      const file = new File([msg.ab], msg.fileName || 'input.mp4', {
        type: msg.fileType || 'video/mp4',
      });
      handleEncode(file, mode);
    } else if (msg.file instanceof File) {
      handleEncode(msg.file, mode);
    } else {
      postToParent({ type: 'ENCODE_ERROR', message: 'ENCODE_START: tidak ada data file yang valid' });
    }
  }
});

queueMicrotask(() => {
  postToParent({ type: 'FRAME_BOOTED' });

  let attempts = 0;
  const MAX_ATTEMPTS = 20;
  const retryId = setInterval(() => {
    if (_bootAcked || attempts >= MAX_ATTEMPTS) {
      clearInterval(retryId);
      return;
    }
    postToParent({ type: 'FRAME_BOOTED' });
    attempts++;
  }, 100);
});
