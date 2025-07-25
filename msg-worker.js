// 注意：Cloudflare Worker中，所有异步操作必须用await，且避免未捕获的错误
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request).catch(err => {
    // 捕获所有错误，返回友好提示
    return new Response(`Worker错误: ${err.message}`, { status: 500 });
  }));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 1. 仅处理API请求（/send, /pull, /set-permission），其他请求转发给Cloudflare Pages静态页面
  if (!['/send', '/pull', '/set-permission'].includes(path)) {
    return fetch(request); // 静态页面（A端/B端HTML）由Pages处理
  }

  // 2. 发送消息（A端→Worker）
  if (path === '/send' && method === 'POST') {
    try {
      const body = await request.json(); // 解析A端发送的JSON
      const { from, content } = body;

      // 校验必要参数
      if (!from || !content) {
        return new Response(JSON.stringify({ code: 400, msg: '缺少参数' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 从KV获取用户权限（若未设置，默认允许）
      const permissions = await KV.get('user_permissions', { type: 'json' }) || {};
      if (permissions[from] === false) { // 明确禁止才拦截
        return new Response(JSON.stringify({ code: 403, msg: '无发言权限' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 检查B端在线状态（默认离线）
      const status = await KV.get('online_status', { type: 'json' }) || { is_online: false };
      if (status.is_online) {
        // B端在线：这里简化为"实时送达"（实际可用Durable Objects存实时消息）
        return new Response(JSON.stringify({ code: 200, msg: '已送达' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } else {
        // B端离线：存到KV离线消息列表
        const offlineMsgs = await KV.get('offline_messages', { type: 'json' }) || [];
        offlineMsgs.push({
          from,
          content,
          time: new Date().toLocaleString()
        });
        await KV.put('offline_messages', JSON.stringify(offlineMsgs)); // 写入KV
        return new Response(JSON.stringify({ code: 200, msg: '主机离线，消息已保存' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: '发送失败' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 3. B端拉取消息（含离线消息）
  if (path === '/pull' && method === 'GET') {
    try {
      // 验证B端密码（从URL参数获取，与环境变量比对）
      const password = url.searchParams.get('pwd');
      if (password !== env.HOST_PASSWORD) { // 注意：这里是env，不是ENV
        return new Response(JSON.stringify({ code: 401, msg: '密码错误' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 拉取并清空离线消息（避免重复拉取）
      const offlineMsgs = await KV.get('offline_messages', { type: 'json' }) || [];
      await KV.put('offline_messages', JSON.stringify([])); // 清空离线消息

      // 标记B端为在线
      await KV.put('online_status', JSON.stringify({
        is_online: true,
        last_active: new Date().toLocaleString()
      }));

      return new Response(JSON.stringify({
        code: 200,
        offline: offlineMsgs,
        realtime: [] // 实时消息（后续用Durable Objects补充）
      }), { headers: { 'Content-Type': 'application/json' } });
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: '拉取失败' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 4. B端设置用户权限
  if (path === '/set-permission' && method === 'POST') {
    try {
      const password = url.searchParams.get('pwd');
      if (password !== env.HOST_PASSWORD) {
        return new Response(JSON.stringify({ code: 401, msg: '密码错误' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const body = await request.json();
      const { user, allow } = body; // user是A端的临时ID，allow是布尔值
      if (!user || allow === undefined) {
        return new Response(JSON.stringify({ code: 400, msg: '缺少参数' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }

      // 更新权限到KV
      const permissions = await KV.get('user_permissions', { type: 'json' }) || {};
      permissions[user] = allow;
      await KV.put('user_permissions', JSON.stringify(permissions));

      return new Response(JSON.stringify({ code: 200, msg: '权限已更新' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } catch (err) {
      return new Response(JSON.stringify({ code: 500, msg: '设置失败' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }

  // 其他路径返回404
  return new Response(JSON.stringify({ code: 404, msg: '路径不存在' }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
