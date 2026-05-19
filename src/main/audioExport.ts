import { dialog, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export type ExportFormat = "wav" | "mp3";

export interface AudioExportInput {
  sourcePath: string;
  format: ExportFormat;
}

export interface AudioExportResult {
  canceled: boolean;
  path?: string;
}

export class AudioExporter {
  constructor(private readonly projectRoot: string) {}

  async exportAudio(input: AudioExportInput): Promise<AudioExportResult> {
    const sourcePath = this.resolveProjectFile(input.sourcePath);
    await fs.access(sourcePath);
    const defaultPath = path.join(
      process.env.USERPROFILE ?? this.projectRoot,
      "Desktop",
      `auto-speech-${timestampForFile()}.${input.format}`
    );

    const result = await dialog.showSaveDialog({
      title: input.format === "mp3" ? "导出 MP3 音频" : "导出 WAV 音频",
      defaultPath,
      filters: [
        {
          name: input.format.toUpperCase(),
          extensions: [input.format]
        }
      ]
    });

    if (result.canceled || !result.filePath) {
      return { canceled: true };
    }

    const targetPath = ensureExtension(result.filePath, input.format);
    if (input.format === "wav") {
      await fs.copyFile(sourcePath, targetPath);
    } else {
      await exportMp3(sourcePath, targetPath);
    }

    return { canceled: false, path: targetPath };
  }

  async showInFolder(sourcePath: string): Promise<void> {
    const resolvedPath = this.resolveProjectFile(sourcePath);
    await fs.access(resolvedPath);
    shell.showItemInFolder(resolvedPath);
  }

  private resolveProjectFile(sourcePath: string): string {
    const resolvedPath = path.resolve(sourcePath);
    const resolvedRoot = path.resolve(this.projectRoot);
    if (!resolvedPath.toLowerCase().startsWith(resolvedRoot.toLowerCase())) {
      throw new Error("只能打开当前项目里的音频文件。");
    }
    return resolvedPath;
  }
}

async function exportMp3(sourcePath: string, targetPath: string): Promise<void> {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) {
    throw new Error("没有找到 ffmpeg，暂时无法导出 MP3。");
  }

  await execFileAsync(ffmpegPath, [
    "-y",
    "-i",
    sourcePath,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "192k",
    targetPath
  ]);
}

async function findFfmpeg(): Promise<string | undefined> {
  const candidates = [
    "ffmpeg",
    path.join(
      process.env.LOCALAPPDATA ?? "",
      "Microsoft",
      "WinGet",
      "Packages",
      "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe",
      "ffmpeg-8.1.1-full_build",
      "bin",
      "ffmpeg.exe"
    )
  ];

  for (const candidate of candidates) {
    if (await canRun(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

async function canRun(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true }, error => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function ensureExtension(filePath: string, extension: ExportFormat): string {
  return path.extname(filePath).toLowerCase() === `.${extension}` ? filePath : `${filePath}.${extension}`;
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}
