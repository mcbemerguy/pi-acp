# pi-acp

ACP ([Agent Client Protocol](https://agentclientprotocol.com/overview/introduction)) adapter for [`pi`](https://github.com/earendil-works/pi) coding agent (fka shitty coding agent).

`pi-acp` communicates **ACP JSON-RPC 2.0 over stdio** to an ACP client (e.g. Zed editor) and spawns `pi --mode rpc`, bridging requests/events between the two.

## Status

This is an MVP-style adapter intended to be useful today and easy to iterate on. Some ACP features may be not implemented or are not supported (see [Limitations](#limitations)). Development is centered around [Zed](https://zed.dev) editor support, other clients may have varying levels of compatibility.

Expect some minor breaking changes.

## Features

- Streams assistant output as ACP `agent_message_chunk`
- Maps pi tool execution to ACP `tool_call` / `tool_call_update`
  - Tool call locations are surfaced when available for ACP clients that support opening the referenced file/context
  - Relative file paths from pi are resolved against the session cwd before being emitted as ACP tool locations, which enables follow-along features in clients like Zed
  - For `edit`, `pi-acp` attempts to infer a 1-based line number from a unique `oldText` match in the pre-edit file snapshot and includes it in the emitted tool location when possible
  - For `edit`, `pi-acp` snapshots the file before the tool runs and emits an ACP **structured diff** (`oldText`/`newText`) on completion when possible
- Session persistence
  - pi stores its own sessions in `~/.pi/agent/sessions/...`
  - `pi-acp` stores a small mapping file at `~/.pi/pi-acp/session-map.json` so `session/load` can reattach to a previous pi session file
- Workflow commands
  - Detached `/workflow:*` runs keep a high-level workflow tool wrapper and ACP `plan` step status updates
  - Child agent assistant output is projected into the chat as ordinary ACP `agent_message_chunk` / `agent_thought_chunk`, and child tools remain ordinary ACP tool calls
  - Per-step workflow tool wrappers are intentionally omitted so the child transcript is not nested inside synthetic step tool calls
  - ACP `session/load` can reattach to recoverable workflow runs, replay stored workflow events, and expose Pi-specific `_pi/workflows/*` methods for richer clients
- Slash commands
  - Loads file-based slash commands compatible with pi’s conventions
  - Adds a small set of built-in commands for headless/editor usage
  - Supports skill commands (if enabled in pi settings, they appear as `/skill:skill-name` in the ACP client)
- Skills are loaded by pi directly and are available in ACP sessions
- Translates Pi RPC dialog requests (`select`, `input`, `confirm`, best-effort `editor`) to the Cursor-compatible ACP extension method `cursor/ask_question` for clients that support blocking user questions
- (Zed) `pi-acp` emits “startup info” block into the session (pi version, context, skills, prompts, extensions - similar to `pi` in the terminal). You can disable it by setting `quietStartup: true` in pi settings (`~/.pi/agent/settings.json` or `<project>/.pi/settings.json`). When `quietStartup` is enabled, `pi-acp` will still emit a 'New version available' message if the installed pi version is outdated.
- (Zed) Session history is supported in Zed starting with [`v0.225.0`](https://zed.dev/releases/preview/0.225.0). Session loading / history maps to pi's session files. Sessions can be resumed both in `pi` and in the ACP client.

## Prerequisites

Make sure pi is installed

```bash
npm install -g @earendil-works/pi-coding-agent
```

- Node.js 22+
- `pi` installed and available on your `PATH` (the adapter runs the `pi` executable)
- Configure `pi` separately for your model providers/API keys

## Install

### Add pi-acp to your ACP client, e.g. [Zed](https://zed.dev/docs/agents/external-agents/)

#### Using ACP Registry in Zed or other clients that support it:

In Zed launch the registry with `zed: acp registry` command and select `pi ACP` adapter from the list. This will automatically add the agent server configuration to your `settings.json` and keep it up to date:

```json
  "agent_servers": {
    "pi-acp": {
      "type": "registry",
    },
  }
```

#### Using with `npx` (no global install needed, always loads the latest version):

Add the following to your Zed `settings.json`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "npx",
      "args": ["-y", "pi-acp"],
      "env": {}
    }
  }
```

#### Global install

```bash
npm install -g pi-acp
```

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "pi-acp",
      "args": [],
      "env": {}
    }
  }
```

#### From source

```bash
npm install
npm run build
```

Point your ACP client to the built `dist/index.js`:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {}
    }
  }
```

### Environment variables

- `PI_ACP_ENABLE_EMBEDDED_CONTEXT=true` advertises ACP `promptCapabilities.embeddedContext` support to the client.
- Default: unset/any other value means `false`.
- When disabled, compliant ACP clients should avoid sending embedded `resource` blocks. If they send them anyway, `pi-acp` still degrades gracefully by converting them into plain-text prompt context.

You can add the environment variable in the Zed settings with:

```json
  "agent_servers": {
    "pi": {
      "type": "custom",
      "command": "node",
      "args": ["/path/to/pi-acp/dist/index.js"],
      "env": {
          "PI_ACP_ENABLE_EMBEDDED_CONTEXT": "true",
      }
    }
  }
```

### Interactive questions and `ask_user_questions`

Pi has three supported interactive question paths:

1. In-process UI bridge hosts can handle the canonical `ask_user_questions` interaction directly.
2. Local terminal Pi sessions render the built-in TUI questionnaire.
3. ACP/RPC sessions use Pi's standard RPC dialog requests. `pi-acp` marks child Pi processes with `PI_ACP_RPC=1`, then translates blocking dialog requests to `conn.extMethod("cursor/ask_question", payload)` for compatible ACP clients such as T3Code Custom ACP.

The ACP bridge is transport support only. `ask_user_questions` remains opt-in and is not added to default Pi tool caps. To smoke-test it through an ACP client, explicitly expose the tool, for example with `PI_DELEGATED_TOOL_CAP=ask_user_questions` in the ACP server environment.

`pi-acp` sends these `cursor/ask_question` payloads:

- `select`: `{ toolCallId, title, questions: [{ id: "selection", prompt, options: [{ id: "0", label }, ...], allowMultiple: false }] }`
- `input` / `editor`: `{ toolCallId, title, questions: [{ id: "value", prompt, allowMultiple: false }] }` (text-entry prompt; compatible clients should not synthesize an `OK` option as the text answer)
- `confirm`: `{ toolCallId, title, questions: [{ id: "confirmed", prompt, options: [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }], allowMultiple: false }] }`

Responses are normalized from `answers[questionId]`, then the first answer value, then top-level `value` / `answer`. Select option ids are mapped back to labels; exact labels and unknown non-empty strings are passed through so clients can return custom answers. Malformed responses, errors, and unsupported methods cancel the dialog to avoid deadlocking Pi.

#### T3Code Custom ACP smoke path

T3Code's Custom ACP provider defaults to `askQuestionEnabled: true` and `askQuestionMethod: cursor/ask_question`, which matches `pi-acp`.

Practical local smoke configuration:

1. Build the adapter: `cd .local/pi-acp && npm run build`.
2. Start T3Code: `cd .local/t3code && bun run dev`.
3. Add or edit a Custom ACP provider in T3Code settings:
   - Command: `node`
   - Arguments: `/home/marcosb/.pi/.local/pi-acp/dist/index.js`
   - Environment:
     - `PI_ACP_PI_COMMAND=/home/marcosb/.pi/bin/pi`
     - `PI_CODING_AGENT_DIR=/home/marcosb/.pi/agent`
     - `PI_DELEGATED_TOOL_CAP=ask_user_questions`
4. Start a Custom ACP thread and ask the agent to call `ask_user_questions` with a small single-select question. Expected flow: Pi emits an RPC `select`, `pi-acp` sends `cursor/ask_question`, T3Code shows a blocking user-input prompt, the chosen/custom answer returns as `{ answers: { selection: "..." } }`, and Pi resumes the tool call.

If this cannot be smoke-tested manually, the unverified boundary is the browser click/submit step inside T3Code. Unit coverage verifies the adapter payloads and T3Code request/response shapes on both sides of that boundary.

### Session close/delete lifecycle

`session/close` and `session/delete` are intentionally different:

- Close is non-destructive. It cancels active/queued work, lets pending ACP requests settle, disposes workflow monitors, and terminates the live `pi --mode rpc` subprocess. Pi JSONL history, `session-map.json`, and workflow artifacts remain available for `session/load`/recovery.
- Delete is destructive for the backing Pi conversation only. It closes first, validates the resolved Pi JSONL header against the requested ACP session id and cwd, unlinks only that validated JSONL file, removes the `pi-acp` mapping entry, and marks recoverable workflow runs for that parent session aborted so they are not silently auto-resumed.
- Delete does not remove arbitrary paths, project files, workflow audit directories, `events.jsonl`, child session artifacts, or global Pi configuration. Stale/unknown mappings are cleaned up without unlinking a file unless validation succeeds.

Operational smoke tests:

1. Idle delete: create a `pi-acp` session through an ACP client, delete it, confirm the session disappears from `session/list` and the mapped Pi JSONL no longer exists.
2. Active-turn delete: start a long turn, delete the client thread/session, confirm close happens first, no `pi --mode rpc` child remains, and the JSONL is removed only after validation.
3. Stuck cancel: simulate or reproduce a Pi turn that does not acknowledge abort; confirm logs show abort timeout/failure and subprocess kill escalation, then no live Pi process remains.
4. Windows launcher cleanup: run through `pi.cmd`/shell on Windows and confirm escalation uses `taskkill /PID <pid> /T /F`, not only a shell kill.
5. Stale/wrong mapping: delete an already-missing session and a mapping pointing at a wrong-session/wrong-cwd JSONL; confirm the mapping cleanup is safe and the wrong file remains.

Diagnostics are written to stderr with `[pi-acp]` prefixes for delete request parameters, close-before-delete failure, resolved session file, validation refusal reason, unlink failure/success, workflow abort failure, and process kill escalation.

### Workflow recovery

For detached Pi `/workflow:*` runs, `pi-acp` is a presenter/control bridge rather than the source of truth. Pi workflow artifacts remain authoritative: `run.json` stores the state machine, `events.jsonl` is the replayable event stream, child session artifacts prove final handoffs, and `audit.md` is the human-readable recovery record. Recovery does not depend on inserting workflow progress into model-visible context.

On ACP `session/load`, the adapter uses the persisted session mapping and the loaded session cwd/id to discover recoverable workflow runs. Current `session/load` attaches those runs with a full standard ACP `session/update` replay, then tails live `events.jsonl` records. Pi-aware clients that store a workflow cursor, such as T3Code, suppress duplicate presentation with their saved last observed `sequence`; clients that need incremental event fetches can call `_pi/workflows/events` with `sinceSequence`. If a terminal `run_end` event was missed, the replay path can synthesize terminal presentation from terminal `run.json` state.

The adapter advertises Pi workflow support under `_meta.piAcp` and supports these additive custom methods for clients that opt in:

- `_pi/workflows/list`
- `_pi/workflows/get`
- `_pi/workflows/events`
- `_pi/workflows/resume`
- `_pi/workflows/interrupt`
- `_pi/workflows/pause`
- `_pi/workflows/abort`

Generic ACP clients can ignore those methods and still receive replayed standard updates plus audit/run links. Pi-aware clients should include `sessionId` when controlling a live run; the adapter routes live `interrupt`, `pause`, `resume`, and explicit `abort` through Pi's workflow control path (dedicated RPC command when available, otherwise the internal `/workflow:control` extension command) so execution stops or continues in Pi rather than only editing artifacts. `session/cancel` remains the standard Stop path and interrupts the active Pi turn without implying terminal abort. If no live ACP session is available, the custom control methods are limited to offline recovery metadata in `run.json`; that offline path does not append `events.jsonl` control records because Pi owns workflow event sequencing. A normal next user prompt continues the single recoverable run for the session; if multiple runs are recoverable, the adapter asks the client to choose one explicitly with `_pi/workflows/resume`. Use the end-to-end checklist at `/home/marcosb/.pi/agent/extensions/workflows/scripts/recovery-smoke.md` to validate T3Code UI reload, T3Code server restart, adapter restart, parent `pi --mode rpc` restart with `session/load`, child crashes before/after handoff, and interrupt/resume/abort behavior.

### Slash commands

`pi-acp` supports slash commands:

#### 1) File-based commands (aka prompts)

Loaded from:

- User commands: `~/.pi/agent/prompts/**/*.md`
- Project commands: `<cwd>/.pi/prompts/**/*.md`

#### 2) Built-in commands

- `/compact [instructions...]` – run pi compaction (optionally with custom instructions)
- `/autocompact on|off|toggle` – toggle automatic compaction
- `/export` – export the current session to HTML in the session `cwd`
- `/session` – show session stats (tokens/messages/cost/session file)
- `/name <name>` – set session display name
- `/queue all|one-at-a-time` – set pi queue mode (unstable feature)
- `/changelog` – print the installed pi changelog (best-effort)
- `/steering` - maps to `pi` Steering Mode, get/set
- `/follow-up` - pats to `pi` Follow-up Mode, get/set

Other built-in commands:

- `/model` - maps to model selector in Zed
- `/thinking` - maps to 'mode' selector in Zed
- `/clear` - not implemented (use ACP client 'new' command)

#### 3) Skill commands

- Skill commands can be enabled in pi settings and will appear in the slash command list in ACP client as `/skill:skill-name`.

**Note**: Slash commands provided by pi extensions are not currently supported.

## Authentication (ACP Registry support)

This agent supports **Terminal Auth** for the [ACP Registry](https://agentclientprotocol.com/get-started/registry).
In Zed, this will show an **Authenticate** banner that launches pi in a terminal.
Launch pi in a terminal for interactive login/setup:

```bash
pi-acp --terminal-login
```

Your ACP client can also invoke this automatically based on the agent's advertised `authMethods`.

## Development

```bash
npm install
npm run dev        # run from src via tsx
npm run build
npm run lint
npm run test
```

Project layout:

- `src/acp/*` – ACP server + translation layer
- `src/pi-rpc/*` – pi subprocess wrapper (RPC protocol)

## Limitations

- No ACP filesystem delegation (`fs/*`) and no ACP terminal delegation (`terminal/*`). pi reads/writes and executes locally.
- MCP servers are accepted in ACP params and stored in session state, but not wired through to pi in this adapter. If you use [pi MCP adapter](https://github.com/nicobailon/pi-mcp-adapter) it will be available in the ACP client.
- Assistant streaming is currently sent as `agent_message_chunk` (no separate thought stream).
- Queue is implemented client-side and should work like pi's `one-at-a-time`
- ~~ACP clients don't yet suport session history, but ACP sessions from `pi-acp` can be `/resume`d in pi directly~~

## License

MIT (see [LICENSE](LICENSE)).
