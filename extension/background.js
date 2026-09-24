import {
  buildProxyConfig,
  isExcludedHost,
  isEffectiveProxySetting,
  isMatchingProxyChallenge,
  normalizeExclusions,
  parseConnectionKey,
  validateConnection
} from './core.mjs';

const STORAGE_KEYS = ['connection', 'enabled', 'exclusions', 'proxyError'];
const authAttempts = new Map();
const WEBRTC_POLICY = 'disable_non_proxied_udp';
let operation = Promise.resolve();

function exclusive(task) {
  const next = operation.then(task);
  operation = next.catch(() => {});
  return next;
}

async function stored() {
  return chrome.storage.local.get(STORAGE_KEYS);
}

function configuredConnection(data) {
  if (!data.connection) return null;
  return validateConnection(data.connection);
}

function configuredExclusions(data) {
  return normalizeExclusions((data.exclusions || []).join('\n'));
}

async function effectiveSetting() {
  return chrome.proxy.settings.get({ incognito: false });
}

async function clearOwnProxySetting() {
  // Clear this extension's preference even when another extension currently has precedence.
  // Otherwise our old preference could become active again when that extension turns off.
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

async function clearOwnWebRTCSetting() {
  await chrome.privacy.network.webRTCIPHandlingPolicy.clear({ scope: 'regular' });
}

async function webRTCSetting() {
  return chrome.privacy.network.webRTCIPHandlingPolicy.get({ incognito: false });
}

function webRTCIsRestricted(setting) {
  return setting.levelOfControl === 'controlled_by_this_extension' && setting.value === WEBRTC_POLICY;
}

async function status() {
  const data = await stored();
  const setting = await effectiveSetting();
  const webRTC = await webRTCSetting();
  let connection;
  let exclusions = [];
  try {
    connection = configuredConnection(data);
    exclusions = configuredExclusions(data);
  } catch {
    return { state: 'error', message: 'Сохранённая конфигурация повреждена.', enabled: false, hasConnection: false, exclusions: [] };
  }
  const base = {
    enabled: data.enabled === true,
    hasConnection: Boolean(connection),
    server: connection ? `${connection.host}:${connection.port}` : null,
    exclusions,
    proxyError: data.proxyError || null
  };
  if (!connection) return { ...base, state: 'unconfigured' };
  if (!data.enabled) {
    return {
      ...base,
      state: setting.levelOfControl === 'controlled_by_this_extension' || webRTC.levelOfControl === 'controlled_by_this_extension' ? 'error' : 'off',
      message: setting.levelOfControl === 'controlled_by_this_extension' || webRTC.levelOfControl === 'controlled_by_this_extension'
        ? 'Настройки ещё активны в Chrome. Повторите отключение.' : undefined
    };
  }
  if (setting.levelOfControl !== 'controlled_by_this_extension') {
    return { ...base, state: 'conflict', message: 'Chrome не разрешает этому расширению управлять прокси.' };
  }
  const expected = buildProxyConfig(connection, exclusions);
  if (!isEffectiveProxySetting(setting, expected)) {
    return { ...base, state: 'error', message: 'Настройка прокси в Chrome отличается от выбранной.' };
  }
  if (!webRTCIsRestricted(webRTC)) {
    return { ...base, state: 'error', message: 'Chrome не применил ограничение прямых WebRTC-соединений.' };
  }
  if (data.proxyError) {
    return {
      ...base,
      state: 'error',
      message: data.proxyError.possibleDirect
        ? 'Chrome сообщил о возможном прямом подключении. Отключите прокси и проверьте настройки Chrome.'
        : 'Chrome сообщил об ошибке прокси. Проверьте сервер и сертификат.'
    };
  }
  return { ...base, state: 'active' };
}

async function updateBadge() {
  const current = await status();
  const badge = current.state === 'active' ? 'ON' : ['conflict', 'error'].includes(current.state) ? '!' : '';
  await chrome.action.setBadgeText({ text: badge });
  if (badge) {
    await chrome.action.setBadgeBackgroundColor({ color: badge === 'ON' ? '#087f63' : '#bd3b3b' });
  }
}

async function reconcileAtStartup() {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const data = await stored();
  let connection;
  let exclusions;
  try {
    connection = configuredConnection(data);
    exclusions = configuredExclusions(data);
  } catch {
    await chrome.storage.local.set({ enabled: false });
    await clearOwnProxySetting();
    await clearOwnWebRTCSetting();
    await updateBadge();
    return;
  }
  if (!data.enabled || !connection) {
    if (data.enabled && !connection) await chrome.storage.local.set({ enabled: false });
    await clearOwnProxySetting();
    await clearOwnWebRTCSetting();
  } else {
    const setting = await effectiveSetting();
    if (setting.levelOfControl === 'controlled_by_this_extension' || setting.levelOfControl === 'controllable_by_this_extension') {
      const rtc = await webRTCSetting();
      if (['controlled_by_this_extension', 'controllable_by_this_extension'].includes(rtc.levelOfControl)) {
        await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: WEBRTC_POLICY, scope: 'regular' });
      }
      await chrome.proxy.settings.set({ value: buildProxyConfig(connection, exclusions), scope: 'regular' });
    }
  }
  await updateBadge();
}

