import { dialog } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface VoiceSampleQuality {
  status: "good" | "warning" | "unsupported";
  durationSeconds?: number;
  sampleRate?: number;
  channels?: number;
  notes: string[];
}

export interface VoiceSample {
  id: string;
  name: string;
  path: string;
  normalizedPath?: string;
  referencePath?: string;
  audioUrl?: string;
  sizeBytes: number;
  importedAt: string;
  quality: VoiceSampleQuality;
  promptText?: string;
}

export interface VoiceProfile {
  id: string;
  name: string;
  activeSampleId?: string;
  samples: VoiceSample[];
  updatedAt: string;
}

export interface RecordedSampleInput {
  name: string;
  mimeType: string;
  data: number[];
  promptText?: string;
}

const DATA_DIR = "auto_speech_data";
const PROFILE_ID = "default";
const RECORDING_PROMPT_TEXT =
  "这是我的声音样本，用来帮助软件生成自然清晰的中文旁白。请保持语速稳定，声音放松，录音环境尽量安静。";

export class VoiceProfileStore {
  constructor(private readonly projectRoot: string) {}

  async getDefaultProfile(): Promise<VoiceProfile> {
    await this.ensureProfile();
    return this.decorateProfile(await this.readProfile());
  }

  async importSamples(): Promise<VoiceProfile> {
    const result = await dialog.showOpenDialog({
      title: "导入声音样本",
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Audio",
          extensions: ["wav", "mp3", "m4a", "flac", "ogg", "webm"]
        }
      ]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return this.getDefaultProfile();
    }

    await this.ensureProfile();
    const profile = await this.readProfile();
    const samplesDir = this.samplesDir();
    await fs.mkdir(samplesDir, { recursive: true });

    for (const filePath of result.filePaths) {
      const stat = await fs.stat(filePath);
      const parsed = path.parse(filePath);
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const targetName = `${id}${parsed.ext.toLowerCase()}`;
      const targetPath = path.join(samplesDir, targetName);
      const normalizedPath = await this.normalizedSamplePath(id);
      const referencePath = await this.referenceSamplePath(id);

      await fs.copyFile(filePath, targetPath);
      const normalized = await normalizeAudio(targetPath, normalizedPath);
      const referenceCreated = await createReferenceAudio(normalized ? normalizedPath : targetPath, referencePath);
      profile.activeSampleId = id;
      profile.samples.push({
        id,
        name: parsed.base,
        path: targetPath,
        normalizedPath: normalized ? normalizedPath : undefined,
        referencePath: referenceCreated ? referencePath : undefined,
        sizeBytes: stat.size,
        importedAt: new Date().toISOString(),
        quality: await analyzeSample(normalized ? normalizedPath : targetPath),
        promptText: ""
      });
    }

