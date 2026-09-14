import path from 'path';
import express from 'express';
import axios from 'axios';
import cors from 'cors';
import { fileURLToPath } from 'url';
import fs from 'fs';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
  port: process.env.PORT || 8080,
  password: process.env.PASSWORD || '',
  corsOrigin: process.env.CORS_ORIGIN || '*',
  timeout: parseInt(process.env.REQUEST_TIMEOUT || '5000'),
  maxRetries: parseInt(process.env.MAX_RETRIES || '2'),
  cacheMaxAge: process.env.CACHE_MAX_AGE || '1d',
  userAgent: process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
  debug: process.env.DEBUG === 'true'
};

const log = (...args) => {
  if (config.debug) {
    console.log('[DEBUG]', ...args);
  }
};

const app = express();

app.use(cors({
  origin: config.corsOrigin,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // 播放器通过同源 iframe 打开（见 app.js showVideoPlayer），DENY 会挡掉它；
  // 用 SAMEORIGIN：允许同源 iframe，同时仍阻止跨域点击劫持嵌入。
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

function sha256Hash(input) {
  return new Promise((resolve) => {
    const hash = crypto.createHash('sha256');
    hash.update(input);
    resolve(hash.digest('hex'));
  });
}

async function renderPage(filePath, password) {
  let content = fs.readFileSync(filePath, 'utf8');
  if (password !== '') {
    const sha256 = await sha256Hash(password);
    content = content.replace('{{PASSWORD}}', sha256);
  }
  return content;
}

app.get(['/', '/index.html', '/player.html'], async (req, res) => {
  try {
    let filePath;
    switch (req.path) {
      case '/player.html':
        filePath = path.join(__dirname, 'player.html');
        break;
      default: // '/' 和 '/index.html'
        filePath = path.join(__dirname, 'index.html');
        break;
    }
    
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

app.get('/s=:keyword', async (req, res) => {
  try {
    const filePath = path.join(__dirname, 'index.html');
    const content = await renderPage(filePath, config.password);
    res.send(content);
  } catch (error) {
    console.error('搜索页面渲染错误:', error);
    res.status(500).send('读取静态页面失败');
  }
});

function isValidUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const allowedProtocols = ['http:', 'https:'];
    
    // 从环境变量获取阻止的主机名列表
    const blockedHostnames = (process.env.BLOCKED_HOSTS || 'localhost,127.0.0.1,0.0.0.0,::1').split(',');
    
    // 从环境变量获取阻止的 IP 前缀
    const blockedPrefixes = (process.env.BLOCKED_IP_PREFIXES || '192.168.,10.,172.').split(',');
    
    if (!allowedProtocols.includes(parsed.protocol)) return false;
    if (blockedHostnames.includes(parsed.hostname)) return false;
    
    for (const prefix of blockedPrefixes) {
      if (parsed.hostname.startsWith(prefix)) return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

// --- M3U8 代理重写：让本地 server.mjs 与部署的 Netlify 代理行为一致 ---
// 把 m3u8 里的分片/子列表/密钥/初始化段 URI 全部重写为 /proxy 路径，
// 这样前端 hls.js 经本地代理拉流时相对路径才能正确解析，且分片可被浏览器缓存。
function getBaseUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    const parts = parsed.pathname.split('/');
    parts.pop();
    return `${parsed.origin}${parts.join('/')}/`;
  } catch (e) {
    return urlStr.slice(0, urlStr.lastIndexOf('/') + 1);
  }
}

function resolveUrl(baseUrl, relativeUrl) {
  if (!relativeUrl) return '';
  if (/^https?:\/\//i.test(relativeUrl)) return relativeUrl;
  try {
    return new URL(relativeUrl, baseUrl).toString();
  } catch (e) {
    return relativeUrl.startsWith('/') ? new URL(baseUrl).origin + relativeUrl : baseUrl.replace(/\/[^/]*$/, '/') + relativeUrl;
  }
}

function rewriteUrlToProxy(targetUrl) {
  return '/proxy/' + encodeURIComponent(targetUrl);
}

function processM3u8Content(targetUrl, content) {
  const baseUrl = getBaseUrl(targetUrl);
  const lines = content.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line && i === lines.length - 1) { out.push(line); continue; }
    if (!line) continue;

    if (line.startsWith('#EXT-X-KEY') || line.startsWith('#EXT-X-MAP')) {
      out.push(line.replace(/URI="([^"]+)"/, (m, uri) => `URI="${rewriteUrlToProxy(resolveUrl(baseUrl, uri))}"`));
      continue;
    }
    if (line.startsWith('#EXT-X-MEDIA')) {
      out.push(line.replace(/URI="([^"]+)"/, (m, uri) => {
        const abs = resolveUrl(baseUrl, uri);
        return (abs && /^https?:\/\//i.test(abs)) ? `URI="${rewriteUrlToProxy(abs)}"` : m;
      }));
      continue;
    }
    if (line.startsWith('#')) { out.push(line); continue; }

    // 变体 URI（master 播放列表）或分片 URI（media 播放列表）都重写为代理路径；
    // 保留全部档位，前端 hls.js 自行做自适应码率。
    out.push(rewriteUrlToProxy(resolveUrl(baseUrl, line)));
  }
  return out.join('\n');
}

// 代理路由
app.get('/proxy/:encodedUrl', async (req, res) => {
  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    // 安全验证
    if (!isValidUrl(targetUrl)) {
      return res.status(400).send('无效的 URL');
    }

    log(`代理请求: ${targetUrl}`);

    // 添加请求超时和重试逻辑
    const maxRetries = config.maxRetries;
    let retries = 0;
    
    // 针对有防盗链的站点补充 Referer。豆瓣图床要求 Referer 为 https://m.douban.com/
    const buildHeaders = () => {
      const headers = { 'User-Agent': config.userAgent };
      try {
        const host = new URL(targetUrl).hostname;
        if (host.endsWith('doubanio.com') || host.endsWith('douban.com')) {
          headers['Referer'] = 'https://m.douban.com/';
        }
      } catch (e) {
        // URL 解析失败时忽略，走默认头
      }
      return headers;
    };

    const makeRequest = async () => {
      try {
        return await axios({
          method: 'get',
          url: targetUrl,
          responseType: 'stream',
          timeout: config.timeout,
          headers: buildHeaders()
        });
      } catch (error) {
        if (retries < maxRetries) {
          retries++;
          log(`重试请求 (${retries}/${maxRetries}): ${targetUrl}`);
          return makeRequest();
        }
        throw error;
      }
    };

    const response = await makeRequest();

    // 转发响应头（过滤敏感头）
    const headers = { ...response.headers };
    const sensitiveHeaders = (
      process.env.FILTERED_HEADERS ||
      'content-security-policy,cookie,set-cookie,x-frame-options,access-control-allow-origin'
    ).split(',');

    sensitiveHeaders.forEach(header => delete headers[header]);

    const contentType = headers['content-type'] || headers['Content-Type'] || '';
    const isM3u8 = /mpegurl/i.test(contentType) || /\.m3u8(\?|$)/i.test(targetUrl);
    const isMedia = /^(video|audio|image)\//i.test(contentType) || /\.(ts|mp4|webm|mp3|jpg|jpeg|png|webp)(\?|$)/i.test(targetUrl);

    // M3U8：读取文本、重写分片/子列表 URI 为 /proxy 路径，并允许缓存
    if (isM3u8) {
      let raw = '';
      for await (const chunk of response.data) raw += chunk.toString('utf8');
      const processed = processM3u8Content(targetUrl, raw);
      res.set(headers);
      res.set('Content-Type', 'application/vnd.apple.mpegurl');
      res.set('Cache-Control', 'public, max-age=86400');
      res.send(processed);
      return;
    }

    // 非 M3U8：透传响应流；媒体类内容（图片/音视频分片等）允许缓存
    res.set(headers);
    if (isMedia) {
      res.set('Cache-Control', 'public, max-age=86400');
    }

    // 管道传输响应流
    response.data.pipe(res);
  } catch (error) {
    console.error('代理请求错误:', error.message);
    if (error.response) {
      res.status(error.response.status || 500);
      error.response.data.pipe(res);
    } else {
      res.status(500).send(`请求失败: ${error.message}`);
    }
  }
});

app.use(express.static(path.join(__dirname), {
  maxAge: config.cacheMaxAge
}));

app.use((err, req, res, next) => {
  console.error('服务器错误:', err);
  res.status(500).send('服务器内部错误');
});

app.use((req, res) => {
  res.status(404).send('页面未找到');
});

// 启动服务器
app.listen(config.port, () => {
  console.log(`服务器运行在 http://localhost:${config.port}`);
  if (config.password !== '') {
    console.log('登录密码已设置');
  }
  if (config.debug) {
    console.log('调试模式已启用');
    console.log('配置:', { ...config, password: config.password ? '******' : '' });
  }
});
