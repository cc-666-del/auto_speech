import { contextBridge, ipcRenderer } from "electron";
import type { AudioExportInput, AudioExportResult } from "./audioExport.js";
import type { ModelSetupResult, ModelStatus } from "./modelManager.js";
import type {
  AddGeneratedHistoryInput,
  DeletedHistoryEntry,
  GeneratedHistoryEntry,
  HistoryCollections,
  ProjectTransferResult,
  ScriptProject
} from "./projectStore.js";
import type { RecordedSampleInput, VoiceProfile } from "./voiceProfiles.js";

const api = {
  model: {
    status: (): Promise<ModelStatus> => ipcRenderer.invoke("model:status"),
    start: (): Promise<ModelStatus> => ipcRenderer.invoke("model:start"),
    load: (): Promise<ModelStatus> => ipcRenderer.invoke("model:load"),
    unload: (): Promise<ModelStatus> => ipcRenderer.invoke("model:unload"),
    shutdown: (): Promise<ModelStatus> => ipcRenderer.invoke("model:shutdown"),
    setupCosyVoice: (): Promise<ModelSetupResult> => ipcRenderer.invoke("model:setupCosyVoice")
  },
  voice: {
    getDefaultProfile: (): Promise<VoiceProfile> => ipcRenderer.invoke("voice:getDefaultProfile"),
    importSamples: (): Promise<VoiceProfile> => ipcRenderer.invoke("voice:importSamples"),
    saveRecording: (input: RecordedSampleInput): Promise<VoiceProfile> =>
      ipcRenderer.invoke("voice:saveRecording", input),
    deleteSample: (sampleId: string): Promise<VoiceProfile> => ipcRenderer.invoke("voice:deleteSample", sampleId),
    selectSample: (sampleId: string): Promise<VoiceProfile> => ipcRenderer.invoke("voice:selectSample", sampleId),
    updateSamplePromptText: (sampleId: string, promptText: string): Promise<VoiceProfile> =>
      ipcRenderer.invoke("voice:updateSamplePromptText", sampleId, promptText)
  },
  project: {
    getDefault: (): Promise<ScriptProject> => ipcRenderer.invoke("project:getDefault"),
    saveDefault: (script: string): Promise<ScriptProject> => ipcRenderer.invoke("project:saveDefault", script),
    exportDefault: (): Promise<ProjectTransferResult> => ipcRenderer.invoke("project:exportDefault"),
    import: (): Promise<ProjectTransferResult> => ipcRenderer.invoke("project:import"),
    getHistory: (): Promise<GeneratedHistoryEntry[]> => ipcRenderer.invoke("project:getHistory"),
    getHistoryTrash: (): Promise<DeletedHistoryEntry[]> => ipcRenderer.invoke("project:getHistoryTrash"),
    addHistory: (input: AddGeneratedHistoryInput): Promise<GeneratedHistoryEntry[]> =>
      ipcRenderer.invoke("project:addHistory", input),
    deleteHistory: (ids: string[]): Promise<GeneratedHistoryEntry[]> => ipcRenderer.invoke("project:deleteHistory", ids),
    clearHistory: (): Promise<GeneratedHistoryEntry[]> => ipcRenderer.invoke("project:clearHistory"),
    restoreHistory: (ids: string[]): Promise<HistoryCollections> => ipcRenderer.invoke("project:restoreHistory", ids),
    emptyHistoryTrash: (): Promise<DeletedHistoryEntry[]> => ipcRenderer.invoke("project:emptyHistoryTrash")
  },
  audio: {
    export: (input: AudioExportInput): Promise<AudioExportResult> => ipcRenderer.invoke("audio:export", input),
    showInFolder: (sourcePath: string): Promise<void> => ipcRenderer.invoke("audio:showInFolder", sourcePath)
  }
};

contextBridge.exposeInMainWorld("autoSpeech", api);

export type AutoSpeechApi = typeof api;
