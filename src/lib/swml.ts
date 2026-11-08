/**
 * Pure SWML (SignalWire Markup Language) document builders.
 *
 * These builders produce the JSON documents returned by the telephony route
 * handlers for the three inbound-call flows:
 *
 *  1. Known-contact bypass — connect straight through to the Personal_Number.
 *  2. Unknown caller — hand off to the AI Screening_Agent, bounded to a
 *     60-second intent window, posting its summary to the report endpoint.
 *  3. Forwarding inactive — answer, play a short notice, and hang up.
 *
 * Every function here is pure: it takes plain inputs and returns a plain SWML
 * document object with no IO. The route handlers own all IO (resolving the
 * Senior, normalizing numbers, persisting Call_Records). Shapes mirror the
 * design "SWML shapes (JSON)" section exactly.
 */

/** A single SWML instruction (e.g. `answer`, `connect`, `ai`, `play`, `hangup`). */
export interface SwmlInstruction {
  readonly [verb: string]: Record<string, unknown>;
}

/** The ordered list of instructions executed for a call flow. */
export interface SwmlSections {
  readonly main: readonly SwmlInstruction[];
}

/** A complete SWML document returned to SignalWire. */
export interface SwmlDocument {
  readonly version: string;
  readonly sections: SwmlSections;
}

/** Inputs for the unknown-caller AI screening document. */
export interface UnknownCallerScreeningInput {
  /** Absolute URL SignalWire posts the conversation summary to. */
  readonly postPromptUrl: string;
}

/** SWML version string shared by every document. */
const SWML_VERSION = "1.0.0";

/** Seconds the Screening_Agent is given to obtain caller intent (Req 6.6). */
const CONVERSATION_TIMEOUT_SECONDS = 60;

/** Prompt that instructs the AI Screening_Agent to gather call intent. */
const SCREENING_PROMPT_TEXT =
  "You are a call screener. Determine the caller's purpose and whether the " +
  "call is legitimate, spam, or fraud. Be brief and polite.";

/** Spoken notice played when forwarding is inactive for the Senior. */
const FORWARDING_INACTIVE_NOTICE = "say:This number is not accepting calls right now.";

/**
 * Known-contact bypass: answer and connect straight through to the Senior's
 * Personal_Number with no screening (Req 5.4).
 */
export const buildKnownContactConnectSwml = (personalNumberE164: string): SwmlDocument => ({
  version: SWML_VERSION,
  sections: {
    main: [{ answer: {} }, { connect: { to: personalNumberE164 } }],
  },
});

/**
 * Unknown caller: answer and hand the call to the AI Screening_Agent, which
 * posts its conversation summary to `postPromptUrl` and is bounded to a
 * 60-second intent window; the call hangs up when the agent completes or the
 * window elapses (Req 6.1, 6.6).
 */
export const buildUnknownCallerScreeningSwml = ({
  postPromptUrl,
}: UnknownCallerScreeningInput): SwmlDocument => ({
  version: SWML_VERSION,
  sections: {
    main: [
      { answer: {} },
      {
        ai: {
          prompt: { text: SCREENING_PROMPT_TEXT },
          post_prompt_url: postPromptUrl,
          params: { conversation_timeout: CONVERSATION_TIMEOUT_SECONDS },
        },
      },
      { hangup: {} },
    ],
  },
});

/**
 * Forwarding inactive: answer, play a short notice, and hang up so the call is
 * recorded with a "not forwarded" outcome (Req 6.3).
 */
export const buildForwardingInactiveSwml = (): SwmlDocument => ({
  version: SWML_VERSION,
  sections: {
    main: [
      { answer: {} },
      { play: { url: FORWARDING_INACTIVE_NOTICE } },
      { hangup: {} },
    ],
  },
});
