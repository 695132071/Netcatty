# Selected Note Assistant

A minimal browser plugin that uses Netcatty's selected configured model and one
explicitly selected reference. It provides Send, streamed text, Stop, and usage.
It has no tools, terminal commands, direct network access, Node runtime, or storage.

The host must support `ai.model-invocation` and `context.selected-read`, with the
trusted renderer adapter connected. AI invocation, selected-summary enumeration,
and selected-content reading have separate optional permissions. The host shows
the exact selected text for review before the plugin or model receives it.
A menu or command ID grants no authority over a resource.

Build the six-file staging directory with `node build.mjs`, then pack `.package`
with Netcatty's plugin CLI. Build scripts are not included in the installed package.
The plugin uses only the canonical `context.ai` and `context.selectedContext` SDK
methods through its own declared view commands. No chat history is persisted.

For isolated QA, use the deterministic loopback provider and synthetic Note recipe
in `docs/plugin-platform/assistant-native-qa.md` in the Netcatty repository. Fixture
QA performs no model inference or paid API call. Native acceptance and the remaining
independent review are separate requirements.
