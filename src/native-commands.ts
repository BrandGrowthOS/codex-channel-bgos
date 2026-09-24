/** UI commands call native protocol methods; they are never prompts to an LLM. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CodexHost, RunTurnCallbacks } from "./codex-host.js";
import { formatGoalSeconds, goalStatusWord, GOAL_DEFAULT_TURN_CAP } from "./goal-lane.js";
import type { ThreadGoal } from "./goal-protocol.js";
import type { DispatchArgs } from "./inbound-handler.js";
import type { Interactions, InteractionContext } from "./interactions.js";
import { planWaitEnforced } from "./plan-mode.js";
import type { SessionSettings } from "./session-settings.js";
import { RequestTimeoutError, type RpcObject } from "./app-server.js";

/**
 * The native command a correction rides, typed or sent by the HOAI app's
 * follow ups tray (its Send now on a Codex agent, P5 stage 5, C-27). The
 * catalog registers it under this name and the router answers to it, and the
 * app offers a steer only to an agent whose catalog lists it.
 */
export const STEER_COMMAND_NAME = "steer";
/**
 * The first release whose `/steer` with nothing to steer runs the text as a
 * normal message instead of answering an error and dropping it, and whose
 * landed steer posts no reply. The app steers only daemons at or past it (its
 * `CODEX_STEER_FALLBACK_SINCE`); below it, Send now is a plain send. A test
 * holds package.json at or past this floor.
 */
export const STEER_FALLBACK_SINCE = "0.15.0";
/**
 * THE CROSS REPO PIN (P5 stage 5, spec section 8). The sha256 of the
 * canonical steer contract `steer;slash_command;/steer {text};0.15.0`: the
 * command name, the message type it arrives under, the text shape the router
 * parses and the floor above. The HOAI app carries the SAME constant in
 * `frontend/expo-app/src/components/chat/followUpTrayModel.ts`; each side
 * rebuilds the string from its OWN values in a test (here
 * test/steer-contract.spec.ts) and compares this hash, so a one sided change
 * that also updates its own word for word pin still turns the hash pin red.
 * Change the contract only with the app's PR, and move the hash in both.
 */
export const TRAY_STEER_CONTRACT_SHA256 =
  "04ae44be5ff657f805b13f44cb7919997328387e9caddec8fc2cc422477f7226";
/**
 * The one line a steer can still produce: Codex never answered it. It may
 * have landed, so it is neither run as a message nor sent again (never both),
 * and the owner is told plainly what to do if it did not.
 */
export const STEER_UNCONFIRMED_TEXT =
  "Codex did not confirm the correction in time, so it was not sent a second time. If Codex does not act on it, send it again as a normal message.";

export const NATIVE_COMMAND_DESCRIPTIONS = [
  ["model", "Choose this chat's Codex model and reasoning level"],
  ["effort", "Change the reasoning level for the current model"],
  ["plan", "Plan before acting; use /plan off to return to coding"],
  ["code", "Return to coding mode, with an optional task"],
  ["permissions", "Choose read-only or workspace access for this chat"],
  ["personality", "Choose a supported communication style"],
  ["fast", "Choose a speed tier offered by the current model"],
  ["usage", "Show current account limits and chat context usage"],
  ["skills", "List or invoke this workspace's native Codex skills"],
  ["mcp", "Show connected MCP servers and available tools"],
  ["review", "Review working changes, a branch, commit, or custom scope"],
  ["diff", "Show the working folder's Git diff"],
  ["resume", "Resume a saved Codex conversation from this HOAI chat"],
  ["fork", "Continue from a copy of this chat's Codex conversation"],
  ["ps", "Show whether this chat has an active Codex response"],
  [STEER_COMMAND_NAME, "Send a correction to this chat's running response"],
  ["goal", "Set a condition Codex works toward until it is met"],
  ["help", "Show supported Codex controls and how to use them"],
] as const;

export type NativeRunOptions = Pick<
  RunTurnCallbacks,
  "reviewTarget" | "skillInput"
