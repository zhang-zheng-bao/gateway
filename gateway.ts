/**
 * 庐州GO 网关 (Gateway)
 * ──────────────────────────────────────────────────────────────
 * 独立的反向代理 + TLS 终结服务，取代原先内嵌在庐州GO 进程里的网关逻辑。
 *
 * 职责（只做两件事，不碰任何业务逻辑）：
 *   1. TLS 终结：监听 443（及 80 跳转），按 SNI 域名选择对应证书
 *   2. 反向代理：按请求 Host 转发到本机对应的业务端口
 *
 * 路由表通过环境变量 ROUTES 配置，格式：
 *   ROUTES=luzhougo.cn:3001,zhengbao.work:3002
 *
 * 这样拆分后：
 *   · 庐州GO 重启不再影响「我的空间」
 *   · 新增站点只需在 ROUTES 里加一条，无需改业务代码
 */

import http from 'http';
import https from 'https';
import tls from 'tls';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';

const GATEWAY_DIR = process.cwd();
const ENV_PATH = path.join(GATEWAY_DIR, '.env');
dotenv.config({ path: ENV_PATH, override: true });

// ── 配置 ──────────────────────────────────────────────────────
const HTTP_PORT = Number(process.env.HTTP_PORT) || 80;
const HTTPS_PORT = Number(process.env.HTTPS_PORT) || 443;
const CERT_DIR = process.env.CERT_DIR
  ? path.resolve(GATEWAY_DIR, process.env.CERT_DIR)
  : path.join(GATEWAY_DIR, 'certs');

/** 域名 -> 本机业务端口 */
const ROUTES: Record<string, number> = {};
const rawRoutes = process.env.ROUTES || '';
for (const entry of rawRoutes.split(',')) {
  const trimmed = entry.trim();
  if (!trimmed) continue;
  const idx = trimmed.lastIndexOf(':');
  if (idx <= 0) continue;
  const domain = trimmed.slice(0, idx).trim().toLowerCase();
  const port = Number(trimmed.slice(idx + 1).trim());
  if (domain && Number.isFinite(port)) ROUTES[domain] = port;
}

/** 未匹配到任何域名的兜底端口（通常是主站），未配置则返回 404 */
const DEFAULT_PORT = Number(process.env.DEFAULT_PORT) || 0;

const log = (msg: string) => console.log(`[gateway] ${msg}`);

// ── 证书加载 ──────────────────────────────────────────────────
type PemCertificate = { hostname: string; certPath: string; keyPath: string };
type PfxCertificate = { hostname: string; pfxPath: string; passphrase: string };

/**
 * 递归查找 PEM 证书。支持两种布局：
 *   certs/<domain>/cert.pem + key.pem
 *   certs/<domain>_tomcat/cert.pem + key.pem   （腾讯云下载的原始命名）
 * hostname 取目录名并去掉 _tomcat 后缀。
 */
const findPemCertificates = (dir: string): PemCertificate[] => {
  const found: PemCertificate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (!entry.isDirectory()) continue;
    const certPath = path.join(full, 'cert.pem');
    const keyPath = path.join(full, 'key.pem');
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      found.push({
        hostname: entry.name.replace(/_tomcat$/i, '').toLowerCase(),
        certPath,
        keyPath,
      });
    }
    // 允许再嵌套一层（例如 certs/archive/xxx_tomcat/）
    found.push(...findPemCertificates(full));
  }
  return found;
};

/** 递归查找 PFX 证书（备选，同名 PEM 优先） */
const findPfxCertificates = (dir: string): PfxCertificate[] => {
  const found: PfxCertificate[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && full.toLowerCase().endsWith('.pfx')) {
      const passFile = path.join(path.dirname(full), 'keystorePass.txt');
      found.push({
        hostname: path.basename(full, path.extname(full)).toLowerCase(),
        pfxPath: full,
        passphrase: fs.existsSync(passFile)
          ? fs.readFileSync(passFile, 'utf8').trim()
          : '',
      });
    }
    if (entry.isDirectory()) found.push(...findPfxCertificates(full));
  }
  return found;
};

