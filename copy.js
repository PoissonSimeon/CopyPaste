const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const { pipeline } = require('stream/promises');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');

// Nettoyage au démarrage
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
try { fs.rmSync(UPLOAD_DIR, { recursive: true, force: true }); fs.mkdirSync(UPLOAD_DIR); } catch (err) {}

// === LIMITES STRICTES ===
const MAX_STORAGE_BYTES = 15 * 1024 * 1024 * 1024; // 15 Go
const MAX_GLOBAL_FILES = 5000; 
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 1h
const MAX_SSE_CLIENTS = 100; 

let currentTotalSize = 0;
let currentTotalFiles = 0;
const storedItems = new Map();
const connectedClients = new Set();

// Multer gère uniquement la réception des morceaux de 50 Mo
const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        cb(null, `chunk-${crypto.randomBytes(8).toString('hex')}.tmp`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 60 * 1024 * 1024, files: 1 } // Accepte un chunk jusqu'à 60Mo (marge de sécurité)
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
    fs.unlink(filePath, () => {});
}

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
        return `<div class="preview-box text-content">${item.previewText}</div><button class="btn-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copié !'; setTimeout(()=>this.innerText='Copier', 2000)">Copier</button>`;
    }
    const ext = path.extname(item.originalName).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return `<img class="preview-media" src="/view/${item.id}" loading="lazy" alt="Aperçu">`;
    if (['.mp4', '.webm'].includes(ext)) return `<video class="preview-media" controls src="/view/${item.id}" preload="none"></video>`;
    if (['.mp3', '.wav', '.ogg'].includes(ext)) return `<audio class="preview-audio" controls src="/view/${item.id}" preload="none"></audio>`;
    if (ext === '.pdf') return `<iframe class="preview-pdf" src="/view/${item.id}"></iframe>`;
    return `<div class="preview-box">Aperçu indisponible</div>`;
}

// Auto-Healer Asynchrone : Traque les morceaux abandonnés (Dossiers et .part)
setInterval(async () => {
    try {
        let actualSize = 0;
        let actualFiles = 0;
        const activeIds = new Set(Array.from(storedItems.values()).map(i => i.id));
        const entries = await fs.promises.readdir(UPLOAD_DIR, { withFileTypes: true });

        for (const dirent of entries) {
            const fullPath = path.join(UPLOAD_DIR, dirent.name);
            const stats = await fs.promises.stat(fullPath);
            const isAbandoned = (Date.now() - stats.mtimeMs) > ABSOLUTE_TIMEOUT_MS;

            if (dirent.isDirectory()) {
                if (isAbandoned) fs.rm(fullPath, { recursive: true, force: true }, () => {});
            } else {
                if ((dirent.name.endsWith('.part') || dirent.name.endsWith('.tmp')) && isAbandoned) {
                    safeUnlink(fullPath);
                } else if (!dirent.name.endsWith('.part') && !dirent.name.endsWith('.tmp')) {
                    const id = dirent.name.split('-')[0];
                    if (!activeIds.has(id) && isAbandoned) safeUnlink(fullPath);
                    else if (activeIds.has(id)) { actualSize += stats.size; actualFiles++; }
                }
            }
        }
        currentTotalSize = actualSize;
        currentTotalFiles = actualFiles;
    } catch (err) {}
}, 15 * 60 * 1000);

// --- NOUVEAU MOTEUR DE RÉCEPTION DES MORCEAUX (CHUNKS) ---

