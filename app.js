import {loadMediaFiles} from './editor-storage.js';

const root = document.querySelector('#app');
const dialog = document.querySelector('#media-dialog');
const dialogContent = document.querySelector('#media-dialog-content');
const previewAssetUrls = new Map();
let publishedData;

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function safeUrl(value = '') {
  const url = String(value).trim();
  if (previewAssetUrls.has(url)) return escapeHtml(previewAssetUrls.get(url));
  if (/^(https?:\/\/|\.\.?\/|assets\/|mailto:|#)/i.test(url) && !/[\u0000-\u001f]/.test(url)) return escapeHtml(url);
  return '';
}

function setPreviewFiles(files) {
  for (const url of previewAssetUrls.values()) URL.revokeObjectURL(url);
  previewAssetUrls.clear();
  for (const item of files || []) {
    if (item?.path?.startsWith('assets/') && item.file instanceof Blob) previewAssetUrls.set(item.path, URL.createObjectURL(item.file));
  }
}

function focusSection(target) {
  const id = target === 'experiences' ? 'experience' : target === 'skills' ? 'capabilities' : target === 'profile' ? 'top' : target;
  if (id) document.getElementById(id)?.scrollIntoView({block:'start'});
}

function tags(items = []) {
  return items.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
}

function visual(project) {
  if (project.cover) {
    const firstMedia = (project.media || [])[0];
    return `<div class="project-cover image-cover">
      <img src="${safeUrl(project.cover)}" alt="${escapeHtml(project.coverAlt || project.title)}" loading="lazy" />
      <span class="image-cover-label">${escapeHtml(project.category)}</span>
      ${firstMedia ? `<button class="cover-play" type="button" data-project="${escapeHtml(project.id)}" data-media="0" aria-label="播放${escapeHtml(firstMedia.title)}演示"><span aria-hidden="true">▶</span> 观看演示</button>` : ''}
    </div>`;
  }
  const visualSteps = {
    vision: ['语言描述', 'Qwen-VL', 'Rex-Omni', '视觉定位'],
    grading: ['文档扫描', '版面切割', 'VLM 批改', '数据记录'],
    water: ['河流拓扑', '时序观测', 'T-GCN', '预测 API']
  };
  const steps = visualSteps[project.visual] || ['输入', '分析', '执行', '结果'];
  return `<div class="project-cover diagram-cover diagram-${escapeHtml(project.visual || 'default')}" role="img" aria-label="${escapeHtml(steps.join('到'))}的流程示意">
    <span class="diagram-overline">SYSTEM / ${escapeHtml(project.category)}</span>
    <div class="diagram-flow">${steps.map((step, index) => `<span class="diagram-node">${escapeHtml(step)}</span>${index < steps.length - 1 ? '<span class="diagram-arrow" aria-hidden="true">→</span>' : ''}`).join('')}</div>
    <span class="diagram-foot">${escapeHtml(project.subtitle)}</span>
  </div>`;
}

function mediaGallery(project) {
  if (!project.media?.length) return '';
  return `<div class="media-gallery" aria-label="${escapeHtml(project.title)}演示素材">
    <div class="media-gallery-head"><span>项目影像</span><small>${project.media.length.toString().padStart(2, '0')} ITEMS</small></div>
    <div class="media-list">${project.media.map((item, index) => `<button class="media-item" type="button" data-project="${escapeHtml(project.id)}" data-media="${index}">
      <span class="media-thumb">${item.type === 'image' || item.poster || project.cover ? `<img src="${safeUrl(item.type === 'image' ? item.src : item.poster || project.cover)}" alt="" loading="lazy" />` : '<span class="media-placeholder" aria-hidden="true">▶</span>'}<span class="media-type">${item.type === 'video' ? '▶ VIDEO' : '↗ IMAGE'}</span></span>
      <span class="media-caption">${escapeHtml(item.title)}</span>
    </button>`).join('')}</div>
  </div>`;
}

function projectCard(project) {
  return `<article class="project-card ${project.featured ? 'featured' : ''}" data-category="${escapeHtml(project.category)}" id="${escapeHtml(project.id)}">
    ${visual(project)}
    <div class="project-content">
      <div class="project-topline"><span>${escapeHtml(project.eyebrow || project.category)}</span><span>${escapeHtml(project.period || '')}</span></div>
      <h3>${escapeHtml(project.title)}</h3>
      <p class="project-subtitle">${escapeHtml(project.subtitle || '')}</p>
      <p class="project-summary">${escapeHtml(project.summary || '')}</p>
      <div class="project-meta"><span>我的工作</span><strong>${escapeHtml(project.role || '待补充')}</strong></div>
      <div class="tag-list">${tags(project.tags)}</div>
      <details class="project-details">
        <summary>查看项目经历 <span aria-hidden="true">↗</span></summary>
        <div class="detail-body">
          ${project.challenge ? `<div><h4>问题</h4><p>${escapeHtml(project.challenge)}</p></div>` : ''}
          ${project.approach ? `<div><h4>做法</h4><p>${escapeHtml(project.approach)}</p></div>` : ''}
          ${project.outcome ? `<div><h4>结果</h4><p>${escapeHtml(project.outcome)}</p></div>` : ''}
          ${project.contributions?.length ? `<div><h4>具体贡献</h4><ul>${project.contributions.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}
          <p class="detail-context">${escapeHtml(project.context || '')}</p>
        </div>
      </details>
      ${mediaGallery(project)}
    </div>
  </article>`;
}

function render(data) {
  const profile = data.profile;
  const projects = (data.projects || []).filter((item) => item.visible !== false);
  const categories = ['全部', ...new Set(projects.map((project) => project.category))];
  const previewMode = new URLSearchParams(location.search).has('preview');
  const resumeHref = previewMode ? 'resume.html?preview=1&print=1' : 'assets/resume.pdf';
  const resumeAttributes = previewMode ? 'target="_blank" rel="noopener"' : 'download';
  root.innerHTML = `
    <header class="site-header"><div class="shell header-inner">
      <a class="brand" href="#top" aria-label="返回首页"><span class="brand-mark">${escapeHtml(profile.initials || 'CY')}<span class="brand-dot"></span></span><span class="brand-text">${escapeHtml(profile.name)}<small>PORTFOLIO / 2026</small></span></a>
      <nav class="site-nav" aria-label="主导航">${(data.navigation || []).map((item) => `<a href="${safeUrl(item.href)}">${escapeHtml(item.label)}</a>`).join('')}</nav>
      <a class="header-action" href="${resumeHref}" ${resumeAttributes}>${previewMode ? '打印草稿' : '下载简历'} <span aria-hidden="true">↓</span></a>
    </div></header>
    <main id="top">
      <section class="hero shell" aria-labelledby="hero-title">
        <div class="hero-copy"><p class="eyebrow"><span class="live-dot"></span> EMBODIED INTELLIGENCE / PORTFOLIO</p>
          <h1 id="hero-title">${escapeHtml(profile.headline).replace(/\n/g, '<br>')}</h1>
          <p class="hero-intro">${escapeHtml(profile.intro)}</p>
          <div class="hero-actions"><a class="button-primary" href="#projects">浏览项目 <span aria-hidden="true">↓</span></a><a class="button-quiet" href="${resumeHref}" ${resumeAttributes}>${previewMode ? '打印草稿 PDF ↗' : '一键下载 PDF 简历 ↓'}</a></div>
          <div class="hero-facts"><div><span>研究与实践</span><strong>导航 / 感知 / 工程</strong></div><div><span>项目记录</span><strong>${String(projects.length).padStart(2, '0')} 个精选案例</strong></div></div>
        </div>
        <div class="hero-visual"><img src="${safeUrl(profile.heroImage || 'assets/images/drone-hardware.webp')}" alt="${escapeHtml(profile.name)}的项目影像" /><div class="hero-visual-top">FIELD NOTES <span>NO. 001</span></div><div class="hero-visual-bottom"><span class="crosshair" aria-hidden="true">⌖</span><div><strong>从指令到行动</strong><small>LANGUAGE → PERCEPTION → ACTION</small></div><span class="hero-visual-index">01 / 05</span></div></div>
      </section>
      <div class="marquee-line" aria-hidden="true"><div class="shell">NATURAL LANGUAGE NAVIGATION <span>✳</span> MULTIMODAL PERCEPTION <span>✳</span> ROBOTICS ENGINEERING</div></div>
      <section class="section projects-section shell" id="projects" aria-labelledby="projects-title">
        <div class="section-heading"><div><p class="section-kicker">01 / SELECTED WORK</p><h2 id="projects-title">项目实践<span class="heading-accent">.</span></h2></div><p>每个项目都记录问题、我的工作和可观看的演示。<br>点击卡片可查看完整项目经历。</p></div>
        <div class="project-toolbar"><div class="filters" role="group" aria-label="项目分类">${categories.map((category, index) => `<button class="filter-button ${index === 0 ? 'active' : ''}" type="button" data-filter="${escapeHtml(category)}" aria-pressed="${index === 0}">${escapeHtml(category)}</button>`).join('')}</div><span id="result-count" aria-live="polite">${projects.length} 个项目</span></div>
        <div class="projects-grid">${projects.map(projectCard).join('')}</div>
      </section>
      <section class="section capabilities-section" id="capabilities" aria-labelledby="capabilities-title"><div class="shell"><div class="section-heading"><div><p class="section-kicker">02 / HOW I WORK</p><h2 id="capabilities-title">能力地图<span class="heading-accent">.</span></h2></div><p>把模型、环境与服务连起来，<br>让技术在具体场景中运行。</p></div><div class="capabilities-grid">${(data.capabilities || []).map((capability) => `<article class="capability"><span class="capability-number">${escapeHtml(capability.number)}</span><h3>${escapeHtml(capability.title)}</h3><p>${escapeHtml(capability.description)}</p><div class="tag-list">${tags(capability.tags)}</div></article>`).join('')}</div></div></section>
      <section class="section experience-section shell" id="experience" aria-labelledby="experience-title"><div class="section-heading"><div><p class="section-kicker">03 / EXPERIENCE</p><h2 id="experience-title">工作经历<span class="heading-accent">.</span></h2></div><p>项目内容以实际参与范围表达，<br>原简历中的信息待本人持续核对更新。</p></div><div class="timeline">${(data.experiences || []).map((experience) => `<article class="timeline-item"><div class="timeline-period">${escapeHtml(experience.period)}</div><div class="timeline-body"><p class="timeline-company">${escapeHtml(experience.company)}</p><h3>${escapeHtml(experience.role)}</h3><p>${escapeHtml(experience.description)}</p><ul>${(experience.bullets || []).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul></div></article>`).join('')}</div><div class="education-row"><span>教育背景</span><strong>${escapeHtml(profile.education)}</strong></div></section>
      <section class="contact-section" id="contact" aria-labelledby="contact-title"><div class="shell contact-inner"><div><p class="section-kicker">04 / GET IN TOUCH</p><h2 id="contact-title">讨论下一步<span>.</span></h2><p>欢迎交流具身智能、机器人导航与多模态系统的工程机会。</p></div><div class="contact-actions"><div class="contact-mails"><a href="${safeUrl(`mailto:${profile.email}`)}" class="contact-mail">${escapeHtml(profile.email)} <span aria-hidden="true">↗</span></a>${profile.emailAlt ? `<a href="${safeUrl(`mailto:${profile.emailAlt}`)}" class="contact-mail secondary-mail">${escapeHtml(profile.emailAlt)} <span aria-hidden="true">↗</span></a>` : ''}</div><a href="${resumeHref}" ${resumeAttributes} class="contact-resume">${previewMode ? '打印草稿 PDF ↗' : '下载投递版简历 PDF ↓'}</a></div></div></section>
    </main>
    <footer class="footer"><div class="shell footer-inner"><span>${escapeHtml(profile.name)} / ${escapeHtml(profile.role)}</span><span>最后整理 · ${escapeHtml(profile.updated || '')}</span><a href="#top">回到顶部 ↑</a></div></footer>`;

  document.querySelectorAll('.filter-button').forEach((button) => button.addEventListener('click', () => {
    const filter = button.dataset.filter;
    document.querySelectorAll('.filter-button').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    const visible = projects.filter((project) => filter === '全部' || project.category === filter);
    document.querySelectorAll('.project-card').forEach((card) => { card.hidden = filter !== '全部' && card.dataset.category !== filter; });
    document.querySelector('#result-count').textContent = `${visible.length} 个项目`;
  }));

  document.querySelectorAll('[data-project][data-media]').forEach((button) => button.addEventListener('click', () => {
    const project = projects.find((item) => item.id === button.dataset.project);
    const media = project?.media?.[Number(button.dataset.media)];
    if (!media) return;
    dialogContent.innerHTML = `<div class="dialog-head"><div><small>${escapeHtml(project.title)} / 项目影像</small><h2>${escapeHtml(media.title)}</h2></div><button type="button" class="dialog-close" aria-label="关闭媒体">✕</button></div>
      ${media.type === 'video' ? `<video controls autoplay playsinline preload="metadata" poster="${safeUrl(media.poster || '')}"><source src="${safeUrl(media.src)}" type="video/mp4">浏览器暂不支持播放此视频。</video>` : `<img class="dialog-image" src="${safeUrl(media.src)}" alt="${escapeHtml(media.title)}" />`}
      <p class="dialog-caption">${escapeHtml(media.caption || '')}</p>`;
    dialogContent.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
    dialog.showModal();
  }));
}

dialog.addEventListener('close', () => { dialogContent.innerHTML = ''; });
dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); });

try {
  const response = await fetch('content.json');
  if (!response.ok) throw new Error('内容文件无法读取');
  const published = await response.json();
  publishedData = published;
  const preview = new URLSearchParams(location.search).has('preview') ? localStorage.getItem('portfolio-draft') : null;
  let draft;
  try { draft = preview ? JSON.parse(preview) : null; } catch { draft = null; }
  if (preview) {
    try { setPreviewFiles(await loadMediaFiles()); } catch { /* 浏览器草稿仍可显示文字。 */ }
  }
  render(draft?.profile && Array.isArray(draft.projects) && draft.projects.every((project) => project && typeof project === 'object') ? draft : published);
} catch (error) {
  root.innerHTML = `<main class="error-state"><h1>内容加载失败</h1><p>请通过本地服务器打开网站，并检查 content.json 是否存在。</p><small>${escapeHtml(error.message)}</small></main>`;
}

if (new URLSearchParams(location.search).has('preview')) {
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'portfolio:preview') return;
    if (event.data.files) setPreviewFiles(event.data.files);
    if (event.data.data?.profile && Array.isArray(event.data.data.projects)) render(event.data.data);
    focusSection(event.data.focus);
  });
  if (window.parent === window) window.addEventListener('storage', async (event) => {
    if (event.key !== 'portfolio-draft' || !publishedData) return;
    try {
      setPreviewFiles(await loadMediaFiles());
      const draft = event.newValue ? JSON.parse(event.newValue) : null;
      render(draft?.profile && Array.isArray(draft.projects) ? draft : publishedData);
    } catch { render(publishedData); }
  });
}
