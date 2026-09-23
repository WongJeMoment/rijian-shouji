/* 日记在浏览器中加密，密文同步到云端；密码不写入公开仓库。 */
const CLOUD_ORIGIN = location.hostname === '127.0.0.1' || location.hostname === 'localhost' || location.hostname.endsWith('.chatgpt.site') ? location.origin : 'https://rijian-shouji-cloud.workspace-985459.chatgpt.site';
const KEY_SALT = new TextEncoder().encode('rijian-shouji-private-archive-v1');
const DB_NAME = 'rijian-shouji-v1';
const STORE_NAME = 'entries';
const state = { key: null, token: null, entries: [], selectedId: null, editingId: null, images: [], dirty: false, mode: 'edit' };
const $ = (selector) => document.querySelector(selector);
let databasePromise;
let toastTimer;

function bytesToBase64(bytes) { let out = ''; for (let i = 0; i < bytes.length; i += 8192) out += String.fromCharCode(...bytes.subarray(i, i + 8192)); return btoa(out); }
function base64ToBytes(value) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function deriveKey(password) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: KEY_SALT, iterations: 250000, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function encrypt(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.key, bytes);
  return { iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(encrypted)) };
}
async function decrypt(row) {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(row.iv) }, state.key, base64ToBytes(row.data));
  return JSON.parse(new TextDecoder().decode(bytes));
}
function openDatabase() {
  if (!databasePromise) databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}
