const root = document.querySelector('#resume-root');
const printButton = document.querySelector('#print-button');

const escapeHtml = (value = '') => String(value).replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);

function render(data) {
  const profile = data.profile || {};
  const projects = (data.projects || []).filter((project) => project.includeInResume);
  const website = /^https?:\/\//i.test(profile.website || '') ? profile.website : '';
  root.innerHTML = `<article class="resume-page">
    <header class="resume-header"><div><p class="resume-eyebrow">EMBODIED INTELLIGENCE · ENGINEERING</p><h1>${escapeHtml(profile.name)}</h1><p class="resume-title">${escapeHtml(profile.role)}</p></div><div class="resume-contact"><span>${escapeHtml(profile.email || '')}</span>${profile.emailAlt ? `<span>${escapeHtml(profile.emailAlt)}</span>` : ''}${profile.phone ? `<span>${escapeHtml(profile.phone)}</span>` : ''}<span>${escapeHtml(profile.location || '')}</span></div></header>
    <section class="resume-section" id="resume-profile"><h2>个人简介 <small>PROFILE</small></h2><p>${escapeHtml(profile.resumeSummary || profile.intro || '')}</p></section>
    <section class="resume-section" id="resume-skills"><h2>核心技能 <small>SKILLS</small></h2><div class="skill-grid">${(data.capabilities || []).map((capability) => `<div><strong>${escapeHtml(capability.title)}</strong><span>${escapeHtml((capability.tags || []).join(' · '))}</span></div>`).join('')}</div></section>
    <section class="resume-section" id="resume-experiences"><h2>工作经历 <small>EXPERIENCE</small></h2>${(data.experiences || []).map((experience) => `<div class="resume-experience"><div class="resume-experience-head"><strong>${escapeHtml(experience.role)}</strong><span>${escapeHtml(experience.period)}</span></div><p class="resume-company">${escapeHtml(experience.company)}</p>${experience.bullets?.length ? `<ul>${experience.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : `<p>${escapeHtml(experience.description || '')}</p>`}</div>`).join('')}</section>
    <section class="resume-section resume-projects"><h2>项目经历 <small>SELECTED PROJECTS</small></h2>${projects.map((project) => `<div class="resume-project" id="resume-${escapeHtml(project.id)}"><div class="resume-project-head"><strong>${escapeHtml(project.title)}</strong><span>${escapeHtml(project.period || '')}</span></div><p class="resume-project-meta">${escapeHtml(project.context || '')} / ${escapeHtml(project.role || '')}</p><ul>${(project.resumeBullets || []).map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul></div>`).join('')}</section>
    <section class="resume-section resume-bottom"><h2>教育与认证 <small>EDUCATION</small></h2><p>${escapeHtml(profile.education || '')}</p><p>${escapeHtml((data.certificates || []).join(' · '))}</p></section>
    <footer class="resume-footer"><span>${escapeHtml(profile.name)}${website ? ` · 项目作品集：<a href="${escapeHtml(website)}">${escapeHtml(website)}</a>` : ''}</span><span>更新于 ${escapeHtml(profile.updated || '')}</span></footer>
  </article>`;
  document.body.dataset.resumeReady = 'true';
}

printButton.addEventListener('click', () => window.print());

try {
  const response = await fetch('content.json');
  if (!response.ok) throw new Error('内容文件无法读取');
  const published = await response.json();
  const preview = new URLSearchParams(location.search).has('preview') ? localStorage.getItem('portfolio-draft') : null;
  let draft;
  try { draft = preview ? JSON.parse(preview) : null; } catch { draft = null; }
  render(draft?.profile && Array.isArray(draft.projects) && draft.projects.every((project) => project && typeof project === 'object') ? draft : published);
  if (new URLSearchParams(location.search).has('print')) setTimeout(() => window.print(), 550);
} catch (error) {
  document.body.dataset.resumeError = error.message;
  root.innerHTML = `<p class="resume-error">简历加载失败：${escapeHtml(error.message)}</p>`;
}

if (new URLSearchParams(location.search).has('preview')) {
  window.addEventListener('message', (event) => {
    if (event.origin !== location.origin || event.source !== window.parent || event.data?.type !== 'portfolio:preview') return;
    if (event.data.data?.profile && Array.isArray(event.data.data.projects)) render(event.data.data);
    const target = event.data.focus;
    const id = target === 'profile' || target === 'skills' || target === 'experiences' ? `resume-${target}` : target ? `resume-${target}` : '';
    if (id) document.getElementById(id)?.scrollIntoView({block:'start'});
  });
  if (window.parent === window) window.addEventListener('storage', (event) => {
    if (event.key !== 'portfolio-draft') return;
    try {
      const draft = event.newValue ? JSON.parse(event.newValue) : null;
      if (draft?.profile && Array.isArray(draft.projects)) render(draft);
    } catch { /* 保留当前预览。 */ }
  });
}
