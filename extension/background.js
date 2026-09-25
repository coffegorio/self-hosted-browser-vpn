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
let configurationChanging = false;
let configurationEpoch = 0;
let proxyErrorEpoch = 0;
let browserSettingEpoch = 0;
let restoreAfterIncognitoTakeover = false;
let ownProxyClearedForConflict = false;

function exclusive(task) {
  const next = operation.then(async () => {
    configurationChanging = true;
    configurationEpoch++;
    try {
      return await task();
    } finally {
      configurationChanging = false;
    }
  });
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

async function effectiveSetting(incognito = false) {
  return chrome.proxy.settings.get({ incognito });
}

async function clearOwnProxySetting() {
  // Clear this extension's preference even when another extension currently has precedence.
  // Otherwise our old preference could become active again when that extension turns off.
  await chrome.proxy.settings.clear({ scope: 'regular' });
}

async function clearOwnWebRTCSetting() {
  await chrome.privacy.network.webRTCIPHandlingPolicy.clear({ scope: 'regular' });
}

async function webRTCSetting(incognito = false) {
  return chrome.privacy.network.webRTCIPHandlingPolicy.get({ incognito });
}

function webRTCIsRestricted(setting) {
  return setting.levelOfControl === 'controlled_by_this_extension' && setting.value === WEBRTC_POLICY;
}

async function incognitoWebRTCIsRestricted() {
  try {
    if (!(await chrome.extension.isAllowedIncognitoAccess())) return true;
    return webRTCIsRestricted(await webRTCSetting(true));
  } catch {
    return false;
  }
}

async function webRTCIsRestrictedInAllEnabledContexts() {
  return webRTCIsRestricted(await webRTCSetting()) && await incognitoWebRTCIsRestricted();
}

async function incognitoProxyState(expected) {
  try {
    if (!(await chrome.extension.isAllowedIncognitoAccess())) {
      return { controllable: true, effective: true, levelOfControl: null };
    }
    const setting = await effectiveSetting(true);
    return {
      controllable: ['controlled_by_this_extension', 'controllable_by_this_extension'].includes(setting.levelOfControl),
      effective: isEffectiveProxySetting(setting, expected),
      levelOfControl: setting.levelOfControl
    };
  } catch {
    return { controllable: false, effective: false, levelOfControl: null };
  }
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
  if (!webRTCIsRestricted(webRTC)) {
    return { ...base, state: 'error', message: 'Chrome не применил ограничение прямых WebRTC-соединений.' };
  }
  if (!await incognitoWebRTCIsRestricted()) {
    return { ...base, state: 'error', message: 'Chrome не применил ограничение WebRTC в режиме инкогнито.' };
  }
  const expected = buildProxyConfig(connection, exclusions);
  const incognitoProxy = await incognitoProxyState(expected);
  if (!incognitoProxy.controllable) {
    return { ...base, state: 'conflict', message: 'Chrome не разрешает этому расширению управлять прокси в режиме инкогнито.' };
  }
  if (setting.levelOfControl !== 'controlled_by_this_extension') {
    return { ...base, state: 'conflict', message: 'Chrome не разрешает этому расширению управлять прокси.' };
  }
  if (!isEffectiveProxySetting(setting, expected)) {
    return { ...base, state: 'error', message: 'Настройка прокси в Chrome отличается от выбранной.' };
  }
  if (!incognitoProxy.effective) {
    return { ...base, state: 'error', message: 'Настройка прокси в режиме инкогнито отличается от выбранной.' };
  }
  if (data.proxyError) {
    return {
      ...base,
      state: 'error',
      // Chrome may fall back to DIRECT after a nonfatal proxy error.
      canRetryIp: data.proxyError.possibleDirect !== true,
      message: data.proxyError.possibleDirect
        ? 'Chrome сообщил о прямом подключении. Отключите прокси и проверьте настройки Chrome.'
        : 'Chrome сообщил об ошибке прокси. Проверьте сервер и повторите проверку IP.'
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
    try {
      const rtc = await webRTCSetting();
      if (!webRTCIsRestricted(rtc)) {
        await clearOwnProxySetting();
        if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(rtc.levelOfControl)) {
          throw new Error('Chrome не разрешает ограничить WebRTC.');
        }
        await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: WEBRTC_POLICY, scope: 'regular' });
        if (!webRTCIsRestricted(await webRTCSetting())) {
          throw new Error('Chrome не применил ограничение WebRTC.');
        }
      }
      if (!await incognitoWebRTCIsRestricted()) {
        throw new Error('Chrome не применил ограничение WebRTC в режиме инкогнито.');
      }
      const setting = await effectiveSetting();
      if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(setting.levelOfControl)) {
        throw new Error('Chrome не разрешает управлять прокси.');
      }
      const expected = buildProxyConfig(connection, exclusions);
      if (!(await incognitoProxyState(expected)).controllable) {
        restoreAfterIncognitoTakeover = true;
        throw new Error('Chrome не разрешает управлять прокси в режиме инкогнито.');
      }
      if (!isEffectiveProxySetting(setting, expected)) {
        await chrome.proxy.settings.set({ value: expected, scope: 'regular' });
        if (!isEffectiveProxySetting(await effectiveSetting(), expected)) {
          throw new Error('Chrome не применил настройку прокси.');
        }
      }
      if (!webRTCIsRestricted(await webRTCSetting())) {
        throw new Error('Chrome потерял ограничение WebRTC.');
      }
      if (!await incognitoWebRTCIsRestricted()) {
        throw new Error('Chrome не применил ограничение WebRTC в режиме инкогнито.');
      }
      if (!(await incognitoProxyState(expected)).effective) {
        throw new Error('Chrome не применил настройку прокси в режиме инкогнито.');
      }
      restoreAfterIncognitoTakeover = false;
      ownProxyClearedForConflict = false;
    } catch {
      // A stored PAC must never remain active if WebRTC cannot be restricted.
      await clearOwnProxySetting();
    }
  }
  await updateBadge();
}

