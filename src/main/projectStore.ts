import { dialog } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

export interface ScriptProject {
  id: string;
  name: string;
  script: string;
  updatedAt: string;
}

export interface ProjectTransferResult {
  canceled: boolean;
  path?: string;
  project?: ScriptProject;
}

export interface GeneratedHistoryEntry {
  id: string;
  text: string;
  path: string;
  audioUrl?: string;
  durationMs: number;
  itemCount: number;
  mode: "single" | "split";
  createdAt: string;
}

export interface DeletedHistoryEntry extends GeneratedHistoryEntry {
  deletedAt: string;
}

export interface HistoryCollections {
  history: GeneratedHistoryEntry[];
  trash: DeletedHistoryEntry[];
}

export interface AddGeneratedHistoryInput {
  text: string;
  path: string;
  durationMs: number;
  itemCount: number;
  mode: "single" | "split";
}

const DATA_DIR = "auto_speech_data";
const PROJECT_ID = "default";
const MAX_HISTORY = 20;

export class ProjectStore {
  constructor(private readonly projectRoot: string) {}

  async getDefaultProject(): Promise<ScriptProject> {
    await this.ensureProject();
    return this.readProject();
  }

  async saveDefaultProject(script: string): Promise<ScriptProject> {
    const project: ScriptProject = {
      id: PROJECT_ID,
      name: "默认项目",
      script,
      updatedAt: new Date().toISOString()
    };
    await fs.mkdir(path.dirname(this.projectPath()), { recursive: true });
    await fs.writeFile(this.projectPath(), `${JSON.stringify(project, null, 2)}\n`, "utf-8");
    return project;
  }

