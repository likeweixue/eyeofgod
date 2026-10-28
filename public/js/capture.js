const $ = (selector) => document.querySelector(selector);

const QUALITY = {
  smooth: { label: '流畅', target: 640, fps: 8, quality: 0.55 },
  balanced: { label: '均衡', target: 960, fps: 10, quality: 0.64 },
  sharp: { label: '高清', target: 1280, fps: 12, quality: 0.72 },
};

const state = {
  camera: null,
  sessionExpiresAt: null,
  stream: null,
  ws: null,
  active: false,
  streaming: false,
  startPending: false,
  facing: 'environment',
  quality: 'balanced',
  encoding: false,
  frameTimer: null,
  statsTimer: null,
  sentFrames: 0,
  sentBytes: 0,
  displayFps: 0,
  displayBitrate: 0,
  wakeLock: null,
  reconnectAttempt: 0,
  reconnectTimer: null,
  intentionalClose: false,
  multipleCameras: false,
  sessionChecked: false,
  unbindBusy: false,
};

const video = $('#preview');
const canvas = $('#capture-canvas');
const ctx = canvas.getContext('2d', { alpha: false });
const previewFrame = $('#preview-frame');

function toast(message, type = '') {
  const stack = $('#toasts');
  const item = document.createElement('div');
  item.className = `toast ${type}`.trim();
  item.textContent = message;
  stack.append(item);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  setTimeout(() => item.remove(), 4000);
}

function api(path, { method = 'GET', body } = {}) {
  const options = { method, credentials: 'same-origin', headers: {} };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  return fetch(path, options).then(async (response) => {
    let data = {};
    try {
      data = await response.json();
    } catch {
      /* ignore */
    }
    if (!response.ok) {
      const error = new Error(data.error || '请求失败');
      error.status = response.status;
      error.code = data.code;
      throw error;
    }
    return data;
  });
}

function showError(message) {
  const box = $('#capture-error');
  box.textContent = message || '';
  box.classList.toggle('is-visible', Boolean(message));
}

function clearError() {
  showError('');
}

function setHeaderConnection(kind, text) {
  const element = $('#header-conn');
  element.className = `capture-conn ${kind}`.trim();
  const dot = element.querySelector('.status-dot');
  dot.className = `status-dot ${kind === 'is-live' ? 'live' : kind === 'is-warn' ? 'warn' : kind === 'is-online' ? 'online' : ''}`.trim();
  $('#header-conn-text').textContent = text;
}

function updateUI() {
  const active = state.active;
  const streaming = state.streaming;
  const camera = state.camera;

  $('#header-camera-name').hidden = !camera;
  if (camera) $('#header-camera-name').textContent = camera.name;

  if (streaming) setHeaderConnection('is-live', '直播中');
  else if (state.startPending) setHeaderConnection('is-warn', '正在开启');
  else if (active) setHeaderConnection('is-warn', '连接中');
  else if (camera) setHeaderConnection('is-online', '待机');
  else setHeaderConnection('', '未接入');

  const headState = $('#camera-head-state');
  headState.classList.toggle('is-live', streaming);
  $('#camera-state-label').textContent = streaming ? '直播中' : active ? '连接中' : '待机';

  $('#camera-heading').textContent = streaming ? '本机正在直播' : active ? '正在连接管理端' : '设备待机';
  $('#camera-subheading').textContent = streaming
    ? '画面正在通过加密局域网连接传输，只有管理员可以看到。'
    : active
      ? '摄像头已开启，正在建立实时通道…'
      : '准备就绪。按下开始后，画面才会离开这台设备。';

  const button = $('#start-button');
  button.classList.toggle('is-live', active);
  button.disabled = state.startPending;
  button.querySelector('.start-icon').textContent = active ? '■' : '◉';
  button.querySelector('.start-label').textContent = state.startPending ? '正在开启摄像头…' : active ? '停止直播' : '开始直播';

  $('#preview-idle').hidden = active;
  $('#live-indicator').hidden = !streaming;
  $('#live-banner').hidden = !streaming;
  $('#reconnect-banner').hidden = !active || streaming || state.startPending || state.reconnectAttempt === 0;
  $('#preview-frame').classList.toggle('is-front', state.facing === 'user' && active);
  $('#preview-meta').textContent = streaming
    ? `LIVE · ${canvas.width}×${canvas.height}`
    : active
      ? 'CONNECTING'
      : 'READY';
  $('#preview-name').textContent = camera?.name || '摄像机';
  $('#device-status').textContent = streaming ? '直播中' : active ? '连接中' : '待机';
  $('#device-status').classList.toggle('is-live', streaming);
  $('#stat-link').textContent = streaming ? '加密传输中' : active ? '正在重连' : '已停止';
  $('#stat-fps').textContent = `${state.displayFps.toFixed(1)} fps`;
  $('#stat-bitrate').textContent = `${Math.round(state.displayBitrate)} kbps`;
  $('#stat-resolution').textContent = active ? `${canvas.width}×${canvas.height}` : '—';
  $('#quality-select').value = state.quality;
  $('#quality-select').disabled = false;
  $('#switch-camera').hidden = !state.multipleCameras || !active;
  $('#switch-camera').disabled = !active || state.startPending;
  $('#device-name').textContent = camera?.name || '—';
  $('#device-location').textContent = camera?.location || '未标注位置';
  $('#device-expiry').textContent = state.sessionExpiresAt
    ? `本次接入有效至 ${new Date(state.sessionExpiresAt).toLocaleDateString('zh-CN')}`
    : '—';
}

