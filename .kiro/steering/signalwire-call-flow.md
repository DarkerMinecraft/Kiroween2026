---
inclusion: auto
name: signalwire-call-flow
description: Verified SignalWire facts and required patterns for this app's phone calls — SWML webhooks, the screening AI agent and its SWAIG tools, conferences, the ai_sidecar live listener, whispering to only the senior, dialing family into a live call, REST call commands, phone number setup, webhook security, and SMS rules. Use for ANY work on telephony routes, SWML builders, the SignalWire client, call-flow specs, listener prompts, or tests of call logic.
---

# SignalWire call flow: verified facts and rules

Facts come from SignalWire's docs (mirrored 2026-09-07). Items marked **VERIFIED LIVE** were confirmed on real phone calls during the day-1 call spike (Nov 8, 2026; see `docs/day-1-call-spike.md`). Items marked **NOT YET TESTED** are documented but unproven.

## Rules (mistakes this repo has already made once)

1. **`post_prompt_url` cannot control a call.** It receives an end-of-call report, and SignalWire ignores the response body ("The body is not read"). Never return SWML from it. Use it only to store the summary.
2. **To connect or move a call out of an `ai` session, a SWAIG function returns a transfer action:**
   ```json
   {
     "response": "Connecting you now.",
     "action": [
       { "SWML": { "version": "1.0.0", "sections": { "main": [] } }, "transfer": true }
     ]
   }
   ```
   `transfer: true` ends the AI session and hard-transfers the call to that SWML. Without it, the SWML runs inline and the AI session continues. (**NOT YET TESTED** for the screener → conference hand-off.)
3. **Numbers that return SWML must use the `relay_script` handler:** `PUT /api/relay/rest/phone_numbers/{id}` with `{ "name": "<non-empty>", "call_handler": "relay_script", "call_relay_script_url": "<https url>" }`. `name` is required: without it SignalWire returns 422 "Name is required" (**VERIFIED LIVE**). `laml_webhooks` + `call_request_url` is the cXML (XML) handler and is wrong for this app.
4. **Don't invent parameters.** If a field isn't on the reference page, it doesn't exist. Example: `conversation_timeout` is not an `ai` param. Real `ai.params` timeouts include `inactivity_timeout` (ms, default 600000), `attention_timeout` (ms, default 5000), `end_of_speech_timeout` and `first_word_timeout`.
5. **Use SWML (JSON) and the REST APIs.** Never cXML/LaML for new code.
6. **Mocks don't prove telephony.** A call-flow task is done only after a real test call works. Unit and property tests cover our logic, not SignalWire's behavior.

## Listener prompt rules (learned on real calls)

1. **No example sentences in tool instructions.** The model copied an example warning word for word and told the senior "wants you to keep it secret" when nobody said that.
2. **Ground every sentence.** Warnings, replies and summaries may only state what appears in the transcript. Say "the caller", never "he" or "she".
3. **Trust the speaker labels.** Telling the model to second-guess them made it blame the caller for the senior's own question.
4. **Re-warn when the senior starts going along** (agrees to pay, asks how or where to send money, or starts sharing details). A "warn once per risk" rule kept it silent at the most dangerous moments.
5. **Summary prompts must not ask leading questions** (e.g. "did the senior ask the Operator for help?"). The model answers yes regardless.
6. **Safety advice is fixed in code; the AI writes only the specific part.** Warning = `"Operator here. " + <AI sentence about the red flag> + " Say you'll call back, then hang up."`, with a fallback if the AI sentence is missing or too long.
7. **AI-written replies to the senior pass a code-side safety filter** that rejects anything advising them to comply (send, pay, buy, share codes or details) and swaps in a safe default.

## Inbound call webhook (SignalWire → us)

- SignalWire POSTs JSON `{ call, vars, envs, params }` to the number's `call_relay_script_url` and expects a SWML document back (`application/json`). **VERIFIED LIVE.**
- `call` fields: `call_id`, `from`, `to`, `direction`, `call_state`, `type`, `headers`, `project_id`, `space_id`. The caller is `call.from` (not `from_number`).
- The same payload is POSTed on every fetch that SWML triggers (`transfer` to a URL, `join_conference.wait_url`, `connect.confirm`).
- `envs` carries the `custom_variables` we pass when we create a call over REST (read them as `${envs.key}` in SWML).

## Call topology (VERIFIED LIVE except the screener step)

