import {createPublishZip, deleteMediaFile, loadMediaFiles, saveMediaFile} from './editor-storage.js';

const list = document.querySelector('#project-list');
const form = document.querySelector('#editor-form');
const title = document.querySelector('#form-title');
const description = document.querySelector('#section-description');
const saveState = document.querySelector('#save-state');
const previewPanel = document.querySelector('#preview-panel');
const sitePreview = document.querySelector('#site-preview');
const resumePreview = document.querySelector('#resume-preview');
const toast = document.querySelector('#toast');
const uploaded = new Map();
const objectUrls = new Map();
const sentRevision = new WeakMap();
const pendingUploads = new Set();
const sourceProfile = {name:'作品集作者', initials:'PI', email:'', emailAlt:'', phone:''};
let data;
let mode = 'profile';
let projectIndex = 0;
let mediaRevision = 0;
let exportBusy = false;
let previewTimer;
let toastTimer;

function isRecord(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }

function validateData(value) {
  if (!isRecord(value) || !isRecord(value.profile)) return '缺少个人资料';
  if (!Array.isArray(value.projects) || !value.projects.every((project) => isRecord(project) && typeof project.id === 'string' && typeof project.title === 'string' && Array.isArray(project.tags) && Array.isArray(project.contributions) && Array.isArray(project.resumeBullets) && Array.isArray(project.media) && project.media.every(isRecord))) return '项目列表格式错误';
  if (!Array.isArray(value.experiences) || !value.experiences.every((experience) => isRecord(experience) && Array.isArray(experience.bullets))) return '工作经历格式错误';
  if (!Array.isArray(value.capabilities) || !value.capabilities.every((capability) => isRecord(capability) && Array.isArray(capability.tags))) return '能力列表格式错误';
  if (!Array.isArray(value.certificates) || !Array.isArray(value.navigation) || !value.navigation.every((item) => isRecord(item) && typeof item.label === 'string' && typeof item.href === 'string')) return '证书或导航格式错误';
  return '';
}

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function notify(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 4500);
}

function field(label, key, value = '', options = {}) {
  const rows = options.rows || 3;
  const attributes = `${options.array ? ` data-array="${options.array}"` : ''}${options.placeholder ? ` placeholder="${escapeHtml(options.placeholder)}"` : ''}`;
  return `<label class="field ${options.long ? 'full' : ''}"><span>${escapeHtml(label)}</span>${options.long
    ? `<textarea data-field="${escapeHtml(key)}" rows="${rows}"${attributes}>${escapeHtml(Array.isArray(value) ? value.join('\n') : value)}</textarea>`
    : `<input data-field="${escapeHtml(key)}" value="${escapeHtml(value)}"${attributes} />`}</label>`;
}

function sectionHeading(text, destination) {
  return `<h2>${text}<span class="section-destination">${destination}</span></h2>`;
}

function assetUrl(path = '') {
  const value = String(path);
  if (objectUrls.has(value)) return objectUrls.get(value);
  return /^(assets\/|https?:\/\/)/i.test(value) ? value : '';
}

function imagePreview(path, label, type = 'image', poster = '') {
  const source = assetUrl(path);
  const cover = assetUrl(poster);
  if (type === 'video' && source) return `<video src="${escapeHtml(source)}" ${cover ? `poster="${escapeHtml(cover)}"` : ''} controls preload="metadata" aria-label="${escapeHtml(label)}"></video>`;
  if (source) return `<img src="${escapeHtml(source)}" alt="${escapeHtml(label)}" loading="lazy" />`;
  return `<span>${escapeHtml(label || '暂无素材')}</span>`;
}

function filePicker(label, kind, index = null) {
  const accept = kind === 'media' || kind === 'new-media' ? 'image/jpeg,image/png,image/webp,video/mp4' : 'image/jpeg,image/png,image/webp';
  const dropIndex = index === null ? '' : ` data-drop-index="${index}"`;
  const uploadIndex = index === null ? '' : ` data-upload-index="${index}"`;
  return `<label class="file-picker" data-drop-kind="${kind}"${dropIndex}>${escapeHtml(label)}<input type="file" data-upload-kind="${kind}"${uploadIndex} accept="${accept}" ${kind === 'new-media' ? 'multiple' : ''} /></label>`;
}

