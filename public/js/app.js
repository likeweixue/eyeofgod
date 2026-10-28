const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  view: 'wall',
  config: null,
  cameras: [],
  events: [],
  tiles: new Map(),
  playerId: null,
  ws: null,
  wsConnected: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  intentionalClose: false,
  sessionCheckedOnReconnect: false,
  openModals: [],
  pairingExpiresAt: 0,
  pairingTimer: null,
  confirmHandler: null,
  uptimeTimer: null,
};

const refs = {
  grid: $('#video-grid'),
  wallEmpty: $('#wall-empty'),
  devicesList: $('#devices-list'),
  devicesEmpty: $('#devices-empty'),
  eventsList: $('#events-list'),
  eventsEmpty: $('#events-empty'),
  connectionBanner: $('#connection-banner'),
  wallPulse: $('#wall-pulse'),
  wallLinkLabel: $('#wall-link-label'),
  toasts: $('#toasts'),
};

const viewTitles = {
  wall: '监控墙',
  devices: '设备与接入',
  system: '系统',
};

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  const options = {
    method,
    credentials: 'same-origin',
    headers: {},
  };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, options);
  } catch {
    throw new ApiError('无法连接到服务，请确认 Mac 上的服务仍在运行', 0, 'NETWORK_ERROR');
  }
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* ignore empty */
  }
  if (!response.ok) {
    if (response.status === 401 && data.code === 'AUTH_REQUIRED') {
      window.location.replace('/login');
    }
    throw new ApiError(data.error || '请求失败', response.status, data.code);
  }
  return data;
}

function el(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function showToast(message, type = '') {
  const toast = el('div', `toast ${type}`.trim(), message);
  refs.toasts.append(toast);
  while (refs.toasts.children.length > 3) refs.toasts.firstElementChild.remove();
  window.setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(5px)';
    toast.style.transition = 'opacity 200ms, transform 200ms';
    window.setTimeout(() => toast.remove(), 230);
  }, 3400);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.label;
}

function formatClock() {
  const now = new Date();
  const date = now
    .toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short' })
    .replaceAll('/', '.');
  const time = now.toLocaleTimeString('en-GB', { hour12: false });
  $('#clock-date').textContent = date;
  $('#clock-time').textContent = time;
}

function relativeTime(iso) {
  if (!iso) return '从未上线';
  const time = new Date(iso).getTime();
  if (!Number.isFinite(time)) return '未知';
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (seconds < 20) return '刚刚';
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} 天前`;
  return new Date(iso).toLocaleDateString('zh-CN');
}

function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatUptime(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分钟`;
}

function animateUptime() {
  if (state.config?.server?.startedAt) {
    $('#uptime').textContent = formatUptime(state.config.server.startedAt);
  }
}

/* ---------------- Routing ---------------- */