- **Known contact:** `answer` → `connect` to the senior's phone. No AI attached (cost rule: never pay for AI listening on calls from saved contacts).
- **Blocked number:** never rings the senior.
- **Unknown caller:** `answer` → `ai` screener → SWAIG `connect_call` returns transfer SWML → `ai_sidecar` → `join_conference` (`op-<session id>`) with `start_on_enter: false`, so the caller hears hold music until the senior joins.
- **Senior leg:** our backend REST-dials the senior with inline SWML `[ play "say:Operator here. Connecting a screened call.", join_conference { name, start_on_enter: true, end_on_exit: true } ]` and stores the returned call `id`. When the senior hangs up, every leg ends.
- **Why a conference:** `connect` bridges exactly two parties. Adding family mid-call needs a conference from the start.
- Keep a call-session record mapping the inbound `call_id` → conference name → senior leg `id` → family leg ids. Sidecar tool webhooks only tell us the call the sidecar is attached to.
- **Edge case:** if the caller hangs up while the senior is answering, the senior joins an empty conference. Detect `participant-leave` with `size: 0` before the senior joins, then tell the senior "The caller hung up" and end their leg.
- **Privacy note:** everything the senior says, including "Operator, what should I do?", is heard by the caller. Only the whispers back are private.
- Timings seen: the senior's phone starts ringing ~2 s after the call arrives; family join ~6 s after answering (the intro TTS length).

## `ai_sidecar` (the live scam listener)