app.post('/upload-chunk', upload.single('chunk'), async (req, res) => {
    if (!req.file) return res.status(400).send("Morceau manquant.");
    
    try {
        const { fileId, chunkIndex, totalChunks, filename, duration, folderId, relativePath } = req.body;
        
        // SÉCURITÉ : Validation stricte des IDs pour éviter l'injection de chemin
        if (!/^[a-f0-9]{16}$/.test(fileId)) throw new Error("ID de fichier invalide.");
        if (folderId && !/^[a-f0-9]{16}$/.test(folderId)) throw new Error("ID de dossier invalide.");

        const chunkSize = req.file.size;
        if (currentTotalSize + chunkSize > MAX_STORAGE_BYTES) throw new Error("Limite de 15 Go dépassée.");
        if (currentTotalFiles >= MAX_GLOBAL_FILES) throw new Error("Quota de fichiers atteint.");

        // On colle le morceau à la fin du fichier partiel
        const partPath = path.join(UPLOAD_DIR, `${fileId}.part`);
        await pipeline(fs.createReadStream(req.file.path), fs.createWriteStream(partPath, { flags: 'a' }));
        safeUnlink(req.file.path);
        
        currentTotalSize += chunkSize;

        // Si c'est le dernier morceau du fichier
        if (parseInt(chunkIndex) === parseInt(totalChunks) - 1) {
            const delayMs = (parseInt(duration) || 5) * 60 * 1000;
            const safeName = sanitizeRelativePath(filename);

            if (folderId) {
                // Le fichier appartient à un dossier
                const folderPath = path.join(UPLOAD_DIR, folderId);
                if (!fs.existsSync(folderPath)) fs.mkdirSync(folderPath, { recursive: true });
                
                const finalSubPath = path.join(folderPath, sanitizeRelativePath(relativePath || filename));
                fs.mkdirSync(path.dirname(finalSubPath), { recursive: true });
                fs.renameSync(partPath, finalSubPath);
                
                return res.json({ status: 'chunk_ok', complete: true });
            } else {
                // C'est un fichier seul, on finalise son upload
                const finalId = crypto.randomBytes(8).toString('hex');
                const finalPath = path.join(UPLOAD_DIR, `${finalId}-${safeName}`);
                fs.renameSync(partPath, finalPath);
                
                currentTotalFiles++;
                const deleteToken = crypto.randomBytes(16).toString('hex');
                
                storedItems.set(finalId, {
                    id: finalId, originalName: filename, path: finalPath, size: fs.statSync(finalPath).size,
                    isText: false, activeDownloads: 0, deleteToken
                });
                scheduleDestruction(finalId, delayMs);
                return res.json({ status: 'done', tokens: [{ id: finalId, token: deleteToken }] });
            }
        }

        res.json({ status: 'chunk_ok', complete: false });
    } catch (err) {
        if (req.file) safeUnlink(req.file.path);
        res.status(400).send(err.message);
    }
});

// Finalisation d'un dossier uploadé
app.post('/finalize-folder', async (req, res) => {
    const { folderId, duration, folderName } = req.body;
    if (!/^[a-f0-9]{16}$/.test(folderId)) return res.status(400).send("ID invalide.");

    const folderPath = path.join(UPLOAD_DIR, folderId);
    if (!fs.existsSync(folderPath)) return res.status(404).send("Dossier introuvable.");

    const delayMs = (parseInt(duration) || 5) * 60 * 1000;
    const safeZipName = sanitizeRelativePath(folderName || 'Dossier') + '.zip';
    const finalId = crypto.randomBytes(8).toString('hex');
    const zipPath = path.join(UPLOAD_DIR, `${finalId}-${safeZipName}`);

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 0 } }); // Niveau 0 vital pour Proxmox 512Mo

    output.on('close', () => {
        const zipSize = archive.pointer();
        fs.rm(folderPath, { recursive: true, force: true }, () => {}); // On supprime le dossier source pour libérer l'espace
        
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
    archive.directory(folderPath, false); // Zippe tout le contenu en préservant l'arborescence
    archive.finalize();
});

