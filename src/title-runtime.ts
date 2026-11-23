/**
 * The extension's Effect runtime and its boundary with Pi.
 *
 * `index.ts` imports this module only on a session's first message, so Pi
 * starts without loading Effect. One runtime belongs to one extension
 * instance and is disposed on `session_shutdown`.
 *
 * At most one title is generated at a time. A newer request, a rename from
 * anywhere else, a session switch and shutdown each interrupt it, and an
 * interrupted request aborts its model call and changes nothing.
 */

import { Cause, Effect, Exit, Fiber, Layer, ManagedRuntime, Option } from "effect";
import { TitleGenerationError } from "./errors.ts";
import { conversationTitle, firstPromptTitle } from "./title-generator.ts";
import { type TitleModelAccess, titleModelLayer } from "./title-model.ts";
import { type ConversationMessage, fallbackTitle } from "./title-text.ts";

export type { ConversationMessage } from "./title-text.ts";
export type { TitleModelAccess } from "./title-model.ts";

/** Naming a session after its first message. */
export interface FirstPromptRequest {
  readonly userMessage: string;
  readonly access: TitleModelAccess;
  /** Show a provisional title without saving it as the session's name. */
  readonly showProvisional: (title: string) => void;
  /**
   * Save `title` as the session's name unless the session was named while
   * the title was written; it then returns false and nothing changes.
   */
  readonly save: (title: string) => boolean;
  /** Generation failed; the placeholder, if any, was saved instead. */
  readonly onFailure: (message: string) => void;
}

/** The outcome of `/retitle`. */
export type RetitleResult =
  | { readonly ok: true; readonly title: string }
  | { readonly ok: false; readonly message: string };

/** The runtime as `index.ts` sees it: no Effect types. */
export interface TitleRuntime {
  /** Show a placeholder now and name the session in the background. */
  readonly nameFromFirstPrompt: (request: FirstPromptRequest) => void;
  /** A title from the latest messages. Interrupted by `cancel`. */
  readonly retitle: (
    messages: ReadonlyArray<ConversationMessage>,
    access: TitleModelAccess,
  ) => Promise<RetitleResult>;
  /** Interrupt the title being written, if any. */
  readonly cancel: () => void;
  /** Interrupt everything and release the runtime. It cannot be used again. */
  readonly dispose: () => Promise<void>;
}

/** The message of a failed title request. */
const failureMessage = (cause: Cause.Cause<TitleGenerationError>): string =>
  Option.match(Cause.findErrorOption(cause), {
    onNone: () => Cause.pretty(cause),
    onSome: (error) => error.message,
  });

/** Start the extension's runtime. */
export const startTitleRuntime = (): TitleRuntime => {
  const runtime = ManagedRuntime.make(Layer.empty);
  let pending: Option.Option<Fiber.Fiber<string, TitleGenerationError>> = Option.none();

  const cancel = (): void => {
    if (Option.isSome(pending)) {
      const fiber = pending.value;
      pending = Option.none();
      runtime.runFork(Fiber.interrupt(fiber));
    }
  };

  /** Run one title request as the only pending one. */
  const run = (
    program: Effect.Effect<string, TitleGenerationError>,
    onExit: (exit: Exit.Exit<string, TitleGenerationError>) => void,
  ): void => {
    cancel();
    const fiber = runtime.runFork(program);
    pending = Option.some(fiber);
    fiber.addObserver((exit) => {
      if (Option.isSome(pending) && pending.value === fiber) pending = Option.none();
      onExit(exit);
    });
  };

  return {
    nameFromFirstPrompt: (request) => {
      const placeholder = fallbackTitle(request.userMessage);
      if (Option.isSome(placeholder)) request.showProvisional(placeholder.value);
      run(
        firstPromptTitle(request.userMessage).pipe(
          Effect.provide(titleModelLayer(request.access)),
          Effect.withSpan("SessionTitle.nameFromFirstPrompt", { root: true }),
        ),
        (exit) => {
          if (Exit.isSuccess(exit)) {
            request.save(exit.value);
            return;
          }
          // An interrupted request was superseded; leave everything as it is.
          if (Cause.hasInterruptsOnly(exit.cause)) return;
          if (Option.isSome(placeholder)) request.save(placeholder.value);
          request.onFailure(failureMessage(exit.cause));
        },
      );
    },

    retitle: (messages, access) =>
      new Promise((resolve) => {
        run(
          conversationTitle(messages).pipe(
            Effect.provide(titleModelLayer(access)),
            Effect.withSpan("SessionTitle.retitle", { root: true }),
          ),
          (exit) => {
            if (Exit.isSuccess(exit)) return resolve({ ok: true, title: exit.value });
            resolve({
              ok: false,
              message: Cause.hasInterruptsOnly(exit.cause)
                ? "Naming the session was cancelled"
                : failureMessage(exit.cause),
            });
          },
        );
      }),

    cancel,

    dispose: async () => {
      cancel();
      await runtime.dispose();
    },
  };
};
