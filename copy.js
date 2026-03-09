const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');

// Nettoyage au demarrage
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); fs.mkdirSync(UPLOAD_DIR); } catch (err) {}

// === LIMITES STRICTES PROXMOX ===
const MAX_STORAGE_BYTES = 15 * 1024 * 1024 * 1024; // 15 Go
const MAX_GLOBAL_FILES = 5000; 
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 1h pour les fichiers finis
const PARTIAL_TIMEOUT_MS = 15 * 60 * 1000; // 15 min pour les morceaux abandonnes
const MAX_SSE_CLIENTS = 100; 

let currentTotalSize = 0;
let currentTotalFiles = 0;
let reservedSize = 0;
const storedItems = new Map();
const connectedClients = new Set();

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const safeName = path.basename(file.originalname);
        const fullFilename = `chunk-${uniqueId}-${safeName}.tmp`;
        
        if (!req.multerTempFiles) req.multerTempFiles = [];
        req.multerTempFiles.push(path.join(UPLOAD_DIR, fullFilename));
        
        cb(null, fullFilename);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 100 * 1024 * 1024, files: 1 } // Marge a 100Mo pour les blocs de 90Mo
});

app.use(express.urlencoded({ extended: true, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));

function escapeHtml(unsafe) {
    return (unsafe || '').toString().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function sanitizeRelativePath(unsafePath) {
    let clean = unsafePath.replace(/\0/g, '').replace(/\\/g, '/');
    clean = path.normalize(clean);
    if (clean.startsWith('..') || clean.startsWith('/')) return path.basename(clean); 
    return clean;
}

function safeUnlink(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return;
    try { fs.unlinkSync(filePath); } catch (e) {}
}

app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.startsWith('/upload')) {
        const contentLengthHeader = req.headers['content-length'];
        if (!contentLengthHeader) return res.status(411).send("Code 411 : 'Content-Length' requis.");

        const contentLength = Math.max(0, parseInt(contentLengthHeader, 10) || 0);
        
        if (currentTotalSize + reservedSize + contentLength > MAX_STORAGE_BYTES) {
            return res.status(413).send("La limite de 15 Go est atteinte ou l'espace est temporairement reserve.");
        }
        if (currentTotalFiles >= MAX_GLOBAL_FILES) {
            return res.status(503).send("Quota maximum de fichiers simultanes atteint.");
        }
        
        req.reservedBytes = contentLength;
        reservedSize += contentLength;

        req.reservationReleased = false;
        const cleanupRequest = () => {
            if (!req.reservationReleased) {
                reservedSize = Math.max(0, reservedSize - req.reservedBytes);
                req.reservationReleased = true;
            }
            if (!res.writableEnded && req.multerTempFiles) {
                req.multerTempFiles.forEach(f => safeUnlink(f));
                req.multerTempFiles = [];
            }
        };

        res.on('finish', cleanupRequest);
        res.on('close', cleanupRequest);
    }
    next();
});

// --- TEMPS REEL (SSE) ---
app.get('/events', (req, res) => {
    if (connectedClients.size >= MAX_SSE_CLIENTS) return res.status(503).end();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    connectedClients.add(res);
    const heartbeat = setInterval(() => res.write(':\n\n'), 20000);
    req.on('close', () => { clearInterval(heartbeat); connectedClients.delete(res); });
});

function broadcastState(id) {
    const message = `data: ${JSON.stringify({ type: 'delete', id: id, newSize: currentTotalSize })}\n\n`;
    for (const client of connectedClients) client.write(message);
}

function broadcastGhostDelete(filename) {
    const message = `data: ${JSON.stringify({ type: 'delete-ghost', id: filename, newSize: currentTotalSize })}\n\n`;
    for (const client of connectedClients) client.write(message);
}

function scheduleDestruction(id, delayMs) {
    const item = storedItems.get(id);
    if (item) {
        item.remainingMs = delayMs;
        item.expiresAt = Date.now() + delayMs;
        item.timeoutId = setTimeout(() => deleteItemData(id), delayMs);
        item.absoluteTimeoutId = setTimeout(() => deleteItemData(id), delayMs + ABSOLUTE_TIMEOUT_MS);
    }
}

function pauseTimer(id) {
    const item = storedItems.get(id);
    if (!item) return;
    if (item.activeDownloads === 0) {
        clearTimeout(item.timeoutId);
        item.remainingMs = Math.max(0, item.expiresAt - Date.now());
    }
    item.activeDownloads++;
}

function resumeTimer(id) {
    const item = storedItems.get(id);
    if (!item) return;
    item.activeDownloads--;
    if (item.activeDownloads <= 0) {
        item.activeDownloads = 0;
        item.expiresAt = Date.now() + item.remainingMs;
        item.timeoutId = setTimeout(() => deleteItemData(id), item.remainingMs);
    }
}

