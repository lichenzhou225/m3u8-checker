// ==========================================
// server.js 完美兼容打包版（报告合流+前端修复版）
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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

process.on('uncaughtException', err => console.error('未捕获异常:', err));
process.on('unhandledRejection', err => console.error('Promise异常:', err));

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// 环境判断
const isPkg = typeof process.pkg !== 'undefined';
const isElectron = process.versions && process.versions.electron;
let baseDir = isPkg ? path.dirname(process.execPath) : (isElectron ? (require('electron').app.isPackaged ? path.dirname(process.execPath) : __dirname) : __dirname);

// 目录初始化
const publicPath = path.join(baseDir, 'public');
if (!fs.existsSync(publicPath)) fs.mkdirSync(publicPath, { recursive: true });

const tempDownloadDir = path.join(baseDir, 'temp_detect');
if (!fs.existsSync(tempDownloadDir)) fs.mkdirSync(tempDownloadDir, { recursive: true });

// 💡 优化：结果直接放在 EXE 同级目录下，不再单独建夹，方便查找
const upload = multer({ dest: path.join(baseDir, 'uploads') });

// FFmpeg 路径
const ffmpegRoot = path.join(baseDir, 'bin');
const ffmpegExe = path.join(ffmpegRoot, 'ffmpeg.exe');
const ffprobeExe = path.join(ffmpegRoot, 'ffprobe.exe');
let ffmpegReady = false;

async function ensureFFmpeg() {
    if (ffmpegReady) return;
    if (fs.existsSync(ffmpegExe) && fs.existsSync(ffprobeExe)) {
        ffmpeg.setFfmpegPath(ffmpegExe);
        ffmpeg.setFfprobePath(ffprobeExe);
        ffmpegReady = true;
        console.log('✅ 已成功挂载本地 FFmpeg');
        return;
    }
    console.log('⏳ 开始自动下载 FFmpeg...');
    if (!fs.existsSync(ffmpegRoot)) fs.mkdirSync(ffmpegRoot, { recursive: true });
    const zipPath = path.join(ffmpegRoot, 'ffmpeg.zip');
    await new Promise((resolve, reject) => {
        const file = fs.createWriteStream(zipPath);
        https.get('https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip', (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                https.get(res.headers.location, response => response.pipe(file)).on('error', reject);
            } else { res.pipe(file); }
            file.on('finish', () => file.close(resolve));
        }).on('error', reject);
    });
    console.log('📦 开始解压 FFmpeg...');
    await fs.createReadStream(zipPath).pipe(unzipper.Extract({ path: ffmpegRoot })).promise();
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
    if (!found) throw new Error('FFmpeg 解压失败');
    ffmpeg.setFfmpegPath(ffmpegExe);
    ffmpeg.setFfprobePath(ffprobeExe);
    ffmpegReady = true;
    console.log('🚀 FFmpeg 配置就绪！');
}

// 基础 M3U8 校验
async function checkM3U8(url, timeout = 10000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { method: 'GET', signal: controller.signal });
        if (!res.ok) return { valid: false, msg: `HTTP ${res.status}` };
        const text = await res.text();
        if (text.includes('#EXTM3U') || text.includes('#EXTINF') || text.includes('.ts') || text.includes('.mp4') || text.includes('#EXT-X-STREAM-INF')) {
            return { valid: true, msg: '有效直播流格式', text };
        }
        return { valid: false, msg: '非直播内容' };
    } catch (e) {
        return { valid: false, msg: e.name === 'AbortError' ? '连接超时' : e.message };
    } finally { clearTimeout(timer); }
}

// 底层拉流核心
function downloadAndProbe(streamUrl, duration, probeSize, analyzeDuration, timeoutMs) {
    const tempFileName = `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}.ts`;
    const tempFilePath = path.join(tempDownloadDir, tempFileName);

    return new Promise((resolve) => {
        let isResolved = false;
        const killTimer = setTimeout(() => {
            if (!isResolved) {
                isResolved = true;
                cleanup();
                resolve('TIMEOUT');
            }
        }, timeoutMs);

        function cleanup() {
            try { if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath); } catch (e) {}
        }

        ffmpeg(streamUrl)
            .inputOptions([
                '-rw_timeout 4000000', 
                `-probesize ${probeSize}`, 
                `-analyzeduration ${analyzeDuration}`
            ])
            .outputOptions([
                `-t ${duration}`, 
                '-c copy', 
                '-map 0:v:0'
            ])
            .output(tempFilePath)
            .on('end', () => {
                ffmpeg.ffprobe(tempFilePath, (err, metadata) => {
                    clearTimeout(killTimer);
                    if (isResolved) return;
                    isResolved = true;
                    if (err || !metadata || !metadata.streams) {
                        cleanup();
                        return resolve('FAILED');
                    }
                    const stream = metadata.streams.find(s => s.codec_type === 'video');
                    cleanup();
                    if (!stream) return resolve('NO_VIDEO');
                    resolve(`${stream.width}x${stream.height}`);
                });
            })
            .on('error', () => {
                clearTimeout(killTimer);
                if (isResolved) return;
                isResolved = true;
                cleanup();
                resolve('FAILED');
            })
            .run();
    });
}

