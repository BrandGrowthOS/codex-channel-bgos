/**
 * Turn a BGOS inbound message (text + downloaded attachments) into a Codex SDK
 * `Input`. Images map to the SDK's native `local_image` input; other files have
 * no native input type, so we inject a labeled path line into the text (the
 * daemon adds each file's directory to the thread's additionalDirectories so
 * Codex can read it from disk).
 */
import type { Input, UserInput } from "@openai/codex-sdk";

export interface InboundFileForCodex {
  /** Absolute local path the file was downloaded to. */
  path: string;
  mime: string;
  name: string;
  isImage: boolean;
}

function describeFile(f: InboundFileForCodex): string {
  const name = f.name ? `, name="${f.name}"` : "";
  return `[File attached: ${f.path} (${f.mime})${name}]`;
}

export function buildCodexInput(
  text: string,
  files: InboundFileForCodex[],
): Input {
  const images = files.filter((f) => f.isImage);
  const others = files.filter((f) => !f.isImage);

  let composed = text ?? "";
  if (others.length > 0) {
    const lines = others.map(describeFile).join("\n");
    composed = composed.trim().length > 0 ? `${composed}\n\n${lines}` : lines;
  }

  if (images.length === 0) {
    return composed;
  }

  const parts: UserInput[] = [];
  if (composed.trim().length > 0) {
    parts.push({ type: "text", text: composed });
  }
  for (const image of images) {
    parts.push({ type: "local_image", path: image.path });
  }
  return parts;
}