const boot = reconcileAtStartup().catch(async () => {
  try { await updateBadge(); } catch { /* Chrome may be shutting down. */ }
});

async function importKey(key) {
  const connection = parseConnectionKey(key);
  await chrome.storage.local.set({ enabled: false });
  await clearOwnProxySetting();
  await clearOwnWebRTCSetting();
  await chrome.storage.local.set({ connection, exclusions: [], proxyError: null });
  await updateBadge();
  return status();
}

async function connect() {
  const data = await stored();
  const connection = configuredConnection(data);
  if (!connection) throw new Error('Сначала добавьте ключ подключения.');
  const exclusions = configuredExclusions(data);
  const setting = await effectiveSetting();
  if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(setting.levelOfControl)) {
    throw new Error('Другое расширение или политика Chrome управляет прокси.');
  }
  const rtc = await webRTCSetting();
  if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(rtc.levelOfControl)) {
    throw new Error('Chrome не разрешает ограничить прямые WebRTC-соединения.');
  }
  await chrome.storage.local.set({ enabled: true, proxyError: null });
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: WEBRTC_POLICY, scope: 'regular' });
    if (!webRTCIsRestricted(await webRTCSetting())) {
      throw new Error('Chrome не применил ограничение WebRTC.');
    }
    await chrome.proxy.settings.set({ value: buildProxyConfig(connection, exclusions), scope: 'regular' });
    const applied = await effectiveSetting();
    if (!isEffectiveProxySetting(applied, buildProxyConfig(connection, exclusions))) {
      throw new Error('Chrome не применил настройку прокси.');
    }
  } catch (error) {
    await chrome.storage.local.set({ enabled: false });
    await clearOwnProxySetting();
    await clearOwnWebRTCSetting();
    throw error;
  }
  await updateBadge();
  return status();
}

async function disconnect() {
  await chrome.storage.local.set({ enabled: false, proxyError: null });
  await clearOwnProxySetting();
  await clearOwnWebRTCSetting();
  await updateBadge();
  return status();
}

async function forget() {
  await disconnect();
  await chrome.storage.local.remove(['connection', 'exclusions']);
  await updateBadge();
  return status();
}

