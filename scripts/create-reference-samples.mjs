import fs from "node:fs";
import path from "node:path";

const profilePath = "auto_speech_data/profiles/default/profile.json";
const referenceDir = "auto_speech_data/profiles/default/reference";
const referencePromptText = "这是我的声音样本，用来帮助软件生成自然清晰的中文旁白。";

function readUInt32LE(buffer, offset) {
  return buffer.readUInt32LE(offset);
}

function trimWav(inputPath, outputPath, seconds = 8) {
  const buffer = fs.readFileSync(inputPath);
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error(`Not a WAV file: ${inputPath}`);
  }

  let offset = 12;
  let fmtChunk;
  let dataChunk;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = readUInt32LE(buffer, offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      fmtChunk = { start, size };
    }
    if (id === "data") {
      dataChunk = { start, size };
      break;
    }
    offset = start + size + (size % 2);
  }

  if (!fmtChunk || !dataChunk) {
    throw new Error(`Incomplete WAV file: ${inputPath}`);
  }

  const channels = buffer.readUInt16LE(fmtChunk.start + 2);
  const sampleRate = buffer.readUInt32LE(fmtChunk.start + 4);
  const bitsPerSample = buffer.readUInt16LE(fmtChunk.start + 14);
  const bytesPerFrame = channels * (bitsPerSample / 8);
  const keepBytes = Math.min(dataChunk.size, sampleRate * seconds * bytesPerFrame);

  const output = Buffer.concat([
    buffer.subarray(0, dataChunk.start),
    buffer.subarray(dataChunk.start, dataChunk.start + keepBytes),
  ]);

  output.writeUInt32LE(output.length - 8, 4);
  output.writeUInt32LE(keepBytes, dataChunk.start - 4);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, output);
}

const profile = JSON.parse(fs.readFileSync(profilePath, "utf8").replace(/^\uFEFF/, ""));
fs.mkdirSync(referenceDir, { recursive: true });

for (const sample of profile.samples ?? []) {
  const source = sample.normalizedPath || sample.path;
  if (!source) continue;
  const outputPath = path.resolve(referenceDir, `${sample.id}-ref.wav`);
  trimWav(source, outputPath);
  sample.referencePath = outputPath;
  sample.referencePromptText = referencePromptText;
}

fs.writeFileSync(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");
console.log(JSON.stringify(profile.samples.at(-1), null, 2));
