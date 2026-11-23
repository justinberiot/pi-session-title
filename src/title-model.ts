/**
 * The model that writes titles, and the one request made of it.
 *
 * The model is the session's current one unless `sessionTitle.model` in
 * Pi's settings names another as `provider/model-id`, for example:
 *
 *     "sessionTitle": { "model": "openai/gpt-6-luna" }
 */

import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { TitleGenerationError } from "./errors.ts";

/**
 * What the title model needs from Pi for one request: plain functions over
 * the extension context, so this module holds no Pi state. Values are as Pi
 * returns them; they become `Option`s here.
 */
export interface TitleModelAccess {
  /** The session's current model; undefined when none is selected. */
  readonly currentModel: Model<Api> | undefined;
  /** Pi's effective settings, as Pi returned them. */
  readonly settings: unknown;
  /** The model Pi knows by this name; undefined when it knows none. */
  readonly findModel: (provider: string, modelId: string) => Model<Api> | undefined;
  readonly hasAuth: (model: Model<Api>) => boolean;
  /** One request with no session ID, so no provider ties it to the conversation. */
  readonly complete: (
    model: Model<Api>,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<AssistantMessage>;
}

/** The title model's capability. */
export interface ITitleModel {
  /** The model titles are written with. */
  readonly resolve: Effect.Effect<Model<Api>, TitleGenerationError>;
  /** The text of the model's answer to `prompt`. Interrupting it aborts the request. */
  readonly complete: (
    model: Model<Api>,
    prompt: string,
  ) => Effect.Effect<string, TitleGenerationError>;
}

/** The contextual title model. */
export class TitleModel extends Context.Service<TitleModel, ITitleModel>()(
  "@pi-session-title/TitleModel",
) {}

/** `provider/model-id`; the model ID may hold more slashes. */
const ModelSelector = Schema.String.check(Schema.isPattern(/^[^/\s]+\/\S+$/u));

/** The part of Pi's settings this extension reads. */
const TitleSettings = Schema.Struct({
  sessionTitle: Schema.optionalKey(
    Schema.Struct({
      model: Schema.optionalKey(ModelSelector),
    }),
  ),
});
const decodeTitleSettings = Schema.decodeUnknownEffect(TitleSettings);

/** The model `sessionTitle.model` names; None when it is not set. */
const configuredSelector = Effect.fn("TitleModel.configuredSelector")(function* (
  settings: unknown,
) {
  const decoded = yield* decodeTitleSettings(settings).pipe(
    Effect.mapError(
      () =>
        new TitleGenerationError({
          reason: "InvalidSettings",
          message:
            'sessionTitle.model in Pi\'s settings must be "provider/model-id", such as "openai/gpt-6-luna"',
        }),
    ),
  );
  return Option.fromUndefinedOr(decoded.sessionTitle?.model);
});

/** The title model over one request's Pi context. */
const titleModelFrom = (access: TitleModelAccess): ITitleModel => ({
  resolve: Effect.gen(function* () {
    const selector = yield* configuredSelector(access.settings);
    const model = Option.isSome(selector)
      ? yield* Effect.fromOption(
          Option.fromUndefinedOr(
            access.findModel(
              selector.value.slice(0, selector.value.indexOf("/")),
              selector.value.slice(selector.value.indexOf("/") + 1),
            ),
          ),
        ).pipe(
          Effect.mapError(
            () =>
              new TitleGenerationError({
                reason: "ModelNotFound",
                message: `sessionTitle.model names ${selector.value}, which Pi does not know; check the name with /model`,
              }),
          ),
        )
      : yield* Effect.fromOption(Option.fromUndefinedOr(access.currentModel)).pipe(
          Effect.mapError(
            () =>
              new TitleGenerationError({
                reason: "NoModel",
                message: "No model is selected to write a session title; choose one with /model",
              }),
          ),
        );
    if (!access.hasAuth(model)) {
      return yield* new TitleGenerationError({
        reason: "NoAuth",
        message: `${model.provider}/${model.id} has no credentials to write a session title; log in with /login`,
      });
    }
    return model;
  }).pipe(Effect.withSpan("TitleModel.resolve")),

  complete: Effect.fn("TitleModel.complete")(function* (model: Model<Api>, prompt: string) {
    const answer = yield* Effect.tryPromise({
      try: (signal) => access.complete(model, prompt, signal),
      catch: (cause) =>
        new TitleGenerationError({
          reason: "RequestFailed",
          message: `${model.provider}/${model.id} could not write a session title: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        }),
    });
    if (answer.stopReason === "error" || answer.stopReason === "aborted") {
      return yield* new TitleGenerationError({
        reason: "RequestFailed",
        message: `${model.provider}/${model.id} could not write a session title: ${
          answer.errorMessage ?? answer.stopReason
        }`,
      });
    }
    return answer.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
  }),
});

/** The title model over one request's Pi context. */
export const titleModelLayer = (access: TitleModelAccess): Layer.Layer<TitleModel> =>
  Layer.succeed(TitleModel, titleModelFrom(access));