function saveDraft() {
  try {
    localStorage.setItem('portfolio-draft', JSON.stringify(data));
    saveState.textContent = '草稿已保存';
  } catch {
    saveState.textContent = '草稿保存失败';
    notify('浏览器存储空间不足，请及时下载发布包。', true);
  }
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => sendPreview(), 130);
}

function sourceSnapshot() {
  const snapshot = structuredClone(data);
  Object.assign(snapshot.profile, sourceProfile);
  return snapshot;
}

function sendPreview(focus = false) {
  if (!data) return;
  for (const frame of [sitePreview, resumePreview]) {
    if (!frame.contentWindow || frame.dataset.loaded !== 'true') continue;
    const needsFiles = sentRevision.get(frame) !== mediaRevision;
    const message = {type: 'portfolio:preview', data, focus: focus ? (mode === 'project' ? data.projects[projectIndex]?.id : mode) : ''};
    if (needsFiles) message.files = Array.from(referencedAssets()).filter((path) => uploaded.has(path)).map((path) => uploaded.get(path));
    frame.contentWindow.postMessage(message, location.origin);
    sentRevision.set(frame, mediaRevision);
  }
}

function renderSidebar() {
  document.querySelectorAll('.sidebar-link').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
  list.innerHTML = (data.projects || []).map((project, index) => `<button type="button" class="project-link ${mode === 'project' && index === projectIndex ? 'active' : ''}" data-index="${index}"><span>${escapeHtml(project.title || '未命名项目')}</span><small>${String(index + 1).padStart(2, '0')}</small></button>`).join('');
}

function renderProfile() {
  const p = data.profile;
  title.textContent = '首页与联系方式';
  description.textContent = '这里的文字会出现在网站首页、联系区和简历抬头。';
  form.innerHTML = `<section class="form-section">${sectionHeading('首页首屏', '显示在网站')}
    <div class="form-grid">${field('首页大标题', 'headline', p.headline, {long:true,rows:2})}${field('首页简介', 'intro', p.intro, {long:true,rows:3})}${field('网站身份描述', 'role', p.role)}${field('姓名（私密资料）', 'name', p.name)}${field('姓名缩写（私密资料）', 'initials', p.initials)}${field('最后更新月份', 'updated', p.updated)}</div>
    <div class="form-divider"></div><h3 class="form-subheading">首页主图</h3><div class="media-grid"><div class="media-preview">${imagePreview(p.heroImage || 'assets/images/drone-hardware.webp', '首页主图')}</div><div class="media-inputs">${filePicker('选择或拖入首页图片', 'hero')}<span class="file-picked">${escapeHtml(p.heroImage || 'assets/images/drone-hardware.webp')}</span></div></div>
  </section><section class="form-section">${sectionHeading('联系与教育', '网站 + 简历')}
    <div class="form-grid">${field('主要邮箱（私密资料）', 'email', p.email)}${field('备用邮箱（私密资料）', 'emailAlt', p.emailAlt || '')}${field('所在地', 'location', p.location)}${field('作品集公开网址', 'website', p.website || '')}${field('教育背景', 'education', p.education, {long:true,rows:2})}${field('电话（填写后会公开）', 'phone', p.phone || '')}</div><p class="form-note">姓名、缩写、邮箱与电话不写入公开 GitHub 仓库。修改后点击“复制私密资料”，并更新仓库 Actions 密钥 PORTFOLIO_PRIVATE_PROFILE。</p>
  </section><section class="form-section">${sectionHeading('简历个人简介', '只显示在 PDF')}
    <div class="form-grid">${field('个人简介', 'resumeSummary', p.resumeSummary, {long:true,rows:4})}</div>
  </section>`;
}

function renderExperiences() {
  title.textContent = '工作经历';
  description.textContent = '公司、岗位、时间和工作要点同时显示在网站与 PDF 中。';
  form.innerHTML = `<section class="form-section">${sectionHeading('经历时间线', '网站 + 简历')}<p class="form-note">按时间从近到远排列；项目归属在项目卡片中填写。</p>
    ${data.experiences.map((experience, index) => `<div class="experience-edit" data-experience="${index}"><div class="experience-heading"><h3>${escapeHtml(experience.company || `经历 ${index + 1}`)}</h3><button type="button" class="minor-button" data-remove-experience="${index}">删除经历</button></div><div class="form-grid">
      ${field('公司名称', 'company', experience.company)}${field('实际岗位', 'role', experience.role)}
      ${field('任职时间', 'period', experience.period)}${field('经历概述（网站显示）', 'description', experience.description, {long:true})}
      ${field('工作要点（网站与 PDF，每行一条）', 'bullets', experience.bullets || [], {long:true,array:'lines',rows:5})}
    </div></div>`).join('')}<div class="form-actions"><button type="button" data-add-experience>＋ 新增工作经历</button></div></section>`;
}

