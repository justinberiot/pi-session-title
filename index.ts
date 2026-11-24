/**
 * Session titles for Pi, the way Codex and Claude Code name their sessions.
 *
 * On the first message of an unnamed session, the terminal title shows the
 * message's first line at once while the model writes a short task title in
 * the background (Codex's rules: at most 36 characters, imperative verb).
 * The title becomes the session's name, so it also shows in /resume. If
 * generation fails, the first line is kept as the name.
 *
 * - A name set any other way (/name, `pi -n`, a resumed name) always wins,
 *   and a rename while a title is being written cancels it.
 * - `/retitle` names the session again from its latest messages;
 *   `/retitle <name>` sets the name directly.
 * - The terminal title is the name alone, or the folder while there is none,
 *   instead of Pi's `π - name - folder`. Terminal tabs (Rex, Ghostty, tmux)
 *   follow it.
 * - The title is written with the session's current model, or with
 *   `sessionTitle.model` (`provider/model-id`) from Pi's settings.
 * - The agent can rename an automatically named session with
 *   `set_session_title` once the task becomes clear or changes, as Codex's
 *   agent can with `set_thread_title`. It sees the current title in a
 *   `<session-title>` prompt section and cannot rename a session the user
 *   named. Each name is recorded as a `session-title` entry, with the
 *   agent's reason for a rename.
 *
 * No Effect import here: `src/title-runtime.ts` is loaded on the first
 * message and disposed on `session_shutdown`.
 */

import { basename } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { TITLE_MAX_CHARS, TITLE_RULES } from "./src/title-rules.ts";
import type {
  ConversationMessage,
  TitleModelAccess,
  TitleRuntime,
} from "./src/title-runtime.ts";

/** Pi sets its own title after some events; set ours again once it has. */
const TITLE_SETTLE_DELAYS_MS = [0, 250, 1_000] as const;

/** The tool the agent renames the session with. */
const SET_TITLE_TOOL = "set_session_title";

/** The prompt section telling the agent the current title. */
const TITLE_SECTION = "session-title";

/** The custom session entry recording each name this extension saves. */
const TITLE_ENTRY = "session-title";

/** Who chose a name: the first message (generated or its placeholder), the agent, or the user. */
type NamedBy = "first-message" | "agent" | "user";

/** A `session-title` entry. */
interface TitleEntry {
  readonly name: string;
  readonly by: NamedBy;
  readonly previous?: string | undefined;
  readonly reason?: string;
}

/** What `set_session_title` reports, for rendering and review. */
interface SetTitleDetails {
  readonly title: string;
  readonly previous: string | undefined;
  readonly reason: string;
}

const setTitleParameters = Type.Object({
  title: Type.String({ description: "The new session title." }),
  reason: Type.String({
    description: "Why the current title no longer fits, in a few words. Shown to the user.",
  }),
});