function showPairing(message = '') {
  $('#loading-state').hidden = true;
  $('#camera-view').hidden = true;
  $('#pairing-view').hidden = false;
  $('#header-camera-name').hidden = true;
  setHeaderConnection('', '未接入');
  if (message) {
    const error = $('#pair-error');
    error.textContent = message;
    error.classList.add('is-visible');
  }
  setTimeout(() => $('#pair-code').focus(), 80);
}

function showCamera(camera, sessionExpiresAt) {
  state.camera = camera;
  state.sessionExpiresAt = sessionExpiresAt || null;
  $('#loading-state').hidden = true;
  $('#pairing-view').hidden = true;
  $('#camera-view').hidden = false;
  updateUI();
}

async function loadDevice() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const initialCode = (hash.get('c') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  if (initialCode) {
    history.replaceState(null, '', window.location.pathname);
    $('#pair-code').value = initialCode;
    await pairDevice(initialCode, true);
    return;
  }
  try {
    const data = await api('/api/camera/me');
    showCamera(data.camera, data.sessionExpiresAt);
  } catch (error) {
    if (error.status === 401) {
      showPairing();
    } else {
      showPairing(error.message);
    }
  }
}

async function pairDevice(code, automatic = false) {
  const normalized = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  const errorBox = $('#pair-error');
  const submit = $('#pair-submit');
  errorBox.classList.remove('is-visible');
  if (normalized.length !== 6) {
    errorBox.textContent = '请输入完整的 6 位接入码';
    errorBox.classList.add('is-visible');
    return;
  }
  submit.disabled = true;
  submit.textContent = '正在验证…';
  if (automatic) {
    $('#pair-code').value = normalized;
    $('#loading-state').hidden = false;
    $('#pairing-view').hidden = true;
  }
  try {
    const data = await api('/api/camera/pair', { method: 'POST', body: { code: normalized } });
    history.replaceState(null, '', window.location.pathname);
    showCamera(data.camera);
    clearError();
    toast('接入成功。按下“开始直播”后画面才会传输。', 'success');
  } catch (error) {
    state.camera = null;
    $('#loading-state').hidden = true;
    $('#pairing-view').hidden = false;
    errorBox.textContent = error.message;
    errorBox.classList.add('is-visible');
    if (automatic) $('#pair-code').value = normalized;
    updateUI();
    $('#pair-code').focus();
  } finally {
    submit.disabled = false;
    submit.textContent = '验证接入码';
  }
}

async function openCameraStream() {
  if (!window.isSecureContext) {
    throw new Error('当前页面不是安全上下文。请通过 HTTPS 打开，并确认已信任本地证书。');
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('当前浏览器不支持网页摄像头，请使用较新的 Safari 或 Chrome。');
  }
  const baseVideo = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
  };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { ...baseVideo, facingMode: { ideal: state.facing } },
    });
  } catch (error) {
    if (error.name === 'OverconstrainedError' || error.name === 'NotFoundError') {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: baseVideo });
    } else {
      throw error;
    }
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
  }
  state.stream = stream;
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play().catch(() => {});
  const videoTrack = stream.getVideoTracks()[0];
  const settings = videoTrack?.getSettings?.() || {};
  if (settings.facingMode === 'user' || settings.facingMode === 'environment') {
    state.facing = settings.facingMode;
  }
  await discoverCameras();
}

async function discoverCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.multipleCameras = devices.filter((device) => device.kind === 'videoinput').length > 1;
  } catch {
    state.multipleCameras = false;
  }
  updateUI();
}

function cameraErrorMessage(error) {
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return '摄像头权限被拒绝。请在浏览器或系统设置中允许此站点访问摄像头，然后重试。';
    case 'NotFoundError':
      return '没有检测到可用的摄像头。';
    case 'NotReadableError':
      return '摄像头正被其他应用占用，请关闭其他相机应用后重试。';
    case 'AbortError':
      return '摄像头启动被中断，请重试。';
    default:
      return error?.message || '无法开启摄像头，请检查浏览器权限。';
  }
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener?.('release', () => {
      state.wakeLock = null;
    });
  } catch {
    state.wakeLock = null;
  }
}