function renderSkills() {
  title.textContent = '能力与证书';
  description.textContent = '能力名称和技术标签会进入简历，描述显示在网站能力地图。';
  form.innerHTML = `<section class="form-section">${sectionHeading('能力地图', '网站 + 简历')}
    ${data.capabilities.map((capability, index) => `<div class="experience-edit" data-capability="${index}"><div class="experience-heading"><h3>${escapeHtml(capability.title || `能力 ${index + 1}`)}</h3><button type="button" class="minor-button" data-remove-capability="${index}">删除能力</button></div><div class="form-grid">
      ${field('能力名称', 'title', capability.title)}${field('排序编号', 'number', capability.number)}
      ${field('能力描述（网站显示）', 'description', capability.description, {long:true})}
      ${field('技术标签（网站与 PDF，逗号分隔）', 'tags', (capability.tags || []).join(', '), {array:'commas'})}
    </div></div>`).join('')}<div class="form-actions"><button type="button" data-add-capability>＋ 新增能力</button></div></section>
    <section class="form-section">${sectionHeading('证书', '只显示在 PDF')}<div class="form-grid">${field('证书与语言能力（每行一项）', 'certificates', data.certificates || [], {long:true,array:'lines'})}</div></section>
    <section class="form-section">${sectionHeading('网站导航', '只显示在网站')}<div class="form-grid">${field('每行“标签|#锚点”', 'navigation', (data.navigation || []).map((item) => `${item.label}|${item.href}`).join('\n'), {long:true,array:'navigation'})}</div><p class="form-note">可用锚点：#projects、#capabilities、#experience、#contact。</p></section>`;
}

