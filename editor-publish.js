// 在线编辑页通过受校验的窗口消息使用本机发布服务，凭据不会离开本机。
export const LOCAL_PUBLISHER = 'http://127.0.0.1:8771';
const PREFIX = 'portfolio:publish:';
const validId = (value) => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

export function trustedMessage(event, source, origin, id) {
  return !!source && validId(id) && event.source === source && event.origin === origin && event.data?.id === id;
}

export function publishThroughLocal({prepare, onProgress, publisherOrigin = LOCAL_PUBLISHER}) {
  const id = crypto.randomUUID().replaceAll('-', '');
  return new Promise((resolve, reject) => {
    let publisher;
    let sent = false;
    let settled = false;
    let timer;
    let closedTimer;
    const cleanup = () => {
      settled = true;
      clearTimeout(timer); clearInterval(closedTimer);
      window.removeEventListener('message', receive);
    };
    const fail = (error) => { if (!settled) { cleanup(); reject(error); } };
    const deadline = (duration, message) => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error(message)), duration);
    };
    const receive = async (event) => {
      if (!trustedMessage(event, publisher, publisherOrigin, id)) return;
      const message = event.data;
      if (message.type === PREFIX + 'ready' && !sent) {
        sent = true;
        deadline(120000, '准备草稿与素材超时，内容仍保留；请重试。');
        try {
          const payload = await prepare();
          if (!settled) {
            publisher.postMessage({type:PREFIX + 'request', id, payload}, publisherOrigin);
            deadline(20 * 60 * 1000, '发布等待超时，草稿仍保留；请查看本机发布窗口的状态。');
          }
        } catch (error) { fail(error); }
      }
      if (message.type === PREFIX + 'progress') onProgress?.(message.job);
      if (message.type === PREFIX + 'result') {
        cleanup();
        if (message.error) reject(new Error(message.error));
        else resolve(message.job);
      }
    };
    window.addEventListener('message', receive);
    // 保留窗口关系以传递草稿，接收端同时校验来源、窗口和随机会话编号。
    publisher = window.open(publisherOrigin + '/editor.html#publish=' + id, 'portfolio-publish-' + id, 'popup,width=1180,height=860');
    if (!publisher) return fail(new Error('发布窗口被浏览器拦截，请允许此网站打开弹窗后再次点击一键更新。'));
    onProgress?.({status:'running', message:'正在连接本机发布服务，将自动带入当前修改与新素材'});
    deadline(20000, '尚未连接到本机发布服务。请在已安装发布服务的这台电脑编辑，或运行“安装本机发布服务.sh”后重试；草稿仍保留。');
    closedTimer = setInterval(() => {
      if (publisher.closed) fail(new Error(sent ? '发布窗口已关闭，已提交的任务可能仍在运行；请查看公开网站或本机编辑台。' : '发布窗口已关闭，当前草稿尚未发布。'));
    }, 500);
  });
}

export function receiveOnlineDraft({publicOrigin, accept, onError}) {
  const id = new URLSearchParams(location.hash.slice(1)).get('publish');
  const opener = window.opener;
  if (!validId(id) || !opener) return;
  let consumed = false;
  const send = (type, fields = {}) => opener.postMessage({type:PREFIX + type, id, ...fields}, publicOrigin);
  const ready = setInterval(() => { if (!opener.closed) send('ready'); }, 500);
  const expire = setTimeout(() => {
    clearInterval(ready); window.removeEventListener('message', receive);
    send('result', {error:'草稿传递超时，内容仍保留，请重新点击一键更新。'});
  }, 120000);
  const receive = async (event) => {
    if (consumed || event.data?.type !== PREFIX + 'request' || !trustedMessage(event, opener, publicOrigin, id)) return;
    consumed = true; clearInterval(ready); clearTimeout(expire);
    window.removeEventListener('message', receive);
    try {
      const job = await accept(event.data.payload, (progress) => send('progress', {job:progress}));
      send('result', {job});
    } catch (error) {
      onError?.(error);
      send('result', {error:error.message || '发布失败，在线草稿仍保留'});
    }
  };
  window.addEventListener('message', receive);
  send('ready');
}
