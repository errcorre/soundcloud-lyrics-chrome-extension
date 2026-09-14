// content.js — работает на страницах soundcloud.com

(function () {
  const STATE = {
    lastKey: null,
    panelOpen: false,
    requestSeq: 0
  };

  // ---------- Определение текущего трека ----------

  // SoundCloud регулярно меняет классы, поэтому пробуем несколько вариантов
  // и, если ничего не нашлось, откатываемся на document.title.
  const TITLE_SELECTORS = [
    '.playbackSoundBadge__titleLink',
    'a.playbackSoundBadge__title',
    '.playbackSoundBadge__title a'
  ];
  const ARTIST_SELECTORS = [
    '.playbackSoundBadge__lightLink',
    '.playbackSoundBadge__username'
  ];

  // SoundCloud реализует прокрутку длинных заголовков через дублирование
  // текста в DOM (два одинаковых куска подряд, без пробела, для бесшовной
  // анимации), например "BABYLONBABYLON" вместо "BABYLON". Раскладываем
  // такие строки обратно на оригинал.
  function dedupeMarqueeText(text) {
    if (!text) return text;
    const trimmed = text.replace(/\s+/g, ' ').trim();
    // Допускаем разделитель между повторами: обычные пробелы/тире/точки
    // и невидимые юникод-пробелы (zero-width space и т.п.), которые
    // некоторые сайты используют между дублированными копиями текста
    // для анимации "бегущей строки".
    const match = trimmed.match(/^(.+?)(?:[\s\u200B\u200C\u200D\uFEFF\-–—•·]*\1)+$/);
    if (match) return match[1].trim();
    return trimmed;
  }

  function cleanElementText(el) {
    // title/aria-label обычно содержат исходный "чистый" текст без
    // дублирования, которое нужно только для CSS/JS-анимации marquee.
    const attr = (el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
    if (attr) return attr;
    return dedupeMarqueeText(el.textContent);
  }

  function textFromSelectors(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.textContent.trim()) {
        return cleanElementText(el);
      }
    }
    return '';
  }

  function guessFromDocumentTitle() {
    // Частый формат вкладки во время прослушивания: "Track Title by Artist"
    const t = document.title.replace(/^\(\d+\)\s*/, '').trim();
    const m = t.match(/^(.*)\s+by\s+(.*?)(\s*\|\s*Free Listening on SoundCloud)?$/i);
    if (m) {
      return { title: m[1].trim(), artist: m[2].trim() };
    }
    return null;
  }

  function getCurrentTrack() {
    let title = textFromSelectors(TITLE_SELECTORS);
    let artist = textFromSelectors(ARTIST_SELECTORS);

    if (!title || !artist) {
      const guess = guessFromDocumentTitle();
      if (guess) {
        title = title || guess.title;
        artist = artist || guess.artist;
      }
    }

    if (!title) return null;
    return { title, artist: artist || '' };
  }

  // ---------- Время воспроизведения (для синхронизации текста) ----------

  function getAudioElement() {
    return document.querySelector('audio');
  }

  function parseTimeToSeconds(text) {
    if (!text) return null;
    // Не заякориваем ^...$, т.к. контейнер может содержать ещё и скрытый
    // для скринридера текст вида "Current time: 34 seconds" перед/после
    // видимого "0:34" — просто ищем первое совпадение вида (H:)MM:SS.
    const m = text.match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const h = m[1] ? parseInt(m[1], 10) : 0;
    const min = parseInt(m[2], 10);
    const sec = parseInt(m[3], 10);
    return h * 3600 + min * 60 + sec;
  }

  function findTimeLabel(pattern) {
    // Ищем элемент, чей class содержит нужное слово (playbackTimeline__timePassed,
    // playbackTimeline__duration и т.п. — сайт может переименовывать префиксы,
    // поэтому матчим по подстроке, а не по точному классу).
    const el = document.querySelector(`[class*="${pattern}" i]`);
    if (!el) return null;
    // Внутри обычно два <span>: скрытый accessibility-текст и видимый
    // "0:34" с aria-hidden="true" — берём видимый, если он есть.
    const visible = el.querySelector('[aria-hidden="true"]');
    return parseTimeToSeconds(visible ? visible.textContent : el.textContent);
  }

  // Раньше здесь был отладочный console.log способа определения времени —
  // убран за ненадобностью, но саму функцию оставляем no-op'ом, чтобы не
  // трогать вызовы ниже по коду.
  function logTimeMethod() {}

  // Возвращает { seconds, durationSeconds } или null, если ни один способ
  // не сработал.
  function getPlaybackState() {
    // 1. Настоящий <audio> — самый надёжный вариант, если он есть.
    const audio = getAudioElement();
    if (audio && Number.isFinite(audio.currentTime) && Number.isFinite(audio.duration) && audio.duration > 0) {
      logTimeMethod('audio-element');
      return { seconds: audio.currentTime, durationSeconds: audio.duration };
    }

    // 2. Видимые текстовые метки времени (например "0:47" / "2:24").
    const elapsedFromText = findTimeLabel('timePassed') ?? findTimeLabel('timeElapsed') ?? findTimeLabel('currentTime');
    const durationFromText = findTimeLabel('duration') ?? findTimeLabel('totalTime');
    if (elapsedFromText != null && durationFromText != null) {
      logTimeMethod('text-labels', `${elapsedFromText}s / ${durationFromText}s`);
      return { seconds: elapsedFromText, durationSeconds: durationFromText };
    }

    // 3. ARIA прогресс-бар. На SoundCloud это role="progressbar" с
    //    aria-valuenow/aria-valuemax, заданными прямо в секундах.
    const progress = document.querySelector(
      '[role="progressbar"][aria-valuenow], [role="slider"][aria-valuenow]'
    );
    if (progress) {
      const now = parseFloat(progress.getAttribute('aria-valuenow'));
      const max = parseFloat(progress.getAttribute('aria-valuemax'));
      if (!Number.isNaN(now) && !Number.isNaN(max) && max > 0) {
        logTimeMethod('aria-progress-seconds', `${now}s / ${max}s`);
        return { seconds: now, durationSeconds: max };
      }
    }

    logTimeMethod('none-found');
    return null;
  }

  function getPlaybackSeconds() {
    const state = getPlaybackState();
    return state ? state.seconds : null;
  }

  function getDurationSeconds() {
    const state = getPlaybackState();
    return state ? state.durationSeconds : null;
  }

  // ---------- Панель и полноэкранный режим ----------

  let panelEl = null;
  let toggleBtn = null;
  let fsEl = null;

  const FS = {
    open: false,
    tickId: null,
    bgFit: 'cover'
  };

  // Аккуратные line-иконки вместо эмодзи (криво и по-разному рендерятся
  // в разных ОС). currentColor — чтобы наследовали цвет кнопки.
  function svgIcon(pathHtml, size, filled) {
    const style = filled
      ? 'fill="currentColor"'
      : 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"';
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" ${style}>${pathHtml}</svg>`;
  }

  const ICONS = {
    expand: svgIcon('<path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/>', 14, true),
    minimize: svgIcon('<line x1="5" y1="12" x2="19" y2="12"/>', 14, false),
    close: svgIcon('<line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/>', 16, false),
    gear: svgIcon('<path d="M19.14 12.94a7.14 7.14 0 000-1.88l2.03-1.58a.5.5 0 00.12-.64l-1.92-3.32a.5.5 0 00-.61-.22l-2.39.96a7.3 7.3 0 00-1.62-.94l-.36-2.54a.5.5 0 00-.5-.42h-3.84a.5.5 0 00-.5.42l-.36 2.54c-.59.24-1.13.56-1.62.94l-2.39-.96a.5.5 0 00-.61.22L1.65 8.84a.5.5 0 00.12.64l2.03 1.58a7.14 7.14 0 000 1.88l-2.03 1.58a.5.5 0 00-.12.64l1.92 3.32c.14.24.42.32.61.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.25.26.42.5.42h3.84c.24 0 .45-.17.5-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.24.1.47.02.61-.22l1.92-3.32a.5.5 0 00-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1112 8.5a3.5 3.5 0 010 7z"/>', 16, true)
  };

  // ---------- Иконка трека (вместо старого декоративного эквалайзера) ----------
  // Берём обложку из мини-плеера SoundCloud: .playControls__soundBadge
  // содержит .sc-artwork, у которого фон задаётся через style или CSS —
  // поэтому читаем computed style, а не только атрибут style.
  function getArtworkUrl() {
    const el = document.querySelector('.playControls__soundBadge .sc-artwork')
      || document.querySelector('.playbackSoundBadge__avatar .sc-artwork')
      || document.querySelector('.playbackSoundBadge .image');
    if (el) {
      const bg = getComputedStyle(el).backgroundImage;
      const m = bg && bg.match(/url\(["']?(https?:\/\/[^"')]+)["']?\)/);
      if (m) return m[1].replace(/-(t\d+x\d+|large|badge|small)\./i, '-t200x200.');
    }
    return null;
  }

  function updateHeaderArt() {
    const url = getArtworkUrl();
    [panelEl && panelEl.querySelector('#scl-panel-icon'), fsEl && fsEl.querySelector('#scl-fs-icon')]
      .forEach(el => {
        if (!el) return;
        el.style.backgroundImage = url ? `url("${url}")` : '';
        el.classList.toggle('scl-art-has-image', !!url);
      });
  }

  function buildUI() {
    toggleBtn = document.createElement('button');
    toggleBtn.id = 'scl-toggle-btn';
    toggleBtn.type = 'button';
    toggleBtn.textContent = 'L';
    toggleBtn.title = 'Текст песни (Genius)';
    toggleBtn.addEventListener('click', () => setPanelOpen(!STATE.panelOpen));
    document.body.appendChild(toggleBtn);

    panelEl = document.createElement('div');
    panelEl.id = 'scl-panel';
    panelEl.innerHTML = `
      <div id="scl-panel-header">
        <button id="scl-panel-icon" class="scl-art-icon" title="Обновить"></button>
        <div id="scl-panel-heading">
          <span id="scl-panel-artist"></span>
          <span id="scl-panel-title">Текст песни</span>
        </div>
        <div id="scl-panel-actions">
          <button id="scl-expand-btn" title="Во весь экран">${ICONS.expand}</button>
          <button id="scl-close-btn" title="Свернуть">${ICONS.minimize}</button>
        </div>
      </div>
      <div id="scl-panel-body">
        <p class="scl-hint">Включите трек на SoundCloud — текст появится здесь.</p>
      </div>
      <div id="scl-panel-footer">
        <a id="scl-source-link" href="#" target="_blank" rel="noopener"></a>
      </div>
    `;
    document.body.appendChild(panelEl);

    panelEl.querySelector('#scl-close-btn').addEventListener('click', () => setPanelOpen(false));
    panelEl.querySelector('#scl-panel-icon').addEventListener('click', () => {
      STATE.lastKey = null; // форсируем повторный запрос
      pollTrack();
    });
    panelEl.querySelector('#scl-expand-btn').addEventListener('click', () => openFullscreen());

    buildFullscreen();
  }

  function buildFullscreen() {
    fsEl = document.createElement('div');
    fsEl.id = 'scl-fullscreen';
    fsEl.innerHTML = `
      <img id="scl-fs-bg-img" alt="">
      <div id="scl-fs-bg-overlay"></div>

      <div id="scl-fs-topbar">
        <div id="scl-fs-heading">
          <button id="scl-fs-icon" class="scl-art-icon" title="Обновить"></button>
          <div>
            <span id="scl-fs-artist"></span>
            <span id="scl-fs-title">Текст песни</span>
          </div>
        </div>
        <div id="scl-fs-topbar-actions">
          <button id="scl-fs-settings-btn" title="Настройки фона">${ICONS.gear}</button>
          <button id="scl-fs-close" title="Закрыть">${ICONS.close}</button>
        </div>
      </div>

      <div id="scl-fs-settings">
        <div class="scl-fs-settings-row">
          <label>Задний фон</label>
          <div class="scl-fs-settings-actions">
            <button id="scl-fs-bg-pick" type="button">Выбрать файл</button>
            <button id="scl-fs-bg-clear" type="button">Сбросить</button>
          </div>
          <input type="file" id="scl-fs-bg-file" accept="image/*,.gif" hidden>
        </div>
        <div class="scl-fs-settings-row">
          <label>Размытие</label>
          <input type="range" id="scl-fs-bg-blur" min="0" max="30" step="1" value="0">
        </div>
        <div class="scl-fs-settings-row">
          <label>Растягивание</label>
          <div class="scl-fs-fit-group">
            <button data-fit="cover" class="scl-fs-fit-btn scl-fs-fit-active" type="button">Stretched</button>
            <button data-fit="contain" class="scl-fs-fit-btn" type="button">Full</button>
          </div>
        </div>
      </div>

      <div id="scl-fs-main">
        <div id="scl-fs-lyrics">
          <div id="scl-fs-lyrics-content">
            <p class="scl-hint">Включите трек на SoundCloud — текст появится здесь.</p>
          </div>
        </div>
      </div>

      <div id="scl-fs-toast"></div>
    `;
    document.body.appendChild(fsEl);

    fsEl.querySelector('#scl-fs-close').addEventListener('click', () => closeFullscreen());
    fsEl.querySelector('#scl-fs-icon').addEventListener('click', () => {
      STATE.lastKey = null;
      pollTrack();
    });

    // ---------- Настройки фона ----------
    const settingsBtn = fsEl.querySelector('#scl-fs-settings-btn');
    const settingsPanel = fsEl.querySelector('#scl-fs-settings');
    const bgImg = fsEl.querySelector('#scl-fs-bg-img');
    const bgFile = fsEl.querySelector('#scl-fs-bg-file');

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = settingsPanel.classList.toggle('scl-fs-settings-open');
      settingsBtn.classList.toggle('scl-fs-settings-active', open);
    });
    document.addEventListener('click', (e) => {
      if (!settingsPanel.classList.contains('scl-fs-settings-open')) return;
      if (settingsPanel.contains(e.target) || settingsBtn.contains(e.target)) return;
      settingsPanel.classList.remove('scl-fs-settings-open');
      settingsBtn.classList.remove('scl-fs-settings-active');
    });

    fsEl.querySelector('#scl-fs-bg-pick').addEventListener('click', () => bgFile.click());
    bgFile.addEventListener('change', () => {
      const file = bgFile.files && bgFile.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        bgImg.src = reader.result;
        bgImg.classList.add('scl-fs-bg-active');
        showToast('Фон обновлён');
      };
      reader.readAsDataURL(file);
    });

    fsEl.querySelector('#scl-fs-bg-clear').addEventListener('click', () => {
      bgImg.classList.remove('scl-fs-bg-active');
      bgImg.removeAttribute('src');
      bgFile.value = '';
    });

    fsEl.querySelector('#scl-fs-bg-blur').addEventListener('input', (e) => {
      bgImg.style.filter = `blur(${e.target.value}px)`;
    });

    fsEl.querySelectorAll('.scl-fs-fit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        FS.bgFit = btn.getAttribute('data-fit');
        bgImg.style.objectFit = FS.bgFit;
        fsEl.querySelectorAll('.scl-fs-fit-btn').forEach(b => b.classList.toggle('scl-fs-fit-active', b === btn));
      });
    });

    window.addEventListener('resize', () => { if (FS.open) syncFsBottomInset(); });
  }

  function showToast(text) {
    const toast = fsEl.querySelector('#scl-fs-toast');
    toast.textContent = text;
    toast.classList.add('scl-fs-toast-show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.remove('scl-fs-toast-show'), 1600);
  }

  function openFullscreen() {
    FS.open = true;
    fsEl.classList.add('scl-fs-open');
    document.documentElement.classList.add('scl-fs-lock');
    updateHeaderArt();
    syncFsBottomInset();
    if (!FS.tickId) FS.tickId = setInterval(syncFsBottomInset, 500);
  }

  function closeFullscreen() {
    FS.open = false;
    fsEl.classList.remove('scl-fs-open');
    document.documentElement.classList.remove('scl-fs-lock');
    if (FS.tickId) { clearInterval(FS.tickId); FS.tickId = null; }
  }

  // Оставляем видимой родную нижнюю панель SoundCloud — просто не
  // перекрываем её собственным фоном полноэкранного режима.
  function getRealPlayBarEl() {
    return document.querySelector('.playControls[class*="control-bar" i]')
      || document.querySelector('.playControls');
  }

  function syncFsBottomInset() {
    const bar = getRealPlayBarEl();
    const h = bar ? Math.ceil(bar.getBoundingClientRect().height) : 0;
    fsEl.style.bottom = h + 'px';
  }

  function setPanelOpen(open) {
    STATE.panelOpen = open;
    panelEl.classList.toggle('scl-open', open);
    toggleBtn.classList.toggle('scl-active', open);
  }

  function stanzaHtml(text) {
    const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return text
      .split(/\n\s*\n/)
      .map(stanza => `<p class="scl-stanza">${stanza.split('\n').map(escape).join('<br>')}</p>`)
      .join('');
  }

  function setHeading(title, artist) {
    panelEl.querySelector('#scl-panel-artist').textContent = artist || '';
    panelEl.querySelector('#scl-panel-title').textContent = title || 'Текст песни';
    fsEl.querySelector('#scl-fs-artist').textContent = artist || '';
    fsEl.querySelector('#scl-fs-title').textContent = title || 'Текст песни';
    updateHeaderArt();
  }

  function setBodyAll(html) {
    panelEl.querySelector('#scl-panel-body').innerHTML = html;
    fsEl.querySelector('#scl-fs-lyrics-content').innerHTML = html;
  }

  function setSource(url, label) {
    const a = panelEl.querySelector('#scl-source-link');
    if (url) {
      a.href = url;
      a.textContent = label || 'Открыть на Genius';
      a.style.display = 'inline';
    } else {
      a.style.display = 'none';
    }
  }

  function renderLoading(title, artist) {
    stopSyncLoop();
    setHeading(title, artist);
    setBodyAll('<p class="scl-hint">Ищу текст на Genius…</p>');
    setSource(null);
  }

  function renderLyrics(title, artist, lyrics, sourceUrl, geniusTitle) {
    stopSyncLoop();
    setHeading(title, artist);
    setBodyAll(`<div class="scl-lyrics">${stanzaHtml(lyrics)}</div>`);
    setSource(sourceUrl, geniusTitle ? `Genius: ${geniusTitle}` : 'Открыть на Genius');
  }

  // ---------- Синхронизированный (LRC) режим ----------

  let syncIntervalId = null;
  let syncCues = null;
  let syncActiveIndex = -1;

  function stopSyncLoop() {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
    syncCues = null;
    syncActiveIndex = -1;
  }

  function updateSyncHighlight() {
    const current = getPlaybackSeconds();
    if (current == null || !syncCues || !syncCues.length) return;

    let idx = -1;
    for (let i = 0; i < syncCues.length; i++) {
      if (syncCues[i].time <= current) idx = i;
      else break;
    }
    if (idx === syncActiveIndex) return;
    syncActiveIndex = idx;

    document.querySelectorAll('#scl-panel-body .scl-line, #scl-fs-lyrics-content .scl-line').forEach((el) => {
      el.classList.toggle('scl-active-line', Number(el.dataset.index) === idx);
    });
    if (idx >= 0) {
      document.querySelectorAll(`.scl-line[data-index="${idx}"]`).forEach(el => {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      });
    }
  }

  function renderSyncedLyrics(title, artist, cues, sourceUrl, label) {
    stopSyncLoop();
    setHeading(title, artist);

    const escape = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    const html = cues
      .map((c, i) => `<div class="scl-line" data-index="${i}" data-time="${c.time}">${escape(c.text) || '&nbsp;'}</div>`)
      .join('');
    setBodyAll(`<div class="scl-lyrics scl-synced">${html}</div>`);
    setSource(sourceUrl, label || 'lrclib.net');

    syncCues = cues;
    syncActiveIndex = -1;
    syncIntervalId = setInterval(updateSyncHighlight, 300);
    updateSyncHighlight();
  }

  function renderError(title, artist, message, code) {
    stopSyncLoop();
    setHeading(title, artist);
    let extra = '';
    if (code === 'NO_TOKEN' || code === 'BAD_TOKEN') {
      extra = `<p class="scl-hint"><a href="#" id="scl-open-options">Открыть настройки расширения</a></p>`;
    }
    setBodyAll(`<p class="scl-error">${message}</p>${extra}`);
    setSource(null);
    document.querySelectorAll('#scl-open-options').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' });
      });
    });
  }

  // ---------- Опрос текущего трека ----------

  function pollTrack() {
    const track = getCurrentTrack();
    if (!track) return;

    const key = `${track.artist}::${track.title}`.toLowerCase();
    if (key === STATE.lastKey) return;
    STATE.lastKey = key;

    const seq = ++STATE.requestSeq;
    renderLoading(track.title, track.artist);

    chrome.runtime.sendMessage(
      {
        type: 'FETCH_LYRICS',
        title: track.title,
        artist: track.artist,
        durationSeconds: getDurationSeconds()
      },
      (response) => {
        if (seq !== STATE.requestSeq) return; // трек уже сменился, ответ устарел
        if (chrome.runtime.lastError) {
          renderError(track.title, track.artist, 'Расширение потеряло связь с фоновым процессом. Обновите страницу.');
          return;
        }
        if (response && response.ok && response.mode === 'synced') {
          renderSyncedLyrics(track.title, track.artist, response.cues, response.sourceUrl, response.geniusTitle);
        } else if (response && response.ok) {
          renderLyrics(track.title, track.artist, response.lyrics, response.sourceUrl, response.geniusTitle);
        } else {
          renderError(track.title, track.artist, (response && response.error) || 'Неизвестная ошибка.', response && response.code);
        }
      }
    );
  }

  function init() {
    buildUI();
    pollTrack();
    setInterval(pollTrack, 2000);

    const observer = new MutationObserver(() => pollTrack());
    observer.observe(document.title ? document.head : document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