function deleteItemData(id) {
    if (storedItems.has(id)) {
        const item = storedItems.get(id);
        clearTimeout(item.timeoutId);
        clearTimeout(item.absoluteTimeoutId);
        storedItems.delete(id);
        currentTotalSize = Math.max(0, currentTotalSize - item.size);
        currentTotalFiles = Math.max(0, currentTotalFiles - 1);
        safeUnlink(item.path);
        broadcastState(id);
    }
}

function getPreviewHtml(item) {
    if (item.isText) {
        return `<div class="preview-box text-content">${item.previewText}</div><button class="btn-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copie'; setTimeout(()=>this.innerText='Copier', 2000)">Copier</button>`;
    }
    const ext = path.extname(item.originalName).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return `<img class="preview-media" src="/view/${item.id}" loading="lazy" alt="Apercu">`;
    if (['.mp4', '.webm'].includes(ext)) return `<video class="preview-media" controls src="/view/${item.id}" preload="none"></video>`;
    if (['.mp3', '.wav', '.ogg'].includes(ext)) return `<audio class="preview-audio" controls src="/view/${item.id}" preload="none"></audio>`;
    if (ext === '.pdf') return `<iframe class="preview-pdf" src="/view/${item.id}"></iframe>`;
    return `<div class="preview-box">Apercu indisponible</div>`;
}

// Auto-Healer : Nettoie les fichiers residuels (15 min de grace)
setInterval(async () => {
    try {
        let actualSize = 0;
        let actualFiles = 0;
        const activePaths = new Set(Array.from(storedItems.values()).map(i => path.basename(i.path)));
        const entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true });

        for (const dirent of entries) {
            const fullPath = path.join(UPLOAD_DIR, dirent.name);
            const stats = await fs.promises.stat(fullPath);
            
            const isGhost = !activePaths.has(dirent.name);
            const timeoutLimit = isGhost ? PARTIAL_TIMEOUT_MS : ABSOLUTE_TIMEOUT_MS;
            const isAbandoned = (Date.now() - stats.mtimeMs) > timeoutLimit;

            if (dirent.isDirectory()) {
                if (isAbandoned) fs.rm(fullPath, { recursive: true, force: true }, () => {});
            } else {
                if (isAbandoned) {
                    safeUnlink(fullPath);
                    if (isGhost) broadcastGhostDelete(dirent.name);
                } else {
                    actualSize += stats.size;
                    actualFiles++;
                }
            }
        }
        currentTotalSize = actualSize;
        currentTotalFiles = actualFiles;
    } catch (err) {}
}, 60 * 1000);

app.post('/abort-upload', (req, res) => {
    const { fileId } = req.body;
    if (fileId && /^[a-f0-9]{16,24}$/.test(fileId)) {
        const safeName = `${fileId}.part`;
        safeUnlink(path.join(UPLOAD_DIR, safeName));
        broadcastGhostDelete(safeName);
    }
    res.sendStatus(200);
});

app.post('/delete-ghost/:filename', (req, res) => {
    const safeName = sanitizeRelativePath(req.params.filename);
    const filePath = path.join(UPLOAD_DIR, safeName);
    
    const activePaths = new Set(Array.from(storedItems.values()).map(i => path.basename(i.path)));
    if (activePaths.has(safeName)) return res.status(403).send("Ce fichier est en ligne et finalise.");

    if (fs.existsSync(filePath)) {
        const size = fs.statSync(filePath).size;
        safeUnlink(filePath);
        currentTotalSize = Math.max(0, currentTotalSize - size);
        currentTotalFiles = Math.max(0, currentTotalFiles - 1);
        broadcastGhostDelete(safeName);
        res.sendStatus(200);
    } else {
        res.status(404).send("Fichier introuvable.");
    }
});

// NOUVEAU : Endpoint pour verifier ou en est un transfert interrompu
app.get('/check-upload/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const { folderId, relativePath } = req.query;
    
    if (!/^[a-f0-9]+$/.test(fileId)) return res.json({ uploadedBytes: 0 });

    const partPath = path.join(UPLOAD_DIR, `${fileId}.part`);
    if (fs.existsSync(partPath)) {
        return res.json({ uploadedBytes: fs.statSync(partPath).size });
    }
    
    if (folderId && relativePath) {
        const safeFolderId = sanitizeRelativePath(folderId);
        const safeRelative = sanitizeRelativePath(relativePath);
        const finalPath = path.join(UPLOAD_DIR, safeFolderId, safeRelative);
        if (fs.existsSync(finalPath)) {
            return res.json({ uploadedBytes: fs.statSync(finalPath).size });
        }
    }
    
    res.json({ uploadedBytes: 0 });
});