async function saveExclusions(text) {
  const exclusions = normalizeExclusions(text);
  const old = await stored();
  const connection = configuredConnection(old);
  if (!connection) throw new Error('Сначала добавьте ключ подключения.');
  if (old.enabled) {
    const setting = await effectiveSetting();
    if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(setting.levelOfControl)) {
      throw new Error('Другое расширение или политика Chrome управляет прокси.');
    }
  }
  await chrome.storage.local.set({ exclusions, proxyError: null });
  if (old.enabled) {
    try {
      await chrome.proxy.settings.set({ value: buildProxyConfig(connection, exclusions), scope: 'regular' });
      const applied = await effectiveSetting();
      if (!isEffectiveProxySetting(applied, buildProxyConfig(connection, exclusions))) {
        throw new Error('Chrome не применил исключения.');
      }
    } catch (error) {
      await chrome.storage.local.set({ exclusions: old.exclusions || [] });
      try {
        await chrome.proxy.settings.set({ value: buildProxyConfig(connection, configuredExclusions(old)), scope: 'regular' });
      } catch { /* The status view will report the mismatch. */ }
      throw error;
    }
  }
  await updateBadge();
  return status();
}

async function testIp() {
  const current = await status();
  if (current.state !== 'active') {
    throw new Error('Сначала включите подключение и устраните ошибки прокси.');
  }
  if (isExcludedHost('api.ipify.org', current.exclusions)) {
    throw new Error('Сервис проверки IP находится в исключениях. Удалите его из списка и повторите проверку.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Сервис проверки IP недоступен.');
    const body = await response.json();
    if (typeof body.ip !== 'string' || body.ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(body.ip)) {
      throw new Error('Сервис проверки IP вернул некорректный ответ.');
    }
    if ((await status()).state !== 'active') {
      throw new Error('Во время проверки возникла ошибка прокси.');
    }
    return { ip: body.ip };
  } catch {
    throw new Error('Не удалось проверить внешний IP. Проверьте сервер и попробуйте ещё раз.');
  } finally {
    clearTimeout(timeout);
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  (async () => {
    await boot;
    switch (message?.type) {
      case 'GET_STATE': return status();
      case 'IMPORT_KEY': return exclusive(() => importKey(message.key));
      case 'CONNECT': return exclusive(connect);
      case 'DISCONNECT': return exclusive(disconnect);
      case 'FORGET': return exclusive(forget);
      case 'SAVE_EXCLUSIONS': return exclusive(() => saveExclusions(message.text));
      case 'TEST_IP': return testIp();
      default: throw new Error('Неизвестная команда.');
    }
  })().then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Неизвестная ошибка.' })
  );
  return true;
});

chrome.webRequest.onAuthRequired.addListener(
  (details, callback) => {
    if (details.isProxy !== true || details.statusCode !== 407 || String(details.scheme).toLowerCase() !== 'basic') {
      callback({});
      return;
    }
    let matched = false;
    (async () => {
      await boot;
      const data = await stored();
      if (!data.enabled || !data.connection) return {};
      const connection = configuredConnection(data);
      if (!isMatchingProxyChallenge(details, connection)) return {};
      matched = true;
      if (authAttempts.has(details.requestId)) {
        await chrome.storage.local.set({ proxyError: { possibleDirect: false, code: 'AUTH_FAILED', at: Date.now() } });
        await updateBadge();
        return { cancel: true };
      }
      authAttempts.set(details.requestId, true);
      return { authCredentials: { username: connection.username, password: connection.password } };
    })().then(callback, () => callback(matched ? { cancel: true } : {}));
  },
  { urls: ['<all_urls>'] },
  ['asyncBlocking']
);

const clearAuthAttempt = (details) => authAttempts.delete(details.requestId);
chrome.webRequest.onCompleted.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });
chrome.webRequest.onErrorOccurred.addListener(clearAuthAttempt, { urls: ['<all_urls>'] });

chrome.proxy.onProxyError.addListener((details) => {
  stored().then((data) => {
    if (!data.enabled) return;
    const code = typeof details.error === 'string' && /^[A-Z_]+$/.test(details.error) ? details.error : 'PROXY_ERROR';
    return chrome.storage.local.set({ proxyError: { possibleDirect: details.fatal === false, code, at: Date.now() } });
  }).then(updateBadge).catch(() => {});
});

chrome.proxy.settings.onChange.addListener(() => {
  updateBadge().catch(() => {});
});

chrome.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(() => {
  updateBadge().catch(() => {});
});