async function releaseWakeLock() {
  try {
    await state.wakeLock?.release();
  } catch {
    /* ignore */
  }
  state.wakeLock = null;
}

function startStatsTimer() {
  clearInterval(state.statsTimer);
  state.statsTimer = setInterval(() => {
    state.displayFps = state.sentFrames;
    state.displayBitrate = (state.sentBytes * 8) / 1000;
    state.sentFrames = 0;
    state.sentBytes = 0;
    if (state.active) updateUI();
  }, 1000);
}

function stopStatsTimer() {
  clearInterval(state.statsTimer);
  state.statsTimer = null;
  state.displayFps = 0;
  state.displayBitrate = 0;
  state.sentFrames = 0;
  state.sentBytes = 0;
}

function stopEncodingLoop() {
  clearTimeout(state.frameTimer);
  state.frameTimer = null;
}

function scheduleFrame(delay = 0) {
  clearTimeout(state.frameTimer);
  state.frameTimer = setTimeout(encodeFrame, delay);
}

function resizeCanvas() {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;
  if (!sourceWidth || !sourceHeight) return false;
  const preset = QUALITY[state.quality];
  const scale = Math.min(1, preset.target / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
  const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return true;
}

function canvasToBlob() {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, 'image/jpeg', QUALITY[state.quality].quality);
  });
}

async function encodeFrame() {
  if (!state.active || !state.streaming) return;
  const started = performance.now();
  if (state.encoding || video.readyState < 2) {
    scheduleFrame(120);
    return;
  }
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    scheduleFrame(200);
    return;
  }
  if (!resizeCanvas()) {
    scheduleFrame(200);
    return;
  }
  state.encoding = true;
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await canvasToBlob();
    if (
      blob &&
      state.active &&
      state.streaming &&
      state.ws?.readyState === WebSocket.OPEN &&
      state.ws.bufferedAmount < 1.5 * 1024 * 1024
    ) {
      state.ws.send(blob);
      state.sentFrames += 1;
      state.sentBytes += blob.size;
    }
  } catch {
    /* a dropped frame is not fatal */
  } finally {
    state.encoding = false;
  }
  const interval = 1000 / QUALITY[state.quality].fps;
  const elapsed = performance.now() - started;
  scheduleFrame(Math.max(0, interval - elapsed));
}