function setView(view) {
  if (!viewTitles[view]) view = 'wall';
  if (state.view !== view && state.playerId) closeModal('modal-player');
  state.view = view;
  for (const name of Object.keys(viewTitles)) {
    $(`#view-${name}`).hidden = name !== view;
  }
  $$('.nav-item').forEach((link) => {
    const active = link.dataset.viewLink === view;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${viewTitles[view]} · 上帝之眼`;
  if (view === 'devices') {
    renderDevices();
    renderEvents();
  }
  if (view === 'system') renderSystem();
  closeAdminMenu();
}

function routeFromHash() {
  const value = window.location.hash.replace(/^#\/?/, '').split('?')[0];
  const view = viewTitles[value] ? value : 'wall';
  if (!window.location.hash) {
    history.replaceState(null, '', '#/wall');
  }
  setView(view);
}

/* ---------------- Rendering ---------------- */

function createTile(camera) {
  const article = document.createElement('article');
  article.className = 'cam-tile';
  article.dataset.id = camera.id;
  article.tabIndex = 0;
  article.setAttribute('role', 'button');
  article.innerHTML = `
    <div class="cam-visual">
      <canvas class="cam-canvas" width="1280" height="720"></canvas>
      <div class="cam-placeholder">
        <span class="eye-rings" aria-hidden="true"><span class="core"></span></span>
        <span class="cam-placeholder-title">等待设备主动开始直播</span>
      </div>
      <div class="cam-overlay">
        <div class="cam-topline">
          <span class="cam-state"><span class="status-dot"></span><span class="cam-state-text">STANDBY</span></span>
          <div class="cam-readouts">
            <span class="cam-readout cam-resolution">—</span>
            <span class="cam-readout cam-fps">0.0 FPS</span>
          </div>
        </div>
        <div class="cam-actions">
          <button class="tile-action" type="button" data-tile-action="expand" title="放大画面" aria-label="放大画面">⛶</button>
          <button class="tile-action" type="button" data-tile-action="snapshot" title="保存当前画面" aria-label="保存当前画面">↓</button>
        </div>
        <div class="cam-caption">
          <div>
            <h3 class="cam-name">摄像机</h3>
            <p class="cam-location">未标注位置</p>
          </div>
          <div class="cam-caption-right">
            <strong class="cam-caption-state">STANDBY</strong>
            <span>ENCRYPTED</span>
          </div>
        </div>
      </div>
    </div>`;

  const tile = {
    id: camera.id,
    el: article,
    canvas: $('.cam-canvas', article),
    ctx: $('.cam-canvas', article).getContext('2d', { alpha: false }),
    placeholder: $('.cam-placeholder', article),
    placeholderTitle: $('.cam-placeholder-title', article),
    stateChip: $('.cam-state', article),
    stateText: $('.cam-state-text', article),
    resolution: $('.cam-resolution', article),
    fps: $('.cam-fps', article),
    name: $('.cam-name', article),
    location: $('.cam-location', article),
    captionState: $('.cam-caption-state', article),
    snapshotButton: $('[data-tile-action="snapshot"]', article),
    hasFrame: false,
    pending: null,
    busy: false,
    camera,
  };
  tile.ctx.fillStyle = '#040506';
  tile.ctx.fillRect(0, 0, tile.canvas.width, tile.canvas.height);

  const open = () => openPlayer(camera.id);
  article.addEventListener('click', open);
  article.addEventListener('keydown', (event) => {
    if (event.target !== article) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });
  $('[data-tile-action="expand"]', article).addEventListener('click', (event) => {
    event.stopPropagation();
    open();
  });
  tile.snapshotButton.addEventListener('click', (event) => {
    event.stopPropagation();
    downloadSnapshot(camera.id);
  });
  return tile;
}

function clearTileFrame(tile) {
  tile.pending = null;
  tile.hasFrame = false;
  tile.posterRequested = false;
  tile.ctx.fillStyle = '#040506';
  tile.ctx.fillRect(0, 0, tile.canvas.width, tile.canvas.height);
  tile.placeholder.hidden = false;
  tile.snapshotButton.disabled = true;
  if (state.playerId === tile.id) {
    const playerCanvas = $('#player-canvas');
    const context = playerCanvas.getContext('2d', { alpha: false });
    context.fillStyle = '#020303';
    context.fillRect(0, 0, playerCanvas.width, playerCanvas.height);
    $('#player-placeholder').hidden = false;
    $('#player-snapshot').disabled = true;
  }
}

function updateTile(tile, camera) {
  const pairedAtChanged = Boolean(tile.pairedAt && camera.pairedAt && tile.pairedAt !== camera.pairedAt);
  if ((!camera.paired || pairedAtChanged) && tile.hasFrame) clearTileFrame(tile);
  tile.pairedAt = camera.pairedAt || null;
  tile.camera = camera;
  const name = camera.name || '未命名摄像机';
  const location = camera.location || '未标注位置';
  tile.name.textContent = name;
  tile.location.textContent = location;
  tile.el.setAttribute('aria-label', `${name}，${camera.streaming ? '正在直播' : camera.online ? '在线待机' : '离线'}，按回车放大`);
  tile.placeholderTitle.textContent = camera.streaming
    ? '正在建立画面…'
    : camera.online
      ? '已连接 · 等待设备开始直播'
      : camera.paired
        ? '设备离线 · 最后画面保留'
        : '尚未绑定设备';
  tile.resolution.textContent = camera.width && camera.height ? `${camera.width}×${camera.height}` : '—';
  tile.fps.textContent = `${Number(camera.fps || 0).toFixed(1)} FPS`;
  tile.captionState.textContent = camera.streaming ? 'LIVE' : camera.online ? 'READY' : camera.paired ? 'OFFLINE' : 'UNPAIRED';
  tile.stateText.textContent = camera.streaming ? 'LIVE' : camera.online ? 'STANDBY' : camera.paired ? 'OFFLINE' : 'UNPAIRED';
  tile.stateChip.classList.toggle('live', Boolean(camera.streaming));
  tile.stateChip.querySelector('.status-dot').className = `status-dot ${camera.streaming ? 'live' : camera.online ? 'online' : camera.paired ? 'warn' : ''}`.trim();
  tile.el.classList.toggle('is-offline', !camera.online);
  tile.canvas.classList.toggle('is-stale', !camera.streaming);
  if (tile.hasFrame) tile.placeholder.hidden = true;
  else {
    tile.placeholder.hidden = false;
    tile.placeholderTitle.textContent = camera.streaming ? '正在建立画面…' : camera.online ? '已连接 · 等待设备开始直播' : camera.paired ? '设备离线 · 最后画面保留' : '尚未绑定设备';
  }
  tile.snapshotButton.disabled = !tile.hasFrame;
}

function loadPoster(tile, camera) {
  if (tile.hasFrame || !camera.latestFrameAt || tile.posterRequested) return;
  tile.posterRequested = true;
  const image = new Image();
  image.decoding = 'async';
  image.onload = () => {
    if (tile.hasFrame || !tile.camera?.paired) return;
    drawContained(tile.canvas, image, image.naturalWidth, image.naturalHeight);
    tile.hasFrame = true;
    tile.placeholder.hidden = true;
    tile.snapshotButton.disabled = false;
  };
  image.onerror = () => {
    tile.posterRequested = false;
  };
  image.src = `/api/cameras/${encodeURIComponent(camera.id)}/latest.jpg?t=${Date.now()}`;
}

function syncCameras() {
  const seen = new Set();
  const ordered = [...state.cameras];
  ordered.forEach((camera, index) => {
    seen.add(camera.id);
    let tile = state.tiles.get(camera.id);
    if (!tile) {
      tile = createTile(camera);
      state.tiles.set(camera.id, tile);
    }
    updateTile(tile, camera);
    loadPoster(tile, camera);
    const current = refs.grid.children[index];
    if (current !== tile.el) refs.grid.insertBefore(tile.el, current || null);
  });

  for (const [id, tile] of state.tiles) {
    if (!seen.has(id)) {
      tile.el.remove();
      state.tiles.delete(id);
      if (state.playerId === id) closeModal('modal-player');
    }
  }
  while (refs.grid.children.length > ordered.length) {
    refs.grid.lastElementChild.remove();
  }

  refs.wallEmpty.hidden = ordered.length !== 0;
  refs.grid.hidden = ordered.length === 0;
  refs.grid.classList.toggle('count-1', ordered.length === 1);
  refs.grid.classList.toggle('count-2', ordered.length === 2);
  updateStats();
  syncPlayer();
  updateDeviceStates();
}

function updateStats() {
  const total = state.cameras.length;
  const online = state.cameras.filter((camera) => camera.online).length;
  const streaming = state.cameras.filter((camera) => camera.streaming);
  const avgFps = streaming.length
    ? streaming.reduce((sum, camera) => sum + Number(camera.fps || 0), 0) / streaming.length
    : 0;
  $('#stat-online').innerHTML = `${online}<span class="metric-total"> / ${total}</span>`;
  $('#stat-streaming').textContent = String(streaming.length);
  $('#stat-fps').innerHTML = `${avgFps.toFixed(1)}<span class="metric-unit"> fps</span>`;
  $('#top-live-count').textContent = String(online);
  $('#top-live-dot').className = `status-dot ${online ? 'online' : ''}`.trim();
  $('#device-count').textContent = `${total} DEVICE${total === 1 ? '' : 'S'}`;
}

function updateDeviceStates() {
  $$('.device-card', refs.devicesList).forEach((card) => {
    const camera = state.cameras.find((item) => item.id === card.dataset.id);
    if (!camera) return;
    const status = $('.device-state', card);
    if (!status) return;
    status.className = `device-state ${camera.streaming ? 'live' : camera.online ? 'online' : ''}`.trim();
    status.innerHTML = '';
    const dot = el('span', `status-dot ${camera.streaming ? 'live' : camera.online ? 'online' : camera.paired ? 'warn' : ''}`.trim());
    status.append(dot, document.createTextNode(camera.streaming ? '正在直播' : camera.online ? '在线 · 待机' : camera.paired ? '离线' : '未绑定'));
    const lastSeen = $('.device-last-seen', card);
    if (lastSeen) lastSeen.textContent = `上次活跃 ${relativeTime(camera.lastSeenAt)}`;
    const stop = $('[data-action="disconnect"]', card);
    if (stop) {
      stop.disabled = !camera.online;
      stop.style.opacity = camera.online ? '' : '0.4';
    }
  });
}

function renderDevices() {
  refs.devicesList.innerHTML = '';
  const cameras = state.cameras;
  refs.devicesEmpty.hidden = cameras.length !== 0;
  refs.devicesList.hidden = cameras.length === 0;

  cameras.forEach((camera, index) => {
    const card = el('div', 'device-card');
    card.dataset.id = camera.id;
    const icon = el('div', 'device-icon');
    icon.append(document.createTextNode('CAM'));
    icon.append(el('span', 'mono', String(index + 1).padStart(2, '0')));
    icon.style.display = 'flex';
    icon.style.flexDirection = 'column';

    const main = el('div', 'device-main');
    const titleLine = el('div', 'device-title-line');
    titleLine.append(el('strong', '', camera.name));
    titleLine.append(el('span', 'device-state', '—'));
    main.append(titleLine);
    const sub = el('div', 'device-sub');
    sub.append(el('span', '', camera.location || '未标注位置'));
    sub.append(el('span', 'mono', `ID ${camera.id.slice(0, 6).toUpperCase()}`));
    const lastSeen = el('span', 'device-last-seen', `上次活跃 ${relativeTime(camera.lastSeenAt)}`);
    sub.append(lastSeen);
    main.append(sub);

    const actions = el('div', 'device-actions');
    const pair = el('button', 'device-action primary', '接入码');
    pair.type = 'button';
    pair.dataset.action = 'pair';
    const edit = el('button', 'device-action', '编辑');
    edit.type = 'button';
    edit.dataset.action = 'edit';
    const disconnect = el('button', 'device-action', '停止直播');
    disconnect.type = 'button';
    disconnect.dataset.action = 'disconnect';
    disconnect.disabled = !camera.online;
    if (!camera.online) disconnect.style.opacity = '0.4';
    const remove = el('button', 'device-action danger', '移除');
    remove.type = 'button';
    remove.dataset.action = 'delete';
    actions.append(pair, edit, disconnect, remove);

    card.append(icon, main, actions);
    refs.devicesList.append(card);
  });
  updateDeviceStates();
}

function renderEvents() {
  refs.eventsList.innerHTML = '';
  const events = state.events.slice(0, 20);
  refs.eventsEmpty.hidden = events.length !== 0;
  refs.eventsList.hidden = events.length === 0;
  for (const event of events) {
    const item = el('div', 'event-item');
    item.title = `${formatDateTime(event.at)} · ${event.message}`;
    item.append(el('span', 'event-time', formatDateTime(event.at).replace(/^.*?(\d{2}\/\d{2} \d{2}:\d{2})$/, '$1')));
    const type = String(event.type || '').split('.').pop();
    item.append(el('span', `event-dot ${type}`));
    item.append(el('span', 'event-text', event.message));
    refs.eventsList.append(item);
  }
}

function renderSystem() {
  if (!state.config) return;
  const server = state.config.server;
  $('#address-app').textContent = server.urls.app;
  $('#address-capture').textContent = server.urls.capture;
  $('#address-trust').textContent = server.urls.trust;
  $('#ca-fingerprint').textContent = server.caFingerprint || '—';
  $('#about-host').textContent = server.hostname || '—';
  $('#about-started').textContent = formatDateTime(server.startedAt);
  animateUptime();
}

/* ---------------- Frame decoding ---------------- */

function drawContained(canvas, source, sourceWidth, sourceHeight) {
  const ctx = canvas.getContext('2d', { alpha: false });
  const width = canvas.width;
  const height = canvas.height;
  ctx.fillStyle = '#040506';
  ctx.fillRect(0, 0, width, height);
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  ctx.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function decodeImage(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bitmap) => ({ source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() }));
  }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    image.onload = () => resolve({ source: image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) });
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    image.src = url;
  });
}

async function decodeTile(tile) {
  if (tile.busy) return;
  tile.busy = true;
  const blob = tile.pending;
  tile.pending = null;
  if (!blob) {
    tile.busy = false;
    return;
  }
  try {
    const decoded = await decodeImage(blob);
    drawContained(tile.canvas, decoded.source, decoded.width, decoded.height);
    if (state.playerId === tile.id) {
      drawContained($('#player-canvas'), decoded.source, decoded.width, decoded.height);
      $('#player-placeholder').hidden = true;
    }
    decoded.release();
    tile.hasFrame = true;
    tile.placeholder.hidden = true;
    tile.snapshotButton.disabled = false;
    tile.canvas.classList.remove('is-stale');
  } catch {
    /* drop malformed frame */
  } finally {
    tile.busy = false;
    if (tile.pending) setTimeout(() => decodeTile(tile), 0);
  }
}

function handleBinaryFrame(data) {
  const buffer = new Uint8Array(data);
  if (buffer.length <= 12) return;
  const id = new TextDecoder().decode(buffer.subarray(0, 12));
  const tile = state.tiles.get(id);
  if (!tile) return;
  if (document.visibilityState === 'hidden') return;
  if (state.view !== 'wall' && state.playerId !== id) return;
  tile.pending = new Blob([buffer.subarray(12)], { type: 'image/jpeg' });
  if (!tile.busy) decodeTile(tile);
}

/* ---------------- WebSocket ---------------- */

function setConnectionState(connected) {
  state.wsConnected = connected;
  refs.connectionBanner.hidden = connected;
  refs.wallPulse.classList.toggle('is-down', !connected);
  refs.wallLinkLabel.textContent = connected ? '实时通道在线' : '实时通道连接中';
}

function connectWebSocket() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  let socket;
  try {
    socket = new WebSocket(`${protocol}//${window.location.host}/ws/admin`);
  } catch {
    scheduleReconnect();
    return;
  }
  state.ws = socket;
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => {
    state.reconnectAttempt = 0;
    state.sessionCheckedOnReconnect = false;
    setConnectionState(true);
  });
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'hello' || message.type === 'status' || message.type === 'camera-closed') {
        if (Array.isArray(message.cameras)) {
          state.cameras = message.cameras;
          syncCameras();
        }
      } else if (message.type === 'event') {
        state.events.unshift(message.event);
        if (state.events.length > 300) state.events.length = 300;
        renderEvents();
      }
    } else {
      handleBinaryFrame(event.data);
    }
  });
  socket.addEventListener('close', (event) => {
    if (state.ws === socket) state.ws = null;
    setConnectionState(false);
    if (state.intentionalClose) return;
    if (event.code === 4401) {
      window.setTimeout(async () => {
        try {
          const response = await fetch('/api/me', { credentials: 'same-origin' });
          if (response.status === 401) {
            window.location.replace('/login');
            return;
          }
        } catch {
          /* fall through to reconnect */
        }
        scheduleReconnect();
      }, 300);
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
  if (state.reconnectTimer || state.intentionalClose) return;
  state.reconnectAttempt += 1;
  const delay = Math.min(1000 * 1.7 ** Math.min(state.reconnectAttempt, 6), 12000);
  state.reconnectTimer = window.setTimeout(async () => {
    state.reconnectTimer = null;
    if (state.reconnectAttempt >= 3 && !state.sessionCheckedOnReconnect) {
      state.sessionCheckedOnReconnect = true;
      try {
        const response = await fetch('/api/me', { credentials: 'same-origin' });
        if (response.status === 401) {
          window.location.replace('/login');
          return;
        }
      } catch {
        /* keep retrying while the server is unreachable */
      }
    }
    connectWebSocket();
  }, delay);
}

/* ---------------- Player ---------------- */

function openPlayer(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  const tile = state.tiles.get(cameraId);
  if (!camera || !tile) return;
  state.playerId = cameraId;
  $('#player-title').textContent = camera.name;
  $('#player-subtitle').textContent = camera.location || '未标注位置';
  const playerCanvas = $('#player-canvas');
  if (tile.hasFrame) {
    const context = playerCanvas.getContext('2d', { alpha: false });
    context.drawImage(tile.canvas, 0, 0, playerCanvas.width, playerCanvas.height);
    $('#player-placeholder').hidden = true;
  } else {
    const context = playerCanvas.getContext('2d', { alpha: false });
    context.fillStyle = '#020303';
    context.fillRect(0, 0, playerCanvas.width, playerCanvas.height);
    $('#player-placeholder').hidden = false;
  }
  syncPlayer();
  openModal('modal-player');
}

function syncPlayer() {
  if (!state.playerId) return;
  const camera = state.cameras.find((item) => item.id === state.playerId);
  if (!camera) {
    closeModal('modal-player');
    return;
  }
  const tile = state.tiles.get(state.playerId);
  $('#player-title').textContent = camera.name;
  $('#player-subtitle').textContent = camera.location || '未标注位置';
  $('#player-resolution').textContent = camera.width && camera.height ? `${camera.width} × ${camera.height}` : '—';
  $('#player-fps').textContent = `${Number(camera.fps || 0).toFixed(1)} FPS`;
  $('#player-device').textContent = camera.id.slice(0, 8).toUpperCase();
  $('#player-location').textContent = camera.location || '未标注位置';
  $('#player-last-frame').textContent = relativeTime(camera.lastSeenAt);
  const dot = $('#player-dot');
  dot.className = `status-dot ${camera.streaming ? 'live' : camera.online ? 'online' : 'warn'}`;
  $('#player-placeholder-text').textContent = camera.streaming
    ? '正在接收画面…'
    : camera.online
      ? '设备已连接，等待开始直播'
      : '设备已离线，保留最后画面';
  if (!tile?.hasFrame) $('#player-placeholder').hidden = false;
  $('#player-snapshot').disabled = !tile?.hasFrame;
  $('#player-stop').disabled = !camera.online;
  $('#player-stop').style.opacity = camera.online ? '' : '0.4';
}

async function downloadSnapshot(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  const tile = state.tiles.get(cameraId);
  if (!camera || !tile?.hasFrame) {
    showToast('暂时没有可保存的画面');
    return;
  }
  try {
    const blob = await new Promise((resolve) => tile.canvas.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) throw new Error('snapshot failed');
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '_');
    const safeName = String(camera.name || 'camera').replace(/[\\/:*?"<>|]/g, '_');
    anchor.href = url;
    anchor.download = `${safeName}_${stamp}.jpg`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 2000);
    showToast('画面已保存', 'success');
  } catch {
    showToast('保存画面失败');
  }
}

/* ---------------- Modals ---------------- */

const focusableSelector =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function openModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  const previousFocus = document.activeElement;
  modal.dataset.returnFocus = previousFocus instanceof HTMLElement ? previousFocus.id || '' : '';
  modal._returnFocusEl = previousFocus;
  modal.classList.add('is-open');
  modal.setAttribute('aria-hidden', 'false');
  if (!state.openModals.includes(id)) state.openModals.push(id);
  document.body.style.overflow = 'hidden';
  window.setTimeout(() => {
    const target = modal.querySelector('input:not([type="hidden"]), button, a[href]');
    target?.focus();
  }, 30);
}

function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('is-open');
  modal.setAttribute('aria-hidden', 'true');
  state.openModals = state.openModals.filter((item) => item !== id);
  if (state.openModals.length === 0) document.body.style.overflow = '';
  if (id === 'modal-player') {
    state.playerId = null;
  }
  if (id === 'modal-pairing') {
    clearInterval(state.pairingTimer);
    state.pairingTimer = null;
  }
  if (id === 'modal-confirm') {
    state.confirmHandler = null;
  }
  const returnFocus = modal._returnFocusEl;
  modal._returnFocusEl = null;
  if (returnFocus instanceof HTMLElement && document.contains(returnFocus)) {
    returnFocus.focus();
  }
}