    profile.updatedAt = new Date().toISOString();
    await this.writeProfile(profile);
    return this.decorateProfile(profile);
  }

  async deleteSample(sampleId: string): Promise<VoiceProfile> {
    await this.ensureProfile();
    const profile = await this.readProfile();
    const sample = profile.samples.find(item => item.id === sampleId);

    if (!sample) {
      return this.decorateProfile(profile);
    }

    const pathsToDelete = [sample.path, sample.normalizedPath, sample.referencePath].filter(Boolean) as string[];
    for (const filePath of pathsToDelete) {
      await deleteFileIfInside(filePath, this.projectRoot);
    }

    profile.samples = profile.samples.filter(item => item.id !== sampleId);
    if (profile.activeSampleId === sampleId) {
      profile.activeSampleId = profile.samples.at(-1)?.id;
    }
    profile.updatedAt = new Date().toISOString();
    await this.writeProfile(profile);
    return this.decorateProfile(profile);
  }

  async selectSample(sampleId: string): Promise<VoiceProfile> {
    await this.ensureProfile();
    const profile = await this.readProfile();
    const sample = profile.samples.find(item => item.id === sampleId);

    if (!sample) {
      return this.decorateProfile(profile);
    }

    profile.activeSampleId = sample.id;
    profile.updatedAt = new Date().toISOString();
    await this.writeProfile(profile);
    return this.decorateProfile(profile);
  }

  async updateSamplePromptText(sampleId: string, promptText: string): Promise<VoiceProfile> {
    await this.ensureProfile();
    const profile = await this.readProfile();
    const sample = profile.samples.find(item => item.id === sampleId);

    if (!sample) {
      return this.decorateProfile(profile);
    }

    sample.promptText = promptText.trim();
    delete (sample as VoiceSample & { referencePromptText?: string }).referencePromptText;
    profile.updatedAt = new Date().toISOString();
    await this.writeProfile(profile);
    return this.decorateProfile(profile);
  }

  async saveRecordedSample(input: RecordedSampleInput): Promise<VoiceProfile> {
    await this.ensureProfile();
    const profile = await this.readProfile();
    const samplesDir = this.samplesDir();
    await fs.mkdir(samplesDir, { recursive: true });

    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const extension = extensionFromMime(input.mimeType);
    const safeName = sanitizeName(input.name || "recorded-sample");
    const targetPath = path.join(samplesDir, `${id}-${safeName}${extension}`);
    const normalizedPath = await this.normalizedSamplePath(id);
    const referencePath = await this.referenceSamplePath(id);
    const buffer = Buffer.from(input.data);

    await fs.writeFile(targetPath, buffer);
    const normalized = await normalizeAudio(targetPath, normalizedPath);
    const referenceCreated = await createReferenceAudio(normalized ? normalizedPath : targetPath, referencePath);
    profile.activeSampleId = id;
    profile.samples.push({
      id,
      name: `${safeName}${extension}`,
      path: targetPath,
      normalizedPath: normalized ? normalizedPath : undefined,
      referencePath: referenceCreated ? referencePath : undefined,
      sizeBytes: buffer.byteLength,
      importedAt: new Date().toISOString(),
      quality: await analyzeSample(normalized ? normalizedPath : targetPath),
      promptText: input.promptText?.trim() || RECORDING_PROMPT_TEXT
    });

    profile.updatedAt = new Date().toISOString();
    await this.writeProfile(profile);
    return this.decorateProfile(profile);
  }

  private async ensureProfile(): Promise<void> {
    const filePath = this.profilePath();
    try {
      await fs.access(filePath);
    } catch {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.mkdir(this.samplesDir(), { recursive: true });
      await this.writeProfile({
        id: PROFILE_ID,
        name: "默认声音档案",
        activeSampleId: undefined,
        samples: [],
        updatedAt: new Date().toISOString()
      });
    }
  }

  private async readProfile(): Promise<VoiceProfile> {
    const content = await fs.readFile(this.profilePath(), "utf-8");
    return JSON.parse(content) as VoiceProfile;
  }

  private async writeProfile(profile: VoiceProfile): Promise<void> {
    await fs.writeFile(this.profilePath(), `${JSON.stringify(stripRuntimeFields(profile), null, 2)}\n`, "utf-8");
  }

  private profilePath(): string {
    return path.join(this.projectRoot, DATA_DIR, "profiles", PROFILE_ID, "profile.json");
  }

  private samplesDir(): string {
    return path.join(this.projectRoot, DATA_DIR, "profiles", PROFILE_ID, "samples");
  }

  private async normalizedSamplePath(id: string): Promise<string> {
    const normalizedDir = path.join(this.projectRoot, DATA_DIR, "profiles", PROFILE_ID, "normalized");
    await fs.mkdir(normalizedDir, { recursive: true });
    return path.join(normalizedDir, `${id}.wav`);
  }

  private async referenceSamplePath(id: string): Promise<string> {
    const referenceDir = path.join(this.projectRoot, DATA_DIR, "profiles", PROFILE_ID, "reference");
    await fs.mkdir(referenceDir, { recursive: true });
    return path.join(referenceDir, `${id}-ref.wav`);
  }

  private decorateProfile(profile: VoiceProfile): VoiceProfile {
    const activeSampleId = profile.samples.some(sample => sample.id === profile.activeSampleId)
      ? profile.activeSampleId
      : profile.samples.at(-1)?.id;
    return {
      ...profile,
      name: cleanProfileName(profile.name),
      activeSampleId,
      samples: profile.samples.map(sample => {
        const audioPath = sample.normalizedPath ?? sample.referencePath ?? sample.path;
        return {
          ...sample,
          audioUrl: audioPath ? mediaUrl(audioPath) : undefined
        };
      })
    };
  }
}

