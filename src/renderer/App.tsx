import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AudioLines,
  Check,
  Download,
  FolderOpen,
  Loader2,
  Mic2,
  Pause,
  Play,
  Power,
  RefreshCw,
  Save,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload
} from "lucide-react";
import "./styles.css";

type ModelRuntimeState = "stopped" | "starting" | "loading_model" | "ready" | "generating" | "unloading" | "error";
type ActiveView = "project" | "voice" | "model";
type VoiceStyle = "natural" | "warm" | "steady";
type GenerationMode = "single" | "split";

interface GpuInfo {
  name: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

interface ModelStatus {
  state: ModelRuntimeState;
  pid?: number;
  serviceUrl: string;
  gpu?: GpuInfo;
  error?: string;
}

interface GeneratedAudioItem {
  index: number;
  text: string;
  path: string;
  url: string;
  durationMs: number;
}

interface MergedAudio {
  path: string;
  url: string;
  durationMs: number;
}

interface VoiceSample {
  id: string;
  name: string;
  path: string;
  normalizedPath?: string;
  referencePath?: string;
  audioUrl?: string;
  sizeBytes: number;
  importedAt: string;
  quality: {
    status: "good" | "warning" | "unsupported";
    durationSeconds?: number;
    sampleRate?: number;
    channels?: number;
    notes: string[];
  };
  promptText?: string;
}

interface RecordedSampleInput {
  name: string;
  mimeType: string;
  data: number[];
  promptText?: string;
}

interface VoiceProfile {
  id: string;
  name: string;
  activeSampleId?: string;
  samples: VoiceSample[];
  updatedAt: string;
}

interface ScriptProject {
  id: string;
  name: string;
  script: string;
  updatedAt: string;
}

interface AudioExportResult {
  canceled: boolean;
  path?: string;
}

interface ProjectTransferResult {
  canceled: boolean;
  path?: string;
  project?: ScriptProject;
}

interface GeneratedHistoryEntry {
  id: string;
  text: string;
  path: string;
  audioUrl?: string;
  durationMs: number;
  itemCount: number;
  mode: GenerationMode;
  createdAt: string;
}

interface DeletedHistoryEntry extends GeneratedHistoryEntry {
  deletedAt: string;
}

interface HistoryCollections {
  history: GeneratedHistoryEntry[];
  trash: DeletedHistoryEntry[];
}

const defaultStatus: ModelStatus = {
  state: "stopped",
  serviceUrl: "http://127.0.0.1:8765"
};

const defaultVoiceProfile: VoiceProfile = {
  id: "default",
  name: "默认声音档案",
  activeSampleId: undefined,
  samples: [],
  updatedAt: new Date(0).toISOString()
};

const starterScript = "";
const maxSingleGenerationChars = 300;

const recordingPromptText =
  "这是我的声音样本，用来帮助软件生成自然清晰的中文旁白。请保持语速稳定，声音放松，录音环境尽量安静。";

const browserPreviewModelApi = {
  status: async () => defaultStatus,
  start: async () => ({ ...defaultStatus, state: "starting" as const }),
  load: async () => ({
    ...defaultStatus,
    state: "ready" as const,
    gpu: { name: "Browser preview", totalMb: 0, usedMb: 0, freeMb: 0 }
  }),
  unload: async () => defaultStatus,
  shutdown: async () => defaultStatus,
  setupCosyVoice: async () => ({
    started: false,
    scriptPath: "",
    message: "CosyVoice setup is only available in the desktop app."
  })
};

const browserPreviewVoiceApi = {
  getDefaultProfile: async () => defaultVoiceProfile,
  importSamples: async () => defaultVoiceProfile,
  saveRecording: async (_input: RecordedSampleInput) => defaultVoiceProfile,
  deleteSample: async (_sampleId: string) => defaultVoiceProfile,
  selectSample: async (_sampleId: string) => defaultVoiceProfile,
  updateSamplePromptText: async (_sampleId: string, _promptText: string) => defaultVoiceProfile
};

const browserPreviewProjectApi = {
  getDefault: async (): Promise<ScriptProject> => ({
    id: "default",
    name: "浏览器预览",
    script: starterScript,
    updatedAt: new Date().toISOString()
  }),
  saveDefault: async (script: string): Promise<ScriptProject> => ({
    id: "default",
    name: "浏览器预览",
    script,
    updatedAt: new Date().toISOString()
  }),
  exportDefault: async (): Promise<ProjectTransferResult> => ({ canceled: true }),
  import: async (): Promise<ProjectTransferResult> => ({ canceled: true }),
  getHistory: async (): Promise<GeneratedHistoryEntry[]> => [],
  addHistory: async (_input: {
    text: string;
    path: string;
    durationMs: number;
    itemCount: number;
    mode: GenerationMode;
  }): Promise<GeneratedHistoryEntry[]> => [],
  getHistoryTrash: async (): Promise<DeletedHistoryEntry[]> => [],
  deleteHistory: async (_ids: string[]): Promise<GeneratedHistoryEntry[]> => [],
  clearHistory: async (): Promise<GeneratedHistoryEntry[]> => [],
  restoreHistory: async (_ids: string[]): Promise<HistoryCollections> => ({ history: [], trash: [] }),
  emptyHistoryTrash: async (): Promise<DeletedHistoryEntry[]> => []
};

const browserPreviewAudioApi = {
  export: async (_input: { sourcePath: string; format: "wav" | "mp3" }): Promise<AudioExportResult> => ({ canceled: true }),
  showInFolder: async (_sourcePath: string): Promise<void> => undefined
};

function modelApi() {
  return window.autoSpeech?.model ?? browserPreviewModelApi;
}

function voiceApi() {
  return window.autoSpeech?.voice ?? browserPreviewVoiceApi;
}

function projectApi() {
  return window.autoSpeech?.project ?? browserPreviewProjectApi;
}

function audioApi() {
  return window.autoSpeech?.audio ?? browserPreviewAudioApi;
}

function profilePromptDrafts(profile: VoiceProfile) {
  return Object.fromEntries(profile.samples.map(sample => [sample.id, sample.promptText ?? ""]));
}

function App() {
  const [activeView, setActiveView] = useState<ActiveView>("project");
  const [modelStatus, setModelStatus] = useState<ModelStatus>(defaultStatus);
  const [script, setScript] = useState(starterScript);
  const [isBusy, setIsBusy] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedItems, setGeneratedItems] = useState<GeneratedAudioItem[]>([]);
  const [mergedAudio, setMergedAudio] = useState<MergedAudio | undefined>();
  const [history, setHistory] = useState<GeneratedHistoryEntry[]>([]);
  const [historyTrash, setHistoryTrash] = useState<DeletedHistoryEntry[]>([]);
  const [selectedHistoryIds, setSelectedHistoryIds] = useState<Set<string>>(new Set());
  const [generationError, setGenerationError] = useState<string | undefined>();
  const [modelMessage, setModelMessage] = useState<string | undefined>();
  const [exportMessage, setExportMessage] = useState<string | undefined>();
  const [isExporting, setIsExporting] = useState(false);
  const [voiceProfile, setVoiceProfile] = useState<VoiceProfile>(defaultVoiceProfile);
  const [project, setProject] = useState<ScriptProject | undefined>();
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">("idle");
  const [projectMessage, setProjectMessage] = useState<string | undefined>();
  const [recordingState, setRecordingState] = useState<"idle" | "recording" | "saving">("idle");
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordingError, setRecordingError] = useState<string | undefined>();
  const [promptDrafts, setPromptDrafts] = useState<Record<string, string>>({});
  const [sentenceGenerating, setSentenceGenerating] = useState<Record<number, boolean>>({});
  const [generationMode, setGenerationMode] = useState<GenerationMode>("single");
  const [speechRate, setSpeechRate] = useState(100);
  const [pauseMs, setPauseMs] = useState(500);
  const [voiceStyle, setVoiceStyle] = useState<VoiceStyle>("natural");
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const chunksRef = useRef<BlobPart[]>([]);
  const projectLoadedRef = useRef(false);
  const saveTimerRef = useRef<number | undefined>(undefined);

  const sentences = useMemo(
    () =>
      script
        .split(/(?<=[。！？!?])/)
        .map(item => item.trim())
        .filter(Boolean),
    [script]
  );

  const selectedSample =
    voiceProfile.samples.find(sample => sample.id === voiceProfile.activeSampleId) ?? voiceProfile.samples.at(-1);

  async function refreshStatus() {
    const status = await modelApi().status();
    setModelStatus(status);
  }

  function syncPromptDrafts(profile: VoiceProfile) {
    setPromptDrafts(profilePromptDrafts(profile));
  }

  async function runModelAction(action: "start" | "load" | "unload" | "shutdown") {
    setIsBusy(true);
    setModelMessage(undefined);
    try {
      const status = await modelApi()[action]();
      setModelStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Model action failed.";
      setModelStatus(current => ({ ...current, state: "error", error: message }));
      await refreshStatus();
    } finally {
      setIsBusy(false);
    }
  }

  async function runModelSetup() {
    setIsBusy(true);
    setModelMessage(undefined);
    try {
      const result = await modelApi().setupCosyVoice();
      setModelMessage(result.message);
    } catch (error) {
      setModelMessage(error instanceof Error ? error.message : "Unable to start CosyVoice setup.");
    } finally {
      setIsBusy(false);
    }
  }

  async function generateNarration(textOverride = script, modeOverride = generationMode) {
    const text = textOverride.trim();
    if (!text) {
      return;
    }

    setIsGenerating(true);
    setGenerationError(undefined);

    try {
      if (modeOverride === "single" && text.length > maxSingleGenerationChars) {
        throw new Error(`整段生成最多 ${maxSingleGenerationChars} 个字。请缩短文案，或切换到分句模式。`);
      }
      if (!selectedSample) {
        throw new Error("请先录制或导入一段声音样本。");
      }
      if (!(selectedSample.promptText ?? "").trim()) {
        throw new Error("请先给当前声音样本填写并保存“实际朗读文本”，内容必须和样本音频一致。");
      }

      const savedProject = await projectApi().saveDefault(script);
      setProject(savedProject);
      setSaveState("saved");

      let currentStatus = modelStatus;
      if (currentStatus.state !== "ready") {
        currentStatus = await modelApi().load();
        setModelStatus(currentStatus);
      }

      const response = await fetch(`${currentStatus.serviceUrl}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, pauseMs, split: modeOverride === "split" })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(payload?.error ?? `生成失败：${response.status}`);
      }

      const payload = (await response.json()) as { items: GeneratedAudioItem[]; merged?: MergedAudio };
      setGeneratedItems(payload.items);
      setMergedAudio(payload.merged);
      setExportMessage(payload.merged ? `已自动保存：${payload.merged.path}` : undefined);
      if (payload.merged) {
        const nextHistory = await projectApi().addHistory({
          text,
          path: payload.merged.path,
          durationMs: payload.merged.durationMs,
          itemCount: payload.items.length,
          mode: modeOverride
        });
        setHistory(nextHistory);
      }
      await refreshStatus();
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成失败");
    } finally {
      setIsGenerating(false);
    }
  }

  async function generateSingleSentence(index: number, text: string) {
    const trimmedText = text.trim();
    if (!trimmedText) {
      return;
    }

    setGenerationError(undefined);
    setSentenceGenerating(current => ({ ...current, [index]: true }));

    try {
      if (!selectedSample) {
        throw new Error("请先录制或导入一段声音样本。");
      }
      if (!(selectedSample.promptText ?? "").trim()) {
        throw new Error("请先给当前声音样本填写并保存“实际朗读文本”，内容必须和样本音频一致。");
      }

      const savedProject = await projectApi().saveDefault(script);
      setProject(savedProject);
      setSaveState("saved");

      let currentStatus = modelStatus;
      if (currentStatus.state !== "ready") {
        currentStatus = await modelApi().load();
        setModelStatus(currentStatus);
      }

      const response = await fetch(`${currentStatus.serviceUrl}/generate-sentence`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ index, text: trimmedText })
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => undefined)) as { error?: string } | undefined;
        throw new Error(payload?.error ?? `生成失败：${response.status}`);
      }

      const payload = (await response.json()) as { item: GeneratedAudioItem };
      setGeneratedItems(current =>
        [...current.filter(item => item.index !== payload.item.index), payload.item].sort((left, right) => left.index - right.index)
      );
      setExportMessage(`已自动保存：${payload.item.path}`);
      await refreshStatus();
    } catch (error) {
      setGenerationError(error instanceof Error ? error.message : "生成失败");
    } finally {
      setSentenceGenerating(current => ({ ...current, [index]: false }));
    }
  }

  async function exportMergedAudio(format: "wav" | "mp3") {
    if (!mergedAudio) {
      return;
    }

    setIsExporting(true);
    setExportMessage(undefined);
    try {
      const result = await audioApi().export({
        sourcePath: mergedAudio.path,
        format
      });
      if (!result.canceled && result.path) {
        setExportMessage(`已导出：${result.path}`);
      }
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : "导出失败");
    } finally {
      setIsExporting(false);
    }
  }

  async function showMergedAudioInFolder() {
    if (!mergedAudio) {
      return;
    }

    try {
      await audioApi().showInFolder(mergedAudio.path);
    } catch (error) {
      setExportMessage(error instanceof Error ? error.message : "无法打开生成目录");
    }
  }

  async function importVoiceSamples() {
    const profile = await voiceApi().importSamples();
    setVoiceProfile(profile);
    syncPromptDrafts(profile);
    await unloadModelAfterVoiceChange();
  }

  async function deleteVoiceSample(sampleId: string) {
    const profile = await voiceApi().deleteSample(sampleId);
    setVoiceProfile(profile);
    syncPromptDrafts(profile);
    await unloadModelAfterVoiceChange();
  }

  async function saveSamplePromptText(sampleId: string) {
    const profile = await voiceApi().updateSamplePromptText(sampleId, promptDrafts[sampleId] ?? "");
    setVoiceProfile(profile);
    syncPromptDrafts(profile);
    await unloadModelAfterVoiceChange();
  }

  async function selectVoiceSample(sampleId: string) {
    const profile = await voiceApi().selectSample(sampleId);
    setVoiceProfile(profile);
    syncPromptDrafts(profile);
    setGeneratedItems([]);
    setMergedAudio(undefined);
    setGenerationError(undefined);
    setProjectMessage("已切换当前声音样本。");
  }

  async function unloadModelAfterVoiceChange() {
    setGeneratedItems([]);
    setMergedAudio(undefined);
    setGenerationError(undefined);
    try {
      const status = await modelApi().unload();
      setModelStatus(status);
    } catch {
      await refreshStatus();
    }
  }

  async function startRecording() {
    setRecordingError(undefined);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = event => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        void saveRecording(recorder.mimeType);
      };

      recorderRef.current = recorder;
      recorder.start();
      setRecordingSeconds(0);
      setRecordingState("recording");
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "无法开始录音");
      setRecordingState("idle");
    }
  }

  function stopRecording() {
    if (recorderRef.current?.state === "recording") {
      setRecordingState("saving");
      recorderRef.current.stop();
    }
  }

  async function saveRecording(mimeType: string) {
    try {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const buffer = await blob.arrayBuffer();
      const profile = await voiceApi().saveRecording({
        name: `recording-${new Date().toISOString().replace(/[:.]/g, "-")}`,
        mimeType,
        data: Array.from(new Uint8Array(buffer)),
        promptText: recordingPromptText
      });
      setVoiceProfile(profile);
      syncPromptDrafts(profile);
      await unloadModelAfterVoiceChange();
    } catch (error) {
      setRecordingError(error instanceof Error ? error.message : "保存录音失败");
    } finally {
      chunksRef.current = [];
      recorderRef.current = undefined;
      setRecordingState("idle");
    }
  }

  async function saveProject() {
    setSaveState("saving");
    const savedProject = await projectApi().saveDefault(script);
    setProject(savedProject);
    setSaveState("saved");
    window.setTimeout(() => setSaveState("idle"), 1400);
  }

  async function exportProject() {
    setProjectMessage(undefined);
    try {
      await saveProject();
      const result = await projectApi().exportDefault();
      if (!result.canceled && result.path) {
        setProjectMessage(`文案项目已导出：${result.path}`);
      }
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : "导出文案项目失败");
    }
  }

  async function importProject() {
    setProjectMessage(undefined);
    try {
      const result = await projectApi().import();
      if (!result.canceled && result.project) {
        projectLoadedRef.current = true;
        setProject(result.project);
        setScript(result.project.script);
        setGeneratedItems([]);
        setMergedAudio(undefined);
        setGenerationError(undefined);
        setProjectMessage(`文案项目已导入：${result.path ?? ""}`);
      }
    } catch (error) {
      setProjectMessage(error instanceof Error ? error.message : "导入文案项目失败");
    }
  }

  async function loadHistoryEntry(entry: GeneratedHistoryEntry) {
    setScript(entry.text);
    setGenerationMode(entry.mode);
    setMergedAudio({
      path: entry.path,
      url: entry.audioUrl ?? "",
      durationMs: entry.durationMs
    });
    setGeneratedItems([]);
    setExportMessage(`已载入历史旁白：${entry.path}`);
  }

  async function copyHistoryText(entry: GeneratedHistoryEntry) {
    await navigator.clipboard.writeText(entry.text);
    setProjectMessage("文案已复制到剪贴板。");
  }

  async function regenerateHistoryEntry(entry: GeneratedHistoryEntry) {
    setScript(entry.text);
    setGenerationMode(entry.mode);
    await generateNarration(entry.text, entry.mode);
  }

  function toggleHistorySelection(entryId: string) {
    setSelectedHistoryIds(current => {
      const next = new Set(current);
      if (next.has(entryId)) {
        next.delete(entryId);
      } else {
        next.add(entryId);
      }
      return next;
    });
  }

  function toggleAllHistorySelection() {
    setSelectedHistoryIds(current =>
      history.length > 0 && current.size === history.length ? new Set() : new Set(history.map(entry => entry.id))
    );
  }

  async function deleteHistoryEntry(entry: GeneratedHistoryEntry) {
    const nextHistory = await projectApi().deleteHistory([entry.id]);
    setHistory(nextHistory);
    setHistoryTrash(await projectApi().getHistoryTrash());
    setSelectedHistoryIds(current => {
      const next = new Set(current);
      next.delete(entry.id);
      return next;
    });
    setProjectMessage("已将 1 条生成历史移入垃圾站。");
  }

  async function deleteSelectedHistory() {
    const ids = [...selectedHistoryIds];
    if (ids.length === 0) {
      return;
    }

    if (!window.confirm(`确定将选中的 ${ids.length} 条生成历史移入垃圾站吗？音频文件会保留到清理垃圾站时。`)) {
      return;
    }

    const nextHistory = await projectApi().deleteHistory(ids);
    setHistory(nextHistory);
    setHistoryTrash(await projectApi().getHistoryTrash());
    setSelectedHistoryIds(new Set());
    setProjectMessage(`已将 ${ids.length} 条生成历史移入垃圾站。`);
  }

  async function clearGeneratedHistory() {
    if (history.length === 0) {
      return;
    }

    if (!window.confirm("确定将全部生成历史移入垃圾站吗？音频文件会保留到清理垃圾站时。")) {
      return;
    }

    const nextHistory = await projectApi().clearHistory();
    setHistory(nextHistory);
    setHistoryTrash(await projectApi().getHistoryTrash());
    setSelectedHistoryIds(new Set());
    setProjectMessage("已将全部生成历史移入垃圾站。");
  }

  async function restoreHistoryEntry(entry: DeletedHistoryEntry) {
    const result = await projectApi().restoreHistory([entry.id]);
    setHistory(result.history);
    setHistoryTrash(result.trash);
    setProjectMessage("已从垃圾站还原 1 条生成历史。");
  }

  async function emptyHistoryTrash() {
    if (historyTrash.length === 0) {
      return;
    }

    if (!window.confirm(`确定清理垃圾站吗？这会物理删除 ${historyTrash.length} 个已移入垃圾站的音频文件。`)) {
      return;
    }

    const nextTrash = await projectApi().emptyHistoryTrash();
    setHistoryTrash(nextTrash);
    setProjectMessage("已清理垃圾站，相关音频文件已删除。");
  }

  useEffect(() => {
    void refreshStatus();
    void voiceApi()
      .getDefaultProfile()
      .then(profile => {
        setVoiceProfile(profile);
        syncPromptDrafts(profile);
      });
    void projectApi()
      .getDefault()
      .then(loadedProject => {
        setProject(loadedProject);
        setScript(loadedProject.script);
        projectLoadedRef.current = true;
      });
    void projectApi()
      .getHistory()
      .then(setHistory);
    void projectApi()
      .getHistoryTrash()
      .then(setHistoryTrash);
    const timer = window.setInterval(() => {
      void refreshStatus();
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const availableIds = new Set(history.map(entry => entry.id));
    setSelectedHistoryIds(current => {
      const next = new Set([...current].filter(id => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [history]);

  useEffect(() => {
    if (!projectLoadedRef.current) {
      return undefined;
    }

    setSaveState("saving");
    saveTimerRef.current = window.setTimeout(() => {
      void projectApi()
        .saveDefault(script)
        .then(savedProject => {
          setProject(savedProject);
          setSaveState("saved");
          window.setTimeout(() => setSaveState("idle"), 1000);
        });
    }, 800);

    return () => {
      if (saveTimerRef.current !== undefined) {
        window.clearTimeout(saveTimerRef.current);
      }
    };
  }, [script]);

  useEffect(() => {
    if (recordingState !== "recording") {
      return undefined;
    }

    const timer = window.setInterval(() => {
      setRecordingSeconds(seconds => seconds + 1);
    }, 1000);

    return () => window.clearInterval(timer);
  }, [recordingState]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <AudioLines size={24} />
          </div>
          <div>
            <h1>Auto Speech</h1>
            <p>本地声音克隆旁白工具</p>
          </div>
        </div>

        <nav className="nav-list" aria-label="主导航">
          <NavButton active={activeView === "project"} icon={<FolderOpen size={18} />} onClick={() => setActiveView("project")}>
            项目
          </NavButton>
          <NavButton active={activeView === "voice"} icon={<Mic2 size={18} />} onClick={() => setActiveView("voice")}>
            声音档案
          </NavButton>
          <NavButton
            active={activeView === "model"}
            icon={<SlidersHorizontal size={18} />}
            onClick={() => setActiveView("model")}
          >
            模型设置
          </NavButton>
        </nav>

        <section className="voice-panel">
          <div className="section-title">
            <span>当前声音</span>
            <button className="icon-button" title="导入声音样本" onClick={importVoiceSamples}>
              <Upload size={16} />
            </button>
          </div>
          <div className="voice-card">
            <div className="voice-avatar">我</div>
            <div>
              <strong>{selectedSample?.name ?? cleanDisplayName(voiceProfile.name, "默认声音档案")}</strong>
              <p>{voiceProfile.samples.length > 0 ? `当前样本 / 共 ${voiceProfile.samples.length} 个` : "等待导入样本"}</p>
            </div>
          </div>
          {voiceProfile.samples.length > 1 ? (
            <select
              className="voice-sample-select"
              value={selectedSample?.id ?? ""}
              onChange={event => void selectVoiceSample(event.target.value)}
            >
              {voiceProfile.samples.map(sample => (
                <option key={sample.id} value={sample.id}>
                  {sample.name}
                </option>
              ))}
            </select>
          ) : null}
          {selectedSample?.audioUrl ? <audio className="compact-audio" controls src={selectedSample.audioUrl} /> : null}
        </section>
      </aside>

      <section className="workspace">
        {activeView === "project" ? (
          <ProjectView
            projectName={cleanDisplayName(project?.name, "默认项目")}
            script={script}
            sentences={sentences}
            saveState={saveState}
            projectMessage={projectMessage}
            isGenerating={isGenerating}
            sentenceGenerating={sentenceGenerating}
            generatedItems={generatedItems}
            history={history}
            historyTrash={historyTrash}
            selectedHistoryIds={selectedHistoryIds}
            generationMode={generationMode}
            maxSingleChars={maxSingleGenerationChars}
            onScriptChange={setScript}
            onGenerationModeChange={setGenerationMode}
            onSave={saveProject}
            onExportProject={exportProject}
            onImportProject={importProject}
            onGenerate={() => void generateNarration()}
            onGenerateSentence={generateSingleSentence}
            onLoadHistory={loadHistoryEntry}
            onCopyHistory={copyHistoryText}
            onRegenerateHistory={regenerateHistoryEntry}
            onToggleHistorySelection={toggleHistorySelection}
            onToggleAllHistorySelection={toggleAllHistorySelection}
            onDeleteHistory={deleteHistoryEntry}
            onDeleteSelectedHistory={deleteSelectedHistory}
            onClearHistory={clearGeneratedHistory}
            onRestoreHistory={restoreHistoryEntry}
            onEmptyHistoryTrash={emptyHistoryTrash}
          />
        ) : null}

        {activeView === "voice" ? (
          <VoiceProfileView
            profile={voiceProfile}
            promptDrafts={promptDrafts}
            recordingState={recordingState}
            recordingSeconds={recordingSeconds}
            recordingError={recordingError}
            activeSampleId={selectedSample?.id}
            onImport={importVoiceSamples}
            onStartRecording={startRecording}
            onStopRecording={stopRecording}
            onPromptChange={(sampleId, promptText) =>
              setPromptDrafts(current => ({
                ...current,
                [sampleId]: promptText
              }))
            }
            onSavePrompt={saveSamplePromptText}
            onSelectSample={selectVoiceSample}
            onDelete={deleteVoiceSample}
          />
        ) : null}

        {activeView === "model" ? (
          <ModelSettingsView
            status={modelStatus}
            isBusy={isBusy}
            speechRate={speechRate}
            pauseMs={pauseMs}
            voiceStyle={voiceStyle}
            onRefresh={refreshStatus}
            onStart={() => runModelAction("start")}
            onLoad={() => runModelAction("load")}
            onUnload={() => runModelAction("unload")}
            onShutdown={() => runModelAction("shutdown")}
            onSetup={runModelSetup}
            modelMessage={modelMessage}
            onSpeechRateChange={setSpeechRate}
            onPauseChange={setPauseMs}
            onStyleChange={setVoiceStyle}
          />
        ) : null}
      </section>

      <aside className="inspector">
        <ModelStatusPanel
          status={modelStatus}
          isBusy={isBusy}
          onRefresh={refreshStatus}
          onStart={() => runModelAction("start")}
          onLoad={() => runModelAction("load")}
          onUnload={() => runModelAction("unload")}
          onShutdown={() => runModelAction("shutdown")}
          onSetup={runModelSetup}
          modelMessage={modelMessage}
        />

        <GenerationSettings speechRate={speechRate} pauseMs={pauseMs} voiceStyle={voiceStyle} />

        <AudioOutputPanel
          generationError={generationError}
          exportMessage={exportMessage}
          isExporting={isExporting}
          mergedAudio={mergedAudio}
          generatedItems={generatedItems}
          onExport={exportMergedAudio}
          onShowInFolder={showMergedAudioInFolder}
        />
      </aside>
    </main>
  );
}

interface NavButtonProps {
  active: boolean;
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}

function NavButton({ active, icon, children, onClick }: NavButtonProps) {
  return (
    <button className={`nav-item ${active ? "active" : ""}`} onClick={onClick}>
      {icon}
      {children}
    </button>
  );
}

interface ProjectViewProps {
  projectName: string;
  script: string;
  sentences: string[];
  saveState: "idle" | "saving" | "saved";
  projectMessage?: string;
  isGenerating: boolean;
  sentenceGenerating: Record<number, boolean>;
  generatedItems: GeneratedAudioItem[];
  history: GeneratedHistoryEntry[];
  historyTrash: DeletedHistoryEntry[];
  selectedHistoryIds: Set<string>;
  generationMode: GenerationMode;
  maxSingleChars: number;
  onScriptChange: (script: string) => void;
  onGenerationModeChange: (mode: GenerationMode) => void;
  onSave: () => void;
  onExportProject: () => void;
  onImportProject: () => void;
  onGenerate: () => void;
  onGenerateSentence: (index: number, text: string) => void;
  onLoadHistory: (entry: GeneratedHistoryEntry) => void;
  onCopyHistory: (entry: GeneratedHistoryEntry) => void;
  onRegenerateHistory: (entry: GeneratedHistoryEntry) => void;
  onToggleHistorySelection: (entryId: string) => void;
  onToggleAllHistorySelection: () => void;
  onDeleteHistory: (entry: GeneratedHistoryEntry) => void;
  onDeleteSelectedHistory: () => void;
  onClearHistory: () => void;
  onRestoreHistory: (entry: DeletedHistoryEntry) => void;
  onEmptyHistoryTrash: () => void;
}

function ProjectView({
  projectName,
  script,
  sentences,
  saveState,
  projectMessage,
  isGenerating,
  sentenceGenerating,
  generatedItems,
  history,
  historyTrash,
  selectedHistoryIds,
  generationMode,
  maxSingleChars,
  onScriptChange,
  onGenerationModeChange,
  onSave,
  onExportProject,
  onImportProject,
  onGenerate,
  onGenerateSentence,
  onLoadHistory,
  onCopyHistory,
  onRegenerateHistory,
  onToggleHistorySelection,
  onToggleAllHistorySelection,
  onDeleteHistory,
  onDeleteSelectedHistory,
  onClearHistory,
  onRestoreHistory,
  onEmptyHistoryTrash
}: ProjectViewProps) {
  const charCount = script.trim().length;
  const isOverSingleLimit = generationMode === "single" && charCount > maxSingleChars;
  const selectedHistoryCount = selectedHistoryIds.size;
  const allHistorySelected = history.length > 0 && selectedHistoryCount === history.length;

  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">宣传视频旁白</p>
          <h2>{projectName}</h2>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" onClick={onImportProject}>
            <FolderOpen size={17} />
            导入文案
          </button>
          <button className="secondary-button" onClick={onExportProject}>
            <Save size={17} />
            导出文案
          </button>
          <button className="secondary-button" onClick={onSave} disabled={saveState === "saving"}>
            {saveState === "saving" ? <Loader2 className="spin" size={17} /> : saveState === "saved" ? <Check size={17} /> : <Save size={17} />}
            {saveState === "saved" ? "已自动保存" : saveState === "saving" ? "保存中" : "保存文案"}
          </button>
          <button className="primary-button" disabled={isGenerating || !script.trim() || isOverSingleLimit} onClick={() => onGenerate()}>
            {isGenerating ? <Loader2 className="spin" size={17} /> : <Play size={17} />}
            {isGenerating ? "生成中" : "生成旁白"}
          </button>
        </div>
      </header>
      {projectMessage ? <p className="project-message">{projectMessage}</p> : null}
      <div className="project-controls">
      <p className="autosave-note">
          文案会自动保存。整段生成最多 {maxSingleChars} 字，后台会自动分小段防止截断；长文案可切换到分句生成。
      </p>
        <div className="generation-mode-row">
          <div className="mode-toggle" role="group" aria-label="生成模式">
            <button className={generationMode === "single" ? "active" : ""} onClick={() => onGenerationModeChange("single")}>
              整段生成
            </button>
            <button className={generationMode === "split" ? "active" : ""} onClick={() => onGenerationModeChange("split")}>
              分句生成
            </button>
          </div>
          <span className={isOverSingleLimit ? "char-count warning" : "char-count"}>
            {generationMode === "single" ? `${charCount} / ${maxSingleChars}` : `${charCount} 字`}
          </span>
        </div>
      </div>
      {isOverSingleLimit ? <p className="error-text">当前文案超过整段生成限制，请缩短文案或切换到分句生成。</p> : null}

      <div className="editor-grid">
        <section className="script-pane">
          <textarea
            value={script}
            onChange={event => onScriptChange(event.target.value)}
            spellCheck={false}
            aria-label="旁白文案"
            placeholder="在这里输入要生成的旁白文案。短文案建议用整段生成；长文案可以切换到分句生成。"
          />
        </section>

        <section className="sentence-pane">
          <div className="section-title">
            <span>{generationMode === "single" ? "整段预览" : "分句预览"}</span>
            <span className="count">{generationMode === "single" ? "1 段" : `${sentences.length} 句`}</span>
          </div>
          {generationMode === "single" ? (
            <div className="single-preview">
              <p>{script.trim() || "输入文案后，这里会显示即将生成的整段旁白。"}</p>
            </div>
          ) : (
            <div className="sentence-list">
              {sentences.map((sentence, index) => {
              const sentenceIndex = index + 1;
              const generated = generatedItems.find(item => item.index === sentenceIndex && item.text === sentence);
              const isSentenceGenerating = Boolean(sentenceGenerating[sentenceIndex]);
              return (
                <article className="sentence-item" key={`${sentence}-${index}`}>
                  <span>{String(sentenceIndex).padStart(2, "0")}</span>
                  <p>{sentence}</p>
                  {generated ? (
                    <div className="sentence-audio-actions">
                      <audio key={generated.url} className="sentence-audio" controls preload="metadata" src={generated.url} />
                      <button
                        className="icon-button"
                        disabled={isGenerating || isSentenceGenerating}
                        title={isSentenceGenerating ? "正在重新生成" : "重新生成这一句"}
                        onClick={() => onGenerateSentence(sentenceIndex, sentence)}
                      >
                        {isSentenceGenerating ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
                      </button>
                    </div>
                  ) : (
                    <button
                      className="icon-button"
                      disabled={isGenerating || isSentenceGenerating}
                      title={isSentenceGenerating ? "正在生成这一句" : "生成并试听这一句"}
                      onClick={() => onGenerateSentence(sentenceIndex, sentence)}
                    >
                      {isSentenceGenerating ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
                    </button>
                  )}
                </article>
              );
              })}
            </div>
          )}
        </section>
      </div>

      <section className="history-panel">
        <div className="section-title">
          <span>生成历史</span>
          <span className="count">
            {selectedHistoryCount > 0 ? `已选 ${selectedHistoryCount} 条` : "最多 20 条"}
          </span>
        </div>
        {history.length === 0 ? (
          <p className="empty-text">还没有生成历史。生成旁白后会自动出现在这里。</p>
        ) : (
          <>
            <div className="history-toolbar">
              <label className="history-select-all">
                <input type="checkbox" checked={allHistorySelected} onChange={onToggleAllHistorySelection} />
                {allHistorySelected ? "取消全选" : "全选"}
              </label>
              <div>
                <button className="secondary-button compact-inline" disabled={selectedHistoryCount === 0} onClick={onDeleteSelectedHistory}>
                  <Trash2 size={15} />
                  移入垃圾站
                </button>
                <button className="danger-button compact-inline" onClick={onClearHistory}>
                  <Trash2 size={15} />
                  全部移入垃圾站
                </button>
              </div>
            </div>
            <div className="history-list">
              {history.map(entry => {
                const isSelected = selectedHistoryIds.has(entry.id);
                return (
                  <article className={`history-item ${isSelected ? "selected" : ""}`} key={entry.id}>
                    <label className="history-check" title="选择这条历史">
                      <input type="checkbox" checked={isSelected} onChange={() => onToggleHistorySelection(entry.id)} />
                    </label>
                    <div className="history-main">
                      <div>
                        <strong>{entry.mode === "single" ? "整段生成" : "分句生成"}</strong>
                        <span>{new Date(entry.createdAt).toLocaleString()}</span>
                      </div>
                      <p>{entry.text}</p>
                      {entry.audioUrl ? <audio controls preload="metadata" src={entry.audioUrl} /> : null}
                    </div>
                    <div className="history-actions">
                      <button className="secondary-button compact-inline" onClick={() => onLoadHistory(entry)}>
                        选中
                      </button>
                      <button className="secondary-button compact-inline" onClick={() => onCopyHistory(entry)}>
                        复制文案
                      </button>
                      <button className="secondary-button compact-inline" disabled={isGenerating} onClick={() => onRegenerateHistory(entry)}>
                        重新生成
                      </button>
                      <button className="danger-button compact-inline" onClick={() => onDeleteHistory(entry)}>
                        <Trash2 size={15} />
                        删除
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        )}

        <div className="trash-section">
          <div className="section-title">
            <span>垃圾站</span>
            <span className="count">{historyTrash.length} 条</span>
          </div>
          {historyTrash.length === 0 ? (
            <p className="empty-text">垃圾站是空的。</p>
          ) : (
            <>
              <div className="trash-toolbar">
                <button className="danger-button compact-inline" onClick={onEmptyHistoryTrash}>
                  <Trash2 size={15} />
                  清理垃圾站
                </button>
              </div>
              <div className="trash-list">
                {historyTrash.map(entry => (
                  <article className="trash-item" key={entry.id}>
                    <div className="history-main">
                      <div>
                        <strong>{entry.mode === "single" ? "整段生成" : "分句生成"}</strong>
                        <span>{new Date(entry.deletedAt).toLocaleString()}</span>
                      </div>
                      <p>{entry.text}</p>
                      {entry.audioUrl ? <audio controls preload="metadata" src={entry.audioUrl} /> : null}
                    </div>
                    <div className="history-actions">
                      <button className="secondary-button compact-inline" onClick={() => onRestoreHistory(entry)}>
                        <RefreshCw size={15} />
                        还原
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </>
          )}
        </div>
      </section>
    </>
  );
}
interface VoiceProfileViewProps {
  profile: VoiceProfile;
  activeSampleId?: string;
  promptDrafts: Record<string, string>;
  recordingState: "idle" | "recording" | "saving";
  recordingSeconds: number;
  recordingError?: string;
  onImport: () => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onPromptChange: (sampleId: string, promptText: string) => void;
  onSavePrompt: (sampleId: string) => void;
  onSelectSample: (sampleId: string) => void;
  onDelete: (sampleId: string) => void;
}

function VoiceProfileView({
  profile,
  activeSampleId,
  promptDrafts,
  recordingState,
  recordingSeconds,
  recordingError,
  onImport,
  onStartRecording,
  onStopRecording,
  onPromptChange,
  onSavePrompt,
  onSelectSample,
  onDelete
}: VoiceProfileViewProps) {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">声音档案</p>
          <h2>{cleanDisplayName(profile.name, "默认声音档案")}</h2>
        </div>
        <div className="topbar-actions">
          <button className="secondary-button" onClick={onImport}>
            <Upload size={17} />
            导入样本
          </button>
          {recordingState === "recording" ? (
            <button className="danger-button" onClick={onStopRecording}>
              <Pause size={17} />
              停止 {recordingSeconds}s
            </button>
          ) : (
            <button className="primary-button" onClick={onStartRecording} disabled={recordingState === "saving"}>
              {recordingState === "saving" ? <Loader2 className="spin" size={17} /> : <Mic2 size={17} />}
              {recordingState === "saving" ? "保存中" : "录制样本"}
            </button>
          )}
        </div>
      </header>

      <section className="profile-workspace-panel">
        <div className="recording-guide">
          <strong>建议朗读文本</strong>
          <p>{recordingPromptText}</p>
        </div>
        {recordingError ? <p className="recording-error">{recordingError}</p> : null}

        {profile.samples.length === 0 ? (
          <div className="empty-panel">还没有声音样本。录制一段 10 到 30 秒的干净人声，或者导入已有音频。</div>
        ) : (
          <div className="full-sample-list">
            {profile.samples
              .slice()
              .reverse()
              .map(sample => {
                const isActive = sample.id === activeSampleId;
                return (
                <article className={`full-sample-item ${isActive ? "active" : ""}`} key={sample.id}>
                  <div className="sample-header">
                    <div>
                      <strong>{sample.name}</strong>
                      <small>{isActive ? `当前使用 / ${formatSampleQuality(sample)}` : formatSampleQuality(sample)}</small>
                    </div>
                    <span className={sample.quality.status}>{formatBytes(sample.sizeBytes)}</span>
                  </div>
                  {sample.audioUrl ? <audio controls src={sample.audioUrl} /> : <p className="empty-text">这个样本暂时没有可播放文件。</p>}
                  <textarea
                    className="sample-prompt-input"
                    value={promptDrafts[sample.id] ?? sample.promptText ?? ""}
                    onChange={event => onPromptChange(sample.id, event.target.value)}
                    placeholder="填写这段样本里你实际说的话，必须和音频内容一致"
                    rows={3}
                  />
                  <div className="sample-footer-actions">
                    <button className="secondary-button compact-inline" disabled={isActive} onClick={() => onSelectSample(sample.id)}>
                      <Check size={15} />
                      {isActive ? "正在使用" : "使用这个样本"}
                    </button>
                    <button className="secondary-button compact-inline" onClick={() => onSavePrompt(sample.id)}>
                      <Save size={15} />
                      保存文本
                    </button>
                    <button className="danger-button compact-inline" onClick={() => onDelete(sample.id)}>
                      <Trash2 size={15} />
                      删除样本
                    </button>
                  </div>
                </article>
              );
              })}
          </div>
        )}
      </section>
    </>
  );
}

interface ModelSettingsViewProps {
  status: ModelStatus;
  isBusy: boolean;
  speechRate: number;
  pauseMs: number;
  voiceStyle: VoiceStyle;
  onRefresh: () => void;
  onStart: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onShutdown: () => void;
  onSetup: () => void;
  modelMessage?: string;
  onSpeechRateChange: (value: number) => void;
  onPauseChange: (value: number) => void;
  onStyleChange: (value: VoiceStyle) => void;
}

function ModelSettingsView(props: ModelSettingsViewProps) {
  return (
    <>
      <header className="topbar">
        <div>
          <p className="eyebrow">模型设置</p>
          <h2>CosyVoice 本地服务</h2>
        </div>
        <button className="secondary-button" onClick={props.onRefresh}>
          <RefreshCw size={17} />
          刷新状态
        </button>
      </header>

      <div className="model-settings-grid">
        <ModelStatusPanel
          status={props.status}
          isBusy={props.isBusy}
          onRefresh={props.onRefresh}
          onStart={props.onStart}
          onLoad={props.onLoad}
          onUnload={props.onUnload}
          onShutdown={props.onShutdown}
          onSetup={props.onSetup}
          modelMessage={props.modelMessage}
        />
        <section className="settings-panel">
          <div className="section-title">
            <span>生成参数</span>
          </div>
          <label>
            语速：{props.speechRate}%
            <input type="range" min="80" max="130" value={props.speechRate} onChange={event => props.onSpeechRateChange(Number(event.target.value))} />
          </label>
          <label>
            句间停顿：{props.pauseMs} ms
            <input type="range" min="200" max="1200" step="50" value={props.pauseMs} onChange={event => props.onPauseChange(Number(event.target.value))} />
          </label>
          <div className="preset-row">
            <button className={`preset ${props.voiceStyle === "natural" ? "active" : ""}`} onClick={() => props.onStyleChange("natural")}>
              自然
            </button>
            <button className={`preset ${props.voiceStyle === "warm" ? "active" : ""}`} onClick={() => props.onStyleChange("warm")}>
              热情
            </button>
            <button className={`preset ${props.voiceStyle === "steady" ? "active" : ""}`} onClick={() => props.onStyleChange("steady")}>
              稳重
            </button>
          </div>
        </section>
        <section className="settings-panel">
          <div className="section-title">
            <span>当前模型</span>
          </div>
          <dl className="status-list">
            <div>
              <dt>适配器</dt>
              <dd>CosyVoice2-0.5B</dd>
            </div>
            <div>
              <dt>加载策略</dt>
              <dd>软件启动后自动加载，关闭时自动卸载并释放显存。</dd>
            </div>
            <div>
              <dt>样本策略</dt>
              <dd>修改或删除声音样本后会自动卸载模型，下次生成时重新加载最新样本。</dd>
            </div>
          </dl>
        </section>
      </div>
    </>
  );
}

function GenerationSettings({ speechRate, pauseMs, voiceStyle }: { speechRate: number; pauseMs: number; voiceStyle: VoiceStyle }) {
  const styleText: Record<VoiceStyle, string> = {
    natural: "自然",
    warm: "热情",
    steady: "稳重"
  };

  return (
    <section className="settings-panel">
      <div className="section-title">
        <span>生成设置</span>
      </div>
      <dl className="status-list">
        <div>
          <dt>语速</dt>
          <dd>{speechRate}%</dd>
        </div>
        <div>
          <dt>句间停顿</dt>
          <dd>{pauseMs} ms</dd>
        </div>
        <div>
          <dt>风格</dt>
          <dd>{styleText[voiceStyle]}</dd>
        </div>
      </dl>
    </section>
  );
}

function AudioOutputPanel({
  generationError,
  exportMessage,
  isExporting,
  mergedAudio,
  generatedItems,
  onExport,
  onShowInFolder
}: {
  generationError?: string;
  exportMessage?: string;
  isExporting: boolean;
  mergedAudio?: MergedAudio;
  generatedItems: GeneratedAudioItem[];
  onExport: (format: "wav" | "mp3") => void;
  onShowInFolder: () => void;
}) {
  return (
    <section className="audio-panel">
      <div className="section-title">
        <span>生成音频</span>
        <span className="count">{generatedItems.length} 条</span>
      </div>
      {generationError ? <p className="error-text">{generationError}</p> : null}
      {exportMessage ? <p className="export-message">{exportMessage}</p> : null}
      {mergedAudio ? (
        <article className="merged-audio">
          <div>
            <strong>整段旁白</strong>
            <span>{Math.round(mergedAudio.durationMs / 1000)}s</span>
          </div>
          <audio key={mergedAudio.url} controls preload="metadata" src={mergedAudio.url} />
          <div className="export-actions">
            <button className="secondary-button compact-inline" onClick={onShowInFolder}>
              <FolderOpen size={15} />
              打开位置
            </button>
            <button className="secondary-button compact-inline" disabled={isExporting} onClick={() => onExport("wav")}>
              {isExporting ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              导出 WAV
            </button>
            <button className="secondary-button compact-inline" disabled={isExporting} onClick={() => onExport("mp3")}>
              {isExporting ? <Loader2 className="spin" size={15} /> : <Save size={15} />}
              导出 MP3
            </button>
          </div>
          <p className="auto-save-hint">已自动保存在项目生成目录；需要放进剪辑软件时再导出。</p>
          <small title={mergedAudio.path}>{mergedAudio.path}</small>
        </article>
      ) : null}
      <div className="audio-list">
        {generatedItems.length === 0 ? (
          <p className="empty-text">暂无音频</p>
        ) : (
          generatedItems.map(item => (
            <article className="audio-item" key={item.path}>
              <div>
                <strong>{String(item.index).padStart(2, "0")}</strong>
                <span>{Math.round(item.durationMs / 1000)}s</span>
              </div>
              <p>{item.text}</p>
              <audio key={item.url} controls preload="metadata" src={item.url} />
            </article>
          ))
        )}
      </div>
    </section>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024 * 1024) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatSampleQuality(sample: VoiceSample) {
  const parts = [];
  if (sample.quality.durationSeconds !== undefined) {
    parts.push(`${sample.quality.durationSeconds.toFixed(1)}s`);
  }
  if (sample.quality.sampleRate !== undefined) {
    parts.push(`${sample.quality.sampleRate} Hz`);
  }
  if (sample.quality.channels !== undefined) {
    parts.push(`${sample.quality.channels} ch`);
  }
  return parts.length > 0 ? parts.join(" / ") : sample.quality.notes[0] ?? "等待分析";
}

function cleanDisplayName(value: string | undefined, fallback: string) {
  if (!value || /[�]/.test(value)) {
    return fallback;
  }
  return value;
}

interface ModelStatusPanelProps {
  status: ModelStatus;
  isBusy: boolean;
  onRefresh: () => void;
  onStart: () => void;
  onLoad: () => void;
  onUnload: () => void;
  onShutdown: () => void;
  onSetup: () => void;
  modelMessage?: string;
}

function ModelStatusPanel({
  status,
  isBusy,
  modelMessage,
  onRefresh,
  onStart,
  onLoad,
  onUnload,
  onShutdown,
  onSetup
}: ModelStatusPanelProps) {
  const stateText: Record<ModelRuntimeState, string> = {
    stopped: "已停止",
    starting: "启动中",
    loading_model: "加载模型",
    ready: "已就绪",
    generating: "生成中",
    unloading: "卸载中",
    error: "异常"
  };

  return (
    <section className="model-panel">
      <div className="section-title">
        <span>模型服务</span>
        <button className="icon-button" title="刷新状态" onClick={onRefresh}>
          <RefreshCw size={16} />
        </button>
      </div>

      <div className={`status-badge ${status.state}`}>
        <Activity size={16} />
        {stateText[status.state]}
      </div>

      <dl className="status-list">
        <div>
          <dt>服务地址</dt>
          <dd>{status.serviceUrl}</dd>
        </div>
        <div>
          <dt>进程</dt>
          <dd>{status.pid ?? "未启动"}</dd>
        </div>
        <div>
          <dt>显卡</dt>
          <dd>{status.gpu?.name ?? "等待检测"}</dd>
        </div>
        <div>
          <dt>显存</dt>
          <dd>{status.gpu ? `${status.gpu.usedMb} / ${status.gpu.totalMb} MB` : "等待检测"}</dd>
        </div>
      </dl>

      {status.error ? <p className="error-text">{status.error}</p> : null}
      {modelMessage ? <p className="export-message">{modelMessage}</p> : null}

      <div className="model-actions">
        <button className="secondary-button" disabled={isBusy} onClick={onStart}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <Power size={16} />}
          启动
        </button>
        <button className="secondary-button" disabled={isBusy} onClick={onLoad}>
          <Play size={16} />
          加载
        </button>
        <button className="secondary-button" disabled={isBusy} onClick={onUnload}>
          <Square size={16} />
          卸载
        </button>
        <button className="primary-button" disabled={isBusy} onClick={onSetup}>
          {isBusy ? <Loader2 className="spin" size={16} /> : <Download size={16} />}
          初始化 CosyVoice
        </button>
        <button className="danger-button" disabled={isBusy} onClick={onShutdown}>
          <Power size={16} />
          关闭
        </button>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