function confirmAction({ title, message, label = '确认', handler }) {
  $('#confirm-title').textContent = title || '确认操作';
  $('#confirm-message').textContent = message;
  const button = $('#confirm-action');
  button.textContent = label;
  button.disabled = false;
  state.confirmHandler = handler;
  openModal('modal-confirm');
}

function closeAdminMenu() {
  const menu = $('#admin-menu');
  menu.hidden = true;
  $('#admin-menu-button').setAttribute('aria-expanded', 'false');
}

function toggleAdminMenu() {
  const menu = $('#admin-menu');
  const willOpen = menu.hidden;
  menu.hidden = !willOpen;
  $('#admin-menu-button').setAttribute('aria-expanded', String(willOpen));
}

/* ---------------- Pairing ---------------- */

function setPairingExpiryText() {
  const element = $('#pairing-expiry');
  const remaining = state.pairingExpiresAt - Date.now();
  if (!state.pairingExpiresAt) {
    element.textContent = '—';
    return;
  }
  if (remaining <= 0) {
    element.textContent = '接入码已过期，请重新生成';
    element.style.color = '#e29b95';
    return;
  }
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  element.textContent = `${minutes}:${String(seconds).padStart(2, '0')} 后失效 · 仅可使用一次`;
}

function showPairing(camera, pairing) {
  $('#pairing-title').textContent = `让「${camera.name}」看见`;
  $('#pairing-subtitle').textContent = '用同一 Wi-Fi 下的手机或平板完成接入。首次接入需要先安装本地证书。';
  $('#pairing-code').textContent = pairing.code;
  $('#pairing-trust-qr').src = pairing.trustQrDataUrl;
  $('#pairing-capture-qr').src = pairing.qrDataUrl;
  $('#pairing-trust-link').href = pairing.trustUrl;
  $('#pairing-capture-link').href = pairing.captureUrl;
  state.pairingExpiresAt = new Date(pairing.expiresAt).getTime();
  state.currentPairing = pairing;
  const warning = $('#pairing-warning');
  warning.hidden = !pairing.warning;
  warning.textContent = pairing.warning || '';
  clearInterval(state.pairingTimer);
  setPairingExpiryText();
  state.pairingTimer = window.setInterval(setPairingExpiryText, 1000);
  openModal('modal-pairing');
}

