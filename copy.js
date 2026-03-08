const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

const app = express();
const PORT = 3000;
const UPLOAD_DIR = path.join(__dirname, 'temp_uploads');

// Création et nettoyage du dossier au démarrage
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);
fs.readdirSync(UPLOAD_DIR).forEach(f => fs.unlinkSync(path.join(UPLOAD_DIR, f)));

const MAX_STORAGE_BYTES = 32 * 1024 * 1024 * 1024; // 32 Go globale
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024; // 5 Go max par fichier individuel
const ABSOLUTE_TIMEOUT_MS = 60 * 60 * 1000; // 1 heure max (Anti-Slowloris)

let currentTotalSize = 0;
const storedItems = new Map();
const connectedClients = new Set();

const storage = multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const safeName = path.basename(file.originalname);
        cb(null, `${uniqueId}-${safeName}`);
    }
});

// SÉCURITÉ : Limites strictes au niveau de Multer
const upload = multer({ 
    storage: storage,
    limits: { 
        fileSize: MAX_FILE_SIZE,
        fieldSize: 50 * 1024 * 1024, // Limite le texte collé à 50 Mo (évite le crash de buffer)
        files: 2000 // Évite une attaque par saturation du nombre de fichiers (DDoS)
    }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function escapeHtml(unsafe) {
    return (unsafe || '').toString()
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#039;");
}

// SÉCURITÉ : Première barrière basée sur l'en-tête
app.use((req, res, next) => {
    if (req.method === 'POST' && req.path.startsWith('/upload')) {
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (currentTotalSize + contentLength > MAX_STORAGE_BYTES) {
            return res.status(413).send("La limite globale du serveur (32 Go) est atteinte.");
        }
    }
    next();
});

// --- GESTION DU TEMPS RÉEL (SSE) ---

app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    connectedClients.add(res);
    req.on('close', () => connectedClients.delete(res));
});

function broadcastDelete(id) {
    const message = `data: ${JSON.stringify({ type: 'delete', id: id })}\n\n`;
    for (const client of connectedClients) {
        client.write(message);
    }
}

// --- GESTION DU CHRONOMÈTRE ET DE LA PAUSE ---

function scheduleDestruction(id, delayMs) {
    const item = storedItems.get(id);
    if (item) {
        item.remainingMs = delayMs;
        item.expiresAt = Date.now() + delayMs;
        item.timeoutId = setTimeout(() => deleteItemData(id), delayMs);
        
        // SÉCURITÉ : "Kill switch" absolu pour empêcher les attaques Slowloris sur les téléchargements en pause
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
        currentTotalSize -= item.size;
        fs.unlink(item.path, () => {});
        broadcastDelete(id);
    }
}

function getPreviewHtml(item) {
    if (item.isText) {
        let content = '';
        try { content = fs.readFileSync(item.path, 'utf8'); } catch (e) { content = 'Erreur de lecture'; }
        return `
            <div class="preview-box text-content">${escapeHtml(content)}</div>
            <button class="btn-copy" onclick="navigator.clipboard.writeText(this.previousElementSibling.innerText); this.innerText='Copié !'; setTimeout(()=>this.innerText='Copier', 2000)">Copier</button>
        `;
    }

    const ext = path.extname(item.originalName).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext)) return `<img class="preview-media" src="/view/${item.id}" loading="lazy" alt="Aperçu">`;
    if (['.mp4', '.webm'].includes(ext)) return `<video class="preview-media" controls src="/view/${item.id}" preload="none"></video>`;
    if (['.mp3', '.wav', '.ogg'].includes(ext)) return `<audio class="preview-audio" controls src="/view/${item.id}" preload="none"></audio>`;
    if (ext === '.pdf') return `<iframe class="preview-pdf" src="/view/${item.id}"></iframe>`;
    
    return `<div class="preview-box">Aperçu indisponible</div>`;
}