/**
 * 构建 SNI 上下文表。
 * 每个域名同时注册 its-name 和 www.its-name 两个键，
 * 使 https://www.<domain> 也能命中同一张证书。
 */
const buildSniContexts = (): {
  contexts: Map<string, tls.SecureContext>;
  defaultOptions: tls.SecureContextOptions | null;
} => {
  const contexts = new Map<string, tls.SecureContext>();
  let defaultOptions: tls.SecureContextOptions | null = null;

  const register = (hostname: string, options: tls.SecureContextOptions) => {
    if (contexts.has(hostname)) return false;
    contexts.set(hostname, tls.createSecureContext(options));
    if (!hostname.startsWith('www.')) {
      contexts.set(`www.${hostname}`, tls.createSecureContext(options));
    }
    return true;
  };

  // PEM 优先（腾讯云的 pem 是完整证书链，比 pfx 更可靠）
  for (const cert of findPemCertificates(CERT_DIR)) {
    try {
      const options: tls.SecureContextOptions = {
        key: fs.readFileSync(cert.keyPath),
        cert: fs.readFileSync(cert.certPath),
      };
      if (!defaultOptions) defaultOptions = options;
      if (register(cert.hostname, options)) {
        log(`loaded PEM certificate for ${cert.hostname}`);
      }
    } catch (err: any) {
      log(`PEM certificate error (${cert.certPath}): ${err.message}`);
    }
  }

  // PFX 仅作备选：同名域名若已有 PEM 则跳过
  for (const cert of findPfxCertificates(CERT_DIR)) {
    if (contexts.has(cert.hostname)) {
      log(`skip PFX for ${cert.hostname} (PEM already loaded)`);
      continue;
    }
    try {
      const options: tls.SecureContextOptions = {
        pfx: fs.readFileSync(cert.pfxPath),
        passphrase: cert.passphrase,
      };
      if (!defaultOptions) defaultOptions = options;
      if (register(cert.hostname, options)) {
        log(`loaded PFX certificate for ${cert.hostname}`);
      }
    } catch (err: any) {
      log(`PFX certificate error (${cert.pfxPath}): ${err.message}`);
    }
  }

  return { contexts, defaultOptions };
};

// ── 反向代理 ──────────────────────────────────────────────────
const resolveTarget = (hostHeader: string | undefined): number | null => {
  const host = String(hostHeader || '').split(':')[0].trim().toLowerCase();
  if (!host) return null;
  if (ROUTES[host]) return ROUTES[host];
  // www.example.com 回退到 example.com 的配置
  if (host.startsWith('www.')) {
    const bare = host.slice(4);
    if (ROUTES[bare]) return ROUTES[bare];
  }
  if (DEFAULT_PORT) return DEFAULT_PORT;
  return null;
};