// Moteur de reception de morceaux (Mise a jour pour la reprise)
app.post('/upload-chunk', upload.single('chunk'), async (req, res) => {
    if (!req.file) return res.status(400).send("Morceau manquant.");
    
    try {
        const { fileId, filename, duration, folderId, relativePath, totalSize, offset } = req.body;
        const totalSizeBytes = parseInt(totalSize, 10);
        const offsetBytes = parseInt(offset, 10) || 0;
        
        if (!/^[a-f0-9]+$/.test(fileId)) throw new Error("ID de fichier invalide.");

        const chunkSize = req.file.size;
        if (currentTotalSize + chunkSize > MAX_STORAGE_BYTES) throw new Error("Limite de 15 Go depassee.");
        if (currentTotalFiles >= MAX_GLOBAL_FILES) throw new Error("Quota de fichiers atteint.");

        const partPath = path.join(UPLOAD_DIR, `${fileId}.part`);
        
        // SECURITE REPRISE : Verifie que le serveur et le client sont synchronises sur l'octet exact
        let existingSize = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0;
        if (existingSize !== offsetBytes) {
            throw new Error(`Desynchronisation (Attendu: ${offsetBytes}, Serveur: ${existingSize}). Reprise avortee.`);
        }

        await new Promise((resolve, reject) => {
            const readStream = fs.createReadStream(req.file.path);
            const writeStream = fs.createWriteStream(partPath, { flags: 'a' });
            readStream.on('error', reject);
            writeStream.on('error', reject);
            writeStream.on('finish', resolve);
            readStream.pipe(writeStream);
        });
        
        safeUnlink(req.file.path); 
        currentTotalSize += chunkSize;

        const currentPartSize = fs.statSync(partPath).size;

        if (currentPartSize >= totalSizeBytes) {
            const delayMs = (parseInt(duration) || 5) * 60 * 1000;
            const safeName = sanitizeRelativePath(filename);

            if (folderId) {
                const folderPath = path.join(UPLOAD_DIR, folderId);
                if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
                
                const finalSubPath = path.join(folderPath, sanitizeRelativePath(relativePath || filename));
                fs.mkdirSync(path.dirname(finalSubPath), { recursive: true });
                fs.renameSync(partPath, finalSubPath);
                
                broadcastGhostDelete(`${fileId}.part`);
                return res.json({ status: 'chunk_ok', complete: true });
            } else {
                const finalId = crypto.randomBytes(8).toString('hex');
                const finalPath = path.join(UPLOAD_DIR, `${finalId}-${safeName}`);
                fs.renameSync(partPath, finalPath);
                
                currentTotalFiles++;
                const deleteToken = crypto.randomBytes(16).toString('hex');
                
                storedItems.set(finalId, {
                    id: finalId, originalName: filename, path: finalPath, size: totalSizeBytes,
                    isText: false, activeDownloads: 0, deleteToken
                });
                scheduleDestruction(finalId, delayMs);
                broadcastGhostDelete(`${fileId}.part`);
                return res.json({ status: 'done', tokens: [{ id: finalId, token: deleteToken }] });
            }
        }

        res.json({ status: 'chunk_ok', complete: false });
    } catch (err) {
        if (req.file) safeUnlink(req.file.path);
        res.status(err.message.includes('Desynchronisation') ? 409 : 400).send(err.message);
    }
});

app.post('/finalize-folder', async (req, res) => {
    const { folderId, duration, folderName } = req.body;
    if (!/^[a-f0-9]+$/.test(folderId)) return res.status(400).send("ID invalide.");

    const folderPath = path.join(UPLOAD_DIR, folderId);
    if (!fs.existsSync(folderPath)) return res.status(404).send("Dossier introuvable.");

    const delayMs = (parseInt(duration) || 5) * 60 * 1000;
    const safeZipName = sanitizeRelativePath(folderName || 'Dossier') + '.zip';
    const finalId = crypto.randomBytes(8).toString('hex');
    const zipPath = path.join(UPLOAD_DIR, `${finalId}-${safeZipName}`);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 0 } }); 

    output.on('close', () => {
        const zipSize = archive.pointer();
        fs.rm(folderPath, { recursive: true, force: true }, () => {}); 
        
        currentTotalFiles++;
        const deleteToken = crypto.randomBytes(16).toString('hex');
        
        storedItems.set(finalId, {
            id: finalId, originalName: safeZipName, path: zipPath, size: zipSize,
            isText: false, activeDownloads: 0, deleteToken
        });
        scheduleDestruction(finalId, delayMs);
        res.json({ tokens: [{ id: finalId, token: deleteToken }] });
    });

    archive.on('error', (err) => {
        safeUnlink(zipPath);
        fs.rm(folderPath, { recursive: true, force: true }, () => {});
        res.status(500).send(err.message);
    });

    archive.pipe(output);
    archive.directory(folderPath, false); 
    archive.finalize();

    req.on('close', () => {
        if (!res.writableEnded) {
            archive.abort();
            req.files && req.files.forEach(f => safeUnlink(f.path));
            safeUnlink(zipPath);
        }
    });
});