const boot = reconcileAtStartup().catch(async () => {
  try { await clearOwnProxySetting(); } catch { /* Chrome may be shutting down. */ }
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
    await clearOwnProxySetting();
    throw new Error('Другое расширение или политика Chrome управляет прокси.');
  }
  const expected = buildProxyConfig(connection, exclusions);
  if (!(await incognitoProxyState(expected)).controllable) {
    await clearOwnProxySetting();
    throw new Error('Другое расширение или политика Chrome управляет прокси в режиме инкогнито.');
  }
  const rtc = await webRTCSetting();
  if (!['controlled_by_this_extension', 'controllable_by_this_extension'].includes(rtc.levelOfControl)) {
    await clearOwnProxySetting();
    throw new Error('Chrome не разрешает ограничить прямые WebRTC-соединения.');
  }
  if (!webRTCIsRestricted(rtc)) await clearOwnProxySetting();
  await chrome.storage.local.set({ enabled: true, proxyError: null });
  try {
    await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: WEBRTC_POLICY, scope: 'regular' });
    if (!webRTCIsRestricted(await webRTCSetting())) {
      throw new Error('Chrome не применил ограничение WebRTC.');
    }
    if (!await incognitoWebRTCIsRestricted()) {
      throw new Error('Chrome не применил ограничение WebRTC в режиме инкогнито.');
    }
    await chrome.proxy.settings.set({ value: expected, scope: 'regular' });
    const applied = await effectiveSetting();
    if (!isEffectiveProxySetting(applied, expected)) {
      throw new Error('Chrome не применил настройку прокси.');
    }
    if (!(await incognitoProxyState(expected)).effective) {
      throw new Error('Chrome не применил настройку прокси в режиме инкогнито.');
    }
    if (!await webRTCIsRestrictedInAllEnabledContexts()) {
      throw new Error('Chrome потерял ограничение WebRTC.');
    }
  } catch (error) {
    await chrome.storage.local.set({ enabled: false });
    await clearOwnProxySetting();
    await clearOwnWebRTCSetting();
    await updateBadge();
    throw error;
  }
  restoreAfterIncognitoTakeover = false;
  ownProxyClearedForConflict = false;
  await updateBadge();
  return status();
}

