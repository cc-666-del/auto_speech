import { ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ModelRuntimeState =
  | "stopped"
  | "starting"
  | "loading_model"
  | "ready"
  | "generating"
  | "unloading"
  | "error";

export interface GpuInfo {
  name: string;
  totalMb: number;
  usedMb: number;
  freeMb: number;
}

export interface ModelStatus {
  state: ModelRuntimeState;
  pid?: number;
  serviceUrl: string;
  gpu?: GpuInfo;
  error?: string;
}

export interface ModelSetupResult {
  started: boolean;
  scriptPath: string;
  message: string;
}

const SERVICE_PORT = 8765;
const SERVICE_URL = `http://127.0.0.1:${SERVICE_PORT}`;

export class ModelManager {
  private process?: ChildProcessWithoutNullStreams;
  private state: ModelRuntimeState = "stopped";
  private lastError?: string;

  constructor(private readonly projectRoot: string) {}

  async status(): Promise<ModelStatus> {
    const serviceStatus = await this.fetchServiceStatus();

    if (serviceStatus) {
      this.state = serviceStatus.state;
      return {
        state: serviceStatus.state,
        pid: this.process?.pid,
        serviceUrl: SERVICE_URL,
        gpu: serviceStatus.gpu,
        error: serviceStatus.error
      };
    }

    return {
      state: this.state,
      pid: this.process?.pid,
      serviceUrl: SERVICE_URL,
      error: this.lastError
    };
  }

  async start(): Promise<ModelStatus> {
    if (this.process && !this.process.killed) {
      return this.status();
    }

    this.state = "starting";
    this.lastError = undefined;

    const servicePath = path.join(this.projectRoot, "model_service", "main.py");
    const python = this.resolvePythonRuntime();
    this.process = spawn(python.command, [...python.args, servicePath, "--port", String(SERVICE_PORT)], {
      cwd: this.projectRoot,
      windowsHide: true
    });

    this.process.stdout.on("data", data => {
      console.info(`[model-service] ${data.toString().trim()}`);
    });

    this.process.stderr.on("data", data => {
      console.error(`[model-service] ${data.toString().trim()}`);
    });

    this.process.on("exit", code => {
      this.process = undefined;
      if (this.state !== "stopped" && code !== 0) {
        this.state = "error";
        this.lastError = `Model service exited with code ${code}.`;
      } else {
        this.state = "stopped";
      }
    });

    return this.status();
  }

  async load(): Promise<ModelStatus> {
    await this.ensureStarted();
    await this.waitForService();
    await this.post("/load");
    return this.status();
  }

  async unload(): Promise<ModelStatus> {
    await this.post("/unload");
    return this.status();
  }

  async shutdown(): Promise<ModelStatus> {
    this.state = "unloading";

    try {
      await this.post("/shutdown");
    } catch {
      // The service may close the socket before sending a full response.
    }

    await this.killProcessIfNeeded();
    this.state = "stopped";
    return this.status();
  }

  async setupCosyVoice(): Promise<ModelSetupResult> {
    const scriptPath = path.join(this.projectRoot, "scripts", "setup-cosyvoice.ps1");
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`CosyVoice setup script was not found: ${scriptPath}`);
    }

    const child = spawn(
      "powershell.exe",
      ["-NoExit", "-ExecutionPolicy", "Bypass", "-File", scriptPath],
      {
        cwd: this.projectRoot,
        detached: true,
        stdio: "ignore",
        windowsHide: false
      }
    );
    child.unref();

    return {
      started: true,
      scriptPath,
      message: "CosyVoice setup started in a PowerShell window. Wait for it to finish, then click Load."
    };
  }

  private async ensureStarted(): Promise<void> {
    if (!this.process || this.process.killed) {
      await this.start();
    }
  }

  private async waitForService(timeoutMs = 20000): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const status = await this.fetchServiceStatus();
      if (status) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 300));
    }

    throw new Error("Model service did not become ready in time.");
  }

  private async fetchServiceStatus(): Promise<ModelStatus | undefined> {
    try {
      const response = await fetch(`${SERVICE_URL}/status`);
      if (!response.ok) {
        return undefined;
      }
      return (await response.json()) as ModelStatus;
    } catch {
      return undefined;
    }
  }

  private async post(pathname: string): Promise<void> {
    const response = await fetch(`${SERVICE_URL}${pathname}`, {
      method: "POST"
    });

    if (!response.ok) {
      const detail = await this.readErrorResponse(response);
      this.state = "error";
      this.lastError = detail;
      throw new Error(detail);
    }
  }

  private async readErrorResponse(response: Response): Promise<string> {
    const fallback = `Model service request failed: ${response.status}`;
    try {
      const text = await response.text();
      if (!text.trim()) {
        return fallback;
      }

      try {
        const payload = JSON.parse(text) as { error?: unknown };
        return typeof payload.error === "string" && payload.error.trim() ? payload.error : text;
      } catch {
        return text;
      }
    } catch {
      return fallback;
    }
  }

  private async killProcessIfNeeded(): Promise<void> {
    const child = this.process;
    if (!child || child.killed) {
      this.process = undefined;
      return;
    }

    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill();
        resolve();
      }, 1500);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });

    this.process = undefined;
  }

  private resolvePythonRuntime(): { command: string; args: string[] } {
    const cosyVoicePython = path.join(this.projectRoot, "models", "CosyVoice", ".venv", "Scripts", "python.exe");
    if (fs.existsSync(cosyVoicePython)) {
      return { command: cosyVoicePython, args: [] };
    }

    const venvPython = path.join(this.projectRoot, ".venv", "Scripts", "python.exe");
    if (fs.existsSync(venvPython)) {
      return { command: venvPython, args: [] };
    }

    const python311 = this.resolvePythonLauncherVersion("3.11");
    if (python311) {
      return { command: python311, args: [] };
    }

    return { command: "py", args: ["-3.11"] };
  }

  private resolvePythonLauncherVersion(version: string): string | undefined {
    try {
      const output = execFileSync("py", [`-${version}`, "-c", "import sys; print(sys.executable)"], {
        encoding: "utf8",
        windowsHide: true
      }).trim();
      return output && fs.existsSync(output) ? output : undefined;
    } catch {
      return undefined;
    }
  }
}