function renderProject() {
  const p = data.projects[projectIndex];
  if (!p) { mode = 'profile'; renderProfile(); return; }
  title.textContent = p.title || '新项目';
  description.textContent = '网站卡片、详细经历、影像和 PDF 要点分区编辑；右侧可查看最终表达。';
  form.innerHTML = `<section class="form-section">${sectionHeading('项目卡片', '显示在网站')}
    <div class="form-grid">${field('项目名称', 'title', p.title)}${field('副标题', 'subtitle', p.subtitle)}${field('分类', 'category', p.category)}${field('时间', 'period', p.period)}${field('我的工作（卡片重点）', 'role', p.role)}${field('卡片眉标', 'eyebrow', p.eyebrow)}${field('项目概述', 'summary', p.summary, {long:true,rows:4})}${field('技术标签（逗号分隔）', 'tags', (p.tags || []).join(', '), {array:'commas'})}</div>
    <div class="check-row"><label><input type="checkbox" data-check="visible" ${p.visible !== false ? 'checked' : ''}> 在网站展示</label><label><input type="checkbox" data-check="includeInResume" ${p.includeInResume ? 'checked' : ''}> 纳入 PDF 简历</label><label><input type="checkbox" data-check="featured" ${p.featured ? 'checked' : ''}> 重点卡片</label></div>
  </section><section class="form-section">${sectionHeading('封面', '显示在网站')}
    <div class="media-grid"><div class="media-preview">${imagePreview(p.cover, p.title)}</div><div class="media-inputs">${filePicker('选择或拖入封面图片', 'cover')}<span class="file-picked">${escapeHtml(p.cover || '未选择封面，将使用流程图')}</span><p class="media-tip">支持 JPG、PNG、WebP；建议横图。</p></div></div>
    <div class="form-grid">${field('封面图片说明', 'coverAlt', p.coverAlt || '')}</div>
    <details class="advanced-path"><summary>封面路径与流程图设置</summary><div class="form-grid">${field('封面路径', 'cover', p.cover || '')}${field('流程图样式（vision / grading / water）', 'visual', p.visual || '')}</div></details>
  </section><section class="form-section">${sectionHeading('展开后的项目经历', '显示在网站')}
    <div class="form-grid">${field('项目归属', 'context', p.context)}${field('问题', 'challenge', p.challenge, {long:true})}${field('做法', 'approach', p.approach, {long:true})}${field('结果', 'outcome', p.outcome, {long:true})}${field('具体贡献（每行一条）', 'contributions', p.contributions || [], {long:true,array:'lines',rows:5})}</div>
  </section><section class="form-section">${sectionHeading('投递版项目经历', '只显示在 PDF')}
    <p class="form-note">只有勾选“纳入 PDF 简历”的项目会出现。PDF 使用项目名称、时间、归属、我的工作及下面的要点。</p><div class="form-grid">${field('简历要点（每行一条）', 'resumeBullets', p.resumeBullets || [], {long:true,array:'lines',rows:5})}</div>
  </section><section class="form-section">${sectionHeading('项目影像', '显示在网站')}
    <p class="form-note">直接选择图片或 MP4 视频，完成后可在右侧项目卡片中打开。每个文件不超过 80 MB；视频建议先压缩到便于网页播放的大小。</p>
    ${(p.media || []).map((media, index) => `<div class="media-card" data-media-index="${index}"><div class="media-edit-head"><strong>${String(index + 1).padStart(2, '0')} / ${escapeHtml(media.title || (media.type === 'video' ? '视频' : '图片'))}</strong><button type="button" data-remove-media="${index}">删除素材</button></div>
      <div class="media-grid"><div class="media-preview">${imagePreview(media.src, media.title, media.type, media.poster)}</div><div class="media-inputs">${filePicker('更换图片或视频', 'media', index)}<span class="file-picked">${escapeHtml(media.src || '尚未选择文件')}</span>${media.type === 'video' ? `${filePicker('选择视频封面图片', 'poster', index)}<span class="file-picked">${escapeHtml(media.poster || '未选择封面，公开列表会显示播放占位符')}</span>` : ''}</div></div>
      <div class="form-grid">${field('影像标题', 'title', media.title)}${field('影像说明', 'caption', media.caption || '', {long:true})}</div>
      <details><summary>文件路径和类型</summary><div class="form-grid"><label class="field"><span>类型</span><select data-media-field="type"><option value="video" ${media.type === 'video' ? 'selected' : ''}>视频</option><option value="image" ${media.type === 'image' ? 'selected' : ''}>图片</option></select></label>${field('文件路径', 'src', media.src)}${field('视频封面路径', 'poster', media.poster || '')}</div></details>
    </div>`).join('')}
    <div class="form-actions">${filePicker('＋ 添加图片或 MP4 视频', 'new-media')}<button type="button" data-add-media>添加外部路径</button></div>
    <details class="advanced-path"><summary>项目链接设置</summary><div class="form-grid">${field('项目锚点（英文、小写、无空格）', 'id', p.id)}</div></details>
    <div class="form-actions"><button type="button" class="danger" data-delete-project>删除当前项目</button></div>
  </section>`;
}

function render(focus = true) {
  if (!data) return;
  renderSidebar();
  if (mode === 'profile') renderProfile();
  if (mode === 'experiences') renderExperiences();
  if (mode === 'skills') renderSkills();
  if (mode === 'project') renderProject();
  sendPreview(focus);
}

function extensionFor(file) {
  const extension = file.name.split('.').pop()?.toLowerCase();
  const types = {jpg:'image', jpeg:'image', png:'image', webp:'image', mp4:'video'};
  if (!types[extension]) throw new Error('仅支持 JPG、PNG、WebP 图片或 MP4 视频');
  if (file.type && !(file.type.startsWith('image/') && types[extension] === 'image') && !(file.type === 'video/mp4' && extension === 'mp4')) throw new Error('文件类型与扩展名不一致');
  return {extension, type:types[extension]};
}

function uploadTarget(kind, index) {
  const project = kind === 'hero' ? null : data.projects[projectIndex];
  const media = kind === 'media' || kind === 'poster' ? project?.media[index] : null;
  if (kind !== 'hero' && !project) throw new Error('找不到当前项目');
  if ((kind === 'media' || kind === 'poster') && !media) throw new Error('找不到当前素材');
  return {document: data, profile: data.profile, project, media};
}

