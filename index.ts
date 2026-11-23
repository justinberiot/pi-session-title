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
 *
 * No Effect import here: `src/title-runtime.ts` is loaded on the first
 * message and disposed on `session_shutdown`.
 */

import { basename } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ConversationMessage,
  TitleModelAccess,
  TitleRuntime,
} from "./src/title-runtime.ts";

/** Pi sets its own title after some events; set ours again once it has. */
const TITLE_SETTLE_DELAYS_MS = [0, 250, 1_000] as const;

export default function sessionTitle(pi: ExtensionAPI) {
  let runtime: Promise<TitleRuntime> | undefined;
  /** The name this extension saved last, to tell its own renames apart. */
  let ownName: string | undefined;
  /** The placeholder shown while the first title is written. */
  let provisional: string | undefined;
  /** Whether this session already had its chance to be named automatically. */
  let attempted = false;
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

  const saveName = (ctx: ExtensionContext, name: string): void => {
    ownName = name;
    provisional = undefined;
    pi.setSessionName(name);
    applyTitle(ctx);
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
    ownName = undefined;
    attempted = pi.getSessionName() !== undefined;
    applyTitle(ctx);
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
          saveName(ctx, title);
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

  pi.registerCommand("retitle", {
    description: "Name the session from its latest messages, or set the name: /retitle [name]",
    handler: async (args, ctx) => {
      const name = args.trim();
      if (name.length > 0) {
        cancelPending();
        saveName(ctx, name);
        return;
      }
      ctx.ui.setWorkingMessage("Naming the session…");
      try {
        const loaded = await loadRuntime();
        const result = await loaded.retitle(recentMessages(ctx.sessionManager.getBranch()), modelAccess(ctx));
        if (result.ok) {
          saveName(ctx, result.title);
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
