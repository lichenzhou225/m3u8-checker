const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg'); // 这里已经定义了一次 ffmpeg

// --- 兼容 Electron 打包的路径处理 ---
let binPath;

try {
    // 注意：这里的 app 是 electron 的 app，为了不和 express 的 app 冲突，起个别名
    const { app: electronApp } = require('electron'); 
    
    if (electronApp) {
        const isPackaged = electronApp.isPackaged;
        binPath = isPackaged 
            ? path.join(process.resourcesPath, 'bin') 
            : path.join(__dirname, 'bin');
    } else {
        binPath = path.join(__dirname, 'bin');
    }
} catch (e) {
    // 如果没有 electron 模块，走普通路径
    binPath = path.join(__dirname, 'bin');
}

// 设置 FFmpeg 路径（直接使用上面 require 好的 ffmpeg 变量）
const ffmpegExe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeExe = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

ffmpeg.setFfmpegPath(path.join(binPath, ffmpegExe));
ffmpeg.setFfprobePath(path.join(binPath, ffprobeExe));

// --- 初始化 Express ---
const app = express(); // 这里的 app 是 express 实例
const PORT = 3000;
const MAX_CONCURRENCY = 5;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 这里的目录建议改成当前目录或者指定目录，确保生成的 txt 能被下载
app.use(express.static(__dirname)); 
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: 'uploads/' });

// 后续接你的 API 逻辑（/check, /export 等）...

// ==================== 新的检测与解析核心（已替换） ====================

// 使用 ffprobe 直接分析 M3U8 链接分辨率
async function getResolutionViaFFprobe(url, retries = 2) {
    for (let i = 0; i <= retries; i++) {
        try {
            const res = await new Promise(resolve => {
                ffmpeg(url)
                    .inputOptions([
                        '-analyzeduration', '3000000', // 限制分析流的时间为 3 秒
                        '-probesize', '3000000',       // 限制探测大小为 3MB
                        '-timeout', '5000000'          // 网络超时 5 秒 (单位微秒)
                    ])
                    .ffprobe((err, metadata) => {
                        if (err) {
                            console.error(`ffprobe 错误 [尝试 ${i+1}]:`, err.message);
                            return resolve('未知');
                        }
                        const stream = metadata.streams.find(s => s.codec_type === 'video');
                        resolve(stream ? `${stream.width}x${stream.height}` : '未知');
                    });
            });
            if (res !== '未知') {
                return res;
            }
        } catch (e) {
            console.error(`ffprobe 异常 [尝试 ${i+1}]:`, e.message);
        }
        if (i < retries) await new Promise(r => setTimeout(r, 400));
    }
    return '未知';
}