async function deleteFileIfInside(filePath: string, projectRoot: string): Promise<void> {
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(projectRoot);

  if (!resolvedPath.toLowerCase().startsWith(resolvedRoot.toLowerCase())) {
    return;
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

function extensionFromMime(mimeType: string): string {
  if (mimeType.includes("wav")) {
    return ".wav";
  }
  if (mimeType.includes("mp4")) {
    return ".m4a";
  }
  if (mimeType.includes("ogg")) {
    return ".ogg";
  }
  return ".webm";
}

function sanitizeName(name: string): string {
  return name
    .trim()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .slice(0, 80);
}

async function normalizeAudio(inputPath: string, outputPath: string): Promise<boolean> {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) {
    return false;
  }

  try {
    await execFileAsync(ffmpegPath, ["-y", "-i", inputPath, "-ac", "1", "-ar", "24000", "-sample_fmt", "s16", outputPath]);
    return true;
  } catch {
    return false;
  }
}

async function createReferenceAudio(inputPath: string, outputPath: string): Promise<boolean> {
  const ffmpegPath = await findFfmpeg();
  if (!ffmpegPath) {
    return false;
  }

  try {
    await execFileAsync(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-t",
      "8",
      "-ac",
      "1",
      "-ar",
      "24000",
      "-sample_fmt",
      "s16",
      outputPath
    ]);
    return true;
  } catch {
    return false;
  }
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

async function analyzeSample(filePath: string): Promise<VoiceSampleQuality> {
  if (path.extname(filePath).toLowerCase() !== ".wav") {
    return {
      status: "warning",
      notes: ["暂未解析该格式的时长信息，软件会尽量用 ffmpeg 转码。"]
    };
  }

  try {
    const buffer = await fs.readFile(filePath);
    const metadata = readWavMetadata(buffer);
    const notes: string[] = [];

    if (metadata.durationSeconds < 5) {
      notes.push("样本偏短，建议至少 10-30 秒干净人声。");
    }

    if (metadata.durationSeconds >= 60) {
      notes.push("样本较长，后续可自动切分。");
    }

    if (metadata.sampleRate < 16000) {
      notes.push("采样率偏低，建议 24000 Hz 或以上。");
    }

    if (metadata.channels > 1) {
      notes.push("多声道音频会在预处理时转为单声道。");
    }

    return {
      status: notes.length > 0 ? "warning" : "good",
      durationSeconds: metadata.durationSeconds,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      notes: notes.length > 0 ? notes : ["样本格式看起来可用。"]
    };
  } catch (error) {
    return {
      status: "unsupported",
      notes: [error instanceof Error ? error.message : "无法解析音频文件。"]
    };
  }
}

function readWavMetadata(buffer: Buffer): { durationSeconds: number; sampleRate: number; channels: number } {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("不是有效的 WAV 文件。");
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkDataStart = offset + 8;

    if (chunkId === "fmt ") {
      channels = buffer.readUInt16LE(chunkDataStart + 2);
      sampleRate = buffer.readUInt32LE(chunkDataStart + 4);
      bitsPerSample = buffer.readUInt16LE(chunkDataStart + 14);
    }

    if (chunkId === "data") {
      dataSize = chunkSize;
    }

    offset = chunkDataStart + chunkSize + (chunkSize % 2);
  }

  if (!channels || !sampleRate || !bitsPerSample || !dataSize) {
    throw new Error("WAV 元数据不完整。");
  }

  return {
    channels,
    sampleRate,
    durationSeconds: dataSize / (sampleRate * channels * (bitsPerSample / 8))
  };
}

function stripRuntimeFields(profile: VoiceProfile): VoiceProfile {
  return {
    ...profile,
    samples: profile.samples.map(sample => {
      const { audioUrl: _audioUrl, ...persistedSample } = sample;
      return persistedSample;
    })
  };
}

function cleanProfileName(name: string): string {
  return name && !name.includes("�") ? name : "默认声音档案";
}

function mediaUrl(filePath: string): string {
  return `auto-speech-media://file/${encodeURIComponent(filePath)}`;
}