function targetStillExists(target) {
  return data === target.document && data.profile === target.profile && (!target.project || data.projects.includes(target.project)) && (!target.media || target.project.media.includes(target.media));
}

async function addUploadedFile(file, kind, target) {
  if (!file) return;
  if (!targetStillExists(target)) throw new Error('编辑对象已变化，请重新选择素材');
  const {extension, type} = extensionFor(file);
  if (kind !== 'media' && kind !== 'new-media' && type !== 'image') throw new Error('此处只能选择图片');
  if (file.size > 80 * 1024 * 1024) throw new Error('单个素材超过 80 MB，请先压缩后再导入');
  const stem = file.name.replace(/\.[^.]+$/, '').normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '').slice(0, 35) || 'media';
  const path = `assets/${type === 'video' ? 'video' : 'images'}/${stem}-${crypto.randomUUID().slice(0, 8)}.${extension}`;
  await saveMediaFile(path, file);
  if (!targetStillExists(target)) {
    await deleteMediaFile(path);
    throw new Error('编辑对象已变化，请重新选择素材');
  }
  uploaded.set(path, {path, file});
  objectUrls.set(path, URL.createObjectURL(file));
  mediaRevision += 1;
  if (kind === 'hero') target.profile.heroImage = path;
  if (kind === 'cover') target.project.cover = path;
  if (kind === 'poster') target.media.poster = path;
  if (kind === 'media') {
    target.media.type = type;
    target.media.src = path;
    if (type === 'image') target.media.poster = '';
  }
  if (kind === 'new-media') target.project.media.push({type,src:path,poster:'',title:file.name.replace(/\.[^.]+$/, ''),caption:''});
  await pruneUnusedUploads();
  saveDraft();
}

async function handleFiles(files, kind, index = null) {
  try {
    const target = uploadTarget(kind, index);
    if (kind === 'new-media') {
      for (const file of files) await addUploadedFile(file, kind, target);
    } else if (files[0]) await addUploadedFile(files[0], kind, target);
    render(false);
    notify('素材已加入草稿，请检查右侧预览；导出发布包时会一并包含。');
  } catch (error) { render(false); notify(`素材导入失败：${error.message}`, true); }
}

function startUpload(files, kind, index = null) {
  const task = handleFiles(files, kind, index);
  pendingUploads.add(task);
  updateActionAvailability();
  saveState.textContent = '素材保存中…';
  void task.finally(() => {
    pendingUploads.delete(task);
    updateActionAvailability();
    if (pendingUploads.size) return;
    saveState.textContent = '草稿已保存';
  });
  return task;
}

function updateActionAvailability() {
  const disabled = exportBusy || pendingUploads.size > 0;
  document.querySelector('#package-button').disabled = disabled;
  document.querySelector('#save-folder-button').disabled = disabled;
}

function referencedAssets(content = data) {
  const paths = new Set();
  if (content.profile.heroImage) paths.add(content.profile.heroImage);
  for (const project of content.projects) {
    if (project.cover) paths.add(project.cover);
    for (const item of project.media || []) {
      if (item.src) paths.add(item.src);
      if (item.poster) paths.add(item.poster);
    }
  }
  return paths;
}

async function pruneUnusedUploads() {
  const referenced = referencedAssets();
  for (const path of uploaded.keys()) {
    if (referenced.has(path)) continue;
    try {
      await deleteMediaFile(path);
      URL.revokeObjectURL(objectUrls.get(path));
      objectUrls.delete(path);
      uploaded.delete(path);
      mediaRevision += 1;
    } catch { notify('未使用的旧素材暂未清理；请确认浏览器存储空间。', true); }
  }
}

async function publishEntries() {
  await Promise.all(Array.from(pendingUploads));
  const snapshot = sourceSnapshot();
  const problem = validateData(snapshot);
  if (problem) throw new Error(problem);
  const ids = snapshot.projects.map((project) => project.id);
  if (ids.some((id) => !/^[a-z0-9-]+$/.test(id)) || new Set(ids).size !== ids.length) throw new Error('项目锚点必须使用不重复的英文小写字母、数字或连字符');
  const paths = referencedAssets(snapshot);
  const selectedUploads = new Map(Array.from(paths).filter((path) => uploaded.has(path)).map((path) => [path, uploaded.get(path).file]));
  const missing = [];
  for (const path of paths) {
    if (selectedUploads.has(path)) continue;
    if (!path.startsWith('assets/')) continue;
    try {
      const response = await fetch(path, {method:'HEAD'});
      if (!response.ok) missing.push(path);
    } catch { missing.push(path); }
  }
  if (missing.length) throw new Error(`这些素材文件尚不存在：${missing.join('、')}`);
  const content = new Blob([JSON.stringify(snapshot, null, 2) + '\n'], {type:'application/json;charset=utf-8'});
  return [['content.json', content], ...selectedUploads];
}

