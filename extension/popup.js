const $ = (id) => document.getElementById(id);
const buttons = [...document.querySelectorAll('button')];
let current = null;

async function request(type, fields = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...fields });
  if (!response?.ok) throw new Error(response?.error || 'Не удалось выполнить действие.');
  return response.result;
}

function showError(message) {
  $('error').textContent = message || '';
  $('error').hidden = !message;
}

function render(state) {
  current = state;
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
    $('test-button').disabled = state.state !== 'active' && state.canRetryIp !== true;
    $('test-button').textContent = state.canRetryIp === true ? 'Повторить проверку IP' : 'Проверить внешний IP';
    if (document.activeElement !== $('exclusions')) {
      $('exclusions').value = state.exclusions.join('\n');
    }
  }
}

async function run(task) {
  showError('');
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const result = await task();
    if (result && result.state) render(result);
  } catch (error) {
    showError(error instanceof Error ? error.message : 'Неизвестная ошибка.');
    try { render(await request('GET_STATE')); } catch { /* Keep the last view. */ }
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
    if (current) $('test-button').disabled = current.state !== 'active' && current.canRetryIp !== true;
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
    $('ip-result').textContent = '';
    return state;
  });
});

$('connect-button').addEventListener('click', () => {
  run(async () => {
    $('ip-result').textContent = '';
    return request(current?.enabled ? 'DISCONNECT' : 'CONNECT');
  });
});

$('exclusions-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => request('SAVE_EXCLUSIONS', { text: $('exclusions').value }));
});

$('test-button').addEventListener('click', () => {
  run(async () => {
    $('ip-result').textContent = '';
    const { ip, matched } = await request('TEST_IP');
    $('ip-result').textContent = `${matched ? 'IP совпадает' : 'Внешний IP браузера'}: ${ip}`;
    return request('GET_STATE');
  });
});

$('forget-button').addEventListener('click', () => {
  if (!confirm('Удалить ключ подключения из расширения?')) return;
  run(async () => {
    $('ip-result').textContent = '';
    return request('FORGET');
  });
});

request('GET_STATE').then(render, (error) => showError(error.message || 'Не удалось прочитать настройки Chrome.'));

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
    $('ip-result').textContent = '';
    return state;
  });
});

$('expected-ip-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run(() => {
    $('ip-result').textContent = '';
    return request('SAVE_EXPECTED_IP', {ip:$('expected-ip').value});
  });
});