async function openPairingFor(cameraId) {
  const camera = state.cameras.find((item) => item.id === cameraId);
  if (!camera) return;
  try {
    const data = await api(`/api/cameras/${ensuredId(camera.id)}/pair-code`, { method: 'POST' });
    if (camera.online) {
      data.pairing.warning = '这台摄像机当前正在直播。用新设备完成接入后，旧设备会立即被断开。';
    }
    showPairing(camera, data.pairing);
  } catch (error) {
    showToast(error.message);
  }
}

function ensuredId(id) {
  return encodeURIComponent(String(id));
}

async function copyText(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.append(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    showToast('已复制到剪贴板', 'success');
  } catch {
    showToast('复制失败，请手动选择文本');
  }
}

/* ---------------- Data refresh ---------------- */

async function refreshCameras() {
  const data = await api('/api/cameras');
  state.cameras = data.cameras;
  syncCameras();
  if (state.view === 'devices') renderDevices();
}

async function refreshEvents() {
  const data = await api('/api/events?limit=120');
  state.events = data.events;
  renderEvents();
}

async function refreshAll() {
  try {
    const [cameraData, eventData] = await Promise.all([api('/api/cameras'), api('/api/events?limit=120')]);
    state.cameras = cameraData.cameras;
    state.events = eventData.events;
    syncCameras();
    renderDevices();
    renderEvents();
    showToast('状态已刷新', 'success');
  } catch (error) {
    showToast(error.message);
  }
}

