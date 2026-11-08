---
inclusion: auto
name: SignalWire Docs
description: Guidance and documentation index for building with SignalWire (voice, video, messaging, AI agents, SWML, Relay, REST APIs, Compatibility API). Activate for any SignalWire-related task.
---

# SignalWire Documentation

SignalWire is a programmable communications platform for voice, video, messaging, and AI applications.

## How to use the docs

- The root index is the orientation page: https://signalwire.com/docs/llms.txt
- Treat it as a directory, not an exhaustive list of pages.
- Fetch any doc page as clean Markdown by appending `.md` to its URL, or sending the header `Accept: text/markdown`.
- If a page is not in the root index, open the relevant product index (the `llms.txt` files listed under Products) before concluding the docs don't cover it.

## Development interfaces

- **Server SDKs** (`/docs/server-sdks`) — Build/deploy AI agents, control calls over HTTP or WebSocket, send messages, manage resources via REST. Multiple languages.
- **Browser SDK** (`/docs/browser-sdk/v4/guides/overview`) — Add voice, video, and chat to web apps; custom JS interface or prebuilt components.
- **REST APIs** (`/docs/apis`) — Place/control calls, send messages, manage numbers, subscribers, video rooms, logs over HTTP.
- **SWML** (`/docs/swml`) — Define call flows, message handling, and AI behavior in YAML/JSON (hosted or returned by your server).
- **Call Flow Builder** (`/docs/call-flow-builder`) — Visual voice-app and AI call-flow builder in the Dashboard.
- **Compatibility API** (`/docs/compatibility-api`) — Migrate Twilio TwiML apps via TwiML-compatible XML and REST endpoints.

## Product documentation indexes

- Home: https://signalwire.com/docs/llms.txt
- Platform: https://signalwire.com/docs/platform/llms.txt
- Call Flow Builder: https://signalwire.com/docs/call-flow-builder/llms.txt
- Server SDKs: https://signalwire.com/docs/server-sdks/llms.txt
- Browser SDK: https://signalwire.com/docs/browser-sdk/llms.txt
- APIs: https://signalwire.com/docs/apis/llms.txt
- SWML: https://signalwire.com/docs/swml/llms.txt
- Compatibility API: https://signalwire.com/docs/compatibility-api/llms.txt

## Common starting points

- Get started: `/docs/platform/getting-started`
- API credentials (Project ID + API token): `/docs/platform/your-signalwire-api-space`
- Build your first AI agent in code: `/docs/server-sdks/guides/quickstart`
- Add agent tool calling (SWAIG): `/docs/server-sdks/guides/swaig`
- Local dev + exposing your agent: `/docs/server-sdks/guides/dev-environment`, `/docs/server-sdks/guides/exposing-agents`
- MCP Gateway (connect MCP servers to an agent): `/docs/server-sdks/guides/mcp-gateway`
- Send/receive SMS and MMS: `/docs/platform/messaging/send-and-receive-messages`
- Make and receive calls: `/docs/platform/voice/make-and-receive-calls`
- Migrate from Twilio: `/docs/compatibility-api`

## Credential handling

Never hardcode or commit the Project ID, API token, or personal access tokens. Use environment variables or a local, git-ignored config.

> Twilio and TwiML are trademarks of Twilio, Inc.; SignalWire is not affiliated with, sponsored by, or endorsed by Twilio, Inc.
