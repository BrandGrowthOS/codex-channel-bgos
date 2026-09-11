// Adapted from BrandGrowthOS/bgos-claude-plugin, Apache-2.0, commit 3ecbb58679febcc243f671e05788b521b065546e.
export const HOAI_TOOL_DECLARATIONS = [
{
      name: 'bgos_capabilities',
      description:
        'Load the authoritative, always-current HOAI (BGOS) agent capability ' +
        'guide. It is fetched live from the backend at connect and tells you ' +
        'exactly what you can do through this channel: message formatting, ' +
        'inline buttons, files, ask_user_input, approvals, peers, voice, status, ' +
        'and more. Call this once at the start of a session (and any time you are ' +
        'unsure what HOAI supports); the returned guide supersedes any older ' +
        'summary in these instructions. Falls back to a bundled copy offline.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
{
      name: 'reply',
      description:
        'Send a reply message to the user through the BGOS chat app. ' +
        'Supports text (markdown), file attachments (images, videos, documents), ' +
        'and optional tappable buttons (inline Telegram-style chips or modal ' +
        'pop-under). At least one of text, files, or buttons is required. ' +
        'When buttons are sent, clicks arrive back as a channel event with ' +
        'callback_data (= the button\'s `value`) and message_id. Skip sentinel ' +
        'is "__skip__", Custom-reply sentinel is "__custom__" (with free text). ' +
        'Use `ask_user_input` instead only when you need blocking multi-question ' +
        'flow + free-text + skip semantics.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description:
              'The chat to reply in. Pass back the chat_id (or, if present, the ' +
              'session_handle) from the channel event you are answering. The ' +
              'plugin rejects chat ids it has not received an inbound event for.',
          },
          text: {
            type: 'string',
            description:
              'The message text to send. Supports markdown. Bare URLs/emails ' +
              'auto-link (Telegram-style); masked [text](url) links show the ' +
              'user an "Open this link?" confirmation, so prefer bare URLs. ' +
              'URLs in code spans stay plain. Optional if sending files or buttons.',
          },
          files: {
            type: 'array',
            description: 'File attachments (images, videos, documents). Each file specified by URL or local path.',
            items: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL of the file. Use for remote/web files.' },
                path: { type: 'string', description: 'Absolute local file path. Plugin reads and uploads the file.' },
                file_name: { type: 'string', description: 'Display name (optional).' },
                mime_type: { type: 'string', description: 'MIME type override (optional).' },
              },
            },
          },
          buttons: {
            type: 'array',
            description:
              'Optional tappable choices (2, 6). Clicks come back as a channel event with `callback_data = button.value`. ' +
              'Labels should be under ~24 chars. Use this for async prompts where you do NOT want to block the session, ' +
              'e.g. "Review these 3 options when you get a chance." Chat shows a "Skip" and "Custom reply" affordance ' +
              'automatically; no need to include them yourself.',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                label: { type: 'string', description: 'Visible button text (user-facing).' },
                value: { type: 'string', description: 'Stable identifier returned to you in the click callback_data.' },
              },
              required: ['label', 'value'],
            },
          },
          render_mode: {
            type: 'string',
            enum: ['inline', 'modal'],
            description:
              'Only meaningful when `buttons` is non-empty. "inline" (DEFAULT), Telegram-style chips in the chat thread; ' +
              'never interrupts; stays clickable indefinitely. Use for async/scheduled/proactive sends. ' +
              '"modal", pops over the chat demanding attention; use only when the user is actively in conversation ' +
              'and you want their immediate choice. When in doubt, omit (defaults to inline).',
          },
          reply_to_id: {
            type: 'number',
            description:
              'Set this to the source message id when you want to anchor this ' +
              'reply to a specific earlier message, BGOS renders a Telegram-' +
              'style quoted-reply header (tap → jump to source) and persists a ' +
              'frozen text/sender snapshot. Two use-cases: ' +
              '(1) USER REPLY-QUOTE, answering a question from N messages ago ' +
              "where the user would otherwise have to scroll up, following up on " +
              "your own past commitment, correcting a specific earlier statement, " +
              "or surfacing a cron-triggered nudge tied to an older message. " +
              "Don't quote the immediately preceding user turn (alignment already " +
              'implies the subject) or for pure acknowledgements ("Got it"). ' +
              '(2) AGENT-TO-AGENT SIDE-THREAD, when replying to an inbound peer ' +
              "agent message so the initiating agent's wait_for_reply resolves. " +
              'Same-chat constraint enforced server-side (400 otherwise).',
          },
        },
        required: ['chat_id'],
      },
    },
{
      name: 'edit_message',
      description: 'Edit a previously sent message in the BGOS chat.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'The message ID to edit' },
          text: { type: 'string', description: 'The new message text' },
        },
        required: ['message_id', 'text'],
      },
    },
{
      name: 'rename_chat',
      description: 'Rename a BGOS chat to give it a descriptive title.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: { type: 'string', description: 'The chat to rename' },
          title: { type: 'string', description: 'The new chat title' },
        },
        required: ['chat_id', 'title'],
      },
    },
{
      name: 'set_status',
      description:
        'Publish this agent\'s "what I am doing right now" line for the BGOS ' +
        'Command Center agent-roster view (capability #11). OPTIONAL enrichment: ' +
        'BGOS already derives a live status (idle / thinking / working / blocked / ' +
        'done) from your messages and tool activity, so a self-report only makes ' +
        'the one-liner crisper and more human ("Drafting headlines" instead of the ' +
        'derived "Working"). Call it when you START a task or CHANGE phase; pass an ' +
        'empty string ("") for status_text to CLEAR it when you go idle. Do NOT ' +
        'call it on every step (it is a coarse "current focus", not a transcript) ' +
        'and never use it for your actual reply to the user (use `reply`) or for ' +
        'anything the user must act on (use `ask_user_input`). Maps to ' +
        'PATCH /api/v1/assistants/:id/status (user-scoped, X-API-Key).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status_text: {
            type: 'string',
            description:
              'Short "current focus" line, max 120 chars (e.g. "Researching ' +
              'competitors"). Pass "" to CLEAR the status. Omit to leave it ' +
              'unchanged while only updating the emoji or detail.',
          },
          status_emoji: {
            type: 'string',
            description:
              'Optional single emoji that rides the agent avatar, max 8 chars ' +
              '(ZWJ sequences ok). Pass "" to clear. Omit to leave unchanged.',
          },
          detail: {
            type: 'string',
            description:
              'Optional richer one-sentence "what I am doing right now" for the ' +
              'Command Center context card, max 280 chars (e.g. "Cross-checking ' +
              'the Q3 invoices against the bank export"). Ephemeral (not persisted ' +
              'on the assistant row); dropped if the agent has no live activity ' +
              'entry yet. Pass "" to clear. Omit to leave unchanged.',
          },
        },
      },
    },
{
      name: 'ask_user_input',
      description:
        'Ask the user one or more choice questions or short form fields through a polished ' +
        'modal/sheet in the BGOS app. BLOCKS until every question is answered ' +
        '(option picked, free text typed, or skipped) and returns structured ' +
        'answers. Use ONLY when (a) you need a choice or a specific form value ' +
        'AND (b) the user is actively in this conversation. ' +
        'For open-ended questions use `reply`. For async/unprompted scenarios ' +
        '(scheduled check-ins, proactive nudges) DO NOT use this, a blocking ' +
        'modal is inappropriate when the user is not waiting on you. See the ' +
        'top-level instructions for full guidance on when this fits.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description:
              'The chat to ask in. Pass back the chat_id (or session_handle) ' +
              'from the channel event. Rejected if not a chat you received an ' +
              'inbound event for.',
          },
          questions: {
            type: 'array',
            description:
              '1 to 4 questions to ask, in order. For a short typed form field, ' +
              'use options: [] and allow_free_text: true.',
            items: {
              type: 'object',
              properties: {
                text: {
                  type: 'string',
                  description: 'The question to display. Keep under ~80 chars.',
                },
                options: {
                  type: 'array',
                  description:
                    'Up to 6 selectable choices. Empty only for a typed form field ' +
                    'with allow_free_text enabled. Each label under ~30 chars.',
                  items: {
                    type: 'object',
                    properties: {
                      label: {
                        type: 'string',
                        description: 'Visible button text.',
                      },
                      value: {
                        type: 'string',
                        description:
                          'Identifier returned in the answer when this option is picked.',
                      },
                    },
                    required: ['label', 'value'],
                  },
                  minItems: 0,
                  maxItems: 6,
                },
                allow_free_text: {
                  type: 'boolean',
                  description:
                    'Show "Your answer…" input below the options. Default true.',
                },
                allow_skip: {
                  type: 'boolean',
                  description:
                    'Show a Skip button so the user can move past without answering. Default true.',
                },
              },
              required: ['text', 'options'],
            },
            minItems: 1,
            maxItems: 4,
          },
          timeout_seconds: {
            type: 'number',
            description:
              'Hard upper bound to wait for answers. Default 600 (10 minutes). ' +
              'On timeout, any unanswered questions return as { skipped: true }.',
          },
        },
        required: ['chat_id', 'questions'],
      },
    },
{
      name: 'complete_voice_task',
      description:
        'Report the outcome of a VOICE-DISPATCHED background task. When your ' +
        'user is on a live voice call and dispatches work to you, a ' +
        '[voice_dispatch] notification arrives with a task_id and a complete ' +
        'brief. Do the work in this session, then call this tool EXACTLY ONCE ' +
        'with the task_id and a concise, SPEAKABLE result (1-6 sentences — it ' +
        'is announced aloud in the call and shown on the in-call Agent Work ' +
        'Stream card). If you cannot complete the task, set failed=true and ' +
        'put the reason in result. Maps to ' +
        'POST /api/v1/integrations/voice-tasks/:taskId/result (X-API-Key, ' +
        'owner-scoped).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          task_id: {
            type: 'string',
            description: 'The task id from the [voice_dispatch] notification.',
          },
          result: {
            type: 'string',
            description:
              'The outcome, written to be SPOKEN: lead with the answer, keep ' +
              'it tight. On failure: the reason it could not be done.',
          },
          failed: {
            type: 'boolean',
            description: 'Set true when the task could not be completed.',
          },
        },
        required: ['task_id', 'result'],
      },
    },
{
      name: 'voice_consult_reply',
      description:
        'Answer a LIVE voice-call consult. When a [voice_consult] ' +
        'notification arrives (your user asked you a question mid-call), ' +
        'call this tool FIRST — before any other tool — with the consult_id ' +
        'from the notification and a short, SPEAKABLE answer (1-3 ' +
        'sentences; it is spoken aloud on the call). You have roughly 30 ' +
        'seconds from the notification. If you reply too late the call has ' +
        'moved on: the tool tells you so — then send the answer as a ' +
        'normal chat message with the reply tool instead, so nothing is ' +
        'lost.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          consult_id: {
            type: 'string',
            description:
              'The consult_id from the [voice_consult] notification.',
          },
          answer: {
            type: 'string',
            description:
              'The answer, written to be SPOKEN: lead with the answer, ' +
              '1-3 short sentences, no markdown.',
          },
        },
        required: ['consult_id', 'answer'],
      },
    },
{
      name: 'list_peers',
      description:
        "List the user's other assistants (peer agents) on this BGOS account. " +
        'Each entry includes `assistantId` (the integer to pass to send_to_peer), ' +
        '`name`, `avatarUrl`, and crucially `introduced`, true ONLY if the user ' +
        'has enabled this direction in the Agent Permissions matrix. If introduced ' +
        'is false, you can suggest the peer in your reply ("Want me to ask Hades?") ' +
        'but send_to_peer will return requires_introduction until the user enables it. ' +
        'system_hint is intentionally omitted to prevent capability leakage between agents.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
{
      name: 'list_chats',
      description:
        'Enumerate every chat YOU can reach, including CLOSED peer-bridged side ' +
        'conversations that the poll inbox hides. Each `a2a` entry carries a ' +
        '`binding` with `status` ("open" or "closed"), the `peerAssistantId`, ' +
        'why/when it closed, and `revivable`. Use it to tell a DEAD binding ' +
        '(outbound reply path closed) from a chat that is merely quiet. A ' +
        'closed-but-revivable bridged chat is re-opened automatically when you ' +
        'reply into it (send_to_peer / reply), because being a participant IS ' +
        'the permission; a binding closed as revoked or promoted is not ' +
        'revivable that way. No arguments.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
{
      name: 'send_to_peer',
      description:
        "Send a message into another BGOS assistant's side-thread. The peer receives " +
        'it as a normal inbound message tagged with `fromAgent` so they know it came ' +
        'from a peer, not the user. The user sees the exchange unfold inline as a ' +
        'minimalist SideConversationCard rendered against the parent message in this ' +
        "chat. Set parent_message_id to the id of one of YOUR previous reply messages " +
        "(the one the card visually anchors to in this chat). Set wait_for_reply=true " +
        'to BLOCK until the peer replies (their reply must include reply_to_id pointing ' +
        'to the message_id you sent). Returns { status, sideThreadChatId, messageId, reply? }. ' +
        "Status='requires_introduction' means the user has not enabled this direction. " +
        "Do NOT retry on timeout, the message is already saved server-side. " +
        "Either drop wait_for_reply (cap is 85s anyway) and poll the side-thread " +
        "later, or accept the timeout and check " +
        "GET /api/v1/peers/threads/{parent_message_id} for any reply with " +
        "replyToId matching your sent messageId.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          target_assistant_id: {
            type: 'number',
            description: 'The peer assistant id (from list_peers).',
          },
          text: { type: 'string', description: 'The message body for the peer agent.' },
          parent_message_id: {
            type: 'number',
            description:
              'A message id in YOUR chat that anchors the SideConversationCard. ' +
              'Typically the id of a reply you just sent saying "Looping in <peer>...".',
          },
          wait_for_reply: { type: 'boolean', description: 'Block until peer replies. Default false.' },
          timeout_seconds: {
            type: 'number',
            description:
              'How long to wait when wait_for_reply=true. 1 to 50 seconds, default 45 ' +
              '(the server rejects longer holds; its edge closes idle connections at 60s). ' +
              'For longer waits send without blocking and act on the reply when it arrives.',
          },
          turn_state: {
            type: 'string',
            enum: ['expecting_reply', 'more_coming', 'final'],
            description:
              "Lifecycle hint for the peer conversation. 'expecting_reply' (default) yields the turn to the peer. 'more_coming' keeps the turn so multiple updates land back-to-back without releasing it. 'final' closes the conversation; further sends from either side require a fresh send_to_peer (which will auto-open a new conversation).",
          },
        },
        required: ['target_assistant_id', 'text', 'parent_message_id'],
      },
    },
{
      name: 'complete_peer_thread',
      description:
        "Close the active peer conversation between you and a peer assistant. " +
        "Pass a one-line `summary` describing what was accomplished. CLOSE " +
        "POLICY: either participant (initiator OR peer) may close at any time " +
        "once they consider the exchange finished; you do NOT have to be the " +
        "initiator, and whoever is satisfied first should close rather than " +
        "waiting. This performs a real both-sides close: the conversation is " +
        "truly ended and BOTH sides are notified with your one-line summary, " +
        "which shows as the collapsed-state caption on the SideConversationCard " +
        "so the user doesn't have to expand the card to know what happened. " +
        "Use this when the back-and-forth is complete and you don't expect more " +
        "messages on this thread. After closing, any send_to_peer to the same " +
        "peer will auto-open a NEW conversation. FAILSAFE: if nobody closes, an " +
        "idle sweeper hard-closes the stale conversation after the configured " +
        "idle window (default 15 minutes, env PEER_CONV_IDLE_CLOSE_MS) with a " +
        "generated summary and a both-sides notification, so nothing is left " +
        "stuck on 'Live'. Calling this explicitly is still ALWAYS preferred " +
        "when you can write a real summary.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          peer_assistant_id: {
            type: 'number',
            description: "The peer assistant id whose active conversation with you should be closed.",
          },
          summary: {
            type: 'string',
            description:
              'One-line synthesis of what the peer accomplished (e.g. "Hades created bgos-dev-uploads in us-east-1, public access blocked"). Max 1024 chars. Strongly recommended, without it the UI shows a generic "Conversation completed" line.',
          },
        },
        required: ['peer_assistant_id'],
      },
    },
{
      name: 'peer_status',
      description:
        "Check whether a peer assistant is currently online (an MCP plugin or " +
        "channel adapter is connected for them right now) and whether you have " +
        "an open conversation with them. Use this BEFORE send_to_peer when you " +
        "want to know if the peer will see your message immediately or only on " +
        "their next reconnect. Returns { online, lastSeenAt, hasOpenConversation, " +
        "conversationId, turnHolderId }.",
      inputSchema: {
        type: 'object' as const,
        properties: {
          peer_assistant_id: {
            type: 'number',
            description: 'The peer assistant id to check status for.',
          },
        },
        required: ['peer_assistant_id'],
      },
    },
{
      name: 'complete_side_thread',
      description:
        'Mark a side conversation complete with a one-line synthesis. The user ' +
        'sees this in the SideConversationCard once the live exchange ends, it ' +
        'flips the card from live (pulsing dot + last 2 turns) to ' +
        'completed-collapsed (static dot + this summary). CLOSE POLICY: either ' +
        'participant (initiator OR peer) may call this at any time once they ' +
        'consider the exchange finished. You do not have to be the initiator. ' +
        'When an open conversation exists this performs a real both-sides close ' +
        '(neither agent, nor a cross-user counterpart, is left stuck on Live) ' +
        'and notifies both sides with your one-line summary. FAILSAFE: if ' +
        'nobody closes, an idle sweeper hard-closes the stale conversation ' +
        'after the configured idle window (default 15 minutes, env ' +
        'PEER_CONV_IDLE_CLOSE_MS) with a generated summary and a both-sides ' +
        'notification, so nothing is left stuck on Live.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          parent_message_id: {
            type: 'number',
            description: 'Same parent_message_id you used in send_to_peer.',
          },
          summary: {
            type: 'string',
            description:
              'One-line synthesis of what the peer accomplished (e.g., "Hades created bgos-dev-uploads in us-east-1, public access blocked").',
          },
        },
        required: ['parent_message_id', 'summary'],
      },
    },
{
      name: 'meeting_reply',
      description:
        'Send a message into an active Command Center meeting room. Use ONLY ' +
        'when you are the current speaker, the channel notification you ' +
        'received will say "your_turn=YES" in its meta header. If your_turn=NO ' +
        'you must observe silently; the backend will reject calls (HTTP 409) ' +
        'while it is not your turn. End your reply text with "@<name>" to ' +
        'suggest the next speaker (the user can override). Send the literal ' +
        'token "PASS" to decline this turn without contributing, turn returns ' +
        'to the user.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          meeting_id: {
            type: 'number',
            description:
              'Meeting room id from the channel notification meta. Required.',
          },
          text: {
            type: 'string',
            description:
              'Your reply. Plain text or markdown. Trailing "@<name>" suggests next speaker.',
          },
          next_speaker_id: {
            type: 'number',
            description:
              'Optional explicit next-speaker assistantId. If omitted, the backend infers from any @-mention in `text`.',
          },
          yield_only: {
            type: 'boolean',
            description:
              'When true, send "PASS" and yield without contributing. Equivalent to setting text="PASS".',
          },
        },
        required: ['meeting_id'],
      },
    },
{
      name: 'add_to_meeting',
      description:
        'Seat another agent in an active Command Center meeting you are in. ' +
        'You must be an ACTIVE PARTICIPANT of that meeting (the backend refuses ' +
        'with 403 otherwise), the meeting must be open (409 if closed) and the ' +
        'room has an agent cap (409 when full). The added agent joins the ' +
        'roster and starts receiving turn events; the floor does not change. ' +
        'Use it when the discussion needs an agent who is not in the room; ' +
        'find ids with list_peers.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          meeting_id: {
            type: 'number',
            description: 'Meeting room id from the channel notification meta. Required.',
          },
          assistant_id: {
            type: 'number',
            description: 'The assistantId of the agent to add (see list_peers). Required.',
          },
        },
        required: ['meeting_id', 'assistant_id'],
      },
    },
{
      name: 'call_owner',
      description:
        'Ring the owner with a live, in-app voice call. Use when the user asks ' +
        'the agent to call them (e.g. "call me", "give me a ring", "let\'s hop ' +
        'on voice") or when a scheduled call fires. The owner sees an incoming ' +
        'ring in the BGOS app and can answer to talk to you live. If voice is ' +
        'not set up on this agent, the tool returns a human setup-guidance ' +
        'string instead of an error, relay that guidance to the user verbatim ' +
        'so they know exactly how to enable voice.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          reason: {
            type: 'string',
            description:
              'Short reason shown under your name on the ring screen so the ' +
              'owner knows why you are calling. One or two plain sentences, ' +
              '140 characters max, no markdown or line breaks (e.g. "Daily ' +
              'standup" or "Your build finished. Want to review it now?"). ' +
              'Longer text is trimmed at a word boundary. Optional but ' +
              'recommended.',
          },
          chat_id: {
            type: 'string',
            description:
              'Chat to bind the call to. Pass back the chat_id (or ' +
              'sessionHandle) from the channel event you are answering. Omit to ' +
              'default to the current/most-recent chat.',
          },
        },
        required: [],
      },
    },
{
      name: 'schedule',
      description:
        'Create a task on the platform\'s native scheduler. kind "wake" ' +
        'delivers your `topic` back to you as a system message at fire time ' +
        '(reminders, follow-ups, recurring checks). kind "call" RINGS the ' +
        'owner with a live in-app voice call at fire time, the default for ' +
        'any timed call request. Examples: "wake me tomorrow 9am" = kind ' +
        '"wake" with when set to tomorrow 09:00 as a concrete ISO datetime ' +
        'in the user\'s timezone (shape "2026-07-10T09:00:00+04:00"; always ' +
        'compute the real date, never copy this sample); "call the owner ' +
        'every weekday 8am Dubai" = kind "call" with when { freq: "weekly", ' +
        'daysOfWeek: [1,2,3,4,5], atMinute: 480, tz: "Asia/Dubai" }. For an ' +
        'immediate call use `call_owner` instead; to change a schedule, ' +
        'cancel_schedule the old task and create a new one.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          kind: {
            type: 'string',
            enum: ['wake', 'call'],
            description:
              '"wake" = deliver topic back to you at fire time. "call" = ' +
              'ring the owner with a live in-app voice call at fire time.',
          },
          topic: {
            type: 'string',
            description:
              'The headline instruction to act on at fire time (<=500 chars). ' +
              'Make it self-contained: at fire time you only see this text ' +
              '(plus `instruction`), not this conversation.',
          },
          instruction: {
            type: 'string',
            description:
              'Optional detailed brief delivered alongside the topic at fire ' +
              'time (<=2000 chars). Use it for steps, links, or context that ' +
              'does not fit the topic headline.',
          },
          when: {
            type: ['string', 'object'],
            description:
              'When to fire. ONE of: an ISO datetime string for a one-shot ' +
              '(e.g. "2026-07-10T09:00:00+04:00", convert the user\'s words ' +
              'to ISO in THEIR timezone and ALWAYS include the timezone ' +
              'offset, Z or +04:00; bare dates and offset-less datetimes ' +
              'are rejected), OR { everyHours: N } to repeat every N whole ' +
              'hours (1..8760; add fireAt: "<ISO>" inside it to pin the ' +
              'first fire), OR a recurrence object { freq: ' +
              '"daily"|"weekly"|"monthly", atMinute (minutes after midnight ' +
              'in tz, 8am = 480), tz (IANA name like "Asia/Dubai"), ' +
              'daysOfWeek (weekly, integers 0=Sunday .. 6=Saturday), ' +
              'dayOfMonth (monthly, 1..31), interval? }; a recurrence ' +
              'starts at its next natural occurrence.',
          },
          chat_id: {
            type: 'string',
            description:
              'Chat to bind the task to. Omit to use your main chat with the ' +
              'owner (the platform default).',
          },
        },
        required: ['kind', 'topic', 'when'],
      },
    },
{
      name: 'list_schedules',
      description:
        'List your own scheduled tasks (created with the `schedule` tool): ' +
        'id, kind, topic, and when each fires next. Use it to answer "what ' +
        'reminders do I have?" and to find the id to pass to ' +
        '`cancel_schedule`. Shows active tasks by default; pass status ' +
        '"done", "cancelled", or "all" for history.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          status: {
            type: 'string',
            enum: ['active', 'done', 'cancelled', 'all'],
            description:
              'Filter by task status. Omit for active (the default).',
          },
        },
        required: [],
      },
    },
{
      name: 'cancel_schedule',
      description:
        'Cancel one of your own scheduled tasks by id (find the id with ' +
        '`list_schedules`). Use when the user cancels a reminder or standing ' +
        'call; to reschedule, cancel the old task and create a new one with ' +
        '`schedule`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          schedule_id: {
            type: 'string',
            description:
              'The scheduled task id, as returned by `schedule` or ' +
              '`list_schedules`.',
          },
        },
        required: ['schedule_id'],
      },
    },
{
      name: 'create_mission',
      description:
        'Create a durable mission card pinned in the BGOS chat (capability ' +
        '#19): a title plus 4 to 10 BINARY mini-goals, each with a ' +
        '`done_when` line stating the observable check that proves it. Call ' +
        'this FIRST whenever a user request is multi-step (3+ distinct ' +
        'steps or work spanning tools and minutes), then work normally and ' +
        'tick goals with `tick_mini_goal` as their checks come true. One ' +
        'active mission per agent; creating a new one abandons the previous ' +
        'active mission. Maps to POST /api/v1/assistants/:id/missions ' +
        '(user-scoped, X-API-Key).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description:
              'Mission headline the user sees on the card (<=200 chars), ' +
              'e.g. "Launch the newsletter".',
          },
          mini_goals: {
            type: 'array',
            description:
              '4 to 10 binary mini-goals (hard caps 2..12). Outcomes, not ' +
              'keystrokes.',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Short goal name (<=120 chars).',
                },
                done_when: {
                  type: 'string',
                  description:
                    'Observable completion check (<=200 chars), e.g. "the ' +
                    'URL returns 200". Must be verifiable, never vague.',
                },
              },
              required: ['name', 'done_when'],
            },
          },
        },
        required: ['title', 'mini_goals'],
      },
    },
{
      name: 'tick_mini_goal',
      description:
        'Mark ONE mission mini-goal done the moment its `done_when` check ' +
        'is true (capability #20). Pass the goal_id from the create_mission ' +
        'result and a short `evidence` line (what proved the check). Ticks ' +
        'are quiet (no user ping) and idempotent; ticking the last open ' +
        'goal completes the mission automatically. Targets your active ' +
        'mission unless mission_id is passed. Maps to PATCH ' +
        '/api/v1/assistants/:id/missions/:missionId/tick.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          goal_id: {
            type: 'number',
            description: 'The mini-goal id (1..n) to mark done.',
          },
          evidence: {
            type: 'string',
            description:
              'Short proof line for the done_when check (<=200 chars), ' +
              'e.g. "URL returned 200".',
          },
          mission_id: {
            type: 'number',
            description:
              'Optional mission id; omit to target your active mission.',
          },
        },
        required: ['goal_id'],
      },
    },
{
      name: 'complete_mission',
      description:
        'End a mission early, marking it completed even though open ' +
        'mini-goals remain (capability #20). Only needed when the remaining ' +
        'goals became moot: ticking the last open goal already completes ' +
        'the mission automatically. Targets your active mission unless ' +
        'mission_id is passed. Maps to PATCH ' +
        '/api/v1/assistants/:id/missions/:missionId/complete.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          summary: {
            type: 'string',
            maxLength: 500,
            description:
              'Optional honest completion summary (at most 500 chars). Write ' +
              'one or two plain sentences: what changed, and what is waiting ' +
              'for the user\'s eyes, for example "23 drafts waiting for your review".',
          },
          mission_id: {
            type: 'number',
            description:
              'Optional mission id; omit to target your active mission.',
          },
        },
        required: [],
      },
    },
{
      name: 'log_health_event',
      description:
        'Log a health event (meal, supplement, habit, water, ...) to the ' +
        "owner's native health tracker; it appears in the app's health " +
        'dashboard. Auth and idempotency are handled for you. Contract: ' +
        'tell the user "logged" ONLY when this tool answers Logged. If it ' +
        'answers that the item was already logged today, ask the user first ' +
        'and only on a clear yes call again with allow_duplicate: true. If ' +
        'it fails with a network error, retry with the SAME idempotency_key ' +
        'it echoed (that makes the retry double-log-proof).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event_type: {
            type: 'string',
            description:
              'Lowercase category, e.g. "meal", "supplement", "habit", ' +
              '"water" (<=64 chars).',
          },
          item_name: {
            type: 'string',
            description: 'What was logged, e.g. "Grilled chicken salad" (<=200 chars).',
          },
          quantity: {
            type: 'number',
            description: 'Optional amount, pairs with unit (e.g. 350 + "g").',
          },
          unit: { type: 'string', description: 'Optional unit (<=32 chars).' },
          notes: { type: 'string', description: 'Optional notes (<=2000 chars).' },
          logged_at: {
            type: 'string',
            description:
              'Optional ISO 8601 original event time (backfilling past ' +
              'meals is fine); defaults to now.',
          },
          timezone: {
            type: 'string',
            description: 'Optional IANA zone for the day boundary; defaults to Asia/Dubai.',
          },
          allow_duplicate: {
            type: 'boolean',
            description:
              'Pass true ONLY after the user confirmed logging the same ' +
              'item again on the same day.',
          },
          idempotency_key: {
            type: 'string',
            description:
              'ONLY for retrying a failed attempt: the UUID echoed by that ' +
              'attempt. Omit for every new log.',
          },
        },
        required: ['event_type', 'item_name'],
      },
    },
{
      name: 'list_health_events',
      description:
        "List the owner's logged health events for one local day (default " +
        'today). Use to review before logging or to answer "what did I eat ' +
        'today". Maps to GET /api/v1/health-log/events.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          day: { type: 'string', description: 'Local day YYYY-MM-DD; omit for today.' },
          timezone: {
            type: 'string',
            description: 'Optional IANA zone for the day boundary; defaults to Asia/Dubai.',
          },
        },
        required: [],
      },
    },
{
      name: 'undo_health_event',
      description:
        'Undo a mistakenly logged health event by the event id returned ' +
        'from log_health_event (owner-scoped). Maps to DELETE ' +
        '/api/v1/health-log/events/:id.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          event_id: {
            type: 'string',
            description: 'The event id from the log_health_event response.',
          },
        },
        required: ['event_id'],
      },
    },
{
      name: 'show_health_tracker',
      description:
        "Render the owner's REAL native health tracker card in the chat " +
        '(the visual card, not text; tapping it opens the full dashboard ' +
        'with heatmap and momentum ring). Use when the owner asks to SEE ' +
        'their health data ("show me my macros", "how is my week") or when ' +
        'a visual would land better than numbers, e.g. right after logging ' +
        'a streak-worthy event. When the owner asks to see macros or ' +
        'supplements, put the actual numbers in the macros/supplements ' +
        'arguments: that is what makes the rich Budget board render ' +
        '(kcal-left hero, target band bars, supplement queue). Without ' +
        'them the classic simple card renders and shows no numbers. Send ' +
        'at most one card per occasion; pair it with a short text ' +
        'one-liner. The advice to carry numbers in text applies only to ' +
        'that pairing one-liner, never as a substitute for putting the ' +
        'numbers in the payload.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          chat_id: {
            type: 'string',
            description:
              'The chat to render the card in. Pass back the chat_id (or ' +
              'session_handle) from the channel event you are answering.',
          },
          note: {
            type: 'string',
            description:
              'Optional one-line caption shown on the card (<=300 chars), ' +
              'e.g. "Protein target hit 5 days straight".',
          },
          macros: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Optional macro entries that upgrade the card to the rich ' +
              'Budget board. Each entry commonly carries: key (lowercase ' +
              'id, e.g. "calories", "protein", "carbs", "fat", "fiber", ' +
              '"water"; a calories entry feeds the kcal-left hero), label, ' +
              'value (amount consumed so far, number), target (number; ' +
              'the window LOW bound when targetHigh is present, the cap ' +
              'amount when cap is true), optional targetHigh (window high ' +
              'bound, strictly above target), optional unit (e.g. "g", ' +
              '"kcal"), optional cap (true = stay-under cap like sodium). ' +
              'The LIVE catalog schema for kind health_tracker_card at ' +
              'GET /api/v1/renderables is authoritative over this ' +
              'summary; invalid entries are rejected before sending with ' +
              'the exact field named, e.g. "macros[0].target is required".',
          },
          supplements: {
            type: 'array',
            items: { type: 'object' },
            description:
              'Optional supplement entries rendered as a next-up queue on ' +
              'the rich Budget board. Each entry commonly carries: name, ' +
              'taken (boolean), optional time (free text like "9:12 AM" ' +
              'or "this evening"), optional note (e.g. "Best with ' +
              'dinner"). The LIVE catalog schema for kind ' +
              'health_tracker_card at GET /api/v1/renderables is ' +
              'authoritative over this summary; invalid entries are ' +
              'rejected before sending with the exact field named.',
          },
        },
        required: ['chat_id'],
      },
    },
{
      name: 'show_component',
      description:
        'Summon ANY registered native visualization as a real component ' +
        'card in the chat (the generic successor to show_health_tracker). ' +
        'Discovery: the live catalog of kinds and their payload schemas is ' +
        'fetched for you from GET /api/v1/renderables on every call, so an ' +
        'unknown kind answers with the list of known kinds; you can also ' +
        'browse that endpoint yourself (see bgos_capabilities). Payloads ' +
        'are validated against the kind\'s schema before sending and the ' +
        'specific field error comes back to you. Send at most ONE card per ' +
        'occasion and pair it with a short normal reply carrying the ' +
        'substance. Each kind\'s minAppVersion is advisory: the owner\'s ' +
        'app may not render a new kind yet, in which case (and on any ' +
        'unknown kind or invalid payload) the app degrades gracefully to a ' +
        'quiet collapsible event card, never an error.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          kind: {
            type: 'string',
            description:
              'The component kind from the renderables catalog, e.g. ' +
              '"health_tracker_card".',
          },
          payload: {
            type: 'object',
            description:
              'Component fields per the kind\'s payloadSchema (omit for a ' +
              'kind with no required fields). Do not include "kind"; the ' +
              'tool sets it. Unknown extra fields are ignored by the app.',
          },
          chat_id: {
            type: 'string',
            description:
              'The chat to render the card in. Pass back the chat_id (or ' +
              'session_handle) from the channel event you are answering.',
          },
        },
        required: ['kind', 'chat_id'],
      },
    },
{
      // Zero-terminal lifecycle (design 7.2): the silent liveness probe's
      // answer. The watcher writes probe-requested.json after restarting
      // this agent, the daemon pushes one channel notification asking for
      // this tool, and the call is the proof the new session hears us.
      name: 'channel_ack',
      description:
        'Liveness acknowledgement after a restart; call when a [hoai] liveness ' +
        'check asks for it. Sends nothing to the user. Internal: the HOAI ' +
        'watcher reads the resulting tool call as proof that this session ' +
        'hears channel events.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    }
];
