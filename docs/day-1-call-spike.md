# Day-1 call spike: checklist

**Goal:** prove the risky phone pieces work on real calls before Kiro builds them. This needs no app code: just SignalWire, a throwaway webhook logger that Claude Code runs outside the repo (exposed through ngrok), and three phones.

**Time:** about an hour. **Cost:** a few dollars of call and AI-listening minutes.

## What we're testing

| # | Question | Passes when |
|---|---|---|
| T1 | Can the caller and senior talk in a conference with the AI listener attached, and does it hear both of them? | Both talk normally, and the logger shows `turn` events with both people's words |
| T2 | Can we whisper to the senior only? | The senior hears the warning; the caller hears nothing |
| T3 | Does the listener spot the scam? | A `warn_senior` tool call within two turns of "bail" or "gift cards" |
| T4 | Does "Operator, get Maria" work, and how fast? | An `add_family` tool call naming Maria within about 3 seconds |
| T5 | Can we dial Maria into the live call? | All three hear each other, and a second whisper still reaches only the senior |
| T6 | What happens at hang-up? | The call ends cleanly and a `final` event arrives with a summary |
| T7 | Only if T2 fails: does the conference "coach" whisper work? | Same as T2 |
| T8 | Optional: can the screening AI hand an approved caller into the conference? | The caller ends up talking to the senior |

## Phones

- **Operator number:** the SignalWire number you buy.
- **Senior:** your cell.
- **Caller (the "scammer"):** your partner's cell.
- **Maria (family):** a third phone, such as a friend, a family member, Google Voice or a landline. Only needed for T5.

## Part A: SignalWire setup (you, ~15 min)

1. In the new space, buy one local number (any US area code).
2. Leave trial mode (recommended): add a card and fund $5 or more. Trial mode only allows calls to and from verified numbers, and one number in total.
   - To stay in trial for now, add the senior, caller and Maria phones as Verified Caller IDs instead.
3. Create an API token (Dashboard → API) with voice/calling and phone-number access.
4. Create a file named `.env` in the repo root (it's gitignored) containing:
   ```
   SIGNALWIRE_PROJECT_ID=
   SIGNALWIRE_API_TOKEN=
   SIGNALWIRE_SPACE_URL=yourspace.signalwire.com
   SPIKE_OPERATOR_NUMBER=+1...
   SPIKE_SENIOR_PHONE=+1...
   SPIKE_CALLER_PHONE=+1...
   SPIKE_MARIA_PHONE=+1...
   ```
   Don't paste the token into chat.
5. Tell Claude Code you're ready.

## Part B: Claude Code prepares (~10 min)

- Starts the throwaway logger and an ngrok tunnel, both outside the repo.
- Points the Operator number at the logger (`relay_script`). The logger returns a test SWML script: answer → `ai_sidecar` → `join_conference`.
- Confirms the setup over the REST API.

## Part C: The calls (~30 min)

**T1.** The caller dials the Operator number and waits on hold. Claude Code dials the senior into the conference. Chat for 20 seconds. Can you both hear each other?

**T2.** While you talk, Claude Code plays a warning to the senior's leg only. Senior: did you hear it clearly? Caller: did you hear anything at all? Note any delay.

**T3.** The caller reads this script while the senior reacts naturally. Claude Code watches for `warn_senior`.

> "Grandma? It's me, Jake. I'm in trouble. I got arrested and I need $2,000 for bail. Can you go to the drugstore, buy gift cards and read me the numbers? Please don't tell Mom."

**T4.** The senior says: "Operator, get Maria." Claude Code notes the delay. We repeat once with the other `customer_role` setting and keep the faster one.

**T5.** Claude Code dials Maria into the call. Maria hears a short intro, then joins and all three talk. Claude Code plays a second whisper, which only the senior should hear.

**T6.** The senior hangs up. Does the caller get dropped too? Claude Code checks for the `final` summary.

**T7 / T8** only if needed.

## Part D: Results (3 real calls, Nov 8, 2026)

| # | Result | Notes (delay, clarity, surprises) |
|---|---|---|
| T1 | ✅ Pass | Listener attached ~0.5 s after the call arrived and heard both sides through the conference |
| T2 | ✅ Pass | `calling.play` with `direction: "listen"` on the senior's leg: the senior heard every whisper, the caller never did, and no whisper words reached the caller's audio (3 calls) |
| T3 | ✅ Pass | Warnings ~2 s after the senior responds. After the prompt fixes, each one described what this caller actually said, including an off-script "bank refund" scam |
| T4 | ✅ Pass | "Can you get Maria for me?" → `add_family` + "Calling Maria now" 2.2 s later (with `customer_role: local-caller`) |
| T5 | ✅ Pass | Maria's phone rang 3.7 s after the request; she joined the call ~6 s after answering |
| T6 | ✅ Pass | The senior hanging up ends every leg; the end-of-call summary arrives as a separate callback |
| T7 | Not needed | T2 passed, so no coach leg |
| T8 | Not yet tested | Screener → conference hand-off, to be built with Kiro |

### Problems found and fixed during the spike

- A fixed example sentence in the listener's instructions was copied word for word, telling the senior something nobody said. Fix: no example sentences; only facts from the transcript.
- Telling the model not to trust speaker labels (after same-room echo in call #1) made it blame the caller for the senior's question. Fix: trust the labels, and run tests from separate rooms.
- "Warn once per risk" kept it silent when the senior agreed to pay. Fix: re-warn when the senior starts going along.
- About half of the listener's checks ended with no decision at the default `idle_timeout_ms` (200). Fix: 700 (1 of 15 dropped).
- The senior expected the Operator to answer them ("Operator, can you hear me?", "Operator, what do I do?"). Fix: a `reply_to_senior` tool, with a code-side filter that blocks advice to comply.
- The summary answered a leading question incorrectly. Fix: summarize only facts from the transcript.

### Open product questions

- The caller hears everything the senior says to the Operator. Keep it as a deterrent, or find a private way to talk to the Operator?
- When the listener reacts to the senior's speech, a warning waits until the senior responds (about 7 s after the scam line in call #3). Acceptable, or add a backup trigger on the caller's speech?
- If the caller hangs up while the senior is answering, the senior gets an empty line. The app must detect this and say "The caller hung up."

## Decisions this unlocks

- **Whisper:** if T2 passes, use `calling.play` on the senior's leg. If T2 fails and T7 passes, use a coach leg. If both fail, speak the warning to both sides, which also deters the scammer.
- **Listener placement:** if T1 shows the listener can't hear the senior through the conference, attach it to the senior's leg instead.
- **Voice command:** keep the faster `customer_role`. If both take more than about 3 seconds, look into a keypad backup ("press 0 for the Operator").
- **Afterwards:** update the **TEST LIVE** items in `.kiro/steering/signalwire-call-flow.md` with the results, then start the Kiro spec for live call protection.
