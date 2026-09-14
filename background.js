// background.js — service worker
// Отвечает за:
// 1. поиск трека через официальный Genius Search API (нужен личный Client Access Token)
// 2. скачивание HTML-страницы найденной песни на genius.com
// 3. делегирование парсинга текста offscreen-документу (там есть DOMParser)

const GENIUS_SEARCH_ENDPOINT = 'https://api.genius.com/search?q=';

async function getToken() {
  const { geniusToken } = await chrome.storage.sync.get('geniusToken');
  return geniusToken || null;
}

function cleanForSearch(str) {
  if (!str) return '';
  return str
    .replace(/\(.*?\)|\[.*?\]/g, ' ')       // убираем (feat. ...), [Remix] и т.п.
    .replace(/feat\.?|ft\.?/gi, ' ')
    .replace(/official\s*(video|audio|lyrics)?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchGenius(artist, title) {
  const token = await getToken();
  if (!token) {
    const err = new Error('Не задан Genius Client Access Token. Откройте настройки расширения.');
    err.code = 'NO_TOKEN';
    throw err;
  }

  const query = encodeURIComponent(`${cleanForSearch(artist)} ${cleanForSearch(title)}`.trim());
  const res = await fetch(`${GENIUS_SEARCH_ENDPOINT}${query}`, {
    headers: { Authorization: `Bearer ${token}` }
  });

  if (res.status === 401) {
    const err = new Error('Genius отклонил токен (401). Проверьте Client Access Token в настройках.');
    err.code = 'BAD_TOKEN';
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Ошибка поиска Genius: HTTP ${res.status}`);
  }

  const data = await res.json();
  const hits = (data.response && data.response.hits) || [];
  if (!hits.length) {
    const err = new Error('Ничего не найдено на Genius для этого трека.');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // Простая эвристика ранжирования: совпадение слов заголовка/исполнителя.
  const titleWords = cleanForSearch(title).toLowerCase().split(/\s+/).filter(Boolean);
  const scored = hits
    .map(h => h.result)
    .filter(r => r && r.url)
    .map(r => {
      const fullTitle = `${r.title} ${r.primary_artist ? r.primary_artist.name : ''}`.toLowerCase();
      const score = titleWords.reduce((acc, w) => acc + (fullTitle.includes(w) ? 1 : 0), 0);
      return { result: r, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0].result;
}

async function fetchGeniusPageHTML(url) {
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) {
    throw new Error(`Не удалось загрузить страницу Genius: HTTP ${res.status}`);
  }
  return res.text();
}

// ---------- Синхронизированный текст (lrclib.net) ----------
// lrclib.net — открытая бесплатная база LRC-текстов (не требует ключа).
// Она никак не связана с Genius, поэтому просто пробуем её первой; если
// ничего не нашлось — используем обычный (не построчно-синхронный) текст
// с Genius, как и раньше.

function parseLRC(lrc) {
  const timeTag = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  const cues = [];
  for (const rawLine of lrc.split('\n')) {
    const tags = [...rawLine.matchAll(timeTag)];
    if (!tags.length) continue;
    const text = rawLine.replace(timeTag, '').trim();
    for (const t of tags) {
      const min = parseInt(t[1], 10);
      const sec = parseInt(t[2], 10);
      const fraction = t[3] ? parseInt(t[3].padEnd(3, '0').slice(0, 3), 10) / 1000 : 0;
      cues.push({ time: min * 60 + sec + fraction, text });
    }
  }
  cues.sort((a, b) => a.time - b.time);
  return cues.filter(c => c.text); // пустые "разделительные" метки не нужны для рендера
}

async function lrclibGetExact(artist, title, durationSeconds) {
  const params = new URLSearchParams({
    artist_name: artist || '',
    track_name: title || ''
  });
  if (durationSeconds) params.set('duration', String(Math.round(durationSeconds)));
  const res = await fetch(`https://lrclib.net/api/get?${params.toString()}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data && data.syncedLyrics ? data : null;
}

async function lrclibSearch(artist, title) {
  const q = encodeURIComponent(`${cleanForSearch(title)} ${cleanForSearch(artist)}`.trim());
  const res = await fetch(`https://lrclib.net/api/search?q=${q}`);
  if (!res.ok) return null;
  const list = await res.json();
  if (!Array.isArray(list) || !list.length) return null;

  const titleWords = cleanForSearch(title).toLowerCase().split(/\s+/).filter(Boolean);
  const withSync = list.filter(item => item.syncedLyrics);
  if (!withSync.length) return null;

  withSync.sort((a, b) => {
    const scoreOf = item => {
      const t = `${item.trackName} ${item.artistName}`.toLowerCase();
      return titleWords.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0);
    };
    return scoreOf(b) - scoreOf(a);
  });
  return withSync[0];
}

async function fetchSyncedLyrics(artist, title, durationSeconds) {
  try {
    const exact = await lrclibGetExact(artist, title, durationSeconds);
    if (exact) return exact;
  } catch (e) { /* игнорируем, пробуем поиск */ }

  try {
    const found = await lrclibSearch(artist, title);
    if (found) return found;
  } catch (e) { /* нет синхронизированного текста — не критично */ }

  return null;
}

// ---------- Оркестрация ----------

let offscreenReady = null;

async function ensureOffscreenDocument() {
  if (offscreenReady) return offscreenReady;

  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    if (existing.length > 0) return;

    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_PARSER'],
      justification: 'Парсинг HTML страницы Genius для извлечения текста песни'
    });
  })();

  return offscreenReady;
}

async function extractLyricsFromHTML(html) {
  await ensureOffscreenDocument();
  const response = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'PARSE_LYRICS',
    html
  });
  if (!response || !response.ok) {
    throw new Error((response && response.error) || 'Не удалось разобрать текст песни.');
  }
  return response.lyrics;
}

async function handleFetchLyrics(artist, title, durationSeconds) {
  // 1. Пробуем найти синхронизированный (построчно-таймингованный) текст.
  const synced = await fetchSyncedLyrics(artist, title, durationSeconds);
  if (synced) {
    const cues = parseLRC(synced.syncedLyrics);
    if (cues.length) {
      return {
        ok: true,
        mode: 'synced',
        cues,
        lyrics: synced.plainLyrics || cues.map(c => c.text).join('\n'),
        sourceUrl: 'https://lrclib.net',
        geniusTitle: `${synced.trackName} — ${synced.artistName}`
      };
    }
  }

  // 2. Фолбэк — обычный текст с Genius, без тайминга.
  const song = await searchGenius(artist, title);
  const html = await fetchGeniusPageHTML(song.url);
  const lyrics = await extractLyricsFromHTML(html);
  return {
    ok: true,
    mode: 'plain',
    lyrics,
    sourceUrl: song.url,
    geniusTitle: song.full_title || song.title
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'OPEN_OPTIONS') {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (message && message.type === 'FETCH_LYRICS' && (!message.target || message.target === 'background')) {
    handleFetchLyrics(message.artist, message.title, message.durationSeconds)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, error: err.message, code: err.code }));
    return true; // ответ асинхронный
  }
  // Прочие сообщения (например PARSE_LYRICS адресованные offscreen) фоновый скрипт игнорирует.
  return false;
});