async function getRows() {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function putRows(rows) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    for (const row of rows) tx.objectStore(STORE_NAME).put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
async function deleteRow(id) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function cloudRequest(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) };
  const result = await fetch(CLOUD_ORIGIN + path, { ...options, headers, cache: 'no-store' });
  const body = await result.json().catch(() => ({}));
  if (!result.ok) throw new Error(body.error || `http_${result.status}`);
  return body;
}
async function cloudRows() { return (await cloudRequest('/api/entries')).entries; }
async function cloudPut(row) { return cloudRequest(`/api/entries/${row.id}`, { method: 'PUT', body: JSON.stringify(row) }); }
async function migrateLocalRows() {
  let remote = await cloudRows();
  if (localStorage.getItem('rijian-cloud-migrated-v1') === 'yes') return remote;
  const local = await getRows();
  const byId = new Map(remote.map(row => [row.id, row]));
  for (const row of local) {
    const counterpart = byId.get(row.id);
    const localEntry = await decrypt(row);
    if (!counterpart || localEntry.updatedAt > (await decrypt(counterpart)).updatedAt) await cloudPut(row);
  }
  localStorage.setItem('rijian-cloud-migrated-v1', 'yes');
  if (local.length) { remote = await cloudRows(); showToast(`已将原设备的 ${local.length} 篇本地留档检查并同步到云端。`); }
  return remote;
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.remove('hidden');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add('hidden'), 3500);
}
function formatDate(value, options = { year: 'numeric', month: 'long', day: 'numeric' }) { return new Intl.DateTimeFormat('zh-CN', options).format(new Date(value)); }
function monthKey(value) { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(new Date(value)); }
function cleanExcerpt(body) { return body.replace(/\[\[image:[^\]]+\]\]/g, '').replace(/^[#>\-]\s*/gm, '').replace(/\s+/g, ' ').trim(); }
function isUnsaved() { return state.mode === 'edit' && state.dirty; }
function mayLeave() { return !isUnsaved() || confirm('这篇日记还没有保存，确定离开吗？'); }

async function unlock(event) {
  event.preventDefault();
  const password = $('#password').value;
  const button = $('#unlock-form button[type="submit"]');
  button.disabled = true; button.textContent = '正在解锁…';
  $('#lock-error').textContent = '';
  try {
    const login = await cloudRequest('/api/auth', { method: 'POST', body: JSON.stringify({ password }) });
    state.token = login.token;
    state.key = await deriveKey(password);
    const rows = await migrateLocalRows();
    state.entries = await Promise.all(rows.map(async row => ({ ...await decrypt(row), id: row.id })));
    state.entries.sort((a, b) => b.createdAt - a.createdAt);
    $('#password').value = '';
    $('#lock-screen').classList.add('hidden'); $('#app').classList.remove('hidden');
    renderArchive();
    if (state.entries.length) openEntry(state.entries[0].id); else newEntry(true);
  } catch (error) {
    console.error(error);
    state.token = null; state.key = null;
    $('#lock-error').textContent = error.message === 'wrong_password' ? '密码不正确，请再试一次。' : error.message === 'too_many_attempts' ? '尝试次数过多，请十五分钟后再试。' : '云端暂时无法连接，请检查网络后重试。';
  } finally { button.disabled = false; button.innerHTML = '进入我的日记 <span aria-hidden="true">↗</span>'; }
}
function lock() {
  if (!mayLeave()) return;
  state.key = null; state.token = null; state.entries = []; state.images = []; state.selectedId = null; state.editingId = null; state.dirty = false;
  $('#reader-content').replaceChildren(); $('#attachment-list').replaceChildren();
  $('#app').classList.add('hidden'); $('#lock-screen').classList.remove('hidden'); $('#password').focus();
}
function renderArchive() {
  const list = $('#archive-list'); list.replaceChildren();
  $('#entry-count').textContent = String(state.entries.length).padStart(2, '0');
  const query = $('#search-input').value.trim().toLocaleLowerCase();
  const matches = state.entries.filter(entry => (entry.title + ' ' + cleanExcerpt(entry.body)).toLocaleLowerCase().includes(query));
  if (!matches.length) { const empty = document.createElement('p'); empty.className = 'archive-empty'; empty.textContent = query ? '没有找到匹配的日记。' : '留档还是空的，写下第一篇吧。'; list.append(empty); return; }
  let lastMonth = '';
  for (const entry of matches) {
    const month = monthKey(entry.createdAt);
    if (month !== lastMonth) { const label = document.createElement('p'); label.className = 'archive-month'; label.textContent = month; list.append(label); lastMonth = month; }
    const button = document.createElement('button'); button.type = 'button'; button.className = 'archive-item' + (state.selectedId === entry.id ? ' active' : '');
    const date = document.createElement('span'); date.className = 'archive-item-date'; date.textContent = formatDate(entry.createdAt, { month: '2-digit', day: '2-digit', weekday: 'short' });
    const title = document.createElement('span'); title.className = 'archive-item-title'; title.textContent = entry.title;
    const excerpt = document.createElement('span'); excerpt.className = 'archive-item-excerpt'; excerpt.textContent = cleanExcerpt(entry.body) || `${entry.images.length} 张照片`;
    button.append(date, title, excerpt); button.addEventListener('click', () => { if (mayLeave()) openEntry(entry.id); }); list.append(button);
  }
}
function newEntry(force = false) {
  if (!force && !mayLeave()) return;
  state.mode = 'edit'; state.editingId = null; state.selectedId = null; state.images = []; state.dirty = false;
  $('#entry-title').value = ''; $('#entry-body').value = '';
  $('#editor-heading-title').innerHTML = '写下今天的故事<span class="period">.</span>';
  $('#entry-date').textContent = formatDate(Date.now());
  $('#entry-number').textContent = String(state.entries.length + 1).padStart(3, '0');
  $('#section-label').textContent = 'NEW ENTRY / 新的一页';
  $('#cancel-edit').classList.add('hidden'); $('#save-status').textContent = '';
  $('#reader-view').classList.add('hidden'); $('#editor-view').classList.remove('hidden');
  renderAttachments(); renderWordCount(); renderArchive(); $('#entry-title').focus();
}
function editEntry() {
  const entry = state.entries.find(item => item.id === state.selectedId); if (!entry) return;
  state.mode = 'edit'; state.editingId = entry.id; state.images = structuredClone(entry.images); state.dirty = false;
  $('#entry-title').value = entry.title; $('#entry-body').value = entry.body;
  $('#entry-date').textContent = formatDate(entry.createdAt);
  $('#entry-number').textContent = String(state.entries.findIndex(item => item.id === entry.id) + 1).padStart(3, '0');
  $('#editor-heading-title').innerHTML = '继续写这一天<span class="period">.</span>';
  $('#section-label').textContent = 'EDIT ENTRY / 编辑日记'; $('#cancel-edit').classList.remove('hidden'); $('#save-status').textContent = '';
  $('#reader-view').classList.add('hidden'); $('#editor-view').classList.remove('hidden');
  renderAttachments(); renderWordCount(); $('#entry-title').focus();
}
function openEntry(id) {
  const entry = state.entries.find(item => item.id === id); if (!entry) return;
  state.mode = 'read'; state.selectedId = id; state.editingId = null; state.dirty = false;
  $('#section-label').textContent = 'ARCHIVE / 日记留档';
  $('#editor-view').classList.add('hidden'); $('#reader-view').classList.remove('hidden');
  renderReader(entry); renderArchive();
}
function textNode(tag, content, className) { const el = document.createElement(tag); el.textContent = content; if (className) el.className = className; return el; }
function renderReader(entry) {
  const target = $('#reader-content'); target.replaceChildren();
  target.append(textNode('div', formatDate(entry.createdAt, { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' }), 'reader-date'));
  target.append(textNode('h1', entry.title, 'reader-title'));
  const rule = document.createElement('div'); rule.className = 'reader-rule'; target.append(rule);
  const body = document.createElement('div'); body.className = 'reader-body'; target.append(body);
  const images = new Map(entry.images.map(image => [image.id, image]));
  const lines = entry.body.replace(/\r\n/g, '\n').split('\n');
  let paragraph = [], list = [];
  const flushParagraph = () => { if (paragraph.length) { body.append(textNode('p', paragraph.join('\n'))); paragraph = []; } };
  const flushList = () => { if (list.length) { const ul = document.createElement('ul'); for (const item of list) ul.append(textNode('li', item)); body.append(ul); list = []; } };
  for (const line of lines) {
    const trimmed = line.trim();
    const marker = trimmed.match(/^\[\[image:([a-f0-9-]+)\]\]$/i);
    if (marker) {
      flushParagraph(); flushList();
      const image = images.get(marker[1]);
      if (image) { const figure = document.createElement('figure'); figure.className = 'reader-figure'; const img = document.createElement('img'); img.src = image.dataUrl; img.alt = image.name || '日记照片'; img.loading = 'lazy'; figure.append(img); body.append(figure); }
    } else if (!trimmed) { flushParagraph(); flushList(); }
    else if (/^#{1,3}\s+/.test(trimmed)) { flushParagraph(); flushList(); body.append(textNode('h2', trimmed.replace(/^#{1,3}\s+/, ''))); }
    else if (/^>\s?/.test(trimmed)) { flushParagraph(); flushList(); body.append(textNode('blockquote', trimmed.replace(/^>\s?/, ''))); }
    else if (/^[-*]\s+/.test(trimmed)) { flushParagraph(); list.push(trimmed.replace(/^[-*]\s+/, '')); }
    else { flushList(); paragraph.push(line); }
  }
  flushParagraph(); flushList();
  if (!body.childNodes.length) body.append(textNode('p', '这一天，留下了几张照片。'));
}
function renderWordCount() { $('#word-count').textContent = `${$('#entry-body').value.replace(/\[\[image:[^\]]+\]\]/g, '').replace(/\s/g, '').length} 字`; }
function renderAttachments() {
  const target = $('#attachment-list'); target.replaceChildren(); target.classList.toggle('hidden', !state.images.length);
  for (const image of state.images) {
    const tile = document.createElement('div'); tile.className = 'attachment';
    const img = document.createElement('img'); img.src = image.dataUrl; img.alt = image.name;
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除${image.name}`);
    remove.addEventListener('click', () => { state.images = state.images.filter(item => item.id !== image.id); $('#entry-body').value = $('#entry-body').value.replaceAll(`[[image:${image.id}]]`, '').replace(/\n{3,}/g, '\n\n'); state.dirty = true; renderAttachments(); renderWordCount(); });
    tile.append(img, remove); target.append(tile);
  }
}
function insertAtCursor(text) {
  const textarea = $('#entry-body'); const start = textarea.selectionStart; const end = textarea.selectionEnd;
  const before = textarea.value.slice(0, start), after = textarea.value.slice(end);
  const prefix = before && !before.endsWith('\n') ? '\n' : '';
  const suffix = after && !after.startsWith('\n') ? '\n' : '';
  textarea.value = before + prefix + text + '\n' + suffix + after;
  textarea.selectionStart = textarea.selectionEnd = (before + prefix + text + '\n').length;
  state.dirty = true; renderWordCount();
}
function fileToDataUrl(file) { return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }
async function optimizeImage(file) {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') return fileToDataUrl(file);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
  return canvas.toDataURL('image/webp', .86);
}
async function addImages(files) {
  const accepted = Array.from(files).filter(file => file.type.startsWith('image/'));
  if (!accepted.length) return;
  if (state.images.length + accepted.length > 30) { showToast('每篇日记最多放 30 张照片。'); return; }
  $('#save-status').textContent = '正在处理照片…';
  try {
    for (const file of accepted) {
      if (file.size > 25 * 1024 * 1024) { showToast(`${file.name} 超过 25 MB，已跳过。`); continue; }
      const dataUrl = await optimizeImage(file);
      const image = { id: crypto.randomUUID(), name: file.name, dataUrl };
      state.images.push(image); insertAtCursor(`[[image:${image.id}]]`);
    }
    renderAttachments(); showToast('照片已放入日记。');
  } catch (error) { console.error(error); showToast('有照片无法读取，请换一张再试。'); }
  finally { $('#save-status').textContent = ''; $('#photo-input').value = ''; }
}
async function saveEntry(event) {
  event.preventDefault();
  const title = $('#entry-title').value.trim(); const body = $('#entry-body').value.trim();
  if (!title) { $('#entry-title').focus(); showToast('先给这篇日记起个名字。'); return; }
  if (!body && !state.images.length) { $('#entry-body').focus(); showToast('写一点文字或加一张照片吧。'); return; }
  const existing = state.entries.find(item => item.id === state.editingId);
  const entry = { id: existing?.id || crypto.randomUUID(), title, body, images: structuredClone(state.images), createdAt: existing?.createdAt || Date.now(), updatedAt: Date.now() };
  const button = $('#save-entry'); button.disabled = true; $('#save-status').textContent = '正在加密并同步到云端…';
  try {
    const encrypted = await encrypt(entry); const row = { id: entry.id, ...encrypted };
    await cloudPut(row);
    try { await putRows([row]); } catch (cacheError) { console.warn('Local cache unavailable', cacheError); }
    state.entries = state.entries.filter(item => item.id !== entry.id); state.entries.push(entry); state.entries.sort((a, b) => b.createdAt - a.createdAt);
    state.dirty = false; openEntry(entry.id); showToast('日记已加密保存到云端。');
  } catch (error) { console.error(error); $('#save-status').textContent = '云端保存失败，请检查网络后重试。'; showToast('云端保存失败，请检查网络后重试。'); }
  finally { button.disabled = false; }
}
async function removeEntry() {
  const entry = state.entries.find(item => item.id === state.selectedId); if (!entry || !confirm(`确定删除《${entry.title}》吗？删除后无法恢复，除非已有备份。`)) return;
  try { await cloudRequest(`/api/entries/${entry.id}`, { method: 'DELETE' }); try { await deleteRow(entry.id); } catch (cacheError) { console.warn('Local cache unavailable', cacheError); } state.entries = state.entries.filter(item => item.id !== entry.id); showToast('日记已从云端删除。'); if (state.entries.length) openEntry(state.entries[0].id); else newEntry(true); }
  catch (error) { console.error(error); showToast('删除失败，请重试。'); }
}
async function exportArchive() {
  try {
    const rows = await cloudRows();
    const backup = { app: 'rijian-shouji', version: 1, exportedAt: new Date().toISOString(), entries: rows };
    const url = URL.createObjectURL(new Blob([JSON.stringify(backup)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = `日间手记-加密备份-${new Date().toISOString().slice(0, 10)}.json`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    showToast(`已导出 ${rows.length} 篇日记的加密备份。`);
  } catch (error) { console.error(error); showToast('导出失败，请重试。'); }
}
async function importArchive(event) {
  const file = event.target.files?.[0]; event.target.value = ''; if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    if (backup.app !== 'rijian-shouji' || backup.version !== 1 || !Array.isArray(backup.entries)) throw new Error('bad-format');
    const imported = [];
    for (const row of backup.entries) {
      if (typeof row.id !== 'string' || typeof row.iv !== 'string' || typeof row.data !== 'string') throw new Error('bad-row');
      const entry = await decrypt(row);
      if (entry.id !== row.id || typeof entry.title !== 'string' || typeof entry.body !== 'string' || !Array.isArray(entry.images)) throw new Error('bad-entry');
      imported.push({ row, entry });
    }
    if (!confirm(`备份中有 ${imported.length} 篇日记。导入会补充留档，并用备份版本覆盖同一篇日记。确定导入吗？`)) return;
    for (const item of imported) await cloudPut(item.row);
    try { await putRows(imported.map(item => item.row)); } catch (cacheError) { console.warn('Local cache unavailable', cacheError); }
    const rows = await cloudRows(); state.entries = await Promise.all(rows.map(async row => ({ ...await decrypt(row), id: row.id })));
    state.entries.sort((a, b) => b.createdAt - a.createdAt);
    if (state.entries.length) openEntry(state.entries[0].id); else newEntry(true);
    showToast(`已导入 ${imported.length} 篇日记。`);
  } catch (error) { console.error(error); showToast('导入失败：文件格式错误，或与当前密码不匹配。'); }
}

$('#unlock-form').addEventListener('submit', unlock);
$('#toggle-password').addEventListener('click', () => { const input = $('#password'); input.type = input.type === 'password' ? 'text' : 'password'; $('#toggle-password').textContent = input.type === 'password' ? '显示' : '隐藏'; $('#toggle-password').setAttribute('aria-label', input.type === 'password' ? '显示密码' : '隐藏密码'); });
$('#lock-button').addEventListener('click', lock);
$('#home-link').addEventListener('click', event => { event.preventDefault(); if (mayLeave()) { if (state.entries.length) openEntry(state.entries[0].id); else newEntry(true); } });
$('#new-entry').addEventListener('click', () => newEntry());
$('#search-input').addEventListener('input', renderArchive);
$('#entry-form').addEventListener('submit', saveEntry);
for (const selector of ['#entry-title', '#entry-body']) $(selector).addEventListener('input', () => { state.dirty = true; renderWordCount(); });
$('#cancel-edit').addEventListener('click', () => { if (mayLeave()) openEntry(state.editingId); });
$('#edit-entry').addEventListener('click', editEntry);
$('#delete-entry').addEventListener('click', removeEntry);
$('#photo-dropzone').addEventListener('click', () => $('#photo-input').click());
$('#photo-dropzone').addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('#photo-input').click(); } });
$('#photo-input').addEventListener('change', event => addImages(event.target.files));
$('#entry-body').addEventListener('paste', event => { const files = Array.from(event.clipboardData?.files || []).filter(file => file.type.startsWith('image/')); if (files.length) { event.preventDefault(); addImages(files); } });
for (const selector of ['#entry-body', '#photo-dropzone', '.editor-paper']) {
  const zone = $(selector);
  zone.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); $('#photo-dropzone').classList.add('dragging'); $('#drop-overlay').classList.remove('hidden'); } });
  zone.addEventListener('dragleave', event => { if (!zone.contains(event.relatedTarget)) { $('#photo-dropzone').classList.remove('dragging'); $('#drop-overlay').classList.add('hidden'); } });
  zone.addEventListener('drop', event => { event.preventDefault(); event.stopPropagation(); $('#photo-dropzone').classList.remove('dragging'); $('#drop-overlay').classList.add('hidden'); addImages(event.dataTransfer.files); });
}
document.addEventListener('dragover', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer?.types.includes('Files')) event.preventDefault(); });
$('#export-button').addEventListener('click', exportArchive);
$('#import-button').addEventListener('click', () => { if (mayLeave()) $('#import-input').click(); });
$('#import-input').addEventListener('change', importArchive);
window.addEventListener('beforeunload', event => { if (isUnsaved()) { event.preventDefault(); event.returnValue = ''; } });
$('#today-label').textContent = formatDate(Date.now(), { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
$('#year').textContent = new Date().getFullYear();
