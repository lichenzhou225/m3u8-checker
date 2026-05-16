// ==========================================
// server.js 完美兼容打包版（优化加速版）
// ==========================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const unzipper = require('unzipper');

const app = express();
const PORT = 3000;

// 忽略自签名或不安全直播源链接的 HTTPS 证书校验（防止打包后网络限制导致未知错误）
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

process.on('uncaughtException', err => {
    console.error('未捕获异常:', err);
});

process.on('unhandledRejection', err => {
    console.error('Promise异常:', err);
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// ==========================================
// 💡 环境判断与静态路径修复
// ==========================================
const isPkg = typeof process.pkg !== 'undefined';
const isElectron = process.versions && process.versions.electron;

let baseDir;
if (isPkg) {
    baseDir = path.dirname(process.execPath);
} else if (isElectron) {
    const { app: electronApp } = require('electron');
    baseDir = electronApp.isPackaged ? path.dirname(process.execPath) : __dirname;
} else {
    baseDir = __dirname;
}

// 确保前端静态文件能被正确找到
const publicPath = path.join(baseDir, 'public');
app.use(express.static(publicPath));

const upload = multer({ dest: path.join(baseDir, 'uploads') });

// ==========================================
// 💡 核心修复：FFmpeg 路径不再使用不可写的 __dirname
// ==========================================
const ffmpegRoot = path.join(baseDir, 'bin');
const ffmpegExe = path.join(ffmpegRoot, 'ffmpeg.exe');
const ffprobeExe = path.join(ffmpegRoot, 'ffprobe.exe');

let ffmpegReady = false;

// ============================
// 自动下载 FFmpeg
// ============================
async function ensureFFmpeg() {
    if (ffmpegReady) return;

    if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
        ffmpeg.setFfmpegPath(ffmpegExe);
        ffmpeg.setFfprobePath(ffprobeExe);
        ffmpegReady = true;
        console.log('✅ 已成功挂载本地 FFmpeg:', ffmpegExe);
        return;
    }

    console.log('⏳ 未检测到 FFmpeg，开始自动下载至:', ffmpegRoot);

    if (!fs.existsSync(ffmpegRoot)) {
        fs.mkdirSync(ffmpegRoot, { recursive: true });
    }

    const zipPath = path.join(ffmpegRoot, 'ffmpeg.zip');

    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        https.get(
            'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
            (res) => {
                // 自动处理 HTTP 302 重定向
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    https.get(res.headers.location, response => response.pipe(file)).on('error', reject);
                } else {
                    res.pipe(file);
                }
                file.on('finish', () => {
                    file.close(resolve);
                });
            }
        ).on('error', reject);
    });

    console.log('📦 FFmpeg 下载完成，开始解压...');

    await fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: ffmpegRoot }))
        .promise();

    const dirs = fs.readdirSync(ffmpegRoot);
    let found = false;

    for (const d of dirs) {
        const fp = path.join(ffmpegRoot, d, 'bin', 'ffmpeg.exe');
        const pp = path.join(ffmpegRoot, d, 'bin', 'ffprobe.exe');

        if (fs.existsSync(fp) && fs.existsSync(pp)) {
            fs.copyFileSync(fp, ffmpegExe);
            fs.copyFileSync(pp, ffprobeExe);
            found = true;
            break;
        }
    }

    // 清理临时压缩包
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    if (!found) {
        throw new Error('FFmpeg 解压失败，未找到二进制程序');
    }

    ffmpeg.setFfmpegPath(ffmpegExe);
    ffmpeg.setFfprobePath(ffprobeExe);
    ffmpegReady = true;
    console.log('🚀 FFmpeg 已经自动配置就绪！');
}

// ============================
// 检测 M3U8 是否有效
// ============================
async function checkM3U8(url, timeout = 8000) {
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeout);

    try {
        const res = await fetch(url, {
            method: 'GET',
            signal: controller.signal
        });

        if (!res.ok) {
            return { valid: false, msg: `HTTP ${res.status}` };
        }

        const text = await res.text();
        if (
            text.includes('#EXTM3U') ||
            text.includes('#EXTINF') ||
            text.includes('.ts')
        ) {
            return { valid: true, msg: '有效 M3U8 | 媒体列表' };
        }
        return { valid: false, msg: '非M3U8内容' };
    } catch (e) {
        return { valid: false, msg: e.message };
    } finally {
        clearTimeout(timer);
    }
}

