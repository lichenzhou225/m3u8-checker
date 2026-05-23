// ==========================================
// server.js 超级优化版（1000+链接稳定版）
// 双阶段检测 + FFmpeg进程池 + TXT/M3U导入
// ==========================================

const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const https = require('https');
const unzipper = require('unzipper');
const PQueue = require('p-queue').default;

const app = express();
const PORT = 3000;

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

process.on('uncaughtException', err => {
    console.error('未捕获异常:', err);
});

process.on('unhandledRejection', err => {
    console.error('Promise异常:', err);
});

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({
    extended: true,
    limit: '100mb'
}));

// ==========================================
// 环境检测
// ==========================================

const isPkg = typeof process.pkg !== 'undefined';

const isElectron =
    process.versions &&
    process.versions.electron;

let baseDir = isPkg
    ? path.dirname(process.execPath)
    : (
        isElectron
            ? (
                require('electron').app.isPackaged
                    ? path.dirname(process.execPath)
                    : __dirname
            )
            : __dirname
    );

// ==========================================
// 目录初始化
// ==========================================

const publicPath = path.join(baseDir, 'public');

if (!fs.existsSync(publicPath)) {
    fs.mkdirSync(publicPath, {
        recursive: true
    });
}

const tempDownloadDir =
    path.join(baseDir, 'temp_detect');

if (!fs.existsSync(tempDownloadDir)) {
    fs.mkdirSync(tempDownloadDir, {
        recursive: true
    });
}

const uploadDir = path.join(baseDir, 'uploads');

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, {
        recursive: true
    });
}

const upload = multer({
    dest: uploadDir
});

// ==========================================
// 队列池
// ==========================================

// HTTP检测（高并发）
const validQueue = new PQueue({
    concurrency: 50
});

// FFmpeg检测（低并发）
const resolutionQueue = new PQueue({
    concurrency: 3
});

// ==========================================
// FFmpeg
// ==========================================

const ffmpegRoot = path.join(baseDir, 'bin');

const ffmpegExe =
    path.join(ffmpegRoot, 'ffmpeg.exe');

const ffprobeExe =
    path.join(ffmpegRoot, 'ffprobe.exe');

let ffmpegReady = false;

// ===============================
// 💡 直接探测直播流分辨率和编码
// ===============================
async function probeStreamDirect(url) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(url, (err, metadata) => {
            if (err || !metadata || !metadata.streams) return resolve(null);

            // 找到第一个视频流
            const video = metadata.streams.find(s => s.codec_type === 'video' && s.width && s.height);
            if (!video) return resolve(null);

            const codec = video.codec_name || 'unknown';

            // 返回分辨率和编码
            resolve(`${video.width}x${video.height} | ${codec.toUpperCase()}`);
        });
    });
}

async function ensureFFmpeg() {

    if (ffmpegReady) return;

    if (
        fs.existsSync(ffmpegExe) &&
        fs.existsSync(ffprobeExe)
    ) {

        ffmpeg.setFfmpegPath(ffmpegExe);
        ffmpeg.setFfprobePath(ffprobeExe);

        ffmpegReady = true;

        console.log('✅ 已挂载本地 FFmpeg');

        return;
    }

    console.log('⏳ 开始自动下载 FFmpeg...');

    if (!fs.existsSync(ffmpegRoot)) {
        fs.mkdirSync(ffmpegRoot, {
            recursive: true
        });
    }

    const zipPath =
        path.join(ffmpegRoot, 'ffmpeg.zip');

    await new Promise((resolve, reject) => {

        const file = fs.createWriteStream(zipPath);

        https.get(
            'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
            (res) => {

                if (
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location
                ) {

                    https.get(
                        res.headers.location,
                        response => response.pipe(file)
                    ).on('error', reject);

                } else {

                    res.pipe(file);

                }

                file.on('finish', () => {
                    file.close(resolve);
                });
            }
        ).on('error', reject);
    });

    console.log('📦 开始解压 FFmpeg...');

    await fs
        .createReadStream(zipPath)
        .pipe(
            unzipper.Extract({
                path: ffmpegRoot
            })
        )
        .promise();

    const dirs = fs.readdirSync(ffmpegRoot);

    let found = false;

    for (const d of dirs) {

        const fp =
            path.join(ffmpegRoot, d, 'bin', 'ffmpeg.exe');

        const pp =
            path.join(ffmpegRoot, d, 'bin', 'ffprobe.exe');

        if (
            fs.existsSync(fp) &&
            fs.existsSync(pp)
        ) {

            fs.copyFileSync(fp, ffmpegExe);
            fs.copyFileSync(pp, ffprobeExe);

            found = true;

            break;
        }
    }

    if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
    }

    if (!found) {
        throw new Error('FFmpeg 解压失败');
    }

    ffmpeg.setFfmpegPath(ffmpegExe);
    ffmpeg.setFfprobePath(ffprobeExe);

    ffmpegReady = true;

    console.log('🚀 FFmpeg 配置完成');
}