async function disconnect() {
  restoreAfterIncognitoTakeover = false;
  ownProxyClearedForConflict = false;
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
      await clearOwnProxySetting();
      throw new Error('Другое расширение или политика Chrome управляет прокси.');
    }
    if (!await webRTCIsRestrictedInAllEnabledContexts()) {
      await clearOwnProxySetting();
      throw new Error('Chrome не применил ограничение WebRTC.');
    }
    if (!(await incognitoProxyState(buildProxyConfig(connection, configuredExclusions(old)))).controllable) {
      restoreAfterIncognitoTakeover = true;
      await clearOwnProxySetting();
      throw new Error('Другое расширение или политика Chrome управляет прокси в режиме инкогнито.');
    }
  }
  await chrome.storage.local.set({ exclusions });
  if (old.enabled) {
    try {
      await chrome.proxy.settings.set({ value: buildProxyConfig(connection, exclusions), scope: 'regular' });
      const applied = await effectiveSetting();
      if (!isEffectiveProxySetting(applied, buildProxyConfig(connection, exclusions))) {
        throw new Error('Chrome не применил исключения.');
      }
      if (!(await incognitoProxyState(buildProxyConfig(connection, exclusions))).effective) {
        throw new Error('Chrome не применил исключения в режиме инкогнито.');
      }
      if (!await webRTCIsRestrictedInAllEnabledContexts()) {
        throw new Error('Chrome потерял ограничение WebRTC.');
      }
    } catch (error) {
      await chrome.storage.local.set({ exclusions: old.exclusions || [] });
      try {
        const previous = buildProxyConfig(connection, configuredExclusions(old));
        if (!await webRTCIsRestrictedInAllEnabledContexts() ||
            !(await incognitoProxyState(previous)).controllable) {
          throw new Error('Chrome не разрешает восстановить прежний прокси.');
        }
        await chrome.proxy.settings.set({ value: previous, scope: 'regular' });
        if (!isEffectiveProxySetting(await effectiveSetting(), previous) ||
            !(await incognitoProxyState(previous)).effective ||
            !await webRTCIsRestrictedInAllEnabledContexts()) {
          throw new Error('Chrome не восстановил прежний прокси во всех окнах.');
        }
      } catch {
        try { await clearOwnProxySetting(); } catch { /* The status view will report the mismatch. */ }
      }
      await updateBadge();
      throw error;
    }
  }
  ownProxyClearedForConflict = false;
  await updateBadge();
  return status();
}