app.post('/upload-text', multer().none(), (req, res) => {
    if (!req.body || typeof req.body.text !== 'string' || req.body.text.trim() === '') return res.status(400).send('Texte vide.');
    
    const buffer = Buffer.from(req.body.text, 'utf-8');
    if (currentTotalSize + buffer.length > MAX_STORAGE_BYTES) return res.status(413).send('Limite de 15 Go dépassée.');
    
    const delayMs = (parseInt(req.body.duration) || 5) * 60 * 1000;
    const finalId = crypto.randomBytes(8).toString('hex');
    const filePath = path.join(UPLOAD_DIR, `${finalId}-texte.txt`);

    fs.writeFileSync(filePath, buffer);
    currentTotalSize += buffer.length;
    currentTotalFiles++;
    
    const deleteToken = crypto.randomBytes(16).toString('hex');
    const safePreview = escapeHtml(buffer.toString('utf8', 0, Math.min(buffer.length, 2000))) + (buffer.length > 2000 ? '\n\n[...]' : '');

    storedItems.set(finalId, {
        id: finalId, originalName: 'Texte collé', path: filePath, size: buffer.length,
        isText: true, activeDownloads: 0, deleteToken, previewText: safePreview
    });
    scheduleDestruction(finalId, delayMs);
    res.json({ tokens: [{ id: finalId, token: deleteToken }] });
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
        res.status(403).send('Non autorisé ou expiré.');
    }
});

app.get('/view/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (!item) return res.status(404).end();
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.sendFile(item.path);
});

app.get('/download/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (!item) return res.status(404).send('Expiré.');
    pauseTimer(item.id);
    res.download(item.path, item.originalName, () => resumeTimer(item.id));
});

// --- INTERFACE WEB (FRONTEND AVEC DÉCOUPAGE CHUNK) ---

