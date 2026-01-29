import { kv } from '@vercel/kv';

export const config = {
  runtime: 'edge', // 强制使用 Edge Runtime
};

/**
 * 辅助函数：标准化域名，去除末尾斜杠
 */
const normalizeDomain = (domain) => {
  if (!domain) return '';
  return domain.endsWith('/') ? domain.slice(0, -1) : domain;
};

export default async function handler(request, context) {
  const url = new URL(request.url);
  
  // 获取并清理环境变量
  const DOMAIN_MAIN = normalizeDomain(process.env.DOMAIN_MAIN);
  const DOMAIN_BACKUP = normalizeDomain(process.env.DOMAIN_BACKUP);

  if (!DOMAIN_MAIN || !DOMAIN_BACKUP) {
    return new Response('Configuration Error: Missing DOMAIN_MAIN or DOMAIN_BACKUP', { status: 500 });
  }

  // ----------------------------------------------------------------
  // 辅助函数：构造转发请求
  // ----------------------------------------------------------------
  const createProxyRequest = (targetDomain, originalReq, bodyOverride = null) => {
    // 拼接目标 URL：保留原始 Path 和 Search Params
    const targetUrl = new URL(url.pathname + url.search, targetDomain);
    
    // 复制请求头
    const newHeaders = new Headers(originalReq.headers);
    // 核心：移除 Host 头，让 fetch 自动生成目标域名的 Host，否则对方服务器可能会拒绝
    newHeaders.delete('host');
    // 可选：添加 X-Forwarded-Host 标识
    newHeaders.set('x-forwarded-host', url.host);

    // 确定 Body：如果有缓存的 Buffer 则使用 Buffer，否则使用原始流
    // 注意：GET/HEAD 请求 body 必须为 null
    const method = originalReq.method;
    const hasBody = method !== 'GET' && method !== 'HEAD';
    const body = hasBody ? (bodyOverride || originalReq.body) : null;

    return new Request(targetUrl, {
      method: method,
      headers: newHeaders,
      body: body,
      redirect: 'manual', // 不自动跟随重定向，将 3xx 原样返回给客户端
    });
  };

  // ----------------------------------------------------------------
  // 逻辑分支 1: 监控接口 /api/notice
  // ----------------------------------------------------------------
  if (url.pathname === '/api/notice') {
    let bodyBuffer = null;

    // 如果请求包含 Body，必须先读取到内存中。
    // 因为 Request Body 流只能被读取一次。如果发给 A 失败了，还需要发给 B，所以不能直接流式传输。
    if (request.body) {
      try {
        bodyBuffer = await request.arrayBuffer();
      } catch (e) {
        console.error('Failed to read request body', e);
        return new Response('Bad Request: Unable to read body', { status: 400 });
      }
    }

    try {
      // --- 步骤 2: 转发到 A (带超时) ---
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时

      const proxyReqMain = createProxyRequest(DOMAIN_MAIN, request, bodyBuffer);
      
      const responseMain = await fetch(proxyReqMain, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (responseMain.ok) {
        // --- 步骤 3: A 成功 -> 标记 Up -> 返回 ---
        // 使用 context.waitUntil 异步写入 KV，不阻塞响应返回，降低延迟
        const task = kv.set('primary_status', 'up', { ex: 600 }); // 10分钟过期
        context.waitUntil(task);
        
        return responseMain;
      } else {
        // 状态码错误 (如 500, 502)，抛出异常进入 catch 进行故障转移
        throw new Error(`Primary domain responded with status: ${responseMain.status}`);
      }

    } catch (error) {
      // --- 步骤 4: A 失败/超时 -> 标记 Down -> 转发 B ---
      console.error(`Health check failed (${error.message}), failing over to backup.`);
      
      const task = kv.set('primary_status', 'down', { ex: 600 });
      context.waitUntil(task);

      // 转发到 B (使用之前缓存的 bodyBuffer)
      const proxyReqBackup = createProxyRequest(DOMAIN_BACKUP, request, bodyBuffer);
      return fetch(proxyReqBackup);
    }
  }

  // ----------------------------------------------------------------
  // 逻辑分支 2: 普通接口 (非 /api/notice)
  // ----------------------------------------------------------------
  // --- 步骤 5: 检查缓存状态 ---
  let isUp = true;
  try {
    const status = await kv.get('primary_status');
    // 如果是 'down' 则为 false，如果是 'up' 或 null (不存在) 则默认为 true
    if (status === 'down') {
      isUp = false;
    }
  } catch (e) {
    // 如果 KV 读取失败（极罕见），为了可用性，默认尝试主域名 A
    console.error('KV read failed, defaulting to primary', e);
    isUp = true;
  }

  if (isUp) {
    // --- 步骤 6: 转发到 A ---
    // 这里没有读取 bodyBuffer，直接使用 request.body 流，实现最高性能流式转发
    const proxyReq = createProxyRequest(DOMAIN_MAIN, request);
    return fetch(proxyReq);
  } else {
    // --- 步骤 7: 转发到 B ---
    const proxyReq = createProxyRequest(DOMAIN_BACKUP, request);
    return fetch(proxyReq);
  }
}