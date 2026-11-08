import { describe, expect, it } from "vitest";

import {
  buildForwardingInactiveSwml,
  buildKnownContactConnectSwml,
  buildUnknownCallerScreeningSwml,
} from "./swml";

// Unit tests for the pure SWML document builders (task 5.2 / 5.3). Each builder
// is pure, so these assertions pin down the exact JSON shape returned to
// SignalWire for every inbound-call flow described in the design.
// Validates: Requirements 5.4, 6.1, 6.3

const SWML_VERSION = "1.0.0";

describe("buildKnownContactConnectSwml", () => {
  it("answers and connects straight through to the Personal_Number (Req 5.4)", () => {
    const personalNumber = "+15125550123";

    const doc = buildKnownContactConnectSwml(personalNumber);

    expect(doc).toEqual({
      version: SWML_VERSION,
      sections: {
        main: [{ answer: {} }, { connect: { to: personalNumber } }],
      },
    });
  });

  it("embeds the exact Personal_Number passed in, with no screening step", () => {
    const doc = buildKnownContactConnectSwml("+441632960111");

    const verbs = doc.sections.main.map((instruction) => Object.keys(instruction)[0]);
    expect(verbs).toEqual(["answer", "connect"]);
    expect(verbs).not.toContain("ai");
    expect(doc.sections.main[1]).toEqual({ connect: { to: "+441632960111" } });
  });
});

describe("buildUnknownCallerScreeningSwml", () => {
  it("answers, hands off to the AI screener with the post_prompt_url, then hangs up (Req 6.1)", () => {
    const postPromptUrl = "https://mabel.example.com/api/telephony/report?token=abc";

    const doc = buildUnknownCallerScreeningSwml({ postPromptUrl });

    expect(doc).toEqual({
      version: SWML_VERSION,
      sections: {
        main: [
          { answer: {} },
          {
            ai: {
              prompt: {
                text:
                  "You are a call screener. Determine the caller's purpose and whether the " +
                  "call is legitimate, spam, or fraud. Be brief and polite.",
              },
              post_prompt_url: postPromptUrl,
              params: { conversation_timeout: 60 },
            },
          },
          { hangup: {} },
        ],
      },
    });
  });

  it("bounds the Screening_Agent to a 60-second conversation timeout (Req 6.6)", () => {
    const doc = buildUnknownCallerScreeningSwml({
      postPromptUrl: "https://mabel.example.com/report",
    });

    const aiInstruction = doc.sections.main.find((instruction) => "ai" in instruction);
    expect(aiInstruction?.ai.params).toEqual({ conversation_timeout: 60 });
  });

  it("posts the conversation summary to the exact URL provided", () => {
    const postPromptUrl = "https://mabel.example.com/api/telephony/report?token=xyz-789";

    const doc = buildUnknownCallerScreeningSwml({ postPromptUrl });

    const aiInstruction = doc.sections.main.find((instruction) => "ai" in instruction);
    expect(aiInstruction?.ai.post_prompt_url).toBe(postPromptUrl);
  });
});

describe("buildForwardingInactiveSwml", () => {
  it("answers, plays the notice, and hangs up (Req 6.3)", () => {
    const doc = buildForwardingInactiveSwml();

    expect(doc).toEqual({
      version: SWML_VERSION,
      sections: {
        main: [
          { answer: {} },
          { play: { url: "say:This number is not accepting calls right now." } },
          { hangup: {} },
        ],
      },
    });
  });

  it("takes no inputs and never connects or screens the caller", () => {
    const verbs = buildForwardingInactiveSwml().sections.main.map(
      (instruction) => Object.keys(instruction)[0],
    );

    expect(verbs).toEqual(["answer", "play", "hangup"]);
    expect(verbs).not.toContain("connect");
    expect(verbs).not.toContain("ai");
  });
});