/* ---------------- Handlers ---------------- */

async function handleAddCamera(event) {
  event.preventDefault();
  const form = $('#add-camera-form');
  const name = $('#camera-name').value.trim();
  const location = $('#camera-location').value.trim();
  const errorBox = $('#add-camera-error');
  const submit = $('#add-camera-submit');
  errorBox.classList.remove('is-visible');
  errorBox.textContent = '';
  if (!name) {
    errorBox.textContent = '请先给摄像机起个名字';
    errorBox.classList.add('is-visible');
    $('#camera-name').focus();
    return;
  }
  setBusy(submit, true, '正在生成…');
  try {
    const data = await api('/api/cameras', { method: 'POST', body: { name, location } });
    form.reset();
    closeModal('modal-add-camera');
    await refreshCameras();
    showPairing(data.camera, data.pairing);
    showToast('摄像机已创建，等待手机接入', 'success');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.add('is-visible');
  } finally {
    setBusy(submit, false);
  }
}

async function handleEditCamera(event) {
  event.preventDefault();
  const id = $('#edit-camera-id').value;
  const name = $('#edit-camera-name').value.trim();
  const location = $('#edit-camera-location').value.trim();
  const errorBox = $('#edit-camera-error');
  const submit = event.target.querySelector('button[type="submit"]');
  errorBox.classList.remove('is-visible');
  if (!name) {
    errorBox.textContent = '摄像机名称不能为空';
    errorBox.classList.add('is-visible');
    return;
  }
  setBusy(submit, true, '保存中…');
  try {
    await api(`/api/cameras/${ensuredId(id)}`, { method: 'PATCH', body: { name, location } });
    await refreshCameras();
    await refreshEvents();
    renderDevices();
    closeModal('modal-edit-camera');
    showToast('设备信息已更新', 'success');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.add('is-visible');
  } finally {
    setBusy(submit, false);
  }
}