app.post('/upload-text', multer().none(), (req, res) => {
    if (!req.body || typeof req.body.text !== 'string' || req.body.text.trim() === '') {
        return res.status(400).send('Texte vide ou invalide.');
    }
    const textContent = req.body.text;
    const delayMs = getDelayMs(req);
    const id = crypto.randomBytes(8).toString('hex') + '-texte.txt';
    const filePath = path.join(UPLOAD_DIR, id);
    const buffer = Buffer.from(textContent, 'utf-8');
    const fileSize = buffer.length;

    if (currentTotalSize + fileSize > MAX_STORAGE_BYTES) return res.status(413).send('Limite de 15 Go depassee.');
    if (currentTotalFiles >= MAX_GLOBAL_FILES) return res.status(503).send("Trop de fichiers.");

    fs.writeFileSync(filePath, buffer);
    currentTotalSize += fileSize;
    currentTotalFiles++;
    const deleteToken = crypto.randomBytes(16).toString('hex');

    const previewLimit = 2000;
    const isTruncated = buffer.length > previewLimit;
    const previewRaw = buffer.toString('utf8', 0, Math.min(buffer.length, previewLimit));
    const safePreview = escapeHtml(previewRaw) + (isTruncated ? '\n\n<em style="color:#888;">[... Apercu tronque, copiez ou telechargez pour lire la suite ...]</em>' : '');

    storedItems.set(id, {
        id: id, originalName: 'Texte colle', path: filePath, size: fileSize,
        isText: true, activeDownloads: 0, deleteToken, previewText: safePreview
    });
    scheduleDestruction(id, delayMs);
    res.json({ tokens: [{ id: id, token: deleteToken }] });
});

app.post('/delete/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (!item) return res.status(404).send('Inconnu');

    let clientTokenStr = req.body.token || '';
    if (typeof clientTokenStr !== 'string' || !/^[0-9a-f]{32}$/.test(clientTokenStr)) return res.status(403).send('Jeton invalide.');

    const tokenA = Buffer.from(item.deleteToken, 'hex');
    const tokenB = Buffer.from(clientTokenStr, 'hex');

    if (tokenA.length === tokenB.length && crypto.timingSafeEqual(tokenA, tokenB)) {
        deleteItemData(req.params.id);
        res.sendStatus(200);
    } else {
        res.status(403).send('Non autorise ou expire.');
    }
});

app.get('/view/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (!item) return res.status(404).end();

    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(item.path, (err) => {
        if (err && !res.headersSent) res.status(500).end();
    });
});

app.get('/download/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (!item) return res.status(404).send('Expire.');

    pauseTimer(item.id);
    res.download(item.path, item.originalName, (err) => {
        resumeTimer(item.id);
        if (err && !res.headersSent) res.status(500).end();
    });
});

