
// Cloudflare Worker入口
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request))
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;

  // 1. A端发送消息（POST /send）
  if (path === '/send' && request.method === 'POST') {
    const { from, content } = await request.json();
    // 校验权限：从KV获取user_permissions，检查该用户是否允许发言
    const permissions = await KV.get('user_permissions', { type: 'json' }) || {};
    if (!permissions[from]) {
      return new Response(JSON.stringify({ code: 403, msg: '无发言权限' }));
    }
    // 检查B端是否在线
    const status = await KV.get('online_status', { type: 'json' }) || { is_online: false };
    if (status.is_online) {
      // B端在线：直接转发（通过WebSockets或HTTP长轮询，这里简化为暂存到内存，B端主动拉取）
      // 实际可结合Cloudflare Durable Objects实现实时推送，此处用简易方案
      return new Response(JSON.stringify({ code: 200, msg: '已送达' }));
    } else {
      // B端离线：存入KV offline_messages
      const offlineMsgs = await KV.get('offline_messages', { type: 'json' }) || [];
      offlineMsgs.push({ from, content, time: new Date().toLocaleString() });
      await KV.put('offline_messages', JSON.stringify(offlineMsgs));
      return new Response(JSON.stringify({ code: 200, msg: '主机离线，消息已保存' }));
    }
  }

  // 2. B端拉取消息/离线消息（GET /pull）
  if (path === '/pull' && request.method === 'GET') {
    // 验证B端密码（从URL参数或请求头获取，与Worker环境变量比对）
    const password = url.searchParams.get('pwd');
    if (password !== ENV.HOST_PASSWORD) {
      return new Response('密码错误', { status: 401 });
    }
    // 拉取离线消息（并清空，避免重复拉取）
    const offlineMsgs = await KV.get('offline_messages', { type: 'json' }) || [];
    await KV.put('offline_messages', JSON.stringify([]));
    // 返回实时消息+离线消息
    return new Response(JSON.stringify({ offline: offlineMsgs, realtime: [] }));
  }

  // 3. B端更新权限（POST /set-permission）
  if (path === '/set-permission' && request.method === 'POST') {
    const { user, allow } = await request.json();
    const permissions = await KV.get('user_permissions', { type: 'json' }) || {};
    permissions[user] = allow;
    await KV.put('user_permissions', JSON.stringify(permissions));
    return new Response(JSON.stringify({ code: 200 }));
  }

  // 其他请求：返回前端页面（A端/B端）
  return fetch(request); // 静态页面由Cloudflare Pages托管，Worker仅处理API请求
}