// ============================
// 主播放列表分辨率解析
// ============================
async function getM3U8Resolution(url) {
    try {
        const res = await fetch(url);
        const text = await res.text();
        const regex = /RESOLUTION=(\d+x\d+)/g;
        const list = [];
        let m;

        while ((m = regex.exec(text)) !== null) {
            list.push(m[1]);
        }

        if (list.length > 0) return [...new Set(list)];
        if (text.includes('#EXTINF')) return ['单分辨率'];
        return ['未知'];
    } catch {
        return ['未知'];
    }
}

// ============================
// ⚡ TS真实分辨率检测 + 重试（已优化加速）
// ============================
async function getTSResolution(tsUrl, retries = 2) {
    // 💡 关键改动1：移除此处重复的 ensureFFmpeg()，避免高并发下频繁查询磁盘阻塞线程

    for (let i = 0; i <= retries; i++) {
        try {
            const result = await new Promise((resolve) => {
                // 💡 关键改动2：注入限制探测范围和时间的参数，防止卡顿流死等
                ffmpeg(tsUrl)
                    .inputOptions([
                        '-probesize 50000',       // 只探测前 50KB 数据
                        '-analyzeduration 1000000' // 限制流分析时间最多 1 秒（单位微秒）
                    ])
                    .ffprobe((err, metadata) => {
                        if (err) {
                            console.log(`TS检测失败 第 ${i + 1} 次尝试: ${tsUrl}`);
                            return resolve('未知');
                        }
                        const stream = metadata.streams.find(s => s.codec_type === 'video');
                        if (!stream) return resolve('未知');
                        resolve(`${stream.width}x${stream.height}`);
                    });
            });

            if (result !== '未知') {
                console.log(`TS检测成功: ${result}`);
                return result;
            }
        } catch (e) {
            console.log('TS异常:', e.message);
        }
        await new Promise(r => setTimeout(r, 300)); // 略微缩短网络重试等待间隔
    }
    return '未知';
}

// ============================
// 批量检测核心
// ============================
async function checkBatch(items, concurrency, timeout, enableTSResolution) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const current = index++;
            const item = items[current];
            const validResult = await checkM3U8(item.url, timeout);
            let resolutions = ['未知'];

            if (validResult.valid) {
                resolutions = await getM3U8Resolution(item.url);
                if (
                    enableTSResolution &&
                    resolutions.length === 1 &&
                    resolutions[0] === '单分辨率'
                ) {
                    try {
                        const text = await fetch(item.url).then(r => r.text());
                        const tsLine = text
                            .split(/\r?\n/)
                            .find(l => l && !l.startsWith('#'));

                        if (tsLine) {
                            const tsUrl = new URL(tsLine, item.url).href;
                            console.log('正在精确探测 TS 流:', tsUrl);
                            const realRes = await getTSResolution(tsUrl);
                            resolutions = [realRes];
                        }
                    } catch (e) {
                        console.log('TS流深度解析失败:', e.message);
                    }
                }
            }

            results[current] = {
                url: item.url,
                name: item.name,
                valid: validResult.valid,
                msg: validResult.msg,
                resolutions
            };

            console.log(`[${current + 1}/${items.length}]`, item.url, validResult.valid ? '✅ 有效' : '❌ 无效', resolutions.join(','));
        }
    }

    const workers = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        workers.push(worker());
    }
    await Promise.all(workers);
    return results;
}

// ============================
// API 路由
// ============================
app.post('/check', async (req, res) => {
    const { links, concurrency = 5, timeout = 8000, enableTSResolution = false } = req.body;
    if (!links || !links.length) return res.json({ error: '没有链接' });

    const items = links.map(line => {
        if (line.includes(',')) {
            const idx = line.indexOf(',');
            return {
                name: line.slice(0, idx).trim(),
                url: line.slice(idx + 1).trim()
            };
        }
        return { name: null, url: line.trim() };
    });

    const results = await checkBatch(items, concurrency, timeout, enableTSResolution);
    res.json({ results, done: true });
});

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.json({ error: '未上传文件' });
    const text = fs.readFileSync(req.file.path, 'utf-8');
    fs.unlinkSync(req.file.path);

    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    req.body.links = lines;
    app._router.handle(req, res, () => {});
});

// ============================
// 服务启动
// ============================
app.listen(PORT, () => {
    console.log(`====================================`);
    console.log(` 🚀 M3U8 批量服务已成功在本地建立监听`);
    console.log(` 🌐 访问地址: http://localhost:${PORT}`);
    console.log(`====================================`);
    
    // 💡 仅在程序启动时初始化一次 FFmpeg，挂载全局路径，后续不再重复读盘
    ensureFFmpeg().catch(err => console.error("FFmpeg 初始化崩溃:", err));
});