function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function updatePreviewTab(tab) {
  const site = tab === 'site';
  sitePreview.hidden = !site;
  resumePreview.hidden = site;
  document.querySelector('#resume-preview-spacer').hidden = site;
  document.querySelectorAll('.preview-tab').forEach((button) => {
    const active = button.dataset.preview === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  document.querySelector('#preview-open').href = site ? 'index.html?preview=1' : 'resume.html?preview=1';
  document.querySelector('#preview-description').textContent = site
    ? '这里显示公开网页的实时草稿，点击项目卡片可查看项目经历。'
    : '这里使用实际简历模板显示当前草稿；点击简历顶部按钮可在新窗口打印为 PDF。';
  sendPreview(true);
  sizeResumePreview();
}

function sizeResumePreview() {
  const wrapper = document.querySelector('#preview-frame-wrap');
  const scale = Math.min(1, (wrapper.clientWidth - 12) / 794);
  resumePreview.style.transform = `scale(${scale})`;
  resumePreview.style.left = `${Math.max(0, (wrapper.clientWidth - 794 * scale) / 2)}px`;
  document.querySelector('#resume-preview-spacer').style.height = `${1250 * scale}px`;
}

document.querySelectorAll('.sidebar-link').forEach((button) => button.addEventListener('click', () => { mode = button.dataset.mode; render(); }));
list.addEventListener('click', (event) => {
  const button = event.target.closest('[data-index]');
  if (!button) return;
  mode = 'project'; projectIndex = Number(button.dataset.index); render();
});

form.addEventListener('input', (event) => {
  const control = event.target;
  const key = control.dataset.field;
  const mediaKey = control.dataset.mediaField;
  if (mediaKey) {
    const index = Number(control.closest('[data-media-index]').dataset.mediaIndex);
    data.projects[projectIndex].media[index][mediaKey] = control.value;
  } else if (key) {
    let value = control.value;
    if (control.dataset.array === 'lines') value = value.split('\n').map((item) => item.trim()).filter(Boolean);
    if (control.dataset.array === 'commas') value = value.split(/[,，]/).map((item) => item.trim()).filter(Boolean);
    if (control.dataset.array === 'navigation') value = value.split('\n').map((line) => { const [label, href] = line.split('|').map((item) => item.trim()); return label && href ? {label,href} : null; }).filter(Boolean);
    const mediaEditor = control.closest('[data-media-index]');
    if (mediaEditor) data.projects[projectIndex].media[Number(mediaEditor.dataset.mediaIndex)][key] = value;
    else if (mode === 'profile') data.profile[key] = value;
    else if (mode === 'project') data.projects[projectIndex][key] = value;
    else if (mode === 'skills') {
      const capabilityEditor = control.closest('[data-capability]');
      if (capabilityEditor) data.capabilities[Number(capabilityEditor.dataset.capability)][key] = value;
      else data[key] = value;
    } else if (mode === 'experiences') {
      data.experiences[Number(control.closest('[data-experience]').dataset.experience)][key] = value;
    }
    if (!mediaEditor && (key === 'title' || key === 'company')) {
      if (mode === 'project') title.textContent = data.projects[projectIndex].title;
      renderSidebar();
    }
  }
  saveDraft();
});

form.addEventListener('change', async (event) => {
  const control = event.target;
  if (control.dataset.uploadKind) {
    await startUpload(Array.from(control.files || []), control.dataset.uploadKind, Number(control.dataset.uploadIndex));
    control.value = '';
    return;
  }
  if (control.dataset.check) { data.projects[projectIndex][control.dataset.check] = control.checked; saveDraft(); render(false); }
  if (control.dataset.mediaField) { data.projects[projectIndex].media[Number(control.closest('[data-media-index]').dataset.mediaIndex)][control.dataset.mediaField] = control.value; saveDraft(); render(false); }
});

form.addEventListener('dragover', (event) => {
  const target = event.target.closest('.file-picker');
  if (!target || !event.dataTransfer?.types.includes('Files')) return;
  event.preventDefault();
  target.classList.add('dragover');
});
form.addEventListener('dragleave', (event) => event.target.closest('.file-picker')?.classList.remove('dragover'));
form.addEventListener('drop', async (event) => {
  const target = event.target.closest('.file-picker');
  if (!target) return;
  event.preventDefault();
  target.classList.remove('dragover');
  await startUpload(Array.from(event.dataTransfer.files), target.dataset.dropKind, Number(target.dataset.dropIndex));
});

form.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.hasAttribute('data-add-media')) { data.projects[projectIndex].media.push({type:'image',src:'',poster:'',title:'新影像',caption:''}); saveDraft(); render(false); }
  if (button.hasAttribute('data-remove-media')) { data.projects[projectIndex].media.splice(Number(button.dataset.removeMedia), 1); void pruneUnusedUploads(); saveDraft(); render(false); }
  if (button.hasAttribute('data-add-experience')) { data.experiences.unshift({company:'',role:'',period:'',description:'',bullets:[]}); saveDraft(); render(false); }
  if (button.hasAttribute('data-remove-experience') && confirm('确定删除这段工作经历吗？')) { data.experiences.splice(Number(button.dataset.removeExperience), 1); saveDraft(); render(false); }
  if (button.hasAttribute('data-add-capability')) { data.capabilities.push({number:String(data.capabilities.length + 1).padStart(2,'0'),title:'新能力',description:'',tags:[]}); saveDraft(); render(false); }
  if (button.hasAttribute('data-remove-capability') && confirm('确定删除这项能力吗？')) { data.capabilities.splice(Number(button.dataset.removeCapability), 1); saveDraft(); render(false); }
  if (button.hasAttribute('data-delete-project') && confirm('确定删除当前项目吗？')) { data.projects.splice(projectIndex, 1); projectIndex = Math.max(0, projectIndex - 1); mode = data.projects.length ? 'project' : 'profile'; void pruneUnusedUploads(); saveDraft(); render(); }
});