// --- ROUTES ---

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
        <title>Éphémère</title>
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
        <h1><span>Éphémère</span> <span class="storage-info">${(currentTotalSize / (1024 ** 3)).toFixed(2)} / 32 Go</span></h1>

        <div class="settings">
            <div>⏳ Autodestruction : <input type="number" id="duration" min="1" max="15" value="5"> min</div>
            <button class="btn-refresh" onclick="window.location.reload()">🔄 Rafraîchir</button>
        </div>

        <div id="progress-wrapper">
            <div id="progress-text">Préparation de l'envoi...</div>
            <div class="progress-track"><div id="progress-bar"></div></div>
        </div>

        <div class="section">
            <form action="/upload-files" method="POST" class="upload-form" autocomplete="off">
                <div class="input-group">
                    <input type="file" name="files" multiple required title="Sélectionner des fichiers">
                    <button type="submit">Fichiers</button>
                </div>
            </form>
            <form action="/upload-folder" method="POST" class="upload-form" autocomplete="off">
                <div class="input-group">
                    <input type="file" name="files" webkitdirectory directory multiple required title="Sélectionner un dossier">
                    <button type="submit">Dossier (ZIP)</button>
                </div>
            </form>
            <form action="/upload-text" method="POST" class="upload-form" autocomplete="off">
                <div class="input-group" style="align-items: flex-start;">
                    <textarea name="text" placeholder="Coller du texte..." required></textarea>
                    <button type="submit" style="height: 60px;">Texte</button>
                </div>
            </form>
        </div>

        <ul id="list">
            ${itemsHtml}
        </ul>

        <script>
            window.addEventListener('DOMContentLoaded', () => {
                document.querySelectorAll('.upload-form').forEach(form => form.reset());
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
                                if(!document.getElementById('empty-msg')) {
                                    list.innerHTML = '<p class="empty" id="empty-msg">Aucun fichier pour le moment.</p>';
                                }
                            }
                        }, 300);
                    }
                }
            };

            const tokens = JSON.parse(localStorage.getItem('ephemere_tokens') || '{}');
            document.querySelectorAll('.item').forEach(el => {
                const id = el.dataset.id;
                if (tokens[id]) {
                    const btn = document.createElement('button');
                    btn.innerText = 'Supprimer';
                    btn.className = 'btn-delete';
                    btn.onclick = () => {
                        fetch('/delete/' + id, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ token: tokens[id] })
                        }).then(() => {
                            delete tokens[id];
                            localStorage.setItem('ephemere_tokens', JSON.stringify(tokens));
                        });
                    };
                    el.querySelector('.item-actions').appendChild(btn);
                }
            });

            document.querySelectorAll('.upload-form').forEach(form => {
                form.addEventListener('submit', function(e) {
                    e.preventDefault();
                    const formData = new FormData(this);
                    formData.append('duration', document.getElementById('duration').value);

                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', this.action, true);
                    
                    const wrapper = document.getElementById('progress-wrapper');
                    const bar = document.getElementById('progress-bar');
                    const text = document.getElementById('progress-text');
                    const submitButtons = document.querySelectorAll('button[type="submit"]');
                    
                    wrapper.style.display = 'block';
                    submitButtons.forEach(b => b.disabled = true);

                    const startTime = Date.now();

                    xhr.upload.onprogress = function(e) {
                        if (e.lengthComputable) {
                            const percent = Math.round((e.loaded / e.total) * 100);
                            const elapsedSeconds = (Date.now() - startTime) / 1000;
                            const loadedMb = e.loaded / 1048576;
                            const totalMb = e.total / 1048576;
                            const remainingMb = totalMb - loadedMb;
                            const speedMb = elapsedSeconds > 0 ? loadedMb / elapsedSeconds : 0;

                            bar.style.width = percent + '%';
                            
                            if (form.action.includes('folder') && percent === 100) {
                                text.innerText = 'Compression ZIP en cours... (Veuillez patienter)';
                            } else {
                                text.innerText = \`\${percent}% | \${loadedMb.toFixed(2)} / \${totalMb.toFixed(2)} Mo | \${speedMb.toFixed(2)} Mo/s | Reste : \${remainingMb.toFixed(2)} Mo\`;
                            }
                        }
                    };

                    xhr.onload = function() {
                        if (xhr.status === 200) {
                            try {
                                const res = JSON.parse(xhr.responseText);
                                const currentTokens = JSON.parse(localStorage.getItem('ephemere_tokens') || '{}');
                                res.tokens.forEach(t => currentTokens[t.id] = t.token);
                                localStorage.setItem('ephemere_tokens', JSON.stringify(currentTokens));
                            } catch(err) {}
                            window.location.reload();
                        } else {
                            alert(xhr.responseText || 'Erreur lors de l\\'envoi.');
                            wrapper.style.display = 'none';
                            submitButtons.forEach(b => b.disabled = false);
                        }
                    };
                    xhr.send(formData);
                });
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

function getDelayMs(req) {
    let durationMin = parseInt(req.body.duration) || 5;
    if (durationMin < 1) durationMin = 1;
    if (durationMin > 15) durationMin = 15;
    return durationMin * 60 * 1000;
}

// SÉCURITÉ : Fonction de vérification ultime de la taille après upload (empêche la triche chunked)
function verifyStorageLimitPostUpload(reqFiles) {
    let incomingSize = 0;
    reqFiles.forEach(f => incomingSize += f.size);
    if (currentTotalSize + incomingSize > MAX_STORAGE_BYTES) {
        reqFiles.forEach(f => fs.unlink(f.path, () => {})); // On supprime l'excès
        return false;
    }
    return true;
}

app.post('/upload-files', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send('Aucun fichier.');
    if (!verifyStorageLimitPostUpload(req.files)) return res.status(413).send('Limite des 32 Go dépassée.');
    
    const delayMs = getDelayMs(req);
    const tokens = [];

    req.files.forEach(file => {
        const id = file.filename;
        const fileSize = file.size;
        currentTotalSize += fileSize;
        const deleteToken = crypto.randomBytes(16).toString('hex');
        
        storedItems.set(id, {
            id, originalName: file.originalname, path: file.path, size: fileSize,
            isText: false, activeDownloads: 0, deleteToken
        });
        scheduleDestruction(id, delayMs);
        tokens.push({ id, token: deleteToken });
    });
    res.json({ tokens });
});

app.post('/upload-folder', upload.array('files'), (req, res) => {
    if (!req.files || req.files.length === 0) return res.status(400).send('Dossier vide.');
    if (!verifyStorageLimitPostUpload(req.files)) return res.status(413).send('Limite des 32 Go dépassée.');
    
    const delayMs = getDelayMs(req);
    const id = crypto.randomBytes(8).toString('hex') + '-archive.zip';
    const zipPath = path.join(UPLOAD_DIR, id);
    
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 5 } });

    output.on('close', () => {
        const fileSize = archive.pointer();
        currentTotalSize += fileSize;
        const deleteToken = crypto.randomBytes(16).toString('hex');
        
        storedItems.set(id, {
            id, originalName: 'Dossier_Archive.zip', path: zipPath, size: fileSize,
            isText: false, activeDownloads: 0, deleteToken
        });
        scheduleDestruction(id, delayMs);
        
        req.files.forEach(f => fs.unlink(f.path, () => {}));
        res.json({ tokens: [{ id, token: deleteToken }] });
    });

    // SÉCURITÉ : Nettoyage en cas d'erreur de compression pour éviter les fichiers fantômes
    archive.on('error', (err) => {
        req.files.forEach(f => fs.unlink(f.path, () => {}));
        fs.unlink(zipPath, () => {});
        res.status(500).send(err.message);
    });

    archive.pipe(output);
    req.files.forEach(file => archive.file(file.path, { name: path.basename(file.originalname) }));
    archive.finalize();
});

app.post('/upload-text', upload.none(), (req, res) => {
    const textContent = req.body.text;
    if (!textContent || textContent.trim() === '') return res.status(400).send('Texte vide.');

    const delayMs = getDelayMs(req);
    const id = crypto.randomBytes(8).toString('hex') + '-texte.txt';
    const filePath = path.join(UPLOAD_DIR, id);
    const buffer = Buffer.from(textContent, 'utf-8');
    const fileSize = buffer.length;

    // SÉCURITÉ : On vérifie l'espace avant d'écrire le texte sur le disque
    if (currentTotalSize + fileSize > MAX_STORAGE_BYTES) return res.status(413).send('Limite des 32 Go dépassée.');

    fs.writeFile(filePath, buffer, (err) => {
        if (err) return res.status(500).send("Erreur de sauvegarde.");
        currentTotalSize += fileSize;
        const deleteToken = crypto.randomBytes(16).toString('hex');

        storedItems.set(id, {
            id, originalName: 'Texte collé', path: filePath, size: fileSize,
            isText: true, activeDownloads: 0, deleteToken
        });
        scheduleDestruction(id, delayMs);
        res.json({ tokens: [{ id, token: deleteToken }] });
    });
});

app.post('/delete/:id', (req, res) => {
    const item = storedItems.get(req.params.id);
    if (item && item.deleteToken === req.body.token) {
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

    res.download(item.path, item.originalName, (err) => {
        resumeTimer(item.id);
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Serveur minimaliste et sécurisé démarré sur http://localhost:${PORT}`);
});
