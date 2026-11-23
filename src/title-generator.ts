/** Writing a session title with the title model. */

import { Duration, Effect, Option } from "effect";
import { TitleGenerationError } from "./errors.ts";
import { TitleModel } from "./title-model.ts";
import {
  type ConversationMessage,
  conversationTitleRequest,
  firstPromptTitleRequest,
  parseGeneratedTitle,
} from "./title-text.ts";

/**
 * How long a title may take. Generous, because a provider such as
 * pi-claude-cli starts a fresh process for a request with no session.
 */
const TITLE_TIMEOUT = Duration.seconds(90);

/** The title the model writes for `prompt`. */
const titleFor = Effect.fn("TitleGenerator.titleFor")(
  function* (prompt: string) {
    const titleModel = yield* TitleModel;
    const model = yield* titleModel.resolve;
    yield* Effect.annotateCurrentSpan({ model: `${model.provider}/${model.id}` });
    const answer = yield* titleModel.complete(model, prompt);
    return yield* Effect.fromOption(parseGeneratedTitle(answer)).pipe(
      Effect.mapError(
        () =>
          new TitleGenerationError({
            reason: "InvalidTitle",
            message: `${model.provider}/${model.id} did not answer with a usable session title`,
          }),
      ),
    );
  },
  Effect.timeoutOrElse({
    duration: TITLE_TIMEOUT,
    orElse: () =>
      Effect.fail(
        new TitleGenerationError({
          reason: "TimedOut",
          message: `No session title arrived within ${Duration.format(TITLE_TIMEOUT)}`,
        }),
      ),
  }),
);

/** A title for a session from its first message. */
export const firstPromptTitle = (userMessage: string) =>
  titleFor(firstPromptTitleRequest(userMessage)).pipe(
    Effect.withSpan("TitleGenerator.firstPromptTitle"),
  );

/** A title for a session from its latest messages, for `/retitle`. */
export const conversationTitle = (messages: ReadonlyArray<ConversationMessage>) =>
  Effect.gen(function* () {
    const request = conversationTitleRequest(messages);
    if (Option.isNone(request)) {
      return yield* new TitleGenerationError({
        reason: "NothingToName",
        message: "This session has no messages to name it after yet",
      });
    }
    return yield* titleFor(request.value);
  }).pipe(Effect.withSpan("TitleGenerator.conversationTitle"));