>;
type Choice = { label: string; value: string };
const NAMES = new Set<string>([
  ...NATIVE_COMMAND_DESCRIPTIONS.map((c) => c[0]),
  "status",
]);
const LOCAL_UI_COMMANDS = new Set([
  "theme",
  "statusline",
  "title",
  "keymap",
  "terminal-setup",
  "pets",
  "agent",
  "apps",
  "app",
  "plugins",
  "hooks",
  "memories",
  "experimental",
  "debug",
  "feedback",
  "logout",
  "login",
  "quit",
  "exit",
  "import",
  "side",
]);
export function normalizeNativeCommand(command: {
  name: string;
  args: string;
}): { name: string; args: string } {
  const aliases: Record<string, string> = {
    clear: "new",
    approvals: "permissions",
    approve: "permissions",
  };
  const name = command.name.toLowerCase();
  return { ...command, name: aliases[name] ?? name };
}
const exec = promisify(execFile);

export function parseNativeCommand(
  text: string,
): { name: string; args: string } | undefined {
  const match = text
    .trimStart()
    .match(/^[\\/]([a-z][a-z0-9_:-]*)(?:\s+([\s\S]*))?$/i);
  return match
    ? { name: match[1].toLowerCase(), args: (match[2] ?? "").trim() }
    : undefined;
}
export function reviewTarget(text: string): RpcObject {
  if (!text) return { type: "uncommittedChanges" };
  if (text === "branch" || text.startsWith("branch ")) {
    const branch = text.slice(7).trim();
    if (!branch)
      throw new Error("Use /review branch followed by a Git branch name.");
    return { type: "baseBranch", branch };
  }
  if (text.startsWith("commit ")) {
    const sha = text.slice(7).trim();
    if (!/^[a-f0-9]{7,64}$/i.test(sha))
      throw new Error("Use /review commit followed by a Git commit id.");
    return { type: "commit", sha, title: null };
  }
  return { type: "custom", instructions: text };
}
const safe = (value: unknown) =>
  String(value ?? "")
    .replace(/[\r\n|`]/g, " ")
    .slice(0, 160);

export function usageSummary(response: RpcObject, context?: RpcObject): string {
  const lines = ["**Codex usage**"];
  const buckets =
    response.rateLimitsByLimitId &&
    Object.keys(response.rateLimitsByLimitId).length
      ? (Object.values(response.rateLimitsByLimitId) as RpcObject[])
      : response.rateLimits
        ? [response.rateLimits]
        : [];
  for (const bucket of buckets) {
    for (const key of ["primary", "secondary"]) {
      const window = bucket?.[key];
      if (
        !window ||
        typeof window.usedPercent !== "number" ||
        !Number.isFinite(window.usedPercent)
      )
        continue;
      const label = window.windowDurationMins
        ? `${window.windowDurationMins / 60}h`
        : key;
      const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
      const reset =
        typeof window.resetsAt === "number"
          ? ` · resets ${new Date(window.resetsAt * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`
          : "";
      lines.push(
        `${safe(bucket.limitName ?? bucket.limitId ?? "Account")} · ${label}: ${Math.round(remaining)}% remaining${reset}`,
      );
    }
  }
  if (lines.length === 1)
    lines.push("Account limits are unavailable for this sign-in.");
  if (
    context &&
    context.modelContextWindow > 0 &&
    typeof context.last?.inputTokens === "number"
  ) {
    lines.push(
      `Chat context: ${Math.min(100, Math.round((context.last.inputTokens / context.modelContextWindow) * 100))}% used.`,
    );
  }
  return lines.join("\n\n");
}

/**
 * One goal, in the runtime's own words. Nothing here is worked out from a
 * clock: the time is the elapsed goal time the runtime itself counted, and a
 * count it has not made is simply not printed.
 */
export function goalReadout(goal: ThreadGoal | null): string {
  if (!goal || !goal.objective) {
    return "No goal is set for this chat. Use `/goal` followed by the condition to set one.";
  }
  const lines = ["**Codex goal**", `Objective: ${safe(goal.objective)}`];
  lines.push(`Status: ${safe(goalStatusWord(goal.status))}`);
  const timeUsed = formatGoalSeconds(goal.timeUsedSeconds);
  if (timeUsed) lines.push(`Time used: ${timeUsed}`);
  if (goal.tokensUsed > 0)
    lines.push(`Tokens used: ${goal.tokensUsed.toLocaleString("en-US")}`);
  if (typeof goal.tokenBudget === "number")
    lines.push(`Token budget: ${goal.tokenBudget.toLocaleString("en-US")}`);
  return lines.join("\n");
}

export class NativeCommands {
  private readonly controllers = new Map<number, AbortController>();
  constructor(
    private readonly deps: {
      host: CodexHost;
      interactions: Interactions;
      ownerId: () => string;
      status: () => string;
      run: (
        args: DispatchArgs,
        prompt: string,
        options?: NativeRunOptions,
      ) => Promise<void>;
      /**
       * The native goal lane. `/goal <condition>` goes through it rather than
       * straight to the host, because the mission has to exist and the lane
       * has to be watching BEFORE the goal is set: setting one starts a turn
       * at once, and a turn nobody is watching is dropped on the floor.
       */
      /**
       * `/plan` and `/code` just changed this chat's Codex mode.
       *
       * Told to the adapter rather than done here, because two things follow
       * that are not this file's: BGOS has to be told, so the app can draw the
       * plan mode chip, and a `/plan <task>` has to leave a DOOR behind, so the
       * card the task produces says the owner typed for it rather than that
       * plan mode happened to be on. `typedTask` is that difference.
       *
       * `enforced` is the fourth argument because it is a FACT and not a
       * constant: it says whether the read only sandbox that goes on with the
       * mode was actually applied. The app words the chip differently for the
       * two, so passing a hopeful `true` here would be a promise the owner
       * acts on. It comes back from the host, which is the only thing that
       * knows whether the runtime took the setting.
       */
      onSessionMode?: (
        args: DispatchArgs,
        mode: "plan" | "default",
        typedTask: boolean,
        enforced: boolean,
      ) => void | Promise<void>;
      /**
       * The LOCK moved without the mode moving.
       *
       * `/permissions` inside plan mode is the one way the pair comes apart
       * by hand: the mode stays `plan`, so the app keeps the chip up, while
       * the read only sandbox that made the wait real is gone. Reported
       * separately from `onSessionMode` because the mode has NOT changed and
       * the typed door must survive: `/plan build the uploader` followed by
       * `/permissions workspace` is still a plan the owner typed for, and
       * routing this through `onSessionMode` would clear that door on its
       * `typedTask: false` arm.
       *
       * Without it the owner reads `read only until you answer` off a chat
       * that has just been handed its files back, which is the exact promise
       * this whole lane exists to stop making.
       */
      onPlanEnforcement?: (
        args: DispatchArgs,
        enforced: boolean,
      ) => void | Promise<void>;
      goalLane: {
        setFromChat(input: {
          assistantId: number;
          chatId: number;
          objective: string;
        }): Promise<number | null>;
        clearForChat(chatId: number): Promise<boolean>;
        pauseForChat(chatId: number): Promise<ThreadGoal | null>;
        resumeForChat(chatId: number): Promise<ThreadGoal | null>;
      };
    },
  ) {}

  cancel(chatId: number): boolean {
    const controller = this.controllers.get(chatId);
    controller?.abort();
    return !!controller;
  }
  close(): void {
    for (const c of this.controllers.values()) c.abort();
  }

  private async choose(
    context: InteractionContext,
    title: string,
    choices: Choice[],
  ): Promise<string | undefined> {
    if (!choices.length)
      throw new Error("No options are available for this control right now.");
    let page = 0;
    // Four choices leave room for Back/More without exceeding HOAI's six-option contract.
    const size = choices.length <= 6 ? 6 : 4;
    while (!context.signal.aborted) {
      const options = choices.slice(page * size, (page + 1) * size);
      if (page > 0)
        options.push({ label: "Previous", value: "__previous_page" });
      if ((page + 1) * size < choices.length)
        options.push({ label: "More", value: "__next_page" });
      const [answer] = await this.deps.interactions.ask(context, [
        { text: title, options, allow_free_text: false, allow_skip: true },
      ]);
      if (context.signal.aborted) return undefined;
      // HOAI acknowledges a skipped question by showing Thinking until the
      // agent replies. A silent return strands that indicator even though
      // this native control is already complete. Superseded menus stay silent.
      if (answer.skipped)
        throw new Error("Selection cancelled. No changes were made.");
      if (answer.picked_option_value === "__next_page") page++;
      else if (answer.picked_option_value === "__previous_page") page--;
      else if (choices.some((c) => c.value === answer.picked_option_value))
        return answer.picked_option_value;
      else return undefined;
    }
    return undefined;
  }

  async handle(args: DispatchArgs): Promise<boolean> {
    const command = args.command;
    if (
      !command ||
      (!NAMES.has(command.name) && !LOCAL_UI_COMMANDS.has(command.name)) ||
      args.senderType === "agent" ||
      args.senderType === "system"
    )
      return false;
    if (
      !["help", "status"].includes(command.name) &&
      (args.senderUserId ?? args.userId) !== this.deps.ownerId()
    ) {
      await args.replyHandle.sendText(
        "Only this agent's owner can use its native session controls.",
      );
      return true;
    }
    this.cancel(args.chatId);
    const controller = new AbortController();
    this.controllers.set(args.chatId, controller);
    const context: InteractionContext = {
      assistantId: args.assistantId,
      chatId: args.chatId,
      userId: args.senderUserId ?? args.userId,
      readUserId: args.userId,
      signal: controller.signal,
    };
    try {
      await this.runCommand(args, context);
    } catch (error) {
      if (!controller.signal.aborted)
        await args.replyHandle.sendText(
          error instanceof Error
            ? error.message
            : "Codex could not complete that command.",
        );
    } finally {
      if (this.controllers.get(args.chatId) === controller)
        this.controllers.delete(args.chatId);
    }
    return true;
  }

  /**
   * `/goal`, in five forms: set a condition, read it, clear it, hold it and
   * start it again.
   *
   * Only the exact words clear, pause and resume are controls. Anything else
   * is the owner's own condition, so "/goal clear the design backlog" sets a
   * goal and does not wipe one, which is what a person typing that sentence
   * plainly meant.
   */
  private async runGoal(
    args: DispatchArgs,
    text: string,
    say: (message: string) => Promise<void>,
  ): Promise<void> {
    const lane = this.deps.goalLane;
    const chatId = args.chatId;
    const control = text.trim().toLowerCase();
    if (!text.trim()) {
      const goal = await this.deps.host.getGoal(chatId);
      await say(goalReadout(goal));
      return;
    }
    if (control === "clear") {
      const had = await lane.clearForChat(chatId);
      await say(
        had
          ? "Goal cleared. Codex stops working toward it and answers you normally."
          : "There was no goal set for this chat.",
      );
      return;
    }
    if (control === "pause") {
      const goal = await lane.pauseForChat(chatId);
      await say(
        goal
          ? "Goal held. Codex stops working toward it until you send /goal resume."
          : "There is no goal set for this chat to hold.",
      );
      return;
    }
    if (control === "resume") {
      const goal = await lane.resumeForChat(chatId);
      await say(
        goal
          ? "Goal restarted. Codex is working toward it again."
          : "There is no goal set for this chat to restart.",
      );
      return;
    }
    await lane.setFromChat({
      assistantId: args.assistantId,
      chatId,
      objective: text.trim(),
    });
    await say(
      `Goal set. Codex keeps working toward it on its own until it holds, or until it has taken ${GOAL_DEFAULT_TURN_CAP} turns. ` +
        "Use /goal to see where it is, /goal pause to hold it and /goal clear to stop it.",
    );
  }

  /**
   * `/steer <text>`: into the running turn, or else as a normal message.
   *
   * A steer that LANDS posts nothing. It used to answer "Correction delivered
   * to the current response." as an ordinary reply, and HOAI reads any
   * ordinary reply as the agent being done, so confirming a correction INTO a
   * running turn marked that turn finished: the working line and Stop went
   * away for the rest of it. The owner's own `/steer` message and its
   * delivered tick are the receipt, and the turn's own reply answers it.
   *
   * A steer with NOTHING TO STEER runs the text once as a normal message
   * through `deps.run`, which is the chat's own queue (it waits behind a turn
   * still publishing, exactly as a message sent then would). That covers no
   * turn yet (the host has no turn id: the message still waits in the queue,
   * or `turn/start` has not answered), a turn that ended as the steer went
   * out (the runtime refuses the id it expected), and a review or compaction
   * (the runtime refuses to steer those). It used to answer "No response is
   * ready for a correction" and drop the words, and the HOAI tray's Send now
   * is pressed exactly near a turn's end, when that race is likeliest.
   *
   * Never both, and never an error line for a steer that could be run. The
   * one exception is a steer Codex never ANSWERED: it may have landed, so
   * running it as well could deliver it twice. That one is not run, and one
   * plain line says what to do.
   *
   * Only this router's `/steer` falls back. `MissionControlLane` calls
   * `host.steer` itself and relies on the throw to keep its bulletin queued.
   */
  private async steerOrRun(args: DispatchArgs, text: string): Promise<void> {
    try {
      await this.deps.host.steer(args.chatId, text);
      return;
    } catch (error) {
      if (error instanceof RequestTimeoutError)
        throw new Error(STEER_UNCONFIRMED_TEXT);
    }
    await this.deps.run(args, text);
  }

  private async runCommand(
    args: DispatchArgs,
    context: InteractionContext,
  ): Promise<void> {
    const { name, args: text } = args.command!;
    const host = this.deps.host;
    const say = async (message: string) => {
      await args.replyHandle.sendText(message);
    };
    if (LOCAL_UI_COMMANDS.has(name)) {
      const where = [
        "theme",
        "statusline",
        "title",
        "keymap",
        "terminal-setup",
        "pets",
      ].includes(name)
        ? "HOAI uses its own interface. Use HOAI's Theme and chat settings for appearance."
        : ["logout", "login", "quit", "exit"].includes(name)
          ? "Manage this agent's sign-in and connection in Agent settings → Integration. /stop ends the current response."
          : name === "import"
            ? "Codex does not support /import through a local app-server. /resume lists conversations belonging to this HOAI chat."
            : "This Codex terminal control is not exposed by this bridge. Use Agent settings for skills and integrations; /help lists supported chat controls.";
      await say(where);
      return;
    }
    if (name === "ps") {
      await say(
        host.isBusy(args.chatId)
          ? "Codex is working in this chat. /steer sends a correction; /stop interrupts it."
          : "No Codex response is running in this chat.",
      );
      return;
    }
    if (name === STEER_COMMAND_NAME) {
      // A slash command frame's args arrive as sent; the text parser trims.
      // Both reach the same words here.
      const correction = text.trim();
      if (!correction)
        throw new Error(
          "Use /steer followed by your correction while Codex is responding.",
        );
      await this.steerOrRun(args, correction);
      return;
    }
    if (name === "goal") {
      await this.runGoal(args, text, say);
      return;
    }
    const apply = async (patch: SessionSettings) => {
      context.signal.throwIfAborted();
      return host.updateSettings(args.chatId, patch);
    };
    if (name === "help") {
      await say(
        "**Codex controls**\n\n" +
          [
            ["new", "Fresh context; HOAI messages stay saved"],
            ["retry", "Repeat your last request"],
            ["stop", "Stop this chat's response"],
            ["compact", "Compress this chat's context"],
            ["status", "Model, settings and connection"],
            ...NATIVE_COMMAND_DESCRIPTIONS,
          ]
            .map(([command, description]) => `\`/${command}\` — ${description}`)
            .join("\n") +
          "\n\nExamples: `/model` · `/model gpt-5.6-sol high` · `/plan design a migration` · `/skills skill-name your task`. A leading backslash also works.",
      );
      return;
    }
    if (name === "status") {
      const settings = await host.sessionSettings(args.chatId);
      const usage = host.contextUsage(args.chatId);
      await say(
        `${this.deps.status()}\n\nModel: **${safe(settings.model)}** · reasoning: **${safe(settings.effort)}**\nMode: ${settings.mode} · access: ${settings.permission} · style: ${settings.personality}${settings.serviceTier ? ` · tier: ${safe(settings.serviceTier)}` : ""}${usage?.last?.inputTokens != null ? `\nContext input: ${usage.last.inputTokens.toLocaleString()} tokens.` : ""}`,
      );
      return;
    }
    if (name === "usage") {
      if (text) {
        await say(
          "Use /usage to view limits. Manage reset credits through Codex's account controls.",
        );
        return;
      }
      await say(
        usageSummary(await host.rateLimits(), host.contextUsage(args.chatId)),
      );
      return;
    }
    if (name === "mcp") {
      const servers = await host.mcpStatus();
      await say(
        servers.length
          ? "**MCP connections**\n\n" +
              servers
                .map(
                  (s) =>
                    `**${safe(s.name)}** · ${safe(s.authStatus ?? "unknown")} · ${Object.keys(s.tools ?? {}).length} tools`,
                )
                .join("\n")
          : "No MCP servers are configured for this Codex workspace.",
      );
      return;
    }
    if (name === "skills") {
      const skills = await host.listSkills();
      if (!text) {
        await say(
          skills.length
            ? "**Available skills**\n\n" +
                skills
                  .map(
                    (s) =>
                      `\`${safe(s.name)}\` — ${safe(s.shortDescription ?? s.description)}`,
                  )
                  .join("\n") +
                "\n\nUse `/skills name your task` to invoke one."
            : "No enabled skills were found for this workspace. Add them in Agent settings → Skills.",
        );
        return;
      }
      const match = text.match(/^(\S+)\s+([\s\S]+)$/);
      if (!match)
        throw new Error("Use /skills followed by a skill name and your task.");
      const skill = skills.find((s) => s.name === match[1]);
      if (!skill)
        throw new Error(
          "That skill is not enabled in this workspace. Use /skills to see the list.",
        );
      await this.deps.run(args, `$${skill.name} ${match[2]}`, {
        skillInput: { type: "skill", name: skill.name, path: skill.path },
      });
      return;
    }
    if (name === "review") {
      await this.deps.run(args, text || "Review uncommitted changes", {
        reviewTarget: reviewTarget(text),
      });
      return;
    }
    if (name === "diff") {
      let stdout: string;
      try {
        ({ stdout } = await exec(
          "git",
          [
            "--no-pager",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "HEAD",
            "--",
          ],
          {
            cwd: host.workdir,
            windowsHide: true,
            timeout: 15_000,
            maxBuffer: 512_000,
          },
        ));
      } catch (error) {
        const detail = String((error as { stderr?: string }).stderr ?? "");
        if (/not a git repository/i.test(detail))
          throw new Error(
            "This agent's folder is not a Git repository yet. Open a project with Git history to view its diff.",
          );
        if (
          /bad revision|ambiguous argument.*HEAD|unknown revision/i.test(detail)
        )
          throw new Error(
            "This repository has no first commit yet. Commit its initial files before comparing working changes.",
          );
        throw new Error(
          "The Git diff could not be loaded. Check that Git is installed and the project is accessible, then retry.",
        );
      }
      const body = stdout.slice(0, 18_000);
      const fence = "`".repeat(
        Math.max(3, ...[...body.matchAll(/`+/g)].map((m) => m[0].length + 1)),
      );
      await say(
        body.trim()
          ? `${fence}diff\n${body}\n${fence}${stdout.length > body.length ? "\nDiff shortened to 18,000 characters." : ""}`
          : "No tracked working changes.",
      );
      return;
    }
    if (name === "fork") {
      await host.forkThread(args.chatId);
      await say(
        "Forked the Codex conversation. Continue here; the original remains available through /resume.",
      );
      return;
    }
    if (name === "resume") {
      const threads = await host.savedThreads(args.chatId);
      if (!threads.length) {
        await say("This HOAI chat has no saved Codex conversations yet.");
        return;
      }
      const id =
        text ||
        (await this.choose(
          context,
          "Resume a conversation from this chat",
          threads.map((t) => ({ label: t.name, value: t.id })),
        ));
      if (id) {
        await host.resumeSavedThread(args.chatId, id);
        await say(
          "Resumed the saved Codex conversation. Your HOAI messages remain in place.",
        );
      }
      return;
    }
    const current = await host.sessionSettings(args.chatId);
    if (name === "model") {
      const models = await host.listModels();
      const words = text ? text.split(/\s+/) : [];
      if (words.length > 2)
        throw new Error(
          "Use /model model-id with an optional reasoning level.",
        );
      const id =
        words[0] ||
        (await this.choose(
          context,
          `Choose a model · current: ${safe(current.model)}`,
          models.map((m) => ({ label: m.displayName, value: m.model })),
        ));
      if (!id) return;
      const model = models.find((m) => m.model === id || m.id === id);
      if (!model)
        throw new Error(
          "That model is not in this account's catalog. Use /model to choose one.",
        );
      const effort =
        words[1] ||
        (words.length
          ? model.defaultReasoningEffort
          : await this.choose(
              context,
              `Reasoning level · ${model.displayName}`,
              model.supportedReasoningEfforts.map((e) => ({
                label: e.reasoningEffort,
                value: e.reasoningEffort,
              })),
            ));
      if (!effort) return;
      const result = await apply({
        model: model.model,
        effort,
        serviceTier: null,
        personality: model.supportsPersonality ? current.personality : "none",
      });
      await say(
        `Model set to **${safe(result.model)}** · **${safe(result.effort)}** reasoning. Conversation context is preserved.`,
      );
      return;
    }
    const models = await host.listModels();
    const model = models.find((m) => m.model === current.model);
    if (name === "effort") {
      const effort =
        text ||
        (await this.choose(
          context,
          `Reasoning level · current: ${safe(current.effort)}`,
          (model?.supportedReasoningEfforts ?? []).map((e) => ({
            label: e.reasoningEffort,
            value: e.reasoningEffort,
          })),
        ));
      if (effort) {
        await apply({ effort });
        await say(`Reasoning set to **${safe(effort)}** for this chat.`);
      }
      return;
    }
    if (name === "plan" || name === "code") {
      const mode = name === "code" || text === "off" ? "default" : "plan";
      const typedTask = Boolean(text) && !["on", "off"].includes(text);
      // THE MODE IS NOT THE LOCK, so this does not just write a mode. Plan
      // mode goes on with the read only sandbox and remembers the permission
      // the chat had; coding mode gives that permission back. The host owns
      // the pair (setPlanMode) so `/plan`, `/code` and the card's own buttons
      // cannot drift apart, and it answers whether the sandbox actually took.
      context.signal.throwIfAborted();
      const { enforced } = await host.setPlanMode(args.chatId, mode === "plan");
      // After the store, before the turn: the app should be drawing the chip
      // while the agent is still exploring, and a report that lost a race with
      // the turn would draw it after the plan card had already landed.
      await this.deps.onSessionMode?.(args, mode, typedTask, enforced);
      await say(
        mode === "plan"
          ? enforced
            ? "Plan mode is on. This chat is read only until you answer a plan."
            : "Plan mode is on."
          : "Coding mode is on.",
      );
      if (typedTask) await this.deps.run(args, text);
      return;
    }
    if (name === "permissions") {
      const permission =
        text ||
        (await this.choose(context, "Access for this chat", [
          { label: "Workspace · ask for broader access", value: "workspace" },
          { label: "Read only", value: "read-only" },
        ]));
      if (!permission) return;
      if (permission !== "workspace" && permission !== "read-only")
        throw new Error(
          "Choose workspace or read-only. Broader actions retain their individual approval controls.",
        );
      // The owner choosing an access level SPENDS plan mode's memory of the
      // old one. Without this, `/permissions read-only` typed inside plan mode
      // would be undone by the Go ahead that follows, handing back a workspace
      // the owner had just taken away.
      const saved = await apply({ permission, permissionBeforePlan: undefined });
      // And it may have just taken the lock off a chat that is still in plan
      // mode, or put one on. The mode did not move, so nothing else reports
      // this, and an unreported change leaves the chip claiming a sandbox the
      // chat no longer has.
      if (saved.mode === "plan")
        await this.deps.onPlanEnforcement?.(args, planWaitEnforced(saved));
      await say(
        permission === "read-only"
          ? "Local files are read-only for this chat. Connected HOAI tools retain their own permissions."
          : "This chat can work in its folder and asks before broader file access.",
      );
      return;
    }
    if (name === "personality") {
      if (!model?.supportsPersonality)
        throw new Error("This model does not support personality settings.");
      const personality =
        text ||
        (await this.choose(
          context,
          "Communication style",
          ["none", "friendly", "pragmatic"].map((value) => ({
            label: value,
            value,
          })),
        ));
      if (!personality) return;
      if (!["none", "friendly", "pragmatic"].includes(personality))
        throw new Error("Choose none, friendly, or pragmatic.");
      await apply({
        personality: personality as SessionSettings["personality"],
      });
      await say(`Communication style: **${personality}**.`);
      return;
    }
    if (name === "fast") {
      const tiers = model?.serviceTiers ?? [];
      const tier =
        text === "off"
          ? "__standard"
          : text ||
            (await this.choose(
              context,
              "Speed tier · account pricing applies",
              [
                { label: "Standard", value: "__standard" },
                ...tiers.map((t) => ({ label: t.name, value: t.id })),
              ],
            ));
      if (!tier) return;
      const id =
        tier === "on"
          ? tiers.find((t) => /fast|priority/i.test(t.id + " " + t.name))?.id
          : tier;
      if (!id) throw new Error("This model does not offer a Fast tier.");
      await apply({ serviceTier: id === "__standard" ? null : id });
      await say(
        id === "__standard"
          ? "Standard speed is selected."
          : `Speed tier: **${safe(tiers.find((t) => t.id === id)?.name ?? id)}**.`,
      );
    }
  }
}
