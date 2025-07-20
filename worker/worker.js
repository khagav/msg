export default {
  async fetch(request, env, ctx) {
    // 处理WebSocket连接
    if (request.headers.get("Upgrade") === "websocket") {
      const url = new URL(request.url);
      const userId = url.searchParams.get("id"); // 客人/主人ID
      const role = url.searchParams.get("role"); // 'guest' 或 'host'
      const pwd = url.searchParams.get("pwd"); // 主人密码

      if (!userId || !role) {
        return new Response("缺少ID或角色参数", { status: 400 });
      }

      // 创建WebSocket连接对
      const { 0: clientWs, 1: serverWs } = new WebSocketPair();
      // 处理服务器端逻辑（绑定4个KV存储）
      await handleWebSocket(
        serverWs,
        userId,
        role,
        pwd,
        env.MSGS_KV,    // 存储离线消息
        env.PWDS_KV,    // 存储主人密码
        env.ALLOWED_KV, // 存储已允许的客人
        env.PENDING_KV  // 存储待验证的客人
      );

      return new Response(null, {
        status: 101,
        webSocket: clientWs
      });
    }

    // 普通HTTP请求返回状态
    return new Response("消息系统信令服务器运行中", { status: 200 });
  }
};

// 处理WebSocket消息逻辑
async function handleWebSocket(ws, userId, role, pwd, msgsKV, pwdsKV, allowedKV, pendingKV) {
  // 存储在线用户（内存中）
  const onlineUsers = new Map();
  onlineUsers.set(userId, { ws, role });

  // 主人登录验证
  if (role === "host" && pwd) {
    const storedPwd = await pwdsKV.get(userId);
    if (!storedPwd) {
      // 首次登录：保存密码
      await pwdsKV.put(userId, pwd);
    } else if (storedPwd !== pwd) {
      // 密码错误：拒绝登录
      ws.send(JSON.stringify({ type: "loginFail", reason: "密码错误" }));
      ws.close(1008, "密码错误");
      return;
    }
  }

  // 主人上线：加载离线消息和权限列表
  if (role === "host") {
    // 加载离线消息
    const offlineMsgs = await msgsKV.get(userId) || "[]";
    ws.send(JSON.stringify({
      type: "offlineMessages",
      messages: JSON.parse(offlineMsgs)
    }));
    await msgsKV.delete(userId); // 清空离线消息

    // 加载权限列表
    const allowed = JSON.parse(await allowedKV.get(userId) || "[]");
    const pending = JSON.parse(await pendingKV.get(userId) || "[]");
    ws.send(JSON.stringify({
      type: "permissionsList",
      allowed: allowed,
      pending: pending
    }));
  }

  // 处理收到的消息
  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      const hostId = role === "guest" ? data.to : userId; // 主人ID（固定）

      // 1. 客人发送消息/验证请求
      if (role === "guest" && ["message", "verifyRequest"].includes(data.type)) {
        const allowed = JSON.parse(await allowedKV.get(hostId) || "[]");
        const pending = JSON.parse(await pendingKV.get(hostId) || "[]");
        const isAllowed = allowed.some(g => g.id === data.guestId);
        const isPending = pending.some(g => g.id === data.guestId);

        if (isAllowed) {
          // 已允许：直接转发给主人
          const hostWs = onlineUsers.get(hostId)?.ws;
          if (hostWs) {
            hostWs.send(JSON.stringify({
              type: "message",
              from: data.from,
              content: data.content,
              time: data.time
            }));
          } else {
            // 主人离线：存储为离线消息
            const existingMsgs = await msgsKV.get(hostId) || "[]";
            const msgs = JSON.parse(existingMsgs);
            msgs.push({ from: data.from, content: data.content, time: data.time });
            await msgsKV.put(hostId, JSON.stringify(msgs));
          }
        } else if (data.type === "verifyRequest" && !isPending) {
          // 待验证：添加到待验证列表并通知主人
          pending.push({ id: data.guestId, nickname: data.from });
          await pendingKV.put(hostId, JSON.stringify(pending));
          const hostWs = onlineUsers.get(hostId)?.ws;
          if (hostWs) {
            hostWs.send(JSON.stringify({
              type: "permissionsList",
              allowed: allowed,
              pending: pending
            }));
          }
        }
      }

      // 2. 主人处理权限（允许/拒绝/移除客人）
      else if (role === "host" && ["allowGuest", "rejectGuest", "removeGuest"].includes(data.type)) {
        const allowed = JSON.parse(await allowedKV.get(userId) || "[]");
        const pending = JSON.parse(await pendingKV.get(userId) || "[]");

        if (data.type === "allowGuest") {
          // 允许客人：添加到允许列表，从待验证移除
          allowed.push({ id: data.guestId, nickname: data.nickname });
          await allowedKV.put(userId, JSON.stringify(allowed));
          await pendingKV.put(userId, JSON.stringify(pending.filter(g => g.id !== data.guestId)));
          // 通知客人验证通过
          const guestWs = onlineUsers.get(data.guestId)?.ws;
          guestWs && guestWs.send(JSON.stringify({ type: "verifyPass" }));
        } else if (data.type === "rejectGuest") {
          // 拒绝客人：从待验证移除
          await pendingKV.put(userId, JSON.stringify(pending.filter(g => g.id !== data.guestId)));
          // 通知客人被拒绝
          const guestWs = onlineUsers.get(data.guestId)?.ws;
          guestWs && guestWs.send(JSON.stringify({ type: "verifyReject" }));
        } else if (data.type === "removeGuest") {
          // 移除已允许客人：从允许列表移除
          await allowedKV.put(userId, JSON.stringify(allowed.filter(g => g.id !== data.guestId)));
        }

        // 刷新主人权限列表
        const updatedAllowed = JSON.parse(await allowedKV.get(userId) || "[]");
        const updatedPending = JSON.parse(await pendingKV.get(userId) || "[]");
        ws.send(JSON.stringify({
          type: "permissionsList",
          allowed: updatedAllowed,
          pending: updatedPending
        }));
      }

      // 3. 主人回复消息
      else if (role === "host" && data.type === "message") {
        if (data.to) {
          // 回复特定客人
          const guestWs = onlineUsers.get(data.to)?.ws;
          guestWs && guestWs.send(JSON.stringify({
            type: "message",
            from: "host",
            content: data.content,
            time: data.time
          }));
        } else {
          // 广播给所有在线客人
          onlineUsers.forEach((user) => {
            if (user.role === "guest") {
              user.ws.send(JSON.stringify({
                type: "message",
                from: "host",
                content: data.content,
                time: data.time
              }));
            }
          });
        }
      }
    } catch (err) {
      console.error("消息处理错误：", err);
      ws.send(JSON.stringify({ type: "error", message: "消息处理失败" }));
    }
  };

  // 连接关闭：移除在线用户
  ws.onclose = () => {
    onlineUsers.delete(userId);
  };

  // 处理错误
  ws.onerror = (err) => {
    console.error("WebSocket错误：", err);
  };
}