document.querySelector('#add-project').addEventListener('click', () => {
  data.projects.push({id:`project-${Date.now()}`,category:'机器人探索',featured:false,visible:true,includeInResume:false,eyebrow:'NEW PROJECT',title:'新项目',subtitle:'',period:'',context:'',role:'',summary:'',challenge:'',approach:'',outcome:'',contributions:[],resumeBullets:[],tags:[],media:[]});
  projectIndex = data.projects.length - 1; mode = 'project'; saveDraft(); render();
});

document.querySelector('#download-button').addEventListener('click', () => {
  download(new Blob([JSON.stringify(sourceSnapshot(), null, 2) + '\n'], {type:'application/json;charset=utf-8'}), 'content.json');
  notify('已下载去除私密资料的内容 JSON。若新增了素材，请使用“下载发布包”。');
});

document.querySelector('#copy-private-button').addEventListener('click', async () => {
  const privateProfile = Object.fromEntries(Object.keys(sourceProfile).map((key) => [key, data.profile[key] || '']));
  try {
    await navigator.clipboard.writeText(JSON.stringify(privateProfile));
    notify('私密资料已复制；请粘贴到 GitHub 仓库的 Actions 密钥 PORTFOLIO_PRIVATE_PROFILE，切勿提交到公开仓库。');
  } catch { notify('复制失败，请确认浏览器允许使用剪贴板。', true); }
});

document.querySelector('#package-button').addEventListener('click', async (event) => {
  exportBusy = true;
  updateActionAvailability();
  try {
    const entries = await publishEntries();
    const guide = '发布步骤：\n1. 解压此文件到 embodied-portfolio 仓库根目录，覆盖 content.json，保留原有其他文件。\n2. 检查新增图片和视频位于 assets/images 或 assets/video。\n3. 提交并推送到 GitHub 的 main 分支。GitHub Actions 会更新公开网站和简历 PDF。\n';
    entries.push(['发布说明.txt', new Blob([guide], {type:'text/plain;charset=utf-8'})]);
    download(await createPublishZip(entries), '作品集-发布包.zip');
    notify(`发布包已下载：包含内容文件及 ${entries.length - 2} 个新增素材。`);
  } catch (error) { notify(`无法导出：${error.message}`, true); }
  finally { exportBusy = false; updateActionAvailability(); }
});

