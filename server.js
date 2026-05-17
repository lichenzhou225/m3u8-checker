// ==========================================
// server.js 完美兼容打包版（直播流截取探测版）
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

// 创建临时的临时文件夹用于存放 2 秒的下载片段
const tempDownloadDir = path.join(baseDir, 'temp_detect');
if (!fs.existsSync(tempDownloadDir)) {
    fs.mkdirSync(tempDownloadDir, { recursive: true });
}

const upload = multer({ dest: path.join(baseDir, 'uploads') });

// ==========================================
// 💡 FFmpeg 路径配置
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
async function checkM3U8(url, timeout = 30000) {
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
            text.includes('.ts') || 
            text.includes('.mp4') || 
            text.includes('#EXT-X-STREAM-INF')
        ) {
            return { valid: true, msg: '有效 M3U8 | 直播流格式' };
        }
        return { valid: false, msg: '非M3U8直播内容' };
    } catch (e) {
        return { valid: false, msg: e.message };
    } finally {
        clearTimeout(timer);
    }
}

// ============================
// 主播放列表分辨率解析（原基础文本解析保留作为辅助）
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

// ====================================================
// ⚡ 优化版：支持 4K/高码率直播源的下载探测
// ====================================================
async function getLiveStreamResolutionByDownload(streamUrl, timeoutMs = 20000) {
    const tempFileName = `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.ts`;
    const tempFilePath = path.join(tempDownloadDir, tempFileName);

    return new Promise((resolve) => {
        let isResolved = false;

        // 强行增加定时器保护
        const killTimer = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                console.log(`[超时拦截] 直播源下载探测超时: ${streamUrl}`);
                cleanup();
                resolve('未知 (拉流超时)');
            }
        }, timeoutMs);

        function cleanup() {
            try {
                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }
            } catch (e) {
                // 忽略删除失败
            }
        }

        console.log(`🎬 开始下载直播流进行 4K 兼容测试: ${streamUrl}`);

        // 调用 FFmpeg 录制
        ffmpeg(streamUrl)
            .inputOptions([
                '-rw_timeout 5000000',     // 开启协议层超时 (5秒)
                '-probesize 15000000',     // 💡 增大探测大小（提升至 15MB），确保容纳 4K 的大关键帧
                '-analyzeduration 5000000' // 💡 增大分析时间（提升至 5秒），给 4K 编码更多解析时间
            ])
            .outputOptions([
                '-t 4',            // 💡 严格限制下载时间延长至 4 秒（4K源需要稍长的数据流）
                '-c copy',         // 直接拷贝流，不重新编码
                '-map 0:v:0'       // 只保留第一个视频流
            ])
            .output(tempFilePath)
            .on('end', () => {
                // 下载成功后，利用 ffprobe 分析该本地临时文件
                ffmpeg.ffprobe(tempFilePath, (err, metadata) => {
                    clearTimeout(killTimer);
                    if (isResolved) return;
                    isResolved = true;

                    if (err || !metadata || !metadata.streams) {
                        console.log(`❌ 分析下载切片失败: ${streamUrl}`, err ? err.message : '');
                        cleanup();
                        return resolve('解析失败');
                    }

                    const stream = metadata.streams.find(s => s.codec_type === 'video');
                    cleanup();

                    if (!stream) {
                        return resolve('无视频流');
                    }
                    
                    const resStr = `${stream.width}x${stream.height}`;
                    console.log(`✅ 下载分析成功! 分辨率: ${resStr}`);
                    resolve(resStr);
                });
            })
            .on('error', (err) => {
                clearTimeout(killTimer);
                if (isResolved) return;
                isResolved = true;
                console.log(`❌ FFmpeg 下载流失败: ${err.message}`);
                cleanup();
                resolve('无法检测 (流无响应)');
            })
            .run();
    });
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
            
            // 1. 初步基础检测（判断基础网络可达性与头部）
            const validResult = await checkM3U8(item.url, timeout);
            let resolutions = ['未知'];
            let finalValid = validResult.valid;
            let finalMsg = validResult.msg;

            if (finalValid) {
                // 2. 获取嵌套或单分辨率标示
                resolutions = await getM3U8Resolution(item.url);
                
                // 如果开启了深度检测，或者常规检测为单分辨率/未知，则执行“下载2秒探测法”
                if (enableTSResolution || resolutions[0] === '单分辨率' || resolutions[0] === '未知') {
                    // 直接对该直播源进行 2 秒物理拉流测试
                    const realRes = await getLiveStreamResolutionByDownload(item.url, timeout + 5000);
                    
                    if (realRes.includes('失败') || realRes.includes('超时') || realRes.includes('无法检测')) {
                        // 如果连 2 秒的流都拿不下来，说明直播源实际上无法播放，修正状态为无效
                        finalValid = false;
                        finalMsg = `直播流拉取失败 (${realRes})`;
                        resolutions = ['未知'];
                    } else {
                        resolutions = [realRes];
                        finalMsg = '有效直播源 | 物理拉流成功';
                    }
                }
            }

            results[current] = {
                url: item.url,
                name: item.name,
                valid: finalValid,
                msg: finalMsg,
                resolutions
            };

            console.log(`[${current + 1}/${items.length}]`, item.url, finalValid ? '✅ 有效' : '❌ 无效', resolutions.join(','));
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
    const { links, concurrency = 3, timeout = 10000, enableTSResolution = true } = req.body; 
    // 💡 提示：因为要下载2秒流，建议前端传来的并发并发数（concurrency）不要设置太高，推荐 3-5 
    
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
    
    ensureFFmpeg().catch(err => console.error("FFmpeg 初始化崩溃:", err));
});