export default function sessionTitle(pi: ExtensionAPI) {
  let runtime: Promise<TitleRuntime> | undefined;
  /** The name this extension saved last, to tell its own renames apart. */
  let ownName: string | undefined;
  /** The placeholder shown while the first title is written. */
  let provisional: string | undefined;
  /** Whether this session already had its chance to be named automatically. */
  let attempted = false;
  /** Whether the current name may be replaced by the agent: not one the user chose. */
  let automatic = false;
  let timers: ReturnType<typeof setTimeout>[] = [];

  const loadRuntime = (): Promise<TitleRuntime> =>
    (runtime ??= import("./src/title-runtime.ts").then((module) => module.startTitleRuntime()));

  const cancelPending = (): void => {
    void runtime?.then((loaded) => loaded.cancel());
  };

  const terminalTitle = (ctx: ExtensionContext): string =>
    pi.getSessionName() ?? provisional ?? basename(ctx.sessionManager.getCwd());

  /** Show the title now and again after Pi's own title updates. */
  const applyTitle = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    for (const timer of timers) clearTimeout(timer);
    ctx.ui.setTitle(terminalTitle(ctx));
    timers = TITLE_SETTLE_DELAYS_MS.map((delay) =>
      setTimeout(() => ctx.ui.setTitle(terminalTitle(ctx)), delay),
    );
  };

  const saveName = (ctx: ExtensionContext, entry: TitleEntry): void => {
    ownName = entry.name;
    provisional = undefined;
    automatic = entry.by !== "user";
    pi.appendEntry<TitleEntry>(TITLE_ENTRY, entry);
    pi.setSessionName(entry.name);
    applyTitle(ctx);
  };

  /** Whether the session's name was saved by this extension, not chosen by the user. */
  const restoredAutomatic = (ctx: ExtensionContext): boolean => {
    const name = pi.getSessionName();
    if (name === undefined) return false;
    const entries = ctx.sessionManager.getBranch();
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (entry?.type !== "custom" || entry.customType !== TITLE_ENTRY) continue;
      const data = entry.data as TitleEntry | undefined;
      return data?.name === name && data.by !== "user";
    }
    return false;
  };

  /** The current title as the agent sees it, and whether it may change it. */
  const titleSection = (): string => {
    const name = pi.getSessionName();
    if (name === undefined) {
      return `This session has no title yet; one is being written from the user's first message. Do not call ${SET_TITLE_TOOL} now.`;
    }
    if (!automatic) {
      return `The user named this session "${name}". Keep it: do not call ${SET_TITLE_TOOL}.`;
    }
    return `This session is titled "${name}", named automatically. The user sees it in the terminal tab and in /resume.`;
  };

  const modelAccess = (ctx: ExtensionContext): TitleModelAccess => {
    const currentModel: Model<Api> | undefined = ctx.model;
    return {
      currentModel,
      settings: pi.getSettings(),
      findModel: (provider, modelId) => ctx.modelRegistry.find(provider, modelId),
      hasAuth: (model) => ctx.modelRegistry.hasConfiguredAuth(model),
      complete: (model, prompt, signal) =>
        ctx.modelRegistry
          .streamSimple(
            model,
            {
              messages: [
                { role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() },
              ],
            },
            // No sessionId: a provider must not tie this request to the
            // conversation (pi-claude-cli would reuse its process).
            { reasoning: "low", cacheRetention: "none", signal },
          )
          .result(),
    };
  };

  pi.on("session_start", async (_event, ctx) => {
    cancelPending();
    provisional = undefined;
    attempted = pi.getSessionName() !== undefined;
    automatic = restoredAutomatic(ctx);
    ownName = automatic ? pi.getSessionName() : undefined;
    applyTitle(ctx);
  });

  pi.on("before_agent_start", async (event, ctx) => {
    if (!ctx.hasUI) return;
    event.systemPromptOptions.sections[TITLE_SECTION] = titleSection();
  });

  pi.on("input", async (event, ctx) => {
    if (!ctx.hasUI || event.source === "extension") return;
    if (attempted || pi.getSessionName() !== undefined) return;
    const userMessage = event.text.trim();
    if (userMessage.length === 0) return;
    attempted = true;
    const access = modelAccess(ctx);
    // Not awaited: the message goes to the model while the title is written.
    void loadRuntime().then((loaded) =>
      loaded.nameFromFirstPrompt({
        userMessage,
        access,
        showProvisional: (title) => {
          provisional = title;
          applyTitle(ctx);
        },
        save: (title) => {
          if (pi.getSessionName() !== undefined) return false;
          saveName(ctx, { name: title, by: "first-message" });
          return true;
        },
        onFailure: (message) => ctx.ui.notify(`Session title: ${message}`, "warning"),
      }),
    );
  });

  pi.on("session_info_changed", async (event, ctx) => {
    if (event.name !== ownName) {
      // Named by the user or another extension: theirs wins.
      cancelPending();
      provisional = undefined;
      attempted = true;
      automatic = false;
    }
    applyTitle(ctx);
  });

  pi.on("agent_start", async (_event, ctx) => applyTitle(ctx));

  pi.on("session_shutdown", async () => {
    for (const timer of timers) clearTimeout(timer);
    timers = [];
    const loaded = runtime;
    runtime = undefined;
    if (loaded !== undefined) await (await loaded).dispose();
  });

  pi.registerTool({
    name: SET_TITLE_TOOL,
    label: "Session title",
    description:
      "Rename this session. The title shows in the user's terminal tab and in /resume. " +
      `Title: at most ${TITLE_MAX_CHARS} characters and under five words where possible. ${TITLE_RULES}`,
    promptSnippet: "Rename the session when its title no longer names its task",
    promptGuidelines: [
      `Use ${SET_TITLE_TOOL} when the session title in <session-title> no longer names the task: it is the user's opening words or a greeting rather than a task, or the user has moved on to a different task.`,
      `Do not call ${SET_TITLE_TOOL} when the title still fits, to reword it, or to follow the steps of one task.`,
    ],
    parameters: setTitleParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const previous = pi.getSessionName();
      if (!ctx.hasUI) return refuse("This session has no terminal title to set.");
      if (previous !== undefined && !automatic) {
        return refuse(`The user named this session "${previous}"; keep it.`);
      }
      const title = (await loadRuntime()).agentTitle(params.title);
      if (title === undefined) return refuse("Give the title as one line of words.");
      const details: SetTitleDetails = { title, previous, reason: params.reason.trim() };
      if (title === previous) {
        return { content: [{ type: "text", text: `The session is already titled "${title}".` }], details };
      }
      cancelPending();
      attempted = true;
      saveName(ctx, { name: title, by: "agent", previous, reason: details.reason });
      ctx.ui.notify(`Session renamed: ${previous ?? "(untitled)"} → ${title} (${details.reason})`, "info");
      return { content: [{ type: "text", text: `Session renamed to "${title}".` }], details };
    },
  });

  pi.registerCommand("retitle", {
    description: "Name the session from its latest messages, or set the name: /retitle [name]",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name.length > 0) {
        cancelPending();
        saveName(ctx, { name, by: "user" });
        return;
      }
      ctx.ui.setWorkingMessage("Naming the session…");
      try {
        const loaded = await loadRuntime();
        const result = await loaded.retitle(recentMessages(ctx.sessionManager.getBranch()), modelAccess(ctx));
        if (result.ok) {
          saveName(ctx, { name: result.title, by: "user" });
          ctx.ui.notify(`Session named: ${result.title}`, "info");
        } else {
          ctx.ui.notify(`Session title: ${result.message}`, "warning");
        }
      } finally {
        ctx.ui.setWorkingMessage(undefined);
      }
    },
  });
}

/** A failed `set_session_title` call, explained to the agent. */
function refuse(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    details: undefined as SetTitleDetails | undefined,
    isError: true,
  };
}

/** The user and assistant text of the active branch, oldest first. */
function recentMessages(entries: ReadonlyArray<SessionEntry>): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
    messages.push({ role: message.role, text });
  }
  return messages;
}