document.querySelector('#save-folder-button').addEventListener('click', async (event) => {
  if (!window.showDirectoryPicker) { notify('当前浏览器不支持直接保存目录，请使用“下载发布包”。', true); return; }
  exportBusy = true;
  updateActionAvailability();
  try {
    const folder = await window.showDirectoryPicker({mode:'readwrite'});
    await folder.getFileHandle('index.html');
    await folder.getFileHandle('content.json');
    const entries = await publishEntries();
    for (const [path, blob] of entries.filter(([path]) => path !== 'content.json')) {
      const parts = path.split('/');
      let directory = folder;
      for (const part of parts.slice(0, -1)) directory = await directory.getDirectoryHandle(part, {create:true});
      const handle = await directory.getFileHandle(parts.at(-1), {create:true});
      const writer = await handle.createWritable();
      await writer.write(blob);
      await writer.close();
    }
    const contentHandle = await folder.getFileHandle('content.json', {create:true});
    const writer = await contentHandle.createWritable();
    await writer.write(entries[0][1]);
    await writer.close();
    notify('已保存到本地项目目录。提交并推送到 GitHub 后，公开网站和 PDF 会同步更新。');
  } catch (error) {
    if (error.name !== 'AbortError') notify(`保存失败：${error.message}。请选择包含 index.html 和 content.json 的仓库根目录。`, true);
  } finally { exportBusy = false; updateActionAvailability(); }
});

document.querySelector('#import-button').addEventListener('click', () => document.querySelector('#import-file').click());
document.querySelector('#import-file').addEventListener('change', async (event) => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    const problem = validateData(imported);
    if (problem) throw new Error(problem);
    data = imported; mode = 'profile'; projectIndex = 0; await pruneUnusedUploads(); saveDraft(); render();
    notify('内容已导入。若 JSON 引用了新增素材，还需要在项目影像中重新选择相应文件。');
  } catch (error) { notify(`导入失败：${error.message}`, true); }
  event.target.value = '';
});

document.querySelectorAll('.preview-tab').forEach((button) => button.addEventListener('click', () => updatePreviewTab(button.dataset.preview)));
document.querySelector('#preview-expand').addEventListener('click', () => {
  previewPanel.classList.toggle('expanded');
  document.querySelector('#preview-expand').textContent = previewPanel.classList.contains('expanded') ? '×' : '⤢';
  requestAnimationFrame(sizeResumePreview);
});
document.querySelector('#header-preview').addEventListener('click', () => document.querySelector('#preview-expand').click());
new ResizeObserver(sizeResumePreview).observe(document.querySelector('#preview-frame-wrap'));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && previewPanel.classList.contains('expanded')) document.querySelector('#preview-expand').click();
});
for (const frame of [sitePreview, resumePreview]) frame.addEventListener('load', () => {
  frame.dataset.loaded = 'true';
  sentRevision.set(frame, -1);
  sendPreview(true);
});

try {
  const response = await fetch('content.json');
  if (!response.ok) throw new Error('无法读取 content.json');
  const published = await response.json();
  const publishedProblem = validateData(published);
  if (publishedProblem) throw new Error(`发布内容格式错误：${publishedProblem}`);
  const draft = localStorage.getItem('portfolio-draft');
  let draftData;
  try { draftData = draft ? JSON.parse(draft) : null; } catch { draftData = null; }
  const draftProblem = draftData ? validateData(draftData) : '';
  if (draft && (!draftData || draftProblem)) localStorage.removeItem('portfolio-draft');
  data = draftData && !draftProblem ? draftData : published;
  try {
    for (const record of await loadMediaFiles()) {
      uploaded.set(record.path, record);
      objectUrls.set(record.path, URL.createObjectURL(record.file));
    }
  } catch { notify('浏览器未能读取已选素材；请在导出前重新选择文件。', true); }
  saveState.textContent = draftData && !draftProblem ? '已载入本地草稿' : draft ? '草稿损坏，已载入发布版' : '已载入发布版';
  render(false);
} catch (error) {
  form.innerHTML = `<p>加载失败：${escapeHtml(error.message)}。请通过网站地址或本地服务器打开编辑器。</p>`;
}
