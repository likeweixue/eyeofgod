const $ = (selector, root = document) => root.querySelector(selector);

const loginForm = $('#login-form');
const setupForm = $('#setup-form');
const loginError = $('#login-error');
const setupError = $('#setup-error');
const loginSubmit = $('#login-submit');
const setupSubmit = $('#setup-submit');
const serverStrip = $('#server-strip');
const serverAddress = $('#server-address');

let setupRequired = false;

function setError(element, message) {
  element.textContent = message;
  element.classList.toggle('is-visible', Boolean(message));
}

function setLoading(button, loading, label) {
  const text = button.querySelector('span');
  if (!button.dataset.label) button.dataset.label = text.textContent;
  button.disabled = loading;
  button.dataset.loading = String(loading);
  text.textContent = loading ? label : button.dataset.label;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    /* keep empty */
  }
  if (!response.ok) {
    const error = new Error(data.error || '请求失败，请检查服务是否正在运行');
    error.code = data.code;
    error.status = response.status;
    throw error;
  }
  return data;
}

function setMode(required) {
  setupRequired = required;
  loginForm.hidden = required;
  setupForm.hidden = !required;
  if (required) {
    $('#mode-kicker').textContent = 'FIRST BOOT';
    $('#auth-title').textContent = '初始化·上帝之眼';
    $('#auth-subtitle').textContent = '这是系统的第一次启动。完成初始化后，这只眼睛将只属于你。';
    setTimeout(() => $('#setup-code').focus(), 120);
  } else {
    $('#mode-kicker').textContent = 'ADMIN CONSOLE';
    $('#auth-title').textContent = '管理员登录';
    $('#auth-subtitle').textContent = '进入私有监控中枢，查看已经授权的摄像机。';
    setTimeout(() => $('#password').focus(), 120);
  }
}

async function boot() {
  try {
    const data = await api('/api/bootstrap', { method: 'GET', headers: {} });
    serverStrip.hidden = false;
    serverAddress.textContent = location.host;
    setMode(Boolean(data.setupRequired));
  } catch (error) {
    setError(loginError, error.message);
    setMode(false);
  }
}

document.querySelectorAll('.reveal').forEach((button) => {
  button.addEventListener('click', () => {
    const input = document.getElementById(button.dataset.reveal);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    button.textContent = showing ? '显示' : '隐藏';
    button.setAttribute('aria-label', showing ? '显示密码' : '隐藏密码');
    button.setAttribute('aria-pressed', String(!showing));
    input.focus();
  });
});

$('#setup-code').addEventListener('input', (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const password = $('#password').value;
  setError(loginError, '');
  if (!password) {
    setError(loginError, '请输入管理员密码');
    $('#password').focus();
    return;
  }
  setLoading(loginSubmit, true, '正在验证…');
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
    window.location.replace('/app');
  } catch (error) {
    setError(loginError, error.message);
    setLoading(loginSubmit, false);
    $('#password').select();
  }
});

setupForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const setupCode = $('#setup-code').value.trim().toUpperCase();
  const password = $('#new-password').value;
  const confirm = $('#confirm-password').value;
  setError(setupError, '');

  if (setupCode.length !== 6) {
    setError(setupError, '请输入启动终端显示的 6 位初始化码');
    $('#setup-code').focus();
    return;
  }
  if (password.length < 8) {
    setError(setupError, '管理员密码至少需要 8 位');
    $('#new-password').focus();
    return;
  }
  if (password !== confirm) {
    setError(setupError, '两次输入的密码不一致');
    $('#confirm-password').focus();
    return;
  }

  setLoading(setupSubmit, true, '正在初始化…');
  try {
    await api('/api/setup', {
      method: 'POST',
      body: JSON.stringify({ setupCode, password }),
    });
    window.location.replace('/app');
  } catch (error) {
    setError(setupError, error.message);
    setLoading(setupSubmit, false);
    if (error.code === 'INVALID_SETUP_CODE') $('#setup-code').select();
  }
});

['password', 'new-password', 'confirm-password', 'setup-code'].forEach((id) => {
  document.getElementById(id)?.addEventListener('input', () => {
    setError(setupError, '');
    setError(loginError, '');
  });
});

boot();
