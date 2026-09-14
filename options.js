const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');

chrome.storage.sync.get('geniusToken', ({ geniusToken }) => {
  if (geniusToken) tokenInput.value = geniusToken;
});

document.getElementById('save').addEventListener('click', () => {
  const value = tokenInput.value.trim();
  chrome.storage.sync.set({ geniusToken: value }, () => {
    statusEl.textContent = value ? 'Сохранено.' : 'Токен очищен.';
    setTimeout(() => (statusEl.textContent = ''), 2500);
  });
});