// 智能双阶段探测
async function getLiveStreamResolutionSmart(streamUrl) {
    // 阶段 1：快速下载 2 秒
    let result = await downloadAndProbe(streamUrl, 2, 5000000, 2000000, 9000);
    if (result !== 'TIMEOUT' && result !== 'FAILED' && result !== 'NO_VIDEO') return result; 

    // 阶段 2：启动 4K 增强探测
    let result2 = await downloadAndProbe(streamUrl, 4, 15000000, 5000000, 16000);
    if (result2 === 'TIMEOUT') return '未知 (拉流超时)';
    if (result2 === 'FAILED' || result2 === 'NO_VIDEO') return '无法检测 (流异常)';
    return result2;
}

// 批量处理器
async function checkBatch(items, concurrency, timeout) {
    const results = [];
    let index = 0;

    async function worker() {
        while (index < items.length) {
            const current = index++;
            const item = items[current];
            
            const validResult = await checkM3U8(item.url, timeout);
            let resolutions = ['未知'];
            let finalValid = validResult.valid;
            let finalMsg = validResult.msg;

            if (finalValid) {
                const regex = /RESOLUTION=(\d+x\d+)/g;
                let m, list = [];
                while (validResult.text && (m = regex.exec(validResult.text)) !== null) { list.push(m[1]); }
                
                if (list.length > 0) {
                    resolutions = [...new Set(list)];
                    finalMsg = '有效多码率源';
                } else {
                    const realRes = await getLiveStreamResolutionSmart(item.url);
                    if (realRes.includes('超时') || realRes.includes('异常')) {
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
                name: item.name || `未命名_${current+1}`,
                valid: finalValid,
                msg: finalMsg,
                resolutions
            };
            console.log(`[${current + 1}/${items.length}]`, item.url, finalValid ? '✅' : '❌', resolutions.join(','));
        }
    }

    const workers = Array(Math.min(concurrency, items.length)).fill(null).map(() => worker());
    await Promise.all(workers);
    return results;
}

// API 路由
app.post('/check', async (req, res) => {
    const { links, concurrency = 3, timeout = 10000 } = req.body;
    if (!links || !links.length) return res.json({ error: '没有链接' });

    const items = links.map(line => {
        if (line.includes(',')) {
            const idx = line.indexOf(',');
            return { name: line.slice(0, idx).trim(), url: line.slice(idx + 1).trim() };
        }
        return { name: null, url: line.trim() };
    });

    const results = await checkBatch(items, concurrency, timeout);

    // 💡 优化：每次检测覆盖生成单一文件，不再留下一堆历史文件
    try {
        const reportPath = path.join(baseDir, `最新检测报告.txt`);
        const timeStr = new Date().toLocaleString();
        
        let content = `===== 检测报告 (生成时间: ${timeStr} | 共 ${results.length} 个) =====\n\n`;
        results.forEach((r, i) => {
            content += `[${i+1}] ${r.name},${r.url}\n状态: ${r.valid ? '有效':'无效'} | 原因: ${r.msg} | 分辨率: ${r.resolutions.join('/')}\n\n`;
        });
        
        fs.writeFileSync(reportPath, content, 'utf-8');
        console.log(`💾 报告已自动刷新至: ${reportPath}`);
    } catch (e) {
        console.error('保存报告失败:', e.message);
    }

    res.json({ results, done: true });
});

app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) return res.json({ error: '未上传文件' });
    const text = fs.readFileSync(req.file.path, 'utf-8');
    fs.unlinkSync(req.file.path);
    req.body.links = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    app._router.handle(req, res, () => {});
});

