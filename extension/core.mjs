const KEY_PREFIX = 'shbvpn1:';
const MAX_KEY_LENGTH = 4096;
const MAX_EXCLUSIONS = 100;

function isValidHost(host) {
  if (typeof host !== 'string' || host.length < 3 || host.length > 253 || host !== host.trim()) {
    return false;
  }
  const value = host.toLowerCase();
  if (/^\d+(?:\.\d+){3}$/.test(value)) {
    return value.split('.').every((octet) => Number(octet) <= 255 && Number(octet) >= 0 && String(Number(octet)) === octet);
  }
  if (/^[\d.]+$/.test(value) || !value.includes('.')) {
    return false;
  }
  return value.split('.').every((label) => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
}

export function validateConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Некорректный ключ подключения.');
  }
  const keys = Object.keys(value).sort();
  const legacy = value.v === 1 && keys.join(',') === 'host,password,port,username,v';
  const generic = value.v === 2 && keys.join(',') === 'host,password,port,scheme,username,v';
  if (!legacy && !generic) {
    throw new Error('Неподдерживаемый формат ключа подключения.');
  }
  if (generic && !['http', 'https', 'socks5'].includes(value.scheme)) {
    throw new Error('Неподдерживаемый тип прокси.');
  }
  if (generic && value.scheme === 'socks5' && (value.username !== '' || value.password !== '')) {
    throw new Error('Chrome не поддерживает SOCKS5 с логином и паролем.');
  }
  const anonymous = generic && value.username === '' && value.password === '';
  if (!isValidHost(value.host)) {
    throw new Error('В ключе указан некорректный адрес сервера.');
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error('В ключе указан некорректный порт.');
  }
  if (typeof value.username !== 'string' || (!anonymous && value.username.length < 1) || value.username.length > 256 || /[:\x00-\x1f\x7f]/.test(value.username)) {
    throw new Error('В ключе указано некорректное имя пользователя.');
  }
  if (typeof value.password !== 'string' || (!anonymous && value.password.length < 1) || value.password.length > 512 || /[\x00-\x1f\x7f]/.test(value.password)) {
    throw new Error('В ключе указан некорректный пароль.');
  }
  return {
    v: value.v,
    ...(generic ? { scheme: value.scheme } : {}),
    host: value.host.toLowerCase(),
    port: value.port,
    username: value.username,
    password: value.password
  };
}

export function parseConnectionKey(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Вставьте ключ подключения.');
  }
  const key = raw.trim();
  if (!key.startsWith(KEY_PREFIX) || key.length > MAX_KEY_LENGTH) {
    throw new Error('Ключ должен начинаться с shbvpn1:.');
  }
  const encoded = key.slice(KEY_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('Некорректный ключ подключения.');
  }
  try {
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return validateConnection(JSON.parse(json));
  } catch (error) {
    if (error instanceof Error && /ключ|порт|адрес|пользователя|пароль|формат/.test(error.message)) {
      throw error;
    }
    throw new Error('Не удалось прочитать ключ подключения.');
  }
}

export function normalizeExclusions(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Введите домены для исключений.');
  }
  const result = [];
  for (const item of raw.split(/[\s,;]+/).filter(Boolean)) {
    const domain = item.replace(/^\*\./, '').toLowerCase();
    if (!isValidHost(domain)) {
      throw new Error('Некорректный домен в исключениях. Укажите домен без схемы и пути.');
    }
    if (!result.includes(domain)) {
      result.push(domain);
    }
    if (result.length > MAX_EXCLUSIONS) {
      throw new Error(`Можно добавить не больше ${MAX_EXCLUSIONS} исключений.`);
    }
  }
  return result;
}

export function isExcludedHost(host, exclusions) {
  const normalizedHost = host.toLowerCase().replace(/\.$/, '');
  return exclusions.some((domain) => normalizedHost === domain || normalizedHost.endsWith(`.${domain}`));
}

export function buildPacScript(connection, exclusions = []) {
  const safe = validateConnection(connection);
  if (!Array.isArray(exclusions) || exclusions.some((item) => typeof item !== 'string')) {
    throw new Error('Некорректные исключения.');
  }
  const normalized = normalizeExclusions(exclusions.join('\n'));
  const protocol = { http: 'PROXY', https: 'HTTPS', socks5: 'SOCKS5' }[safe.scheme || 'https'];
  const proxy = `${protocol} ${safe.host}:${safe.port}`;
  return `var SHBVPN_PROXY = ${JSON.stringify(proxy)};\n` +
    `var SHBVPN_EXCLUSIONS = ${JSON.stringify(normalized)};\n` +
    `function FindProxyForURL(url, host) {\n` +
    `  var h = host.toLowerCase().replace(/\\.$/, '');\n` +
    `  for (var i = 0; i < SHBVPN_EXCLUSIONS.length; i++) {\n` +
    `    var d = SHBVPN_EXCLUSIONS[i];\n` +
    `    if (h === d || h.slice(-(d.length + 1)) === '.' + d) return 'DIRECT';\n` +
    `  }\n` +
    `  return SHBVPN_PROXY;\n` +
    `}\n`;
}

export function buildProxyConfig(connection, exclusions = []) {
  return {
    mode: 'pac_script',
    pacScript: {
      data: buildPacScript(connection, exclusions),
      mandatory: true
    }
  };
}

export function isEffectiveProxySetting(setting, expectedConfig) {
  return setting?.levelOfControl === 'controlled_by_this_extension' &&
    setting.value?.mode === 'pac_script' &&
    setting.value?.pacScript?.mandatory === true &&
    setting.value?.pacScript?.data === expectedConfig.pacScript.data;
}

export function isMatchingProxyChallenge(details, connection) {
  return connection.scheme !== 'socks5' && connection.username !== '' &&
    details?.isProxy === true &&
    details.statusCode === 407 &&
    String(details.scheme).toLowerCase() === 'basic' &&
    details.challenger?.host?.toLowerCase() === connection.host &&
    details.challenger?.port === connection.port;
}

export function normalizeExpectedIp(raw) {
  if (typeof raw !== 'string') throw new Error('Укажите IP текстом.');
  const value = raw.trim();
  if (!value) return '';
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && isValidHost(value)) return value;
  if (/^[0-9a-fA-F:]+$/.test(value) && value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.slice(1,-1); } catch {}
  }
  throw new Error('Укажите IPv4 или IPv6 без порта и протокола.');
}