const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
  // 网关自身的健康检查（不转发，供 Actions / 监控使用）
  const url = req.url || '/';
  if (url === '/__gateway/health' || url === '/gateway-health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      status: 'ok',
      service: 'gateway',
      routes: ROUTES,
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }));
    return;
  }

  const host = String(req.headers.host || '').split(':')[0].toLowerCase();
  const targetPort = resolveTarget(req.headers.host);

  if (!targetPort) {
    log(`no route for host "${host}" -> 404`);
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Gateway: no route configured for host "${host}"`);
    return;
  }

  const isTls = Boolean((req.socket as any).encrypted);

  // Node's http.request() rejects a "Connection" header copied from the
  // client (it manages keep-alive itself), and it computes Content-Length /
  // Transfer-Encoding from the body we write. Strip the hop-by-hop headers.
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  delete headers['connection'];
  delete headers['keep-alive'];
  delete headers['proxy-connection'];
  delete headers['transfer-encoding'];
  delete headers['upgrade'];
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = isTls ? 'https' : 'http';
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';
  headers['x-gateway'] = 'lzgo-gateway';

  const proxyReq = http.request(
    {
      hostname: '127.0.0.1',
      port: targetPort,
      path: url,
      method: req.method,
      headers,
    },
    (proxyRes) => {
      if (res.writableEnded) {
        proxyRes.destroy();
        return;
      }
      const resHeaders = { ...proxyRes.headers };
      delete resHeaders['transfer-encoding'];
      res.writeHead(proxyRes.statusCode || 502, resHeaders);
      proxyRes.pipe(res);
      proxyRes.on('error', () => res.destroy());
    },
  );

  proxyReq.on('error', (err: any) => {
    log(`proxy error ${host} -> 127.0.0.1:${targetPort} : ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Gateway: upstream unavailable');
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  // Only relay a body when the client actually sent one. Calling pipe() on a
  // bodyless GET would end the upstream request immediately and, combined with
  // the abort handler, tear the whole exchange down before any response.
  const hasBody =
    req.method !== 'GET' &&
    req.method !== 'HEAD' &&
    (req.headers['content-length'] !== undefined ||
      req.headers['transfer-encoding'] !== undefined);

  if (hasBody) {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }

  // Client vanished mid-flight -> release the upstream socket.
  res.on('close', () => {
    if (!res.writableEnded) proxyReq.destroy();
  });
};

// ── 启动 ──────────────────────────────────────────────────────
log(`gateway dir: ${GATEWAY_DIR}`);
log(`cert dir   : ${CERT_DIR}`);
log(`routes     : ${Object.keys(ROUTES).length ? JSON.stringify(ROUTES) : '(empty)'}`);
if (DEFAULT_PORT) log(`default    : ${DEFAULT_PORT}`);
if (Object.keys(ROUTES).length === 0 && !DEFAULT_PORT) {
  log('WARNING: no ROUTES configured - every request will get 404');
}

// HTTP：仅用于健康检查与（未来的）跳转，业务流量走 HTTPS
const httpServer = http.createServer(handler);
httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  log(`HTTP  listening on http://0.0.0.0:${HTTP_PORT}`);
});
httpServer.on('error', (err: any) => {
  log(`HTTP server error: ${err.message}`);
});

// HTTPS：TLS 终结 + SNI
const { contexts: sniContexts, defaultOptions } = buildSniContexts();

if (!defaultOptions) {
  log('HTTPS not enabled - no usable certificate found.');
  log(`Place cert.pem + key.pem under ${CERT_DIR}/<domain>_tomcat/`);
} else {
  const httpsOptions: https.ServerOptions = { ...defaultOptions };
  if (sniContexts.size > 0) {
    const fallback = tls.createSecureContext(defaultOptions);
    httpsOptions.SNICallback = (servername, callback) => {
      const name = String(servername || '').toLowerCase();
      const ctx =
        sniContexts.get(name) ||
        (name.startsWith('www.') ? sniContexts.get(name.slice(4)) : undefined) ||
        fallback;
      callback(null, ctx);
    };
  }

  const httpsServer = https.createServer(httpsOptions, handler);
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    log(`HTTPS listening on https://0.0.0.0:${HTTPS_PORT} (${sniContexts.size} SNI domain(s))`);
    for (const name of new Set([...sniContexts.keys()].filter((n) => !n.startsWith('www.')))) {
      log(`  cert ready: ${name}`);
    }
  });
  httpsServer.on('error', (err: any) => {
    log(`HTTPS server error: ${err.message}`);
  });
}

// 优雅退出：收到停止信号时关闭监听，交给进程管理器重启
const shutdown = (signal: string) => {
  log(`received ${signal}, shutting down...`);
  httpServer.close();
  process.exit(0);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