app.get('/', (req, res) => {
    res.sendFile(path.join(publicPath, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`====================================\n 🌐 访问地址: http://localhost:${PORT}\n====================================`);
    
    // 💡 修复：前端核心 bug（换行符处理逻辑）
    const htmlContent = `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>直播源分辨率批量检测</title>
    <style>
        body { font-family: system-ui, sans-serif; background: #f4f6f9; margin: 0; padding: 20px; color: #333; }
        .container { max-width: 1000px; margin: 0 auto; background: white; padding: 25px; border-radius: 8px; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
        h2 { margin-top: 0; color: #2c3e50; border-bottom: 2px solid #eee; padding-bottom: 10px; }
        textarea { width: 100%; height: 150px; padding: 10px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; font-family: monospace; font-size: 13px; }
        .controls { margin: 15px 0; display: flex; gap: 15px; align-items: center; }
        button { padding: 10px 20px; font-weight: bold; border: none; border-radius: 4px; cursor: pointer; transition: 0.2s; }
        .btn-start { background: #3498db; color: white; }
        .btn-start:hover { background: #2980b9; }
        .btn-download { background: #2ecc71; color: white; display: none; }
        .btn-download:hover { background: #27ae60; }
        .status { font-weight: bold; color: #7f8c8d; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 14px; }
        th, td { border: 1px solid #edf2f7; padding: 10px; text-align: left; }
        th { background: #f7fafc; color: #4a5568; }
        .badge-success { background: #e6fffa; color: #00a389; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight:bold;}
        .badge-danger { background: #fff5f5; color: #e53e3e; padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight:bold;}
    </style>
</head>
<body>
    <div class="container">
        <h2>📺 直播源有效性及 4K 分辨率批量检测系统</h2>
        <p style="font-size:13px; color:#666;">请输入直播源（格式：名称,链接 或 直接输入链接，每行一个）：</p>
        <textarea id="linksInput" placeholder="CCTV1,http://xxx/live.m3u8&#10;http://xxx/live2.m3u8"></textarea>
        
        <div class="controls">
            <button class="btn-start" onclick="startCheck()">开始批量检测</button>
            <button id="downloadBtn" class="btn-download" onclick="downloadResult()">📥 导出结果为 TXT 文件</button>
            <span id="statusText" class="status">未开始</span>
        </div>

        <table id="resultTable">
            <thead>
                <tr>
                    <th style="width: 5%;">#</th>
                    <th style="width: 20%;">频道名称</th>
                    <th style="width: 40%;">直播源地址</th>
                    <th style="width: 20%;">检测状态</th>
                    <th style="width: 15%;">分辨率</th>
                </tr>
            </thead>
            <tbody id="resultBody"></tbody>
        </table>
    </div>

    <script>
        let currentResults = [];

        async function startCheck() {
            const rawText = document.getElementById('linksInput').value.trim();
            if(!rawText) return alert('请输入链接！');
            
            // 💡 彻底修复换行拆分 Bug
            const links = rawText.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
            
            document.getElementById('resultBody').innerHTML = '';
            document.getElementById('downloadBtn').style.display = 'none';
            const statusText = document.getElementById('statusText');
            statusText.innerText = '正在初始化并将任务加入队列中，请稍候...';
            currentResults = [];

            try {
                const res = await fetch('/check', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ links, concurrency: 3, timeout: 10000 })
                });
                const data = await res.json();
                if(data.error) return alert(data.error);

                currentResults = data.results;
                statusText.innerText = '检测完成！共 ' + currentResults.length + ' 个链接。';
                document.getElementById('downloadBtn').style.display = 'inline-block';

                currentResults.forEach((r, idx) => {
                    const tr = document.createElement('tr');
                    tr.innerHTML = '<td>' + (idx + 1) + '</td>' +
                        '<td>' + (r.name || '未命名') + '</td>' +
                        '<td style="word-break:break-all; font-size:12px; color:#666;">' + r.url + '</td>' +
                        '<td>' + (r.valid ? '<span class="badge-success">有效</span>' : '<span class="badge-danger">无效 ('+r.msg+')</span>') + '</td>' +
                        '<td style="font-weight:bold; color:#2c3e50;">' + r.resolutions.join('/') + '</td>';
                    document.getElementById('resultBody').appendChild(tr);
                });
                
                alert('检测完成！结果已更新到 EXE 目录下的【最新检测报告.txt】中！');
            } catch(e) {
                statusText.innerText = '检测发生异常。';
                alert('检测出错：' + e.message);
            }
        }

        function downloadResult() {
            if(!currentResults.length) return;
            let text = "===== 直播源检测结果 =====\\n\\n";
            currentResults.forEach((r, i) => {
                text += "[" + (i+1) + "] " + r.name + "," + r.url + "\\n状态: " + (r.valid ? '有效':'无效') + " | 原因: " + r.msg + " | 分辨率: " + r.resolutions.join('/') + "\\n\\n";
            });
            
            const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = "网页导出_直播源报告_" + new Date().getTime() + ".txt";
            a.click();
        }
    </script>
</body>
</html>`;
    
    // 💡 强制每次启动都刷新最新的 index.html 代码
    fs.writeFileSync(path.join(publicPath, 'index.html'), htmlContent, 'utf-8');
    ensureFFmpeg().catch(err => console.error("FFmpeg 初始化崩溃:", err));
});
