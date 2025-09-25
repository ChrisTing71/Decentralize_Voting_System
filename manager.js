// manager.js
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
// **修改點 1: 移除此處的 const open = require('open');**

const app = express();
const PORT = 8080; // 管理器的埠號

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); 

const runningNodes = {};

// --- API 端點 (Endpoints) ---

// [GET] /api/nodes - 取得所有正在運行的節點列表
app.get('/api/nodes', (req, res) => {
    const nodesInfo = Object.keys(runningNodes).map(nodeName => ({
        name: nodeName,
        port: runningNodes[nodeName].port,
        status: 'running'
    }));
    res.json(nodesInfo);
});

// [POST] /api/launch-node - 啟動一個新的投票節點
app.post('/api/launch-node', (req, res) => {
    const { nodeName, port, peers } = req.body;

    if (!nodeName || !port) {
        return res.status(400).json({ success: false, message: '節點名稱和埠號為必填項。' });
    }
    if (runningNodes[nodeName]) {
        return res.status(400).json({ success: false, message: `節點 '${nodeName}' 已經在運行中。` });
    }

    const args = [
        path.join(__dirname, 'voting-node.js'),
        nodeName,
        port.toString(),
        ...(peers || [])
    ];

    const nodeProcess = spawn('node', args, {
        detached: true,
        stdio: 'pipe'
    });

    runningNodes[nodeName] = {
        process: nodeProcess,
        port: port,
        log: []
    };

    nodeProcess.stdout.on('data', (data) => {
        const logMessage = `[${nodeName}]: ${data.toString().trim()}`;
        console.log(logMessage);
        runningNodes[nodeName].log.push(logMessage);
    });

    nodeProcess.stderr.on('data', (data) => {
        const errorMessage = `[${nodeName} ERROR]: ${data.toString().trim()}`;
        console.error(errorMessage);
        runningNodes[nodeName].log.push(errorMessage);
    });

    nodeProcess.on('close', (code) => {
        console.log(`節點 ${nodeName} 已關閉，代碼: ${code}`);
        delete runningNodes[nodeName];
    });

    console.log(`指令已發送：啟動節點 ${nodeName} 於埠號 ${port}`);
    res.status(200).json({ success: true, message: `節點 ${nodeName} 已成功啟動！` });
});

// [POST] /api/stop-node - 關閉一個指定的節點
app.post('/api/stop-node', (req, res) => {
    const { nodeName } = req.body;
    const nodeInfo = runningNodes[nodeName];

    if (!nodeInfo) {
        return res.status(404).json({ success: false, message: '找不到指定的節點。' });
    }

    nodeInfo.process.kill();
    delete runningNodes[nodeName];

    console.log(`節點 ${nodeName} 已被關閉。`);
    res.status(200).json({ success: true, message: `節點 ${nodeName} 已成功關閉。` });
});


// 啟動管理器伺服器
// **修改點 2: 將此處的函式改為 async，並使用 await import()**
app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}/register.html`;
    console.log(`=============================================`);
    console.log(`  本地後端管理器已啟動！`);
    console.log(`  控制台網址: ${url}`);
    console.log(`  正在為您自動打開瀏覽器...`);
    console.log(`=============================================`);

    // 使用動態 import() 來載入最新版的 open 套件
    const open = (await import('open')).default;
    await open(url);
});