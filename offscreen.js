// offscreen.js — у offscreen-документа есть доступ к DOMParser/document,
// в отличие от service worker, поэтому парсинг HTML делаем здесь.

function htmlToPlainLyrics(container) {
  // Заменяем <br> на переносы строк перед чтением innerText,
  // чтобы сохранить построчную структуру.
  container.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  return container.innerText || container.textContent || '';
}

function stripLeadingBoilerplate(text) {
  // На некоторых (особенно переводных) страницах Genius перед самим
  // текстом песни внутри того же блока идёт описание трека
  // ("34 Contributors...Read More [Текст песни «X»]"). Настоящий текст
  // почти всегда начинается со строки-заголовка вида "[Intro]", "[Verse 1]",
  // "[Припев]" и т.п. — обрезаем всё, что стоит раньше первой такой строки.
  const lines = text.split('\n');
  const idx = lines.findIndex(line => /^\s*\[[^\]]{1,60}\]\s*$/.test(line));
  if (idx > 0) {
    return lines.slice(idx).join('\n').trim();
  }
  return text;
}

function extractLyrics(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Актуальная разметка Genius: один или несколько
  // <div data-lyrics-container="true">...</div>
  const containers = doc.querySelectorAll('div[data-lyrics-container="true"]');

  if (!containers.length) {
    return null;
  }

  const parts = Array.from(containers).map(htmlToPlainLyrics);
  let text = parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  text = stripLeadingBoilerplate(text);
  return text || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'PARSE_LYRICS' && message.target === 'offscreen') {
    try {
      const lyrics = extractLyrics(message.html);
      if (!lyrics) {
        sendResponse({ ok: false, error: 'На странице Genius не найден блок с текстом песни.' });
      } else {
        sendResponse({ ok: true, lyrics });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  }
  return false;
});