async function testIp() {
  let epoch = configurationEpoch;
  const settingEpoch = browserSettingEpoch;
  const errorEpoch = proxyErrorEpoch;
  const changed = () => configurationEpoch !== epoch || browserSettingEpoch !== settingEpoch || proxyErrorEpoch !== errorEpoch;
  const current = await status();
  if (configurationChanging || changed()) {
    throw new Error('Параметры подключения изменились во время проверки. Повторите проверку IP.');
  }
  if (current.state !== 'active' && current.canRetryIp !== true) {
    throw new Error('Сначала включите подключение и устраните ошибки прокси.');
  }
  if (isExcludedHost('api.ipify.org', current.exclusions)) {
    throw new Error('Сервис проверки IP находится в исключениях. Удалите его из списка и повторите проверку.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  const previousError = current.proxyError;
  try {
    const response = await fetch('https://api.ipify.org?format=json', { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error('Сервис проверки IP недоступен.');
    const body = await response.json();
    if (typeof body.ip !== 'string' || body.ip.length > 64 || !/^[0-9a-fA-F:.]+$/.test(body.ip)) {
      throw new Error('Сервис проверки IP вернул некорректный ответ.');
    }
    const after = await status();
    if (configurationChanging || changed() || (after.state !== 'active' && after.canRetryIp !== true)) {
      throw new Error('Во время проверки возникла ошибка прокси.');
    }
    if (previousError) {
      await exclusive(async () => {
        // Entering this queued operation increments the epoch once. No other
        // configuration operation may have run since the IP request started.
        if (configurationEpoch !== epoch + 1) {
          throw new Error('Параметры подключения изменились во время проверки.');
        }
        epoch = configurationEpoch;
        const data = await stored();
        const latest = await status();
        if (changed() ||
            JSON.stringify(data.proxyError) !== JSON.stringify(previousError) ||
            latest.canRetryIp !== true) {
          throw new Error('Во время проверки возникла ошибка прокси.');
        }
        await chrome.storage.local.set({ proxyError: null });
        if (changed()) {
          throw new Error('Во время проверки возникла ошибка прокси.');
        }
        await updateBadge();
      });
    }
    if (configurationChanging || changed()) {
      throw new Error('Параметры подключения изменились во время проверки.');
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
      const epoch = configurationEpoch;
      const settingEpoch = browserSettingEpoch;
      if (configurationChanging) return { cancel: true };
      const data = await stored();
      if (!data.enabled || !data.connection) return {};
      const connection = configuredConnection(data);
      if (!isMatchingProxyChallenge(details, connection)) return {};
      matched = true;
      let incognito;
      if (Number.isInteger(details.tabId) && details.tabId >= 0) {
        const tab = await chrome.tabs.get(details.tabId);
        if (typeof tab.incognito !== 'boolean') return { cancel: true };
        incognito = tab.incognito;
      } else if (details.tabId === -1 &&
                 details.initiator === `chrome-extension://${chrome.runtime.id}`) {
        // Only this service worker's requests have a known context without a tab.
        incognito = chrome.extension?.inIncognitoContext === true;
      } else {
        return { cancel: true };
      }
      const expected = buildProxyConfig(connection, configuredExclusions(data));
      const [setting, rtc] = await Promise.all([effectiveSetting(incognito), webRTCSetting(incognito)]);
      // Do not hand out a secret after either our configuration or Chrome's effective setting changes.
      if (configurationChanging || configurationEpoch !== epoch || browserSettingEpoch !== settingEpoch ||
          !isEffectiveProxySetting(setting, expected) || !webRTCIsRestricted(rtc)) {
        return { cancel: true };
      }
      if (authAttempts.has(details.requestId)) {
        proxyErrorEpoch++;
        await exclusive(async () => {
          await chrome.storage.local.set({ proxyError: { possibleDirect: false, code: 'AUTH_FAILED', at: Date.now() } });
          await updateBadge();
        });
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
  proxyErrorEpoch++;
  exclusive(async () => {
    const data = await stored();
    if (!data.enabled) return;
    const code = typeof details.error === 'string' && /^[A-Z_]+$/.test(details.error) ? details.error : 'PROXY_ERROR';
    await chrome.storage.local.set({ proxyError: { possibleDirect: details.fatal === false, code, at: Date.now() } });
    await updateBadge();
  }).catch(() => {});
});

chrome.proxy.settings.onChange.addListener(() => {
  browserSettingEpoch++;
  boot.then(() => exclusive(async () => {
    try {
      const data = await stored();
      if (data.enabled && data.connection) {
        const expected = buildProxyConfig(configuredConnection(data), configuredExclusions(data));
        const incognito = await incognitoProxyState(expected);
        const regular = await effectiveSetting();
        if (incognito.effective) {
          restoreAfterIncognitoTakeover = false;
          ownProxyClearedForConflict = false;
        }
        if (!incognito.effective && !ownProxyClearedForConflict) {
          restoreAfterIncognitoTakeover = !incognito.controllable;
          await clearOwnProxySetting();
          ownProxyClearedForConflict = true;
        }
        if (restoreAfterIncognitoTakeover && incognito.levelOfControl === 'controllable_by_this_extension' &&
            regular.levelOfControl === 'controllable_by_this_extension' &&
            await webRTCIsRestrictedInAllEnabledContexts()) {
          restoreAfterIncognitoTakeover = false;
          ownProxyClearedForConflict = false;
          await reconcileAtStartup();
        }
      }
    } finally {
      await updateBadge();
    }
  })).catch(() => {});
});

chrome.privacy.network.webRTCIPHandlingPolicy.onChange.addListener(() => {
  browserSettingEpoch++;
  boot.then(() => exclusive(reconcileAtStartup)).catch(() => {});
});