// 一体化批量检测函数
async function checkBatch(items, concurrency = MAX_CONCURRENCY, timeout = 8000, enableTSResolution=false, progressCallback=null){
    const results = [];
    let index = 0;

    async function worker(){
        while(index < items.length){
            const i = index++;
            const item = items[i];
            
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            
            let validResult = { valid: false, msg: '未检测到特征' };
            let resolutions = ['未知'];
            
            try {
                // 只执行一次 Fetch 请求，并跟随重定向
                const res = await fetch(item.url, { method: 'GET', redirect: 'follow', signal: controller.signal });
                clearTimeout(timer);
                
                const finalUrl = res.url; // 关键：获取重定向后的最终真实 URL
                
                if (!res.ok) {
                    validResult = { valid: false, msg: `HTTP ${res.status}` };
                } else {
                    const ct = (res.headers.get('content-type') || '').toLowerCase();
                    const text = await res.text();
                    const sample = text.slice(0, 4096).toLowerCase();
                    
                    // 综合特征验证是否为有效 M3U8
                    const isValidM3U8 = ct.includes('mpegurl') || ct.includes('m3u') || ct.includes('video') || 
                                        item.url.toLowerCase().includes('.m3u8') || finalUrl.toLowerCase().includes('.m3u8') ||
                                        sample.includes('#extm3u') || sample.includes('#extinf') || sample.includes('#ext-x-stream-inf');
                    
                    if (isValidM3U8) {
                        validResult = { valid: true, msg: '有效 M3U8' };
                        
                        // 1. 尝试从文本中正则匹配分辨率（针对多分辨率主播放列表）
                        const regex = /RESOLUTION=(\d+x\d+)/g;
                        const resList = [];
                        let match;
                        while(match = regex.exec(text)){
                            resList.push(match[1]);
                        }
                        
                        if(resList.length > 0) {
                            resolutions = Array.from(new Set(resList));
                            validResult.msg += ` | 主播放列表`;
                        } else if(text.includes('#EXTINF') || sample.includes('.ts') || sample.includes('#ext-x-targetduration')) {
                            // 2. 单分辨率媒体列表
                            resolutions = ['单分辨率'];
                            validResult.msg += ` | 媒体列表`;
                            
                            // 如果开启了精确检测，直接把最终的 M3U8 丢给 ffprobe 解析
                            if (enableTSResolution) {
                                const realRes = await getResolutionViaFFprobe(finalUrl, 2);
                                resolutions = [realRes];
                            }
                        }
                    }
                }
            } catch (err) {
                clearTimeout(timer);
                const msg = err.name === 'AbortError' ? '请求超时' : err.message;
                validResult = { valid: false, msg };
            }

            results[i] = { url: item.url, name: item.name, ...validResult, resolutions };
            if(progressCallback) progressCallback(i+1, items.length, results[i]);
            console.log(`[${i+1}/${items.length}] ${item.name||''} -> ${validResult.valid?'有效':'无效'} | ${resolutions.join(',')}`);
        }
    }

    const workers = [];
    for(let i=0;i<Math.min(concurrency, items.length);i++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

// =====================================================================

// ---------- 原有 API 保持不变 ----------
app.post('/check', async (req,res)=>{
    const { links, concurrency, timeout, enableTSResolution=false } = req.body;
    if(!links || !links.length) return res.status(400).json({ error:'请提供链接' });
    const items = links.map(line=>{
        if(line.includes(',')){
            const [name,url] = line.split(',');
            return { name:name.trim(), url:url.trim() };
        }
        return { name:null, url:line };
    });
    const results = await checkBatch(items, concurrency||5, timeout||8000, enableTSResolution);
    res.json({ results, done:true });
});

app.post('/upload', upload.single('file'), async (req,res)=>{
    if(!req.file) return res.status(400).json({ error:'未上传文件' });
    const { concurrency, timeout, enableTSResolution=false } = req.body;
    const content = fs.readFileSync(req.file.path,'utf-8');
    fs.unlinkSync(req.file.path);
    const lines = content.split(/\r?\n/).map(l=>l.trim()).filter(l=>l);
    const items = lines.map(line=>{
        if(line.includes(',')){
            const [name,url] = line.split(',');
            return { name:name.trim(), url:url.trim() };
        }
        return { name:null, url:line };
    });
    const results = await checkBatch(items, concurrency||5, timeout||8000, enableTSResolution);
    res.json({ results, done:true });
});

app.post('/export', (req, res) => {
    const { results } = req.body;
    if (!results || !results.length) return res.status(400).json({ error: '无有效数据' });

    // 1. 按分辨率分组数据
    const resMap = {};
    results.filter(r => r.valid).forEach(r => {
        r.resolutions.forEach(reso => {
            if (!resMap[reso]) resMap[reso] = [];
            resMap[reso].push(r);
        });
    });

    const timestamp = Date.now();
    
    // 2. 生成合并分类后的 TXT 内容
    let combinedTxt = "";
    Object.keys(resMap).sort().forEach(reso => {
        combinedTxt += `\n# --- 分辨率: ${reso} ---\n`;
        resMap[reso].forEach((r, i) => {
            combinedTxt += r.name ? `${r.name},${r.url}\n` : `未命名${i + 1},${r.url}\n`;
        });
    });

    // 3. 生成带有 group-title 分组标签的 M3U 内容
    let combinedM3u = "#EXTM3U\n";
    Object.keys(resMap).sort().forEach(reso => {
        resMap[reso].forEach((r, i) => {
            // group-title 让播放器能自动识别分类
            combinedM3u += `#EXTINF:-1 group-title="${reso}",${r.name || '未命名' + (i + 1)}\n${r.url}\n`;
        });
    });

    // 4. 保存文件
    // 生成易读的时间字符串: YYYYMMDD_HHMMSS
    const now = new Date();
    const timeStr = now.getFullYear() + 
                    (now.getMonth() + 1).toString().padStart(2, '0') + 
                    now.getDate().toString().padStart(2, '0') + "_" + 
                    now.getHours().toString().padStart(2, '0') + 
                    now.getMinutes().toString().padStart(2, '0');

    // 修改文件名
    const txtPath = path.join(__dirname, `检测结果_${timeStr}.txt`);
    const m3uPath = path.join(__dirname, `检测结果_${timeStr}.m3u`);

    fs.writeFileSync(txtPath, combinedTxt);
    fs.writeFileSync(m3uPath, combinedM3u);

    // 5. 返回给前端（界面上只会显示这一个分类好的下载链接）
    res.json({ 
        exportData: [{ 
            resolution: "所有结果(已按分辨率分类)", 
            txt: txtPath, 
            m3u: m3uPath, 
            count: results.filter(r => r.valid).length 
        }] 
    });
});

app.listen(PORT,()=>console.log(`Server running at http://localhost:${PORT}`));