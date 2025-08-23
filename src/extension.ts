import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

let selectedFolders: string[] = [];
let currentIndex = 0;
let imagesByKey: Map<string, string[]> = new Map();
let keys: string[] = [];
let panel: vscode.WebviewPanel | null = null;

// по умолчанию — твоя регулярка
let currentRegex: RegExp | null = /(\d{5,8})(?=\D*$)/;

export function activate(context: vscode.ExtensionContext) {
    context.subscriptions.push(
        vscode.commands.registerCommand('multi-image-viewer.openFolders', async () => {
            try {
                selectedFolders = [];
                currentIndex = 0;

                await pickFolders();

                if (selectedFolders.length === 0) {
                    vscode.window.showWarningMessage("No folders selected");
                    return;
                }

                buildImageMap();

                if (keys.length === 0) {
                    vscode.window.showWarningMessage("No matching images found");
                    return;
                }

                openImageViewer();
            } catch (err: any) {
                vscode.window.showErrorMessage(`Error opening folders: ${err.message}`);
                console.error(err);
            }
        }),

        vscode.commands.registerCommand('multi-image-viewer.nextImage', () => {
            if (keys.length === 0) return;
            currentIndex = (currentIndex + 1) % keys.length;
            refreshPanel();
        }),

        vscode.commands.registerCommand('multi-image-viewer.prevImage', () => {
            if (keys.length === 0) return;
            currentIndex = (currentIndex - 1 + keys.length) % keys.length;
            refreshPanel();
        }),

        vscode.commands.registerCommand('multi-image-viewer.setRegex', async () => {
            const input = await vscode.window.showInputBox({
                prompt: "Enter custom regex (leave empty to use full filename)",
                value: currentRegex?.source ?? ""
            });
            if (input === undefined) return; // Esc
            if (input.trim() === "") {
                currentRegex = null; // отключаем, будет всё имя
                vscode.window.showInformationMessage("Regex cleared, using full filename");
            } else {
                try {
                    currentRegex = new RegExp(input);
                    vscode.window.showInformationMessage(`Regex updated: ${input}`);
                } catch (e: any) {
                    vscode.window.showErrorMessage(`Invalid regex: ${e.message}`);
                }
            }
            buildImageMap();
            refreshPanel();
        })
    );
}

async function pickFolders() {
    while (true) {
        const items = [
            { label: "➕ Add new folder" },
            ...selectedFolders.map(f => ({ label: f, description: "Selected folder" })),
            ...selectedFolders.map(f => ({ label: `❌ Remove ${f}`, description: "Remove this folder" }))
        ];

        const choice = await vscode.window.showQuickPick(items, {
            placeHolder: "Manage selected folders"
        });

        if (!choice) break; // Esc

        if (choice.label === "➕ Add new folder") {
            const uris = await vscode.window.showOpenDialog({
                canSelectFolders: true,
                canSelectMany: false,
                canSelectFiles: false,
                openLabel: "Select folder",
                defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
            });
            if (uris && uris.length > 0) {
                const folder = uris[0].fsPath;
                if (!selectedFolders.includes(folder)) {
                    selectedFolders.push(folder);
                } else {
                    vscode.window.showInformationMessage("This folder is already selected");
                }
            }
        } else if (choice.label.startsWith("❌ Remove ")) {
            const toRemove = choice.label.replace("❌ Remove ", "");
            selectedFolders = selectedFolders.filter(f => f !== toRemove);
        }

        console.log("Current selected folders:", selectedFolders);

        if (selectedFolders.length === 0) {
            vscode.window.showWarningMessage("No folders selected");
            break;
        }
    }
}

function buildImageMap() {
    try {
        imagesByKey.clear();

        for (const folder of selectedFolders) {
            const files = fs.readdirSync(folder)
                .filter(f => /\.(png|jpg|jpeg|bmp|tiff|webp)$/i.test(f));

            for (const f of files) {
                let key: string;
                if (currentRegex) {
                    const match = f.match(currentRegex);
                    key = match ? match[1] : path.parse(f).name;
                } else {
                    key = path.parse(f).name;
                }

                const full = path.join(folder, f);

                if (!imagesByKey.has(key)) {
                    imagesByKey.set(key, new Array(selectedFolders.length).fill(""));
                }

                const arr = imagesByKey.get(key)!;
                const idx = selectedFolders.indexOf(folder);
                arr[idx] = full;
            }
        }

        keys = Array.from(imagesByKey.keys()).sort((a, b) => Number(a) - Number(b));

        console.log("=== Mapped keys ===");
        for (const [key, arr] of imagesByKey.entries()) {
            console.log(
                `${key}:`,
                arr.map((f, i) => f ? `${i}:${path.basename(f)}` : `${i}:---`).join(" | ")
            );
        }
        console.log(`=== Total keys: ${keys.length} ===`);

    } catch (err: any) {
        vscode.window.showErrorMessage(`Error parsing files: ${err.message}`);
        console.error(err);
    }
}

