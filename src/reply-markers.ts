/**
 * Parse a Codex text reply for BGOS outbound markers and strip them from the
 * user-visible text. Codex emits a single text stream, so, like OpenClaw, the
 * agent-facing surface uses marker syntax (documented in agent-hints.ts and
 * AGENTS.md):
 *
 *   MEDIA:/abs/path                 one file per line -> outbound files[]
 *   STATUS: <text>                  set the agent status line (empty clears)
 *   [[BGOS_BUTTONS]] ... [[/...]]   inline option buttons (Label | value, <=6)
 *   [[BGOS_ASK]] ... [[/BGOS_ASK]]  blocking multi-question modal (<=4 questions)
 *
 * tool_progress is NOT a marker: Codex streams real tool events, so the daemon
 * drives that card from run() events (see event-mapper.ts), not from the reply.
 */

export interface ButtonOption {
  text: string;
  callbackData: string;
}

export interface ParsedButtons {
  options: ButtonOption[];
}

export interface AskQuestion {
  text: string;
  options: ButtonOption[];
  allowFreeText: boolean;
  allowSkip: boolean;
}

export interface ParsedAsk {
  questions: AskQuestion[];
}

export interface ParsedStatus {
  text: string;
}

export interface ParsedReply {
  cleanText: string;
  media: string[];
  buttons: ParsedButtons | null;
  ask: ParsedAsk | null;
  status: ParsedStatus | null;
}

const MAX_BUTTONS = 6;
const MAX_ASK_QUESTIONS = 4;
const MAX_ASK_OPTIONS = 6;

const BUTTONS_RE = /\[\[BGOS_BUTTONS\]\]([\s\S]*?)\[\[\/BGOS_BUTTONS\]\]/;
const ASK_RE = /\[\[BGOS_ASK\]\]([\s\S]*?)\[\[\/BGOS_ASK\]\]/;

function parseOptionLine(line: string): ButtonOption | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const pipe = trimmed.indexOf("|");
  if (pipe === -1) {
    return { text: trimmed, callbackData: trimmed };
  }
  const text = trimmed.slice(0, pipe).trim();
  const callbackData = trimmed.slice(pipe + 1).trim();
  if (!text) return null;
  return { text, callbackData: callbackData || text };
}

function parseButtonsBlock(body: string): ParsedButtons | null {
  const options: ButtonOption[] = [];
  for (const raw of body.split("\n")) {
    const opt = parseOptionLine(raw);
    if (opt) options.push(opt);
    if (options.length >= MAX_BUTTONS) break;
  }
  return options.length > 0 ? { options } : null;
}

function parseAskBlock(body: string): ParsedAsk | null {
  const questions: AskQuestion[] = [];
  let current: AskQuestion | null = null;

  const push = () => {
    if (current && questions.length < MAX_ASK_QUESTIONS) questions.push(current);
  };

  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("Q:")) {
      push();
      current =
        questions.length < MAX_ASK_QUESTIONS
          ? {
              text: line.slice(2).trim(),
              options: [],
              allowFreeText: true,
              allowSkip: true,
            }
          : null;
      continue;
    }
    if (!current) continue;
    if (line === "noskip") {
      current.allowSkip = false;
      continue;
    }
    if (line === "nofreetext") {
      current.allowFreeText = false;
      continue;
    }
    const opt = parseOptionLine(line);
    if (opt && current.options.length < MAX_ASK_OPTIONS) current.options.push(opt);
  }
  push();
  return questions.length > 0 ? { questions } : null;
}

function collapse(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}

export function parseReply(input: string): ParsedReply {
  let text = input ?? "";

  const buttonsMatch = BUTTONS_RE.exec(text);
  const buttons = buttonsMatch ? parseButtonsBlock(buttonsMatch[1] ?? "") : null;
  if (buttonsMatch) text = text.replace(BUTTONS_RE, "");

  const askMatch = ASK_RE.exec(text);
  const ask = askMatch ? parseAskBlock(askMatch[1] ?? "") : null;
  if (askMatch) text = text.replace(ASK_RE, "");

  const media: string[] = [];
  let status: ParsedStatus | null = null;
  const kept: string[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("MEDIA:")) {
      const path = trimmed.slice("MEDIA:".length).trim();
      if (path) media.push(path);
      continue;
    }
    if (trimmed === "STATUS:" || trimmed.startsWith("STATUS:")) {
      status = { text: trimmed.slice("STATUS:".length).trim() };
      continue;
    }
    kept.push(line);
  }

  return {
    cleanText: collapse(kept.join("\n")),
    media,
    buttons,
    ask,
    status,
  };
}