function wireSocket() {
  if (state.streaming) return;
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${window.location.host}/ws/camera`);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = socket;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    if (state.ws !== socket) return;
    state.reconnectAttempt = 0;
    state.sessionChecked = false;
    state.streaming = true;
    state.reconnectTimer = null;
    state.intentionalClose = false;
    startStatsTimer();
    updateUI();
    scheduleFrame(0);
    requestWakeLock();
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data);
      if (message.type === 'ready' && message.camera && state.camera) {
        state.camera.name = message.camera.name || state.camera.name;
        updateUI();
      }
    } catch {
      /* ignore */
    }
  });
  socket.addEventListener('close', (event) => {
    if (state.ws !== socket) return;
    state.ws = null;
    state.streaming = false;
    stopEncodingLoop();
    stopStatsTimer();
    updateUI();
    if (!state.active || state.intentionalClose) return;
    if (event.code === 4001) {
      stopLive('管理员已停止这台摄像机的直播。', true);
      return;
    }
    if (event.code === 4000) {
      stopLive('这台摄像机已在别处重新绑定，本机直播已停止。', true);
      return;
    }
    if (event.code === 4401) {
      resetSession('接入会话已失效，请联系管理员获取新的接入码。');
      return;
    }
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
  });
}

function scheduleReconnect() {
  if (!state.active || state.reconnectTimer) return;
  state.reconnectAttempt += 1;
  const delay = Math.min(1000 * 1.6 ** Math.min(state.reconnectAttempt, 6), 10000);
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (!state.active) return;
    if (state.reconnectAttempt >= 3 && !state.sessionChecked) {
      state.sessionChecked = true;
      const valid = await verifySession();
      if (!valid) return;
    }
    wireSocket();
  }, delay);
}

async function verifySession() {
  try {
    const response = await fetch('/api/camera/me', { credentials: 'same-origin' });
    if (response.status === 401) {
      resetSession('接入会话已失效，请联系管理员获取新的接入码。');
      return false;
    }
    return response.ok;
  } catch {
    return true;
  }
}

function resetSession(message) {
  stopLive('', false);
  state.camera = null;
  state.sessionExpiresAt = null;
  $('#camera-view').hidden = true;
  $('#pairing-view').hidden = false;
  $('#loading-state').hidden = true;
  showPairing(message);
}

async function startLive() {
  if (state.active || state.startPending) return;
  clearError();
  state.startPending = true;
  updateUI();
  try {
    await openCameraStream();
    state.active = true;
    state.startPending = false;
    state.intentionalClose = false;
    updateUI();
    requestWakeLock();
    writeSocket();
  } catch (error) {
    state.startPending = false;
    state.active = false;
    if (state.stream) {
      for (const track of state.stream.getTracks()) track.stop();
      state.stream = null;
    }
    video.srcObject = null;
    updateUI();
    showError(cameraErrorMessage(error));
    toast('无法开始直播', 'error');
  }
}

function writeSocket() {
  if (!state.active) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  wireSocket();
}

function stopLive(message = '', fromRemote = false) {
  state.active = false;
  state.streaming = false;
  state.startPending = false;
  state.intentionalClose = true;
  stopEncodingLoop();
  stopStatsTimer();
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  if (state.ws) {
    try {
      state.ws.close(1000, '用户停止直播');
    } catch {
      /* ignore */
    }
    state.ws = null;
  }
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  video.srcObject = null;
  releaseWakeLock();
  updateUI();
  if (message) showError(message);
  else clearError();
  if (fromRemote) toast(message, 'error');
}

async function switchCamera() {
  if (!state.active) return;
  const previousFacing = state.facing;
  state.facing = previousFacing === 'environment' ? 'user' : 'environment';
  $('#switch-camera').disabled = true;
  try {
    await openCameraStream();
    updateUI();
    toast(state.facing === 'user' ? '已切换到前置镜头' : '已切换到后置镜头');
  } catch (error) {
    state.facing = previousFacing;
    showError(cameraErrorMessage(error));
    updateUI();
  } finally {
    $('#switch-camera').disabled = false;
  }
}

function openUnbindModal() {
  $('#modal-unbind').classList.add('is-open');
  $('#modal-unbind').setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  $('#confirm-unbind').focus();
}

function closeUnbindModal() {
  $('#modal-unbind').classList.remove('is-open');
  $('#modal-unbind').setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

async function unbind() {
  if (state.unbindBusy) return;
  state.unbindBusy = true;
  const button = $('#confirm-unbind');
  button.disabled = true;
  button.textContent = '正在解除…';
  try {
    stopLive('', false);
    await api('/api/camera/forget', { method: 'POST' });
    state.camera = null;
    state.sessionExpiresAt = null;
    closeUnbindModal();
    showPairing('本机已解除绑定。请向管理员获取新的接入码。');
    toast('已解除本机绑定', 'success');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    state.unbindBusy = false;
    button.disabled = false;
    button.textContent = '解除绑定';
  }
}

function bindEvents() {
  $('#pair-form').addEventListener('submit', (event) => {
    event.preventDefault();
    pairDevice($('#pair-code').value, false);
  });
  $('#pair-code').addEventListener('input', (event) => {
    event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
    $('#pair-error').classList.remove('is-visible');
  });

  $('#start-button').addEventListener('click', () => {
    if (state.active) stopLive();
    else startLive();
  });
  $('#quality-select').addEventListener('change', (event) => {
    state.quality = event.target.value;
    if (state.active) {
      updateUI();
      toast(`画质已切换为${QUALITY[state.quality].label}`);
    }
  });
  $('#switch-camera').addEventListener('click', switchCamera);
  $('#unbind-button').addEventListener('click', openUnbindModal);
  $('#confirm-unbind').addEventListener('click', unbind);
  $('#cert-help').addEventListener('click', () => {
    window.open('/trust', '_blank', 'noopener');
  });
  document.querySelectorAll('[data-close="modal-unbind"]').forEach((button) => {
    button.addEventListener('click', closeUnbindModal);
  });
  $('#modal-unbind').addEventListener('click', (event) => {
    if (event.target === $('#modal-unbind')) closeUnbindModal();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && $('#modal-unbind').classList.contains('is-open')) {
      closeUnbindModal();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (!state.active) return;
    requestWakeLock();
    if (!state.streaming) {
      if (state.reconnectAttempt < 3) writeSocket();
      else if (!state.reconnectTimer) scheduleReconnect();
    }
  });
  window.addEventListener('online', () => {
    if (state.active && !state.streaming) {
      state.reconnectAttempt = 0;
      writeSocket();
    }
  });
  window.addEventListener('pagehide', () => {
    if (state.active) stopLive('', false);
  });
}

async function init() {
  bindEvents();
  updateUI();
  await loadDevice();
}

init();
