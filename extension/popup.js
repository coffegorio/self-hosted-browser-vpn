const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('button')];
let current = null;
let busy = false;
let stateRequest = 0;
let verificationEpoch = 0;

async function request(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось выполнить действие.');
  return response.result;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function updateTestButton() {
  $('test-button').disabled = busy || (current?.state !== 'active' && current?.canRetryIp !== true);
}

function render(state) {
  current = state;
  if (state.state !== 'active') $('ip-result').textContent = '';
  const connected = state.hasConnection;
  $('setup').hidden = connected;
  $('connected').hidden = !connected;
  $('status-dot').parentElement.dataset.state = state.state;

  const labels = {
    unconfigured: ['Сервер не добавлен', 'Укажите адрес своего прокси или импортируйте ключ.'],
    off: ['Отключено', 'Chrome использует обычные настройки подключения.'],
    active: ['Маршрутизация включена', 'Chrome применил настройку вашего прокси.'],
    conflict: ['Конфликт настроек', state.message || 'Другое расширение управляет прокси.'],
    error: ['Нужна проверка', state.message || 'Проверьте настройки прокси.']
  };
  const [title, description] = labels[state.state] || labels.error;
  $('status-title').textContent = title;
  $('status-description').textContent = description;
  if (connected) {
    if (document.activeElement !== $('expected-ip')) $('expected-ip').value = state.expectedIp || '';
    $('server-address').textContent = state.server || '—';
    $('connect-button').textContent = state.enabled ? 'Отключить' : 'Подключить';
    updateTestButton();
    $('test-button').textContent = state.canRetryIp === true ? 'Повторить проверку IP' : 'Проверить внешний IP';
    if (document.activeElement !== $('exclusions')) {
      $('exclusions').value = state.exclusions.join('\n');
    }
  }
}

async function refreshState() {
  const id = ++stateRequest;
  try {
    const state = await request('GET_STATE');
    if (id === stateRequest) render(state);
    return state;
  } catch (error) {
    if (id === stateRequest) throw error;
  }
}

function refreshAfterChange() {
  refreshState().catch(() => {});
}

function invalidateVerification() {
  verificationEpoch++;
  $('ip-result').textContent = '';
  refreshAfterChange();
}

async function run(task) {
  if (busy) return;
  busy = true;
  showError('');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await task();
    if (result?.state) await refreshState();
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Неизвестная ошибка.');
    try { await refreshState(); } catch { /* Keep the last view. */ }
  } finally {
    busy = false;
    buttons.forEach((button) => { button.disabled = false; });
    updateTestButton();
  }
}

$('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const state = await request('IMPORT_KEY', { key: $('connection-key').value });
    $('connection-key').value = '';
    return state;
  });
});

$('replace-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const state = await request('IMPORT_KEY', { key: $('replacement-key').value });
    $('replacement-key').value = '';
    $('replace').open = false;
    return state;
  });
});

$('connect-button').addEventListener('click', () => {
  run(() => request(current?.enabled ? 'DISCONNECT' : 'CONNECT'));
});

$('exclusions-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => request('SAVE_EXCLUSIONS', { text: $('exclusions').value }));
});

$('test-button').addEventListener('click', () => {
  run(async () => {
    const epoch = verificationEpoch;
    $('ip-result').textContent = '';
    const { ip, matched } = await request('TEST_IP');
    const state = await refreshState();
    if (epoch === verificationEpoch && state?.state === 'active') {
      $('ip-result').textContent = `${matched ? 'IP совпадает' : 'Внешний IP браузера'}: ${ip}`;
    }
  });
});

$('forget-button').addEventListener('click', () => {
  if (!confirm('Удалить ключ подключения из расширения?')) return;
  run(() => request('FORGET'));
});

chrome.proxy.settings.onChange.addListener(invalidateVerification);
chrome.proxy.onProxyError.addListener(invalidateVerification);
chrome.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(invalidateVerification);
chrome.storage.local.onChanged.addListener((changes) => {
  if (changes.connection || changes.enabled || changes.exclusions || changes.expectedIp || changes.proxyError?.newValue) {
    invalidateVerification();
  } else if (changes.proxyError) {
    // A successful retry clears the stored error without changing the verified route.
    refreshAfterChange();
  }
});
refreshState().catch((error) => showError(error.message || 'Не удалось прочитать настройки Chrome.'));

$('proxy-type').addEventListener('change', () => {
  const scheme = $('proxy-type').value;
  $('credentials').hidden = scheme === 'socks5';
  $('proxy-port').value = {https:443,http:8080,socks5:1080}[scheme];
  $('protocol-note').textContent = {
    https: 'Сервер должен иметь действительный TLS-сертификат.',
    http: 'Соединение с прокси не шифруется. HTTPS-сайты сохраняют своё шифрование, но пароль прокси может передаваться открыто.',
    socks5: 'Chrome не поддерживает пароль SOCKS5. Доступ к серверу должен быть ограничен другим способом, например по вашему IP.'
  }[scheme];
});
$('manual-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(async () => {
    const scheme = $('proxy-type').value;
    const state = await request('SAVE_CONNECTION', {connection: {
      v:2, scheme, host:$('proxy-host').value.trim(), port:Number($('proxy-port').value),
      username:scheme === 'socks5' ? '' : $('proxy-user').value,
      password:scheme === 'socks5' ? '' : $('proxy-password').value
    }});
    $('proxy-user').value = ''; $('proxy-password').value = '';
    return state;
  });
});

$('expected-ip-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => request('SAVE_EXPECTED_IP', {ip:$('expected-ip').value}));
});
