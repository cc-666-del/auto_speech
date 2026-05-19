import { app, BrowserWindow, ipcMain, protocol } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { AudioExporter } from "./audioExport.js";
import { ModelManager } from "./modelManager.js";
import { ProjectStore } from "./projectStore.js";
import { VoiceProfileStore } from "./voiceProfiles.js";

const projectRoot = app.getAppPath();
const modelManager = new ModelManager(projectRoot);
const voiceProfileStore = new VoiceProfileStore(projectRoot);
const projectStore = new ProjectStore(projectRoot);
const audioExporter = new AudioExporter(projectRoot);

let mainWindow: BrowserWindow | undefined;

protocol.registerSchemesAsPrivileged([
  {
    scheme: "auto-speech-media",
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      supportFetchAPI: true
    }
  }
]);

function registerMediaProtocol(): void {
  protocol.handle("auto-speech-media", async request => {
    const requestUrl = new URL(request.url);
    const decodedPath = decodeURIComponent(requestUrl.pathname.slice(1));
    const resolvedPath = path.resolve(decodedPath);
    const resolvedRoot = path.resolve(projectRoot);
    const relativePath = path.relative(resolvedRoot, resolvedPath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Forbidden", { status: 403 });
    }

    try {
      return await createMediaResponse(resolvedPath, request.headers.get("range"));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return new Response(code === "ENOENT" ? "Not found" : "Unable to read media", {
        status: code === "ENOENT" ? 404 : 500
      });
    }
  });
}

async function createMediaResponse(filePath: string, rangeHeader: string | null): Promise<Response> {
  const stat = await fs.stat(filePath);
  const fileSize = stat.size;
  let start = 0;
  let end = fileSize - 1;
  let status = 200;

  if (rangeHeader) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
    if (!match) {
      return new Response("Invalid range", { status: 416 });
    }

    const [, startText, endText] = match;
    start = startText ? Number(startText) : 0;
    end = endText ? Number(endText) : fileSize - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= fileSize || end < start) {
      return new Response("Range not satisfiable", { status: 416 });
    }
    end = Math.min(end, fileSize - 1);
    status = 206;
  }

  const body = await fs.readFile(filePath);
  const chunk = body.subarray(start, end + 1);
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(chunk.byteLength),
    "Content-Type": mediaContentType(filePath)
  });

  if (status === 206) {
    headers.set("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  }

  return new Response(chunk, { status, headers });
}

function mediaContentType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".wav") {
    return "audio/wav";
  }
  if (extension === ".mp3") {
    return "audio/mpeg";
  }
  if (extension === ".m4a") {
    return "audio/mp4";
  }
  if (extension === ".ogg") {
    return "audio/ogg";
  }
  if (extension === ".webm") {
    return "audio/webm";
  }
  return "application/octet-stream";
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f6f3ee",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (!app.isPackaged) {
    void mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    void mainWindow.loadFile(path.join(projectRoot, "dist", "renderer", "index.html"));
  }
}

ipcMain.handle("model:status", () => modelManager.status());
ipcMain.handle("model:start", () => modelManager.start());
ipcMain.handle("model:load", () => modelManager.load());
ipcMain.handle("model:unload", () => modelManager.unload());
ipcMain.handle("model:shutdown", () => modelManager.shutdown());
ipcMain.handle("model:setupCosyVoice", () => modelManager.setupCosyVoice());
ipcMain.handle("voice:getDefaultProfile", () => voiceProfileStore.getDefaultProfile());
ipcMain.handle("voice:importSamples", () => voiceProfileStore.importSamples());
ipcMain.handle("voice:saveRecording", (_event, input) => voiceProfileStore.saveRecordedSample(input));
ipcMain.handle("voice:deleteSample", (_event, sampleId: string) => voiceProfileStore.deleteSample(sampleId));
ipcMain.handle("voice:selectSample", (_event, sampleId: string) => voiceProfileStore.selectSample(sampleId));
ipcMain.handle("voice:updateSamplePromptText", (_event, sampleId: string, promptText: string) =>
  voiceProfileStore.updateSamplePromptText(sampleId, promptText)
);
ipcMain.handle("project:getDefault", () => projectStore.getDefaultProject());
ipcMain.handle("project:saveDefault", (_event, script: string) => projectStore.saveDefaultProject(script));
ipcMain.handle("project:exportDefault", () => projectStore.exportDefaultProject());
ipcMain.handle("project:import", () => projectStore.importProject());
ipcMain.handle("project:getHistory", () => projectStore.getHistory());
ipcMain.handle("project:getHistoryTrash", () => projectStore.getHistoryTrash());
ipcMain.handle("project:addHistory", (_event, input) => projectStore.addHistory(input));
ipcMain.handle("project:deleteHistory", (_event, ids: string[]) => projectStore.deleteHistory(ids));
ipcMain.handle("project:clearHistory", () => projectStore.clearHistory());
ipcMain.handle("project:restoreHistory", (_event, ids: string[]) => projectStore.restoreHistory(ids));
ipcMain.handle("project:emptyHistoryTrash", () => projectStore.emptyHistoryTrash());
ipcMain.handle("audio:export", (_event, input) => audioExporter.exportAudio(input));
ipcMain.handle("audio:showInFolder", (_event, sourcePath: string) => audioExporter.showInFolder(sourcePath));

app.whenReady().then(async () => {
  registerMediaProtocol();
  createWindow();
  try {
    await modelManager.start();
    await modelManager.load();
  } catch (error) {
    console.error("[model-service] Auto-load failed:", error);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", event => {
  event.preventDefault();
  modelManager.shutdown().finally(() => {
    app.exit(0);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