  async exportDefaultProject(): Promise<ProjectTransferResult> {
    const project = await this.getDefaultProject();
    const result = await dialog.showSaveDialog({
      title: "导出文案项目",
      defaultPath: path.join(process.env.USERPROFILE ?? this.projectRoot, "Desktop", "auto-speech-project.json"),
      filters: [{ name: "Auto Speech Project", extensions: ["json"] }]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const targetPath = ensureJsonExtension(result.filePath);
    await fs.writeFile(targetPath, `${JSON.stringify(project, null, 2)}\n`, "utf-8");
    return { canceled: false, path: targetPath, project };
  }

  async importProject(): Promise<ProjectTransferResult> {
    const result = await dialog.showOpenDialog({
      title: "导入文案项目",
      properties: ["openFile"],
      filters: [{ name: "Auto Speech Project", extensions: ["json"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true };
    }

    const sourcePath = result.filePaths[0];
    const content = await fs.readFile(sourcePath, "utf-8");
    const imported = JSON.parse(content) as Partial<ScriptProject>;
    if (typeof imported.script !== "string") {
      throw new Error("项目文件格式不正确，缺少 script 字段。");
    }

    const project = await this.saveDefaultProject(imported.script);
    return { canceled: false, path: sourcePath, project };
  }

  async getHistory(): Promise<GeneratedHistoryEntry[]> {
    await this.ensureProject();
    const history = await this.readHistory();
    return history.map(entry => this.decorateHistoryEntry(entry));
  }

  async getHistoryTrash(): Promise<DeletedHistoryEntry[]> {
    await this.ensureProject();
    const trash = await this.readHistoryTrash();
    return trash.map(entry => this.decorateDeletedHistoryEntry(entry));
  }

  async addHistory(input: AddGeneratedHistoryInput): Promise<GeneratedHistoryEntry[]> {
    await this.ensureProject();
    const history = await this.readHistory();
    const entry: GeneratedHistoryEntry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      text: input.text,
      path: input.path,
      durationMs: input.durationMs,
      itemCount: input.itemCount,
      mode: input.mode,
      createdAt: new Date().toISOString()
    };
    const nextHistory = [entry, ...history.filter(item => item.path !== input.path)].slice(0, MAX_HISTORY);
    await this.writeHistory(nextHistory);
    return nextHistory.map(item => this.decorateHistoryEntry(item));
  }

  async deleteHistory(ids: string[]): Promise<GeneratedHistoryEntry[]> {
    await this.ensureProject();
    const idSet = new Set(ids.filter(Boolean));
    if (idSet.size === 0) {
      return this.getHistory();
    }

    const history = await this.readHistory();
    const trash = await this.readHistoryTrash();
    const deletedAt = new Date().toISOString();
    const deletedEntries = history
      .filter(item => idSet.has(item.id))
      .map(item => ({ ...item, deletedAt }));
    const nextHistory = history.filter(item => !idSet.has(item.id));
    const nextTrash = [...deletedEntries, ...trash.filter(item => !idSet.has(item.id))];
    await this.writeHistory(nextHistory);
    await this.writeHistoryTrash(nextTrash);
    return nextHistory.map(item => this.decorateHistoryEntry(item));
  }

  async clearHistory(): Promise<GeneratedHistoryEntry[]> {
    await this.ensureProject();
    const history = await this.readHistory();
    if (history.length > 0) {
      const trash = await this.readHistoryTrash();
      const deletedAt = new Date().toISOString();
      const deletedEntries = history.map(item => ({ ...item, deletedAt }));
      await this.writeHistoryTrash([...deletedEntries, ...trash]);
    }
    await this.writeHistory([]);
    return [];
  }

  async restoreHistory(ids: string[]): Promise<HistoryCollections> {
    await this.ensureProject();
    const idSet = new Set(ids.filter(Boolean));
    const history = await this.readHistory();
    const trash = await this.readHistoryTrash();
    const restored = trash
      .filter(item => idSet.has(item.id))
      .map(({ deletedAt: _deletedAt, ...entry }) => entry);
    const nextTrash = trash.filter(item => !idSet.has(item.id));
    const nextHistory = [...restored, ...history.filter(item => !idSet.has(item.id))].slice(0, MAX_HISTORY);
    await this.writeHistory(nextHistory);
    await this.writeHistoryTrash(nextTrash);
    return {
      history: nextHistory.map(item => this.decorateHistoryEntry(item)),
      trash: nextTrash.map(item => this.decorateDeletedHistoryEntry(item))
    };
  }

  async emptyHistoryTrash(): Promise<DeletedHistoryEntry[]> {
    await this.ensureProject();
    const trash = await this.readHistoryTrash();
    await Promise.all(trash.map(entry => deleteFileIfInside(entry.path, this.projectRoot)));
    await this.writeHistoryTrash([]);
    return [];
  }

  private async ensureProject(): Promise<void> {
    try {
      await fs.access(this.projectPath());
    } catch {
      await this.saveDefaultProject("");
    }
  }

  private async readProject(): Promise<ScriptProject> {
    const content = await fs.readFile(this.projectPath(), "utf-8");
    const project = JSON.parse(content) as ScriptProject;
    return {
      ...project,
      name: cleanProjectName(project.name)
    };
  }

  private async readHistory(): Promise<GeneratedHistoryEntry[]> {
    try {
      const content = await fs.readFile(this.historyPath(), "utf-8");
      const history = JSON.parse(content) as GeneratedHistoryEntry[];
      return Array.isArray(history) ? history.slice(0, MAX_HISTORY) : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async readHistoryTrash(): Promise<DeletedHistoryEntry[]> {
    try {
      const content = await fs.readFile(this.historyTrashPath(), "utf-8");
      const trash = JSON.parse(content) as DeletedHistoryEntry[];
      return Array.isArray(trash) ? trash : [];
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    }
  }

  private async writeHistory(history: GeneratedHistoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.historyPath()), { recursive: true });
    await fs.writeFile(this.historyPath(), `${JSON.stringify(history.slice(0, MAX_HISTORY), null, 2)}\n`, "utf-8");
  }

  private async writeHistoryTrash(trash: DeletedHistoryEntry[]): Promise<void> {
    await fs.mkdir(path.dirname(this.historyTrashPath()), { recursive: true });
    await fs.writeFile(this.historyTrashPath(), `${JSON.stringify(trash, null, 2)}\n`, "utf-8");
  }

  private decorateHistoryEntry(entry: GeneratedHistoryEntry): GeneratedHistoryEntry {
    return {
      ...entry,
      audioUrl: mediaUrl(entry.path)
    };
  }

  private decorateDeletedHistoryEntry(entry: DeletedHistoryEntry): DeletedHistoryEntry {
    return {
      ...entry,
      audioUrl: mediaUrl(entry.path)
    };
  }

  private projectPath(): string {
    return path.join(this.projectRoot, DATA_DIR, "projects", PROJECT_ID, "script.json");
  }

  private historyPath(): string {
    return path.join(this.projectRoot, DATA_DIR, "projects", PROJECT_ID, "history.json");
  }

  private historyTrashPath(): string {
    return path.join(this.projectRoot, DATA_DIR, "projects", PROJECT_ID, "history-trash.json");
  }
}

function cleanProjectName(name: string): string {
  return name && !name.includes("�") ? name : "默认项目";
}

function ensureJsonExtension(filePath: string): string {
  return path.extname(filePath).toLowerCase() === ".json" ? filePath : `${filePath}.json`;
}

function mediaUrl(filePath: string): string {
  return `auto-speech-media://file/${encodeURIComponent(filePath)}`;
}

async function deleteFileIfInside(filePath: string, projectRoot: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(projectRoot);
  const relativePath = path.relative(resolvedRoot, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Refusing to delete a file outside the project folder.");
  }

  try {
    await fs.unlink(resolvedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }
}