function openImageViewer() {
    panel = vscode.window.createWebviewPanel(
        'imageViewer',
        'Image Viewer',
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    panel.webview.onDidReceiveMessage(msg => {
        try {
            if (msg.command === "next") {
                currentIndex = (currentIndex + 1) % keys.length;
                refreshPanel();
            } else if (msg.command === "prev") {
                currentIndex = (currentIndex - 1 + keys.length) % keys.length;
                refreshPanel();
            } else if (msg.command === "jump") {
                const idx = parseInt(msg.value) - 1;
                if (!isNaN(idx) && idx >= 0 && idx < keys.length) {
                    currentIndex = idx;
                    refreshPanel();
                }
            } else if (msg.command === "addFolder") {
                pickFolders().then(() => {
                    buildImageMap();
                    refreshPanel();
                });
            } else if (msg.command === "setRegex") {
                vscode.commands.executeCommand('multi-image-viewer.setRegex');
            }
        } catch (err: any) {
            vscode.window.showErrorMessage(`Error in panel handler: ${err.message}`);
            console.error(err);
        }
    });

    refreshPanel();
}

function refreshPanel() {
    if (!panel || keys.length === 0) return;

    if (currentIndex >= keys.length) currentIndex = 0;
    const key = keys[currentIndex];
    const imgs = imagesByKey.get(key)!;

    const imgTags = imgs.map((filePath, idx) => {
        if (!filePath) {
            return `<div class="imgbox"><p>No file</p></div>`;
        }
        const imgUri = panel!.webview.asWebviewUri(vscode.Uri.file(filePath));
        const folderName = path.basename(selectedFolders[idx]);
        const fileName = path.basename(filePath);
        return `<div class="imgbox">
                    <p>${folderName}</p>
                    <img src="${imgUri}" />
                    <p class="filename">${fileName}</p>
                </div>`;
    }).join("");

    const folderList = selectedFolders.map(f => `<li>${f}</li>`).join("");
    const regexInfo = currentRegex ? `/${currentRegex.source}/` : "Using full filename";

    panel.webview.html = `
        <html>
        <body>
            <h3>Selected folders:</h3>
            <ul>${folderList}</ul>
            <p><b>Current regex:</b> ${regexInfo}</p>
            <button id="addFolderBtn">Manage Folders</button>
            <button id="setRegexBtn">Set Regex</button>

            <div class="container">${imgTags}</div>
            <div class="controls">
                <button id="prevBtn">⬅️ Previous</button>
                <span>${currentIndex + 1} / ${keys.length} (key=${key})</span>
                <button id="nextBtn">Next ➡️</button>
                <input id="jumpInput" type="number" min="1" max="${keys.length}" placeholder="Go to index"/>
                <button id="jumpBtn">Go</button>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                document.getElementById("prevBtn").addEventListener("click", () => vscode.postMessage({ command: "prev" }));
                document.getElementById("nextBtn").addEventListener("click", () => vscode.postMessage({ command: "next" }));
                document.getElementById("jumpBtn").addEventListener("click", () => {
                    const val = document.getElementById("jumpInput").value;
                    vscode.postMessage({ command: "jump", value: val });
                });
                document.getElementById("addFolderBtn").addEventListener("click", () => vscode.postMessage({ command: "addFolder" }));
                document.getElementById("setRegexBtn").addEventListener("click", () => vscode.postMessage({ command: "setRegex" }));
                window.addEventListener("keydown", (e) => {
                    if (e.key === "ArrowLeft") vscode.postMessage({ command: "prev" });
                    if (e.key === "ArrowRight") vscode.postMessage({ command: "next" });
                });
            </script>

            <style>
                body { margin:0; padding:10px; background:#222; color:#eee; font-family:sans-serif; }
                ul { color:#ccc; }
                .container { display:flex; flex-wrap:wrap; justify-content:center; }
                .imgbox { margin:10px; text-align:center; width:300px; max-width:23%; min-width:200px; border:1px solid #444; padding:5px; }
                .imgbox img { max-width:100%; max-height:40vh; border:1px solid #444; }
                .filename { font-size:12px; color:#aaa; }
                .controls { text-align:center; margin-top:10px; }
                button, input { margin: 0 5px; }
            </style>
        </body>
        </html>`;
}