function openEdit(camera) {
  $('#edit-camera-id').value = camera.id;
  $('#edit-camera-name').value = camera.name;
  $('#edit-camera-location').value = camera.location || '';
  $('#edit-camera-error').classList.remove('is-visible');
  openModal('modal-edit-camera');
}

async function handlePassword(event) {
  event.preventDefault();
  const currentPassword = $('#current-password').value;
  const newPassword = $('#password-new').value;
  const confirm = $('#password-confirm').value;
  const errorBox = $('#password-error');
  const submit = event.target.querySelector('button[type="submit"]');
  errorBox.classList.remove('is-visible');
  if (!currentPassword) {
    errorBox.textContent = '请输入当前密码';
    errorBox.classList.add('is-visible');
    return;
  }
  if (newPassword.length < 8) {
    errorBox.textContent = '新密码至少需要 8 位';
    errorBox.classList.add('is-visible');
    return;
  }
  if (newPassword !== confirm) {
    errorBox.textContent = '两次输入的新密码不一致';
    errorBox.classList.add('is-visible');
    return;
  }
  setBusy(submit, true, '更新中…');
  try {
    await api('/api/admin/password', { method: 'POST', body: { currentPassword, newPassword } });
    $('#password-form').reset();
    closeModal('modal-password');
    showToast('管理员密码已更新，其他会话已失效', 'success');
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.add('is-visible');
  } finally {
    setBusy(submit, false);
  }
}

