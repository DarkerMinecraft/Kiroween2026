# Kiro spec prompt: live call protection

**How to use:** in Kiro's chat, start a new **Spec** session (not Vibe) and paste everything below the line. Kiro writes the requirements first, then the design, then the task list. Read each one and correct it before approving the next.

---

Create a spec named `live-call-protection`.

## Context

This repo already has the `senior-call-shield` spec: accounts, care links, saved contacts, Stripe billing, and a first-pass call screener. Don't redo that work.

The phone features in this spec were proven on real calls during a day-1 test. Before writing requirements, read:

- `.kiro/steering/signalwire-call-flow.md`: verified SignalWire facts and rules. Follow it exactly.
- `docs/day-1-call-spike.md`: the test results and lessons learned.

## What the feature does

Each senior has their own Operator number (their Protection_Number). Every call to it is handled like an old-fashioned switchboard operator:

1. **Saved contacts** ring straight through to the senior's phone. No AI listens.
2. **Blocked numbers** never ring the senior.
3. **Unknown callers** hear: "This line is protected by the Operator. Who's calling, and what's it about?" An AI screener then connects them, takes a short message, or blocks them.
4. **Connected unknown calls** go into a private conference. The caller waits on hold, the senior's phone is dialed in, and a live AI listener (`ai_sidecar`) is attached.
5. **During the call, the listener can:**
   - **Warn the senior privately** when it hears scam warning signs. The AI writes one sentence describing the specific red flag; the app adds fixed advice: "Say you'll call back, then hang up." It warns again, more firmly, if the senior starts going along.
   - **Answer the senior privately** when they talk to it ("Operator, what should I do?").
   - **Dial a family member into the live call** when the senior asks ("Operator, get Maria"), and confirm with a whisper: "Calling Maria now."
6. **When a call is first flagged,** the senior's primary family contact gets an automated alert call: "This is the Operator. [Senior's name] is on a call that sounds like a scam: [red flag]. Press 1 to join the call now." (Not yet tested on a real call, so include a live test.)
7. **After the call,** its summary, warnings and outcome are saved for the family dashboard.

Caregivers mark which saved contacts are family who can be pulled into calls, and which one is the primary contact for alerts.

## Edge cases to cover

- The caller hangs up before the senior joins: tell the senior "The caller hung up" and end their leg.
- The senior doesn't answer within 30 seconds.
- The family member doesn't answer: tell the senior privately.
- The senior asks for someone who isn't on their family list: "I don't have a number for them."

## Fix these bugs in the existing code as part of this spec

- `src/lib/signalwire.ts` → `configureInboundHandler` uses the cXML handler (`laml_webhooks`). It must use `relay_script` with `call_relay_script_url` and send a non-empty `name`.
- `src/lib/swml.ts` passes `conversation_timeout`, which isn't a real SignalWire parameter.
- The screener tries to connect calls by returning SWML from `post_prompt_url` (`src/app/api/telephony/report/route.ts`). SignalWire ignores that response, so approved callers are never connected. Connecting must happen through a SWAIG function that returns a transfer action. `post_prompt_url` only stores the summary.
- The report URL never includes the senior id that the report route requires, so every report fails with a 400.
- `isForwardingActive` requires an active Stripe subscription, so the demo can't take calls. Add a trial/demo state that allows forwarding without Stripe.
- Update the existing tests that assert the old, wrong behavior.

## Hard rules

- Use exactly the verified settings in the steering doc: listener on the caller's inbound leg, `customer_role: "local-caller"`, `params.idle_timeout_ms: 700`, whispers via REST `calling.play` with `direction: "listen"` on the senior's leg, and the listener prompt rules.
- `add_family` may only dial numbers on that senior's own family list, never a number spoken during the call.
- Whispers only ever go to the senior's leg. A tool call for one call must never affect another senior's call.
- AI-written replies pass a safety filter that blocks any advice to send money, buy gift cards, or share codes or personal details.
- No AI listener on calls from saved contacts.
- Store no audio. Store summaries and flagged events only.
- Every SignalWire webhook is protected by the existing `?token=` secret.

## Testing

- Write property-based tests (fast-check, like the existing ones) for the call rules. For example:
  - a blocked number never rings the senior
  - saved contacts never get the AI listener
  - `add_family` never dials a number outside the family list
  - every whisper ends with the fixed advice and stays under 40 words
  - the safety filter rejects advice to comply
- Mock SignalWire in unit tests.
- A task that changes call behavior is done only after a real test call passes. Use the checklist format in `docs/day-1-call-spike.md`.

## Out of scope (separate specs later)

The switchboard dashboard redesign, weather check-ins, the FTC scam-number list, SMS texts, number porting, and a "try it" demo for judges.