- Listens to both legs and **never speaks**. A `say` action is only reported back as a callback. Every spoken warning and dial-in comes from our backend.
- **VERIFIED LIVE:** attach it on the caller's inbound leg (`answer` → `ai_sidecar` → `join_conference`). It starts in ~0.5 s. It hears the caller as `remote-caller` and the whole conference (senior plus family) as `local-caller`. It never transcribed our whispers.
- `lang` is required (e.g. `en-US`). `direction` must include both `remote-caller` and `local-caller`; a single leg is rejected.
- `customer_role` picks whose end of turn triggers an evaluation. **VERIFIED LIVE trade-off:**
  - `local-caller` (the senior's side): **use this.** Replies to "Operator…" and family requests fire ~2 s after the senior stops talking. Warnings fire ~2 s after the senior responds to the caller, not while the caller is still talking.
  - `remote-caller`: warnings ~1 s after the caller's line, but the senior's requests wait for the caller's next turn.
- `params.idle_timeout_ms`: **use 700.** The default 200 left 5 of 10 evaluations with no decision (they appear to be dropped when someone keeps talking after a short pause). At 700, only 1 of 15 was dropped, and that was the empty first second.
- `url` receives callbacks as POST `{ call_info, sidecar_event }`; unwrap `sidecar_event`. Types: `start`, `turn` (`customer_text`, `agent_text`, `transcript_delta`), `request`, `thought`, `insight`, `skip`, `tool_call` (`arguments` as a JSON string), `tool_result`, `action`, `global_data_change`, `error`, `stop`, `final`.
- `final` carries `transcript` (one entry per utterance: `role`, `content`, `confidence`, `timestamp` in µs, `silence_before_ms`), `stats`, `metrics` and `stop_reason`.
- **The end-of-call summary (`params.ai_summary`) is not in `final`.** It arrives as a separate POST to `url` with no `type`, carrying `conversation_summary` and `conversation_log` (`channel_data.content_disposition` = `transcribe.conversation_log`). **VERIFIED LIVE.**
- Tools go in `SWAIG.functions`, with `SWAIG.defaults.web_hook_url`. The tool webhook body includes `function`, `argument.parsed[0]` (an object), `channel_data.call_id` and `global_data`. Reply `{ "response": "<plain string>", "action": [...] }`; `{}` is a valid reply. Allowed actions: `user_event`, `set_global_data`, `unset_global_data`, `set_meta_data`, `unset_meta_data`, `transfer`, `hangup`, `stop`, `SWML`, `user_input`, `toggle_functions`, `settings`, `back_to_back_functions`.
- The tools that worked live: `warn_senior(reason, warning, risk_score)`, `reply_to_senior(message)` and `add_family(name)`. After a tool call the model usually also calls `sidecar_skip` in the same evaluation; that's normal.
- `sidecar_skip` is built in and reserved, so don't declare it. Tell the model to call it when there's nothing to do.
- Anti-loop guard: more than 4 tool calls in one evaluation, or the same call repeated, stops tools for that evaluation (`error_reason: tool_loop`). Tools must return clear results.
- Other useful params: `ai_summary_prompt`, `max_history_tokens`, `debug`. The model used live was `gpt-4.1-mini`. Pass `hints` (e.g. `"Operator"` and family names) to bias speech recognition.
- Can't run alongside `live_transcribe` on the same call.
- Mid-call over REST: `calling.ai_sidecar` (attach), `calling.ai_sidecar.poke`, `calling.ai_sidecar.ask`, `calling.ai_sidecar.stop`, `calling.ai_sidecar.status`.

## Whisper to the senior only (VERIFIED LIVE)

- REST `calling.play` on the senior's leg `id` with a `tts` item and `direction: "listen"`. Across 3 calls only the senior heard it, and the listener on the caller's leg never picked up any whisper words. The senior's own speech was still transcribed during a whisper.
- The whisper starts ~0.3 s after our tool webhook receives the call.
- Keep whispers short: about 20 words of AI text plus the fixed advice. Long ones run on while the caller keeps talking.
- The conference `coach` alternative (`join_conference.coach`) is unneeded and **NOT YET TESTED**.

## REST call control

- Base URL `https://<space>.signalwire.com`, HTTP Basic auth (project ID : API token), both read from env.
- `POST /api/calling/calls` with a `command`:
  - `dial`: `{ "command": "dial", "params": { "from", "to", "swml": {} or "url", "status_url", "status_events": ["created", "ringing", "answered", "ended"], "timeout", "custom_variables" } }`. The response includes the new call's `id`. Inline `swml` as an object works (**VERIFIED LIVE**).
  - `calling.play`: `{ "command": "calling.play", "id": "<call id>", "params": { "control_id": "<unique>", "play": [{ "type": "tts", "params": { "text": "..." } }], "direction": "listen" } }`
  - Also: `calling.transfer` (`dest`: a number, SIP URI, SWML URL or inline SWML), `calling.end`, `update` (swap in new SWML) and `calling.ai_message`.
- `dial` status callbacks arrive as `{ "event_type": "calling.call.state", "params": { "call_id", "call_state": "ringing" | "answered" | "ended" } }` (**VERIFIED LIVE**).
- Numbers: search `GET /api/relay/rest/phone_numbers/search` (`areacode`, `region`, `max_results`), list `GET /api/relay/rest/phone_numbers?filter_number=<E.164>`, purchase `POST /api/relay/rest/phone_numbers` (`number`), update `PUT /api/relay/rest/phone_numbers/{id}` (needs `name`).

## `join_conference`

- `name` (required), `start_on_enter` (default true), `end_on_exit` (default false), `beep` (`true`, `false`, `onEnter`, `onExit`), `muted`, `wait_url` (hold audio), `coach`, `max_participants`, and `status_callback` + `status_callback_event` (`start end join leave mute hold modify speaker announcement`).
- Conference callbacks arrive as `event_type: "calling.conference"` with `params.status` (`participant-join`, `participant-leave`, `conference-start`, `conference-end`, …), `params.call_id` and `params.size` (**VERIFIED LIVE**).
- Status callbacks are best-effort. Confirm state over REST before acting on anything critical.

## Webhook security

- SWML document requests carry `X-Signalwire-Signature` (hex HMAC-SHA1 of `url + raw_body`, keyed with the project signing key). Call requests also carry `X-Signalwire-SHA256-Signature`. Hash the exact public URL, because proxies change it.
- Signatures don't cover SWAIG or sidecar webhooks. Protect those with the `?token=` secret (or basic auth in the URL).

## SMS rules

- US texts from a local (10DLC) number require a Campaign Registry brand and campaign (fees, about 3–5 business days). Carriers check messages against the registered use case, so never send through another business's campaign.
- Toll-free numbers need toll-free verification first (free, 3–5 business days, up to 2 weeks). It needs a website with messaging terms, and the form asks for a business registration number.
- **MVP family alert = an automated voice call** ("Press 1 to join the call") plus the dashboard. SMS stays behind a feature flag until a number is registered.
- Send with `POST /api/messaging/messages` (`from`, `to`, `body`).

## Trial mode (new spaces)

- Calls only to and from purchased and verified numbers, texts only between the space's own numbers, 1 phone number max, 10 verified caller IDs. Funding the account with $5+ ends trial mode.

## References (append `.md` to read as Markdown)

- SWML calling: https://signalwire.com/docs/swml/reference/calling
- `ai`: https://signalwire.com/docs/swml/reference/calling/ai and its SWAIG functions: https://signalwire.com/docs/swml/reference/calling/ai/swaig/functions
- `ai_sidecar`: https://signalwire.com/docs/swml/reference/calling/ai-sidecar
- `join_conference`: https://signalwire.com/docs/swml/reference/calling/join-conference
- `connect`: https://signalwire.com/docs/swml/reference/calling/connect
- Call commands: https://signalwire.com/docs/apis/rest/calls/call-commands
- Update phone number: https://signalwire.com/docs/apis/rest/phone-numbers/update-phone-number
- Webhook security: https://signalwire.com/docs/swml/guides/webhook-security
- Trial mode: https://signalwire.com/docs/platform/trial-mode