async function logout() {
  try {
    state.intentionalClose = true;
    state.ws?.close();
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* redirect anyway */
  }
  window.location.replace('/login');
}

function openTrustGuide() {
  if (!state.config) return;
  window.open(state.config.server.urls.trust, '_blank', 'noopener');
}

async function handleDeviceAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const card = button.closest('.device-card');
  if (!card) return;
  const camera = state.cameras.find((item) => item.id === card.dataset.id);
  if (!camera) return;
  const action = button.dataset.action;

  if (action === 'pair') {
    await openPairingFor(camera.id);
    return;
  }
  if (action === 'edit') {
    openEdit(camera);
    return;
  }
  if (action === 'disconnect') {
    if (!camera.online) {
      showToast('这台设备当前不在直播');
      return;
    }
    try {
      const data = await api(`/api/cameras/${ensuredId(camera.id)}/disconnect`, { method: 'POST' });
      showToast(data.wasOnline ? `已停止「${camera.name}」的直播` : '设备当前不在直播', 'success');
      if (state.playerId === camera.id) closeModal('modal-player');
      await refreshCameras();
      await refreshEvents();
    } catch (error) {
      showToast(error.message);
    }
    return;
  }
  if (action === 'delete') {
    confirmAction({
      title: `移除「${camera.name}」？`,
      message: '这台摄像机将被删除，正在直播的连接会被立即断开。之后需要重新创建并配对才能恢复。',
      label: '确认移除',
      handler: async () => {
        try {
          await api(`/api/cameras/${ensuredId(camera.id)}`, { method: 'DELETE' });
          if (state.playerId === camera.id) closeModal('modal-player');
          await refreshCameras();
          await refreshEvents();
          renderDevices();
          showToast('摄像机已移除', 'success');
        } catch (error) {
          showToast(error.message);
        }
      },
    });
  }
}

function validateAndCopy(id) {
  const text = document.getElementById(id)?.textContent;
  if (text) copyText(text);
}

