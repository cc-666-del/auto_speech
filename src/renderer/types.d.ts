import type { AutoSpeechApi } from "../main/preload";

declare global {
  interface Window {
    autoSpeech?: AutoSpeechApi;
  }
}
