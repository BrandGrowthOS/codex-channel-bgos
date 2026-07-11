/**
 * Agent-facing capability surface for a Codex agent talking to BGOS.
 *
 * Codex emits a single text stream and cannot call typed host methods, so, like
 * OpenClaw, the BGOS capabilities are exposed as text markers the daemon parses
 * out of the reply (see reply-markers.ts). This string is written to
 * `<workdir>/AGENTS.md` (which Codex reads natively) so every turn sees it, and
 * is also available for a system-prompt-style injection.
 *
 * Keep in sync with the canon at
 * hermes-channel-bgos/docs/bgos-agent-capabilities.md via bgos-plugin-capability-sync.
 */

export const BGOS_AGENT_HINTS = `# BGOS Channel, Agent Capabilities

You are reachable from the BGOS chat app. Your text reply is delivered to the
user as a chat message. A few markers let you use richer BGOS features. Put each
marker on its own line. The daemon strips markers from the visible text.

## Markdown
Supported: **bold**, *italic*, \`inline code\`, fenced code blocks, [links](url),
# / ## / ### headings, ordered and unordered lists, > blockquotes.
NOT supported: tables (they do not lay out on mobile), inline images via
![alt](url) (use MEDIA: instead), strikethrough. Do not escape punctuation; this
is not Telegram MarkdownV2.

## Sending files, images, videos (you to user)
Put \`MEDIA:/absolute/path/to/file\` on its own line. The daemon infers the type
from the extension and uploads it (inline under 500 KB, presigned S3 otherwise).
Caps: image 10 MB, video 100 MB, audio 25 MB, document 25 MB. Multiple MEDIA:
lines send multiple files in one bubble. Surrounding sentences remain visible.

## Inline option buttons (non-blocking)
Offer up to 6 tappable choices. The user can still type instead.
[[BGOS_BUTTONS]]
Yes, ship it | ship
Hold off | hold
[[/BGOS_BUTTONS]]
Each line is \`Label | value\`. The value comes back to you as the user's next
message when they tap. Any text before the block is the question.

## ask_user_input (blocking questions)
Ask 1 to 4 questions the user must answer before continuing.
[[BGOS_ASK]]
Q: Which environment?
Staging | staging
Production | prod
Q: Proceed now?
noskip
Yes | yes
[[/BGOS_ASK]]
Options are \`Label | value\`. Add \`noskip\` to require an answer, \`nofreetext\`
to disallow a typed answer. Each answer arrives as your next message.

## Status line
Show a short working status with \`STATUS: <text>\` on its own line (for example
\`STATUS: running tests\`). An empty \`STATUS:\` clears it.

## Tool activity (automatic)
Your shell commands, file edits, MCP tool calls, and web searches are shown to
the user as a live tool-progress card automatically. You do not need to report
them.

## Files the user sends you
Images are attached to your input directly. Other files are downloaded and their
absolute path is given to you inline as \`[File attached: /path (mime)]\`; read
them from disk as needed.

## Slash commands
\`/new\` starts a fresh conversation (your thread is reset). \`/retry\` re-runs the
user's last message. \`/status\` shows daemon health. These are handled by the
daemon; you will not see them.

## Not supported here
No group chats, threads, or message editing. Dangerous-command approval prompts
are not surfaced to BGOS in this version; run within your sandbox.
`;

const HEADER_MARKER = "# BGOS Channel, Agent Capabilities";
const SEPARATOR = "\n\n---\n";

/**
 * Append the BGOS hints to an existing system prompt (idempotent). Kept for the
 * inbound-handler's prompt-injection call site; the primary delivery for Codex is
 * AGENTS.md (see writeAgentsMd).
 */
export function buildSystemPromptWithHints(original: string): string {
  const base = original ?? "";
  if (base.includes(HEADER_MARKER)) return base;
  return base.trim().length > 0
    ? `${base}${SEPARATOR}${BGOS_AGENT_HINTS}`
    : BGOS_AGENT_HINTS;
}
