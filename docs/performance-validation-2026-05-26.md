# ACP no-data-loss performance validation — 2026-05-26

Scope: Phase 8 validation for the no-data-loss performance work in this fork. The orchestrator plan remains the source of phase state; this note records reproducible evidence from the validation pass.

## Commands run

- `npm run lint`
- `npm run typecheck`
- `npm run test` — 165/165 passing
- `npm run build`
- `npm run smoke` — stdio ACP smoke with real `pi`, `session/new`, `session/prompt`, streamed `session/update`, custom `_pi/extension_ui_event`, and final `end_turn`
- From the parent Pi workspace: `pnpm exec tsx --test extensions/workflows/tests/*.test.ts` — 33 passed, 1 intentionally skipped

## Representative stress metrics

Current run from `npm run test`:

| Fixture               | Fidelity evidence                                                           | Current metric                                                                               |
| --------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Pi RPC stdout         | 1500/1500 events observed in sequence, 210780 bytes                         | prompt completion 18 ms                                                                      |
| ACP outbound pressure | all 2000 source text events accounted, reconstructed ACP text equals source | max queue depth 2, 1999 coalesced, 3 ACP updates sent, prompt completion after unblock 33 ms |
| Workflow JSONL tail   | 1202/1202 records observed in order, 529928 bytes                           | fileBytesRead 529928, maxActiveTails 1                                                       |

Before/after evidence accumulated during phases:

| Area                          | Baseline / previous                                                        | Validated improved behavior                                                                                         |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ACP outbound queue            | 2000 text chunks produced max queue depth 2001 and 61 ms after drain       | current max queue depth 2 with all source updates accounted and complete text reconstruction                        |
| Workflow tailing              | repeated whole-file rereads of growing `events.jsonl`                      | current stress reads only new bytes for the fixture (`fileBytesRead == newBytesObserved == 529928`)                 |
| Workflow event identity       | full-record stable stringify measured 14.361 ms for 1202 records           | source identity construction measured 0.288 ms for 1202 records; fallback hashes remain stable and bounded by tests |
| Slash/settings metadata reads | `loadSlashCommands` 23.064 ms/call; `getEnableSkillCommands` 0.264 ms/call | `loadSlashCommands` 12.054 ms/call; `getEnableSkillCommands` 0.075 ms/call                                          |

## Targeted coverage map

- Pi RPC ingestion: `test/performance/baseline.test.ts` verifies no event loss or reordering.
- ACP presentation pressure: `test/performance/baseline.test.ts` verifies bounded pending updates, coalescing accounting, thought coalescing, and diagnostics accounting.
- Workflow tailing/mapper: `test/unit/workflow-events.test.ts` and the performance baseline cover incremental tailing, malformed/partial lines, rotation/truncation, fast runs, terminal fallback, source identity dedupe, bounded fallback retention, and child tool/text/thought mapping.
- Large payload presentation: `test/component/session-diff.test.ts`, `test/unit/pi-tools.test.ts`, and workflow mapper tests cover explicit truncation/diagnostics without claiming the presentation is complete.
- Session list/load scalability: `test/component/session-list*.test.ts`, `test/component/session-load-toolresult.test.ts`, and `test/unit/load-session-t3code-no-replay.test.ts` cover paging, cwd filtering, mapping invalidation, tail metadata caching, title fallback, and replay compatibility.
- Startup/command metadata caching: `test/unit/slash-commands.test.ts` and `test/unit/pi-settings.test.ts` cover metadata invalidation, including same-size edits with preserved mtime.
- Main Pi workflow artifact semantics: parent workspace workflow tests passed, including ordered child event writer flushing and presentation throttling while preserving artifact records.

## UI boundary

A full interactive T3Code/Zed UI smoke was not run in this validation pass. The available automated/stdin ACP smoke was run successfully after fixing Windows `npm` spawning in `scripts/smoke-acp.mjs`; it validates the adapter wire path through initialize, session creation, prompt streaming, extension UI notification emission, usage updates, and end-turn completion. Client-specific rendering latency remains an external boundary to verify in a live ACP client.

## Remaining bottlenecks and risks

- Interactive client rendering/backpressure was not measured; ACP presentation is bounded adapter-side, but a live client may still have UI-specific batching/rendering costs.
- Non-coalescible lifecycle/tool/dialog/error updates are intentionally preserved and may still create pressure in pathological tool-heavy runs; overload diagnostics/accounting are expected rather than silent loss.
- Full session history remains durable in Pi session files. Load replay compatibility is preserved for existing clients, with t3code-specific no-replay behavior covered by tests; extremely large legacy histories can still cost time when replay is required.
- Workflow artifact production latency belongs to Pi workflow internals and should not be hidden by the ACP adapter. Current adapter validation confirms tailing/monitoring does not add repeated full-file reads for the representative fixture.