// ==========================================
// 快速有效性检测
// ==========================================

async function checkM3U8(url, timeout = 10000) {

    const controller = new AbortController();

    const timer = setTimeout(() => {
        controller.abort();
    }, timeout);

    try {

        const res = await fetch(url, {
            method: 'GET',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });

        if (!res.ok) {

            return {
                valid: false,
                msg: `HTTP ${res.status}`
            };
        }

        const text = await res.text();

        if (
            text.includes('#EXTM3U') ||
            text.includes('#EXTINF') ||
            text.includes('.ts') ||
            text.includes('.m4s') ||
            text.includes('.mp4') ||
            text.includes('#EXT-X-STREAM-INF')
        ) {

            return {
                valid: true,
                msg: '有效直播流',
                text
            };
        }

        return {
            valid: false,
            msg: '非直播流'
        };

    } catch (e) {

        return {
            valid: false,
            msg: e.name === 'AbortError'
                ? '连接超时'
                : e.message
        };

    } finally {

        clearTimeout(timer);

    }
}

// ==========================================
// FFmpeg真实探测
// ==========================================

function downloadAndProbe(
    streamUrl,
    duration,
    probeSize,
    analyzeDuration,
    timeoutMs
) {

    const tempFileName =
        `test_${Date.now()}_${Math.random()
            .toString(36)
            .substr(2, 5)}.ts`;

    const tempFilePath =
        path.join(tempDownloadDir, tempFileName);

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

            try {

                if (fs.existsSync(tempFilePath)) {
                    fs.unlinkSync(tempFilePath);
                }

            } catch (e) {}
        }

        ffmpeg(streamUrl)

            .inputOptions([
                '-rw_timeout 15000000',
                '-fflags nobuffer',
                '-user_agent Mozilla/5.0',
                '-reconnect 1',
                '-reconnect_streamed 1',
                '-reconnect_delay_max 5',
                `-probesize ${probeSize}`,
                `-analyzeduration ${analyzeDuration}`
            ])

            .outputOptions([
                `-t ${duration}`,
                '-c copy'
            ])

            .output(tempFilePath)

            .on('end', () => {

                ffmpeg.ffprobe(
                    tempFilePath,
                    (err, metadata) => {

                        clearTimeout(killTimer);

                        if (isResolved) return;

                        isResolved = true;

                        if (
                            err ||
                            !metadata ||
                            !metadata.streams
                        ) {

                            cleanup();

                            return resolve('FAILED');
                        }

                        const stream =
                            metadata.streams.find(
                                s => s.codec_type === 'video'
                            );

                        cleanup();

                        if (!stream) {
                            return resolve('NO_VIDEO');
                        }

                        resolve(
                            `${stream.width}x${stream.height}`
                        );
                    }
                );
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

// ==========================================
// 智能分辨率检测
// ==========================================

async function getLiveStreamResolutionSmart(streamUrl) {

    // =====================================
    // 第一阶段：ffprobe直接探测
    // =====================================

    const direct =
        await probeStreamDirect(streamUrl);

    if (direct) {

        console.log(
            '✅ ffprobe直接探测成功:',
            direct
        );

        return direct;
    }

    // =====================================
    // 第二阶段：快速拉流
    // =====================================

    let result = await downloadAndProbe(
        streamUrl,
        5,
        10000000,
        5000000,
        15000
    );

    if (
        result !== 'TIMEOUT' &&
        result !== 'FAILED' &&
        result !== 'NO_VIDEO'
    ) {

        console.log(
            '✅ 快速拉流成功:',
            result
        );

        return result;
    }

    // =====================================
    // 第三阶段：深度拉流
    // =====================================

    let result2 = await downloadAndProbe(
        streamUrl,
        10,
        30000000,
        10000000,
        30000
    );

    if (
        result2 !== 'TIMEOUT' &&
        result2 !== 'FAILED' &&
        result2 !== 'NO_VIDEO'
    ) {

        console.log(
            '✅ 深度拉流成功:',
            result2
        );

        return result2;
    }

    // =====================================
    // 最终失败
    // =====================================

    if (result2 === 'TIMEOUT') {

        return '未知 (拉流超时)';
    }

    return '无法检测 (无视频流)';
}
// ==========================================
// 上传 TXT / M3U
// ==========================================

app.post(
    '/upload',
    upload.single('file'),
    async (req, res) => {

        try {

            if (!req.file) {

                return res.json({
                    error: '未上传文件'
                });
            }

            const text = fs.readFileSync(
                req.file.path,
                'utf-8'
            );

            fs.unlinkSync(req.file.path);

            const lines =
                text.split(/\r?\n/);

            const results = [];

            let currentName = '';

            for (let i = 0; i < lines.length; i++) {

                const line =
                    lines[i].trim();

                if (!line) continue;

                // M3U频道名
                if (line.startsWith('#EXTINF')) {

                    const idx =
                        line.indexOf(',');

                    currentName =
                        idx !== -1
                            ? line.slice(idx + 1).trim()
                            : '未命名频道';

                    continue;
                }

                // 跳过注释
                if (line.startsWith('#')) {
                    continue;
                }

                // URL
                if (/^https?:\/\//i.test(line)) {

                    if (currentName) {

                        results.push(
                            `${currentName},${line}`
                        );

                    } else {

                        results.push(line);

                    }

                    currentName = '';
                }
            }

            // 自动去重
            const unique =
                [...new Set(results)];

            res.json({
                success: true,
                count: unique.length,
                links: unique
            });

        } catch (e) {

            res.json({
                error: e.message
            });

        }
    }
);

// ==========================================
// 第一阶段：快速有效性检测
// ==========================================

app.post('/check-valid', async (req, res) => {

    const {
        item,
        timeout = 10000
    } = req.body;

    if (!item || !item.url) {

        return res.json({
            error: '无效条目'
        });
    }

    try {

        const result =
            await validQueue.add(() =>
                checkM3U8(
                    item.url,
                    timeout
                )
            );

        res.json({
            url: item.url,
            name: item.name,
            valid: result.valid,
            msg: result.msg
        });

    } catch (e) {

        res.json({
            url: item.url,
            name: item.name,
            valid: false,
            msg: e.message
        });

    }
});

// ==========================================
// 第二阶段：分辨率检测
// ==========================================

app.post('/check-resolution', async (req, res) => {

    const { item } = req.body;

    if (!item || !item.url) {

        return res.json({
            error: '无效条目'
        });
    }

    try {

        const result =
            await resolutionQueue.add(async () => {

                // 再次解析m3u8内部分辨率
                const validResult =
                    await checkM3U8(
                        item.url,
                        8000
                    );

                const regex =
                    /RESOLUTION=(\d+x\d+)/g;

                let m;

                let list = [];

                while (
                    validResult.text &&
                    (m = regex.exec(validResult.text)) !== null
                ) {
                    list.push(m[1]);
                }

                // m3u8内部已有分辨率
                if (list.length > 0) {

                    return {
                        resolutions:
                            [...new Set(list)],
                        msg: '有效多码率源'
                    };
                }

                // ffmpeg真实探测
                const realRes =
                    await getLiveStreamResolutionSmart(
                        item.url
                    );

                if (
                    realRes.includes('超时') ||
                    realRes.includes('异常')
                ) {

                    return {
                        resolutions: ['未知'],
                        msg: realRes
                    };
                }

                return {
                    resolutions: [realRes],
                    msg: '真实拉流成功'
                };
            });

        res.json({
            url: item.url,
            name: item.name,
            valid: true,
            resolutions: result.resolutions,
            msg: result.msg
        });

    } catch (e) {

        res.json({
            url: item.url,
            name: item.name,
            valid: false,
            resolutions: ['未知'],
            msg: e.message
        });

    }
});

// ==========================================
// 保存分类报告
// ==========================================

app.post('/save-report', async (req, res) => {

    const { results } = req.body;

    if (!results || !results.length) {

        return res.json({
            error: '无有效数据'
        });
    }

    try {

        const reportPath =
            path.join(
                baseDir,
                '最新检测报告.txt'
            );

        const timeStr =
            new Date().toLocaleString();

        const classified = {};

        results.forEach((r) => {

            const resKey =
                r.resolutions.join('/')
                || '未知';

            if (!classified[resKey]) {
                classified[resKey] = [];
            }

            classified[resKey].push(r);
        });

        const sortedKeys =
            Object.keys(classified).sort((a, b) => {

                if (a === '未知') return 1;

                if (b === '未知') return -1;

                return (
                    parseInt(b.split('x')[0]) || 0
                ) - (
                    parseInt(a.split('x')[0]) || 0
                );
            });

        let content = '';

        content +=
            '==================================================\n';

        content +=
            '📊 IPTV直播源检测报告\n';

        content +=
            `生成时间: ${timeStr}\n`;

        content +=
            `总检测数: ${results.length}\n`;

        content +=
            '==================================================\n\n';

        sortedKeys.forEach((resGroup) => {

            const list =
                classified[resGroup];

            content +=
                '==================================================\n';

            content +=
                `📂 分辨率分类：【${resGroup}】 (共 ${list.length} 个)\n`;

            content +=
                '==================================================\n';

            list.forEach((r) => {

                if (r.valid) {

                    content +=
                        `${r.name},${r.url}\n`;

                } else {

                    content +=
                        `${r.name},${r.url} ---- [❌无效: ${r.msg}]\n`;

                }
            });

            content += '\n';
        });

        fs.writeFileSync(
            reportPath,
            content,
            'utf-8'
        );

        console.log(
            `💾 报告已保存: ${reportPath}`
        );

        res.json({
            success: true,
            path: reportPath
        });

    } catch (e) {

        res.json({
            error: e.message
        });

    }
});

// ==========================================
// 首页
// ==========================================

app.get('/', (req, res) => {

    res.sendFile(
        path.join(publicPath, 'index.html')
    );
});

// ==========================================
// 启动服务
// ==========================================

app.listen(PORT, () => {

    console.log(`
====================================
🌐 访问地址:
http://localhost:${PORT}
====================================
`);

    // ==========================================
    // 前端页面
    // ==========================================

    const htmlContent = `
<!DOCTYPE html>
<html>

<head>
<meta charset="utf-8">

<title>直播源检测系统</title>

<style>

body{
    font-family:system-ui;
    background:#f4f6f9;
    margin:0;
    padding:20px;
}

.container{
    max-width:85%;
    margin:auto;
    background:white;
    padding:25px;
    border-radius:10px;
    box-shadow:0 4px 10px rgba(0,0,0,0.1);
}

textarea{
    width:100%;
    height:150px;
    padding:10px;
    font-family:monospace;
}

.controls{
    display:flex;
    gap:10px;
    margin-top:15px;
    align-items:center;
}

button{
    padding:10px 18px;
    border:none;
    border-radius:5px;
    cursor:pointer;
    font-weight:bold;
}

.btn-start{
    background:#3498db;
    color:white;
}

.btn-import{
    background:#2ecc71;
    color:white;
}

.progress{
    flex:1;
}

.progress-bg{
    width:100%;
    height:12px;
    background:#ddd;
    border-radius:6px;
    overflow:hidden;
}

.progress-fill{
    width:0%;
    height:100%;
    background:#3498db;
}

table{
    width:100%;
    border-collapse:collapse;
    margin-top:20px;
}

th,td{
    border:1px solid #eee;
    padding:8px;
    font-size:14px;
}

th{
    background:#f8f8f8;
}

.table-wrap{
    max-height:600px;
    overflow:auto;
}

.success{
    color:#00a389;
    font-weight:bold;
}

.fail{
    color:#e74c3c;
    font-weight:bold;
}

.wait{
    color:#e67e22;
    font-weight:bold;
}

</style>

</head>

<body>

<div class="container">

<h2>📺 IPTV直播源检测系统（1000+稳定版）</h2>

<textarea
id="linksInput"
placeholder="名称,链接"
></textarea>

<div class="controls">

<button
class="btn-start"
onclick="startCheckQueue()"
id="startBtn"
>
开始检测
</button>

<input
type="file"
id="fileInput"
accept=".txt,.m3u,.m3u8"
hidden
>

<button
class="btn-import"
onclick="document.getElementById('fileInput').click()"
>
📂 导入TXT/M3U
</button>

<div class="progress">

<div id="statusText">
准备就绪
</div>

<div class="progress-bg">
<div
id="progressBar"
class="progress-fill"
></div>
</div>

</div>

</div>

<div class="table-wrap">

<table>

<thead>

<tr>
<th>#</th>
<th>频道</th>
<th>地址</th>
<th>状态</th>
<th>分辨率</th>
</tr>

</thead>

<tbody id="resultBody"></tbody>

</table>

</div>

</div>

<script>

let globalResults = [];

document
.getElementById('fileInput')
.addEventListener('change', async (e) => {

    const file = e.target.files[0];

    if (!file) return;

    const formData = new FormData();

    formData.append('file', file);

    const res = await fetch('/upload', {
        method: 'POST',
        body: formData
    });

    const data = await res.json();

    if (data.error) {

        alert(data.error);

        return;
    }

    document
    .getElementById('linksInput')
    .value = data.links.join('\\n');

    alert(
        '成功导入 ' + data.count + ' 条直播源'
    );
});

async function startCheckQueue() {

    const rawText =
        document
        .getElementById('linksInput')
        .value
        .trim();

    if (!rawText) {

        alert('请输入直播源');

        return;
    }

    const rawLines =
        rawText
        .split(/\\r?\\n/)
        .map(l => l.trim())
        .filter(Boolean);

    // 自动去重
    const uniqueLines =
        [...new Set(rawLines)];

    const items =
        uniqueLines.map((line, index) => {

            if (line.includes(',')) {

                const idx = line.indexOf(',');

                return {
                    name:
                        line.slice(0, idx).trim(),
                    url:
                        line.slice(idx + 1).trim()
                };
            }

            return {
                name: '未命名_' + (index + 1),
                url: line
            };
        });

    document
    .getElementById('resultBody')
    .innerHTML = '';

    document
    .getElementById('startBtn')
    .disabled = true;

    globalResults = [];

    // ==========================================
    // 初始化表格
    // ==========================================

    items.forEach((item, index) => {

        const tr =
            document.createElement('tr');

        tr.id = 'row-' + index;

        tr.innerHTML = \`
        <td>\${index + 1}</td>
        <td>\${item.name}</td>
        <td style="word-break:break-all;">
            \${item.url}
        </td>
        <td class="status wait">
            等待检测
        </td>
        <td class="res">
            -
        </td>
        \`;

        document
        .getElementById('resultBody')
        .appendChild(tr);
    });

    // ==========================================
    // 第一阶段：有效性检测
    // ==========================================

    document
    .getElementById('statusText')
    .innerText =
        '阶段1：正在检测链接有效性...';

    let finished1 = 0;

    const validItems = [];

    const VALID_CONCURRENCY = 50;

    let index1 = 0;

    async function worker1() {

        while (index1 < items.length) {

            const current =
                index1++;

            const item =
                items[current];

            const row =
                document.getElementById(
                    'row-' + current
                );

            row.querySelector('.status')
            .innerHTML =
                '⏳ 有效性检测中';

            try {

                const res = await fetch(
                    '/check-valid',
                    {
                        method:'POST',

                        headers:{
                            'Content-Type':
                            'application/json'
                        },

                        body: JSON.stringify({
                            item
                        })
                    }
                );

                const data =
                    await res.json();

                if (data.valid) {

                    validItems.push({
                        ...item,
                        rowIndex: current
                    });

                    row.querySelector('.status')
                    .innerHTML =
                        '<span class="success">有效</span>';

                } else {

                    row.querySelector('.status')
                    .innerHTML =
                        '<span class="fail">无效</span>';

                    row.querySelector('.res')
                    .innerText =
                        data.msg;

                    globalResults.push({
                        ...data,
                        resolutions:['未知']
                    });
                }

            } catch (e) {

                row.querySelector('.status')
                .innerHTML =
                    '<span class="fail">异常</span>';

            } finally {

                finished1++;

                const percent =
                    Math.round(
                        finished1 /
                        items.length * 50
                    );

                document
                .getElementById('progressBar')
                .style.width =
                    percent + '%';

                document
                .getElementById('statusText')
                .innerText =
                    \`阶段1:
                    \${finished1}/\${items.length}\`;
            }
        }
    }

    const workers1 =
        Array(
            Math.min(
                VALID_CONCURRENCY,
                items.length
            )
        )
        .fill(null)
        .map(() => worker1());

    await Promise.all(workers1);

    // ==========================================
    // 第二阶段：分辨率检测
    // ==========================================

    document
    .getElementById('statusText')
    .innerText =
        '阶段2：正在检测分辨率...';

    let finished2 = 0;

    const RES_CONCURRENCY = 3;

    let index2 = 0;

    async function worker2() {

        while (index2 < validItems.length) {

            const current =
                index2++;

            const item =
                validItems[current];

            const row =
                document.getElementById(
                    'row-' + item.rowIndex
                );

            row.querySelector('.status')
            .innerHTML =
                '🎬 拉流检测中';

            try {

                const res = await fetch(
                    '/check-resolution',
                    {
                        method:'POST',

                        headers:{
                            'Content-Type':
                            'application/json'
                        },

                        body: JSON.stringify({
                            item
                        })
                    }
                );

                const data =
                    await res.json();

                row.querySelector('.status')
                .innerHTML =
                    '<span class="success">完成</span>';

                row.querySelector('.res')
                .innerText =
                    data.resolutions.join('/');

                globalResults.push(data);

            } catch (e) {

                row.querySelector('.status')
                .innerHTML =
                    '<span class="fail">失败</span>';

            } finally {

                finished2++;

                const percent =
                    50 + Math.round(
                        finished2 /
                        validItems.length * 50
                    );

                document
                .getElementById('progressBar')
                .style.width =
                    percent + '%';

                document
                .getElementById('statusText')
                .innerText =
                    \`阶段2:
                    \${finished2}/\${validItems.length}\`;
            }
        }
    }

    const workers2 =
        Array(
            Math.min(
                RES_CONCURRENCY,
                validItems.length
            )
        )
        .fill(null)
        .map(() => worker2());

    await Promise.all(workers2);

    // ==========================================
    // 保存报告
    // ==========================================

    document
    .getElementById('statusText')
    .innerText =
        '正在生成报告...';

    await fetch('/save-report', {

        method:'POST',

        headers:{
            'Content-Type':'application/json'
        },

        body: JSON.stringify({
            results: globalResults
        })
    });

    document
    .getElementById('statusText')
    .innerText =
        '🎉 全部完成';

    document
    .getElementById('startBtn')
    .disabled = false;

    alert(
        '检测完成！\\n\\n' +
        '报告已保存到 EXE 目录。'
    );
}

</script>

</body>
</html>
`;

    fs.writeFileSync(
        path.join(publicPath, 'index.html'),
        htmlContent,
        'utf-8'
    );

    // 自动打开浏览器
    try {

        const {
            exec
        } = require('child_process');

        if (process.platform === 'win32') {

            exec(
                `start http://localhost:${PORT}`
            );
        }

    } catch (e) {

        console.error(e.message);

    }

    ensureFFmpeg().catch(err => {
        console.error(
            'FFmpeg初始化失败:',
            err
        );
    });
});