// --- INTERFACE WEB PRINCIPALE ---
app.get('/', (req, res) => {
    // 1. Calcul des elements normaux
    const itemsHtml = Array.from(storedItems.values()).sort((a, b) => a.expiresAt - b.expiresAt).map(item => `
        <li class="item" id="item-${item.id}" data-id="${item.id}">
            <div class="item-header">
                <div class="item-info">
                    <span class="item-title">${escapeHtml(item.originalName)}</span>
                    <span class="size">(${(item.size / 1024 / 1024).toFixed(2)} Mo)</span>
                </div>
                <div class="item-actions">
                    <span class="timer" data-expires="${item.expiresAt}">--:--</span>
                </div>
            </div>
            ${getPreviewHtml(item)}
            ${!item.isText ? `<a class="btn-download" href="/download/${item.id}">Telecharger</a>` : ''}
        </li>
    `).join('') || '<p class="empty" id="empty-msg">Aucun fichier pour le moment.</p>';

    // 2. Traque et affichage des Fichiers Residuels
    let actualSize = 0;
    const activePaths = new Set(Array.from(storedItems.values()).map(i => path.basename(i.path)));
    const allFiles = fs.readdirSync(UPLOAD_DIR);
    const ghosts = [];

    for (const file of allFiles) {
        const filePath = path.join(UPLOAD_DIR, file);
        const stats = fs.statSync(filePath);
        if (stats.isDirectory()) continue;

        actualSize += stats.size;
        
        if (!activePaths.has(file)) {
            const ageMs = Date.now() - stats.mtimeMs;
            const remainingMs = PARTIAL_TIMEOUT_MS - ageMs;
            if (remainingMs > 0) {
                ghosts.push({ filename: file, size: stats.size, expiresAt: Date.now() + remainingMs });
            } else {
                safeUnlink(filePath); 
            }
        }
    }
    
    currentTotalSize = actualSize;

    const ghostsHtml = ghosts.sort((a,b) => a.expiresAt - b.expiresAt).map(g => `
        <li class="item ghost-item" id="ghost-${escapeHtml(g.filename)}">
            <div class="item-header">
                <div class="item-info">
                    <span class="item-title" style="color: #888;">[En pause / Residuel] ${escapeHtml(g.filename)}</span>
                    <span class="size">(${(g.size / 1024 / 1024).toFixed(2)} Mo)</span>
                </div>
                <div class="item-actions">
                    <span class="timer" data-expires="${g.expiresAt}">--:--</span>
                    <button class="btn-delete" onclick="deleteGhost('${encodeURIComponent(g.filename)}')">Supprimer</button>
                </div>
            </div>
        </li>
    `).join('') || '<p class="empty" id="ghost-empty-msg">Aucun fichier residuel.</p>';

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CopyPaste</title>
        <style>
            :root { --bg: #ffffff; --text: #000000; --gray: #888888; --light-gray: #f5f5f5; --border: #eeeeee; --red: #d93025; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem 4rem 1rem; color: var(--text); background: var(--bg); line-height: 1.5; }
            h1 { font-size: 1.2rem; font-weight: 600; margin-bottom: 2rem; display: flex; justify-content: space-between; }
            h2 { font-size: 1rem; margin-top: 3rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); color: var(--gray); }
            .storage-info { color: var(--gray); font-weight: normal; font-size: 0.9rem; }
            .settings { font-size: 0.9rem; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; justify-content: space-between; }
            .settings input { width: 50px; text-align: center; border: 1px solid var(--border); border-radius: 4px; padding: 0.2rem; }
            .btn-refresh { background: var(--light-gray); color: var(--text); border: 1px solid var(--border); cursor: pointer; padding: 0.3rem 0.8rem; border-radius: 4px; font-size: 0.8rem; }
            .section { margin-bottom: 2rem; }
            .input-group { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; }
            input[type="file"], textarea { flex: 1; padding: 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--light-gray); font-family: inherit; }
            textarea { height: 60px; resize: vertical; }
            button, .btn-download { background: var(--text); color: var(--bg); border: none; padding: 0.5rem 1rem; border-radius: 4px; cursor: pointer; text-decoration: none; font-size: 0.9rem; font-weight: 500; display: inline-block; }
            button:hover, .btn-download:hover { opacity: 0.8; }
            button:disabled { opacity: 0.5; cursor: not-allowed; }
            .btn-copy { background: var(--light-gray); color: var(--text); border: 1px solid var(--border); margin-top: 0.5rem; }
            .btn-delete { background: var(--red); color: white; padding: 0.2rem 0.6rem; margin-left: 0.5rem; font-size: 0.8rem; }
            ul { list-style: none; padding: 0; margin: 0; }
            .item { border-bottom: 1px solid var(--border); padding: 1.5rem 0; transition: opacity 0.3s ease, transform 0.3s ease; }
            .item-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1rem; gap: 1rem; }
            .item-info { flex: 1; word-break: break-all; }
            .item-title { font-weight: 500; }
            .item-actions { display: flex; align-items: center; white-space: nowrap; }
            .size { color: var(--gray); font-size: 0.85rem; font-weight: normal; }
            .timer { font-variant-numeric: tabular-nums; color: var(--red); font-size: 0.9rem; font-weight: 600; background: #fff0f0; padding: 2px 6px; border-radius: 4px; }
            .preview-box { background: var(--light-gray); padding: 1rem; border-radius: 4px; font-size: 0.9rem; color: var(--gray); white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; }
            .text-content { color: var(--text); font-family: monospace; }
            .preview-media { width: 100%; height: 200px; object-fit: cover; border-radius: 4px; display: block; background: var(--light-gray); }
            .preview-audio { width: 100%; margin: 0.5rem 0; }
            .preview-pdf { width: 100%; height: 300px; border: none; border-radius: 4px; background: var(--light-gray); }
            .empty { color: var(--gray); font-style: italic; }
            input[type="file"]::file-selector-button { display: none; }
            #progress-wrapper { display: none; margin-bottom: 1rem; background: var(--light-gray); padding: 1rem; border-radius: 4px; }
            #progress-text { font-size: 0.85rem; margin-bottom: 0.5rem; font-weight: 500; font-family: monospace; }
            .progress-track { width: 100%; background: var(--border); height: 6px; border-radius: 3px; overflow: hidden; }
            #progress-bar { width: 0%; height: 100%; background: var(--text); transition: width 0.1s; }
        </style>
    </head>
    <body>
        <h1><span>CopyPaste</span> <span class="storage-info" id="storage-info">${(currentTotalSize / (1024 ** 3)).toFixed(2)} / 15 Go</span></h1>

        <div class="settings">
            <div>Autodestruction : <input type="number" id="duration" min="1" max="15" value="5"> min</div>
            <button class="btn-refresh" onclick="window.location.reload()">Rafraichir</button>
        </div>

        <div id="progress-wrapper">
            <div id="progress-text">Preparation de l'envoi...</div>
            <div class="progress-track"><div id="progress-bar"></div></div>
        </div>

        <div class="section">
            <div class="input-group">
                <input type="file" id="input-files" multiple title="Selectionner des fichiers">
                <button id="btn-files" onclick="startChunkedUpload(false)">Fichiers</button>
            </div>
            <div class="input-group">
                <input type="file" id="input-folder" webkitdirectory directory multiple title="Selectionner un dossier">
                <button id="btn-folder" onclick="startChunkedUpload(true)">Dossier (ZIP)</button>
            </div>
            <div class="input-group" style="align-items: flex-start;">
                <textarea id="input-text" placeholder="Coller du texte..."></textarea>
                <button id="btn-text" onclick="uploadText()" style="height: 60px;">Texte</button>
            </div>
        </div>

        <ul id="list">
            ${itemsHtml}
        </ul>

        <h2>Fichiers residuels / En pause</h2>
        <ul id="ghost-list">
            ${ghostsHtml}
        </ul>

        <script>
            // --- DÉCOUPAGE FLUIDE 90 Mo ET REPRISE SUR ERREUR ---
            const CHUNK_SIZE = 90 * 1024 * 1024; 
            let activeUploads = []; 

            // Generation d'empreinte unique pour identifier un fichier lors d'une reprise
            async function generateFileId(file) {
                let salt = localStorage.getItem('copypaste_salt') || Math.random().toString(36).substring(2);
                localStorage.setItem('copypaste_salt', salt);
                const relPath = file.webkitRelativePath || file.name;
                const msg = salt + relPath + file.size + file.lastModified;
                
                if (window.crypto && crypto.subtle) {
                    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
                    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
                } else {
                    let hash = 0;
                    for (let i = 0; i < msg.length; i++) hash = ((hash << 5) - hash) + msg.charCodeAt(i);
                    return Math.abs(hash).toString(16).padStart(8, '0') + "fallback";
                }
            }

            async function generateFolderId(files, folderName) {
                let salt = localStorage.getItem('copypaste_salt') || Math.random().toString(36).substring(2);
                const msg = salt + folderName + files.length + (files[0] ? files[0].size : 0); 
                
                if (window.crypto && crypto.subtle) {
                    const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
                    return Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join('').substring(0, 16);
                } else {
                    let hash = 0;
                    for (let i = 0; i < msg.length; i++) hash = ((hash << 5) - hash) + msg.charCodeAt(i);
                    return Math.abs(hash).toString(16).padStart(8, '0') + "folder";
                }
            }

            function setUIUploading(isUploading) {
                document.getElementById('progress-wrapper').style.display = isUploading ? 'block' : 'none';
                ['btn-files', 'btn-folder', 'btn-text'].forEach(id => document.getElementById(id).disabled = isUploading);
            }

            function updateProgress(totalUploaded, totalBytes, startTime, alreadyOnServerBytes = 0) {
                const percent = Math.round((totalUploaded / totalBytes) * 100) || 0;
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                
                // Vitesse basee uniquement sur ce qui est reellement envoye via le reseau
                const transmittedBytes = totalUploaded - alreadyOnServerBytes;
                const speedMb = elapsedSeconds > 0 ? (transmittedBytes / 1048576) / elapsedSeconds : 0;
                const remainingMb = (totalBytes - totalUploaded) / 1048576;

                document.getElementById('progress-bar').style.width = percent + '%';
                document.getElementById('progress-text').innerText = \`\${percent}% | \${(totalUploaded/1048576).toFixed(2)} / \${(totalBytes/1048576).toFixed(2)} Mo | \${speedMb.toFixed(2)} Mo/s | Reste : \${remainingMb.toFixed(2)} Mo\`;
            }

            async function startChunkedUpload(isFolder) {
                const input = isFolder ? document.getElementById('input-folder') : document.getElementById('input-files');
                const files = input.files;
                if (!files || files.length === 0) return;

                const duration = document.getElementById('duration').value;
                const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
                const globalTokens = JSON.parse(localStorage.getItem('copypaste_tokens') || '{}');

                setUIUploading(true);
                document.getElementById('progress-text').innerText = 'Verification des fichiers sur le serveur...';
                activeUploads = [];

                let folderId = null;
                let folderName = 'Dossier';
                if (isFolder) {
                    folderName = files[0].webkitRelativePath.split('/')[0] || 'Dossier';
                    folderId = await generateFolderId(files, folderName);
                }

                // 1. Preparation : On demande au serveur ou en est chaque fichier
                const fileUploadStates = new Array(files.length).fill(0);
                let bytesAlreadyOnServer = 0;
                
                for (let i = 0; i < files.length; i++) {
                    const file = files[i];
                    const fileId = await generateFileId(file);
                    
                    let checkUrl = '/check-upload/' + fileId;
                    if (isFolder) checkUrl += '?folderId=' + encodeURIComponent(folderId) + '&relativePath=' + encodeURIComponent(file.webkitRelativePath || file.name);
                    
                    try {
                        const checkRes = await fetch(checkUrl);
                        const checkData = await checkRes.json();
                        fileUploadStates[i] = checkData.uploadedBytes || 0;
                        bytesAlreadyOnServer += fileUploadStates[i];
                    } catch (e) { fileUploadStates[i] = 0; }
                }

                const startTime = Date.now();

                try {
                    // 2. Upload des fichiers
                    for (let i = 0; i < files.length; i++) {
                        const file = files[i];
                        const fileId = await generateFileId(file);
                        
                        if (fileUploadStates[i] < file.size) {
                            activeUploads.push(fileId);
                            
                            const data = await uploadSingleFile(file, duration, folderId, isFolder, fileId, fileUploadStates[i], (newFileBytes) => {
                                fileUploadStates[i] = newFileBytes;
                                const totalNow = fileUploadStates.reduce((a, b) => a + b, 0);
                                updateProgress(totalNow, totalBytes, startTime, bytesAlreadyOnServer);
                            });
                            
                            if (!isFolder && data && data.tokens) data.tokens.forEach(t => globalTokens[t.id] = t.token);
                        } else {
                            // Fichier deja totalement uploade lors d'une session precedente
                            const totalNow = fileUploadStates.reduce((a, b) => a + b, 0);
                            updateProgress(totalNow, totalBytes, startTime, bytesAlreadyOnServer);
                        }
                    }
                    
                    // 3. Finalisation du dossier (Zipping)
                    if (isFolder) {
                        document.getElementById('progress-text').innerText = 'Compression du dossier ZIP sur le serveur...';
                        const res = await fetch('/finalize-folder', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ folderId, duration, folderName })
                        });
                        if (!res.ok) throw new Error(await res.text());
                        const data = await res.json();
                        data.tokens.forEach(t => globalTokens[t.id] = t.token);
                    }

                    activeUploads = []; 
                    localStorage.setItem('copypaste_tokens', JSON.stringify(globalTokens));
                    window.location.reload();
                } catch (err) {
                    if (err.message === 'RESTART_NEEDED') {
                        alert("Le fichier residuel a ete altere. L'envoi a ete stoppe pour eviter la corruption. Veuillez reessayer.");
                    } else {
                        alert("Erreur: " + err.message);
                    }
                    setUIUploading(false);
                }
            }

            // MOTEUR HAUTE FRÉQUENCE AVEC REPRISE
            async function uploadSingleFile(file, duration, folderId, isFolder, fileId, startingOffset, onProgress) {
                let uploadedBytesChunks = startingOffset;

                while (uploadedBytesChunks < file.size) {
                    const end = Math.min(uploadedBytesChunks + CHUNK_SIZE, file.size);
                    const chunk = file.slice(uploadedBytesChunks, end);

                    const formData = new FormData();
                    formData.append('chunk', chunk);
                    formData.append('fileId', fileId);
                    formData.append('offset', uploadedBytesChunks); // Le client indique ou il commence
                    formData.append('totalSize', file.size);
                    formData.append('filename', file.name);
                    formData.append('duration', duration);
                    if (isFolder) {
                        formData.append('folderId', folderId);
                        formData.append('relativePath', file.webkitRelativePath || file.name);
                    }

                    const response = await new Promise((resolve, reject) => {
                        const xhr = new XMLHttpRequest();
                        xhr.open('POST', '/upload-chunk', true);

                        xhr.upload.onprogress = (e) => {
                            if (e.lengthComputable && onProgress) onProgress(uploadedBytesChunks + e.loaded);
                        };

                        xhr.onload = () => {
                            if (xhr.status === 200) {
                                resolve(JSON.parse(xhr.responseText));
                            } else if (xhr.status === 409) {
                                reject(new Error('RESTART_NEEDED')); // Erreur specifique si le fichier a ete supprime pendant la pause
                            } else {
                                reject(new Error(xhr.responseText || 'Erreur reseau'));
                            }
                        };
                        xhr.onerror = () => reject(new Error('Serveur inaccessible'));
                        xhr.send(formData);
                    });
                    
                    uploadedBytesChunks += chunk.size;
                    if (onProgress) onProgress(uploadedBytesChunks);
                    
                    if (response.complete || response.status === 'done') return response;
                }
                return null;
            }

            async function uploadText() {
                const text = document.getElementById('input-text').value;
                if (!text.trim()) return;

                setUIUploading(true);
                document.getElementById('progress-text').innerText = 'Envoi du texte...';

                const fd = new FormData();
                fd.append('text', text);
                fd.append('duration', document.getElementById('duration').value);

                try {
                    const res = await fetch('/upload-text', { method: 'POST', body: fd });
                    if (!res.ok) throw new Error(await res.text());
                    const data = await res.json();
                    
                    const tokens = JSON.parse(localStorage.getItem('copypaste_tokens') || '{}');
                    data.tokens.forEach(t => tokens[t.id] = t.token);
                    localStorage.setItem('copypaste_tokens', JSON.stringify(tokens));
                    window.location.reload();
                } catch (err) {
                    alert("Erreur: " + err.message);
                    setUIUploading(false);
                }
            }

            function deleteGhost(filename) {
                fetch('/delete-ghost/' + filename, { method: 'POST' }).catch(err => alert('Erreur suppression'));
            }

            window.addEventListener('DOMContentLoaded', () => {
                document.getElementById('input-files').value = "";
                document.getElementById('input-folder').value = "";
                document.getElementById('input-text').value = "";
            });

            window.addEventListener('beforeunload', () => {
                if (activeUploads.length > 0) {
                    activeUploads.forEach(id => {
                        const blob = new Blob([JSON.stringify({ fileId: id })], { type: 'application/json' });
                        navigator.sendBeacon('/abort-upload', blob);
                    });
                }
            });

            const eventSource = new EventSource('/events');
            eventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                if (data.type === 'delete' || data.type === 'delete-ghost') {
                    const elId = data.type === 'delete' ? 'item-' + data.id : 'ghost-' + data.id;
                    const el = document.getElementById(elId);
                    if (el) {
                        el.style.opacity = '0';
                        el.style.transform = 'scale(0.95)';
                        setTimeout(() => {
                            el.remove();
                            if (data.type === 'delete' && document.querySelectorAll('.item:not(.ghost-item)').length === 0) {
                                const list = document.getElementById('list');
                                if(!document.getElementById('empty-msg')) list.innerHTML = '<p class="empty" id="empty-msg">Aucun fichier pour le moment.</p>';
                            }
                            if (data.type === 'delete-ghost' && document.querySelectorAll('.ghost-item').length === 0) {
                                const ghostList = document.getElementById('ghost-list');
                                if(!document.getElementById('ghost-empty-msg')) ghostList.innerHTML = '<p class="empty" id="ghost-empty-msg">Aucun fichier residuel.</p>';
                            }
                        }, 300);
                    }
                    if (data.newSize !== undefined) {
                        const storageEl = document.getElementById('storage-info');
                        if (storageEl) storageEl.innerText = (data.newSize / (1024 ** 3)).toFixed(2) + ' / 15 Go';
                    }
                }
            };

            const tokens = JSON.parse(localStorage.getItem('copypaste_tokens') || '{}');
            document.querySelectorAll('.item:not(.ghost-item)').forEach(el => {
                const id = el.dataset.id;
                if (tokens[id]) {
                    const btn = document.createElement('button');
                    btn.innerText = 'Supprimer';
                    btn.className = 'btn-delete';
                    btn.onclick = () => {
                        fetch('/delete/' + id, {
                            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: tokens[id] })
                        }).then(() => {
                            delete tokens[id];
                            localStorage.setItem('copypaste_tokens', JSON.stringify(tokens));
                        });
                    };
                    el.querySelector('.item-actions').appendChild(btn);
                }
            });

            setInterval(() => {
                document.querySelectorAll('.timer').forEach(el => {
                    const diff = parseInt(el.dataset.expires, 10) - Date.now();
                    if (diff <= 0) {
                        el.innerText = "00:00";
                        el.closest('.item').style.opacity = "0.5";
                    } else {
                        const m = Math.floor(diff / 60000).toString().padStart(2, '0');
                        const s = Math.floor((diff % 60000) / 1000).toString().padStart(2, '0');
                        el.innerText = m + ":" + s;
                    }
                });
            }, 1000);
        </script>
    </body>
    </html>
    `;
    res.send(html);
});

app.use((err, req, res, next) => {
    if (req.multerTempFiles) {
        req.multerTempFiles.forEach(f => safeUnlink(f));
        req.multerTempFiles = [];
    }
    if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).send("Un fichier depasse la limite autorisee.");
        if (err.code === 'LIMIT_FIELD_SIZE') return res.status(413).send("Le texte est trop long.");
        return res.status(400).send(`Erreur d'upload : ${err.message}`);
    } else if (err) {
        return res.status(500).send("Erreur serveur : Le transfert a ete interrompu.");
    }
    next();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur CopyPaste demarre sur http://localhost:${PORT}`);
});
