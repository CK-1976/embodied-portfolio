// 用发布内容的签名识别草稿归属，防止旧草稿覆盖新版本。
export function contentSignature(value) {
  if (Array.isArray(value)) return '[' + value.map(contentSignature).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + contentSignature(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

export function archiveDraft(text) {
  const key = 'portfolio-draft-backup-' + Date.now();
  localStorage.setItem(key, text);
  localStorage.setItem('portfolio-last-draft-backup', key);
}

export function restoreDraft(published, validate) {
  const baseline = contentSignature(published);
  const text = localStorage.getItem('portfolio-draft');
  let draft;
  try { draft = text ? JSON.parse(text) : null; } catch { draft = null; }
  if (draft && !validate(draft) && localStorage.getItem('portfolio-draft-base') === baseline) return {data:draft, baseline, restored:true};
  if (text && contentSignature(draft) !== baseline) archiveDraft(text);
  localStorage.setItem('portfolio-draft', JSON.stringify(published));
  localStorage.setItem('portfolio-draft-base', baseline);
  return {data:published, baseline, restored:false, archived:!!text};
}

export function previewDraft(published) {
  try {
    const draft = JSON.parse(localStorage.getItem('portfolio-draft'));
    if (localStorage.getItem('portfolio-draft-base') === contentSignature(published) && draft?.profile && Array.isArray(draft.projects)) return draft;
  } catch { /* 草稿不可用时使用发布内容。 */ }
  return published;
}

export function announceSaved() {
  localStorage.setItem('portfolio-saved-version', String(Date.now()));
}

// 已打开的正式页面在切回窗口、保存后或每分钟检查一次新版本。
export function watchPublished(initial, render) {
  let current = contentSignature(initial);
  let busy = false;
  const check = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const response = await fetch('content.json', {cache:'no-store'});
      if (!response.ok) return;
      const data = await response.json();
      const next = contentSignature(data);
      if (next !== current) { render(data); current = next; }
    } catch { /* 网络恢复后再检查，保留正在阅读的页面。 */ }
    finally { busy = false; }
  };
  window.addEventListener('focus', check);
  document.addEventListener('visibilitychange', check);
  window.addEventListener('storage', (event) => { if (event.key === 'portfolio-saved-version') check(); });
  setInterval(check, 60000);
}