app.get('/', (req, res) => {
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
            ${!item.isText ? `<a class="btn-download" href="/download/${item.id}">Télécharger</a>` : ''}
        </li>
    `).join('') || '<p class="empty" id="empty-msg">Aucun fichier pour le moment.</p>';

    const html = `
    <!DOCTYPE html>
    <html lang="fr">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CopyPaste</title>
        <style>
            :root { --bg: #ffffff; --text: #000000; --gray: #888888; --light-gray: #f5f5f5; --border: #eeeeee; --red: #d93025; }
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 600px; margin: 2rem auto; padding: 0 1rem; color: var(--text); background: var(--bg); line-height: 1.5; }
            h1 { font-size: 1.2rem; font-weight: 600; margin-bottom: 2rem; display: flex; justify-content: space-between; }
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
            <div>⏳ Autodestruction : <input type="number" id="duration" min="1" max="15" value="5"> min</div>
            <button class="btn-refresh" onclick="window.location.reload()">🔄 Rafraîchir</button>
        </div>

        <div id="progress-wrapper">
            <div id="progress-text">Préparation de l'envoi...</div>
            <div class="progress-track"><div id="progress-bar"></div></div>
        </div>

        <div class="section">
            <div class="input-group">
                <input type="file" id="input-files" multiple title="Sélectionner des fichiers">
                <button id="btn-files" onclick="startChunkedUpload(false)">Fichiers</button>
            </div>
            <div class="input-group">
                <input type="file" id="input-folder" webkitdirectory directory multiple title="Sélectionner un dossier">
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

        <script>
            // --- GESTION DU CHUNKING CÔTÉ CLIENT (CONTOURNEMENT CLOUDFLARE) ---
            const CHUNK_SIZE = 50 * 1024 * 1024; // Morceaux de 50 Mo

            function generateUUID() {
                return Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('');
            }

            function setUIUploading(isUploading) {
                document.getElementById('progress-wrapper').style.display = isUploading ? 'block' : 'none';
                ['btn-files', 'btn-folder', 'btn-text'].forEach(id => document.getElementById(id).disabled = isUploading);
            }

            function updateProgress(uploadedBytes, totalBytes, startTime) {
                const percent = Math.round((uploadedBytes / totalBytes) * 100) || 0;
                const elapsedSeconds = (Date.now() - startTime) / 1000;
                const speedMb = elapsedSeconds > 0 ? (uploadedBytes / 1048576) / elapsedSeconds : 0;
                const remainingMb = (totalBytes - uploadedBytes) / 1048576;

                document.getElementById('progress-bar').style.width = percent + '%';
                document.getElementById('progress-text').innerText = \`\${percent}% | \${(uploadedBytes/1048576).toFixed(2)} / \${(totalBytes/1048576).toFixed(2)} Mo | \${speedMb.toFixed(2)} Mo/s | Reste : \${remainingMb.toFixed(2)} Mo\`;
            }

            async function startChunkedUpload(isFolder) {
                const input = isFolder ? document.getElementById('input-folder') : document.getElementById('input-files');
                const files = input.files;
                if (!files || files.length === 0) return;

                const duration = document.getElementById('duration').value;
                const totalBytes = Array.from(files).reduce((sum, f) => sum + f.size, 0);
                let uploadedBytes = 0;
                const startTime = Date.now();
                const globalTokens = JSON.parse(localStorage.getItem('copypaste_tokens') || '{}');

                setUIUploading(true);

                try {
                    if (isFolder) {
                        const folderId = generateUUID();
                        let folderName = files[0].webkitRelativePath.split('/')[0] || 'Dossier';
                        
                        for (const file of files) {
                            await uploadSingleFile(file, duration, folderId, isFolder);
                            uploadedBytes += file.size;
                            updateProgress(uploadedBytes, totalBytes, startTime);
                        }
                        
                        document.getElementById('progress-text').innerText = 'Compression du dossier ZIP sur le serveur...';
                        const res = await fetch('/finalize-folder', {
                            method: 'POST',
                            headers: {'Content-Type': 'application/json'},
                            body: JSON.stringify({ folderId, duration, folderName })
                        });
                        if (!res.ok) throw new Error(await res.text());
                        
                        const data = await res.json();
                        data.tokens.forEach(t => globalTokens[t.id] = t.token);

                    } else {
                        for (const file of files) {
                            const data = await uploadSingleFile(file, duration, null, false);
                            if (data && data.tokens) data.tokens.forEach(t => globalTokens[t.id] = t.token);
                            uploadedBytes += file.size;
                            updateProgress(uploadedBytes, totalBytes, startTime);
                        }
                    }

                    localStorage.setItem('copypaste_tokens', JSON.stringify(globalTokens));
                    window.location.reload();
                } catch (err) {
                    alert("Erreur: " + err.message);
                    setUIUploading(false);
                }
            }

            async function uploadSingleFile(file, duration, folderId, isFolder) {
                const fileId = generateUUID();
                const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
                let lastResponseData = null;

                for (let i = 0; i < totalChunks; i++) {
                    const start = i * CHUNK_SIZE;
                    const end = Math.min(start + CHUNK_SIZE, file.size);
                    const chunk = file.slice(start, end);

                    const formData = new FormData();
                    formData.append('chunk', chunk);
                    formData.append('fileId', fileId);
                    formData.append('chunkIndex', i);
                    formData.append('totalChunks', totalChunks);
                    formData.append('filename', file.name);
                    formData.append('duration', duration);
                    if (isFolder) {
                        formData.append('folderId', folderId);
                        formData.append('relativePath', file.webkitRelativePath || file.name);
                    }

                    const res = await fetch('/upload-chunk', { method: 'POST', body: formData });
                    if (!res.ok) throw new Error(await res.text());
                    lastResponseData = await res.json();
                }
                return lastResponseData;
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

            // --- GESTION DU RESTE DE L'UI ---
            window.addEventListener('DOMContentLoaded', () => {
                document.getElementById('input-files').value = "";
                document.getElementById('input-folder').value = "";
                document.getElementById('input-text').value = "";
            });

            const eventSource = new EventSource('/events');
            eventSource.onmessage = function(event) {
                const data = JSON.parse(event.data);
                if (data.type === 'delete') {
                    const el = document.getElementById('item-' + data.id);
                    if (el) {
                        el.style.opacity = '0';
                        el.style.transform = 'scale(0.95)';
                        setTimeout(() => {
                            el.remove();
                            if (document.querySelectorAll('.item').length === 0) {
                                const list = document.getElementById('list');
                                if(!document.getElementById('empty-msg')) list.innerHTML = '<p class="empty" id="empty-msg">Aucun fichier pour le moment.</p>';
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
            document.querySelectorAll('.item').forEach(el => {
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
    if (err) return res.status(500).send("Erreur serveur inattendue.");
    next();
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur CopyPaste démarré sur http://localhost:${PORT}`);
});
