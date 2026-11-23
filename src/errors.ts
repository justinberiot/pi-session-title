/** Expected failures of naming a session. */

import { Data } from "effect";

/**
 * No title could be generated. The session keeps its placeholder title, or
 * stays unnamed, and `/retitle` can be run again.
 */
export class TitleGenerationError extends Data.TaggedError("TitleGenerationError")<{
  readonly reason:
    | "NoModel"
    | "ModelNotFound"
    | "NoAuth"
    | "InvalidSettings"
    | "RequestFailed"
    | "InvalidTitle"
    | "TimedOut"
    | "NothingToName";
  readonly message: string;
}> {}