function bindEvents() {
  window.addEventListener('hashchange', routeFromHash);

  $$('#add-camera, #empty-add, #add-camera-devices, #empty-devices-add').forEach((button) => {
    button.addEventListener('click', () => {
      const form = $('#add-camera-form');
      form.reset();
      $('#add-camera-error').classList.remove('is-visible');
      openModal('modal-add-camera');
      window.setTimeout(() => $('#camera-name').focus(), 80);
    });
  });

  $('#add-camera-form').addEventListener('submit', handleAddCamera);
  $('#edit-camera-form').addEventListener('submit', handleEditCamera);
  $('#password-form').addEventListener('submit', handlePassword);

  refs.devicesList.addEventListener('click', handleDeviceAction);

  $('#refresh-wall').addEventListener('click', refreshAll);

  $('#admin-menu-button').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleAdminMenu();
  });
  document.addEventListener('click', (event) => {
    if (!event.target.closest('.admin-menu')) closeAdminMenu();
  });
  $('#menu-password').addEventListener('click', () => {
    closeAdminMenu();
    $('#password-form').reset();
    $('#password-error').classList.remove('is-visible');
    openModal('modal-password');
  });
  $('#menu-trust').addEventListener('click', () => {
    closeAdminMenu();
    openTrustGuide();
  });
  $('#menu-logout').addEventListener('click', logout);

  $('#system-password').addEventListener('click', () => {
    $('#password-form').reset();
    $('#password-error').classList.remove('is-visible');
    openModal('modal-password');
  });
  $('#system-logout').addEventListener('click', logout);
  $('#system-trust').addEventListener('click', openTrustGuide);
  $('#trust-guide-link').addEventListener('click', openTrustGuide);

  $$('.copy-btn').forEach((button) => {
    button.addEventListener('click', () => validateAndCopy(button.dataset.copyTarget));
  });

  $('#copy-pairing-link').addEventListener('click', () => {
    if (state.currentPairing?.captureUrl) copyText(state.currentPairing.captureUrl);
  });

  $$('[data-close]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.close));
  });

  $$('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) closeModal(backdrop.id);
    });
  });

  $('#confirm-action').addEventListener('click', async () => {
    const handler = state.confirmHandler;
    if (!handler) {
      closeModal('modal-confirm');
      return;
    }
    const button = $('#confirm-action');
    button.disabled = true;
    try {
      await handler();
    } finally {
      button.disabled = false;
      closeModal('modal-confirm');
    }
  });

  $('#player-snapshot').addEventListener('click', () => {
    if (state.playerId) downloadSnapshot(state.playerId);
  });
  $('#player-stop').addEventListener('click', () => {
    const camera = state.cameras.find((item) => item.id === state.playerId);
    if (!camera) return;
    confirmAction({
      title: `停止「${camera.name}」的直播？`,
      message: '手机的摄像头会立即停止采集，页面也会回到待机状态。需要设备持有人重新按下开始直播，才会恢复画面。',
      label: '停止直播',
      handler: async () => {
        try {
          await api(`/api/cameras/${ensuredId(camera.id)}/disconnect`, { method: 'POST' });
          showToast('已停止该设备的直播', 'success');
          await refreshCameras();
        } catch (error) {
          showToast(error.message);
        }
      },
    });
  });
  $('#player-fullscreen').addEventListener('click', async () => {
    const stage = $('#player-stage');
    if (!stage.requestFullscreen) {
      showToast('当前浏览器不支持网页全屏，可以把设备横过来使用');
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await stage.requestFullscreen();
    } catch {
      showToast('无法进入全屏');
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeAdminMenu();
      const top = state.openModals[state.openModals.length - 1];
      if (top) closeModal(top);
      return;
    }
    if (event.key === 'Tab' && state.openModals.length) {
      const modal = document.getElementById(state.openModals[state.openModals.length - 1]);
      if (!modal) return;
      const focusables = $$(focusableSelector, modal).filter((item) => item.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !state.wsConnected) connectWebSocket();
  });
  window.addEventListener('online', () => {
    if (!state.wsConnected) connectWebSocket();
  });
  window.addEventListener('pagehide', () => {
    state.intentionalClose = true;
    state.ws?.close();
  });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted) return;
    state.intentionalClose = false;
    setConnectionState(false);
    connectWebSocket();
  });
}

/* ---------------- Init ---------------- */

async function init() {
  bindEvents();
  formatClock();
  window.setInterval(formatClock, 1000);
  state.uptimeTimer = window.setInterval(animateUptime, 30_000);
  routeFromHash();

  try {
    const [me, config, cameraData, eventData] = await Promise.all([
      api('/api/me'),
      api('/api/config'),
      api('/api/cameras'),
      api('/api/events?limit=120'),
    ]);
    if (me.role !== 'admin') {
      window.location.replace(me.role === 'camera' ? '/capture' : '/login');
      return;
    }
    state.config = config;
    state.cameras = cameraData.cameras;
    state.events = eventData.events;
    $('#foot-version').textContent = `v${config.version}`;
    renderSystem();
    syncCameras();
    renderDevices();
    renderEvents();
    connectWebSocket();
  } catch (error) {
    if (error.status !== 401) {
      showToast(error.message);
      refs.connectionBanner.hidden = false;
      $('.connection-banner').innerHTML = '无法加载系统数据，请刷新页面或确认 Mac 上的服务正在运行。';
    }
  }
}

init();
