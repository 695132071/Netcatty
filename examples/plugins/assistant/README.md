# Assistant example source

This panel contains the minimal example UI: a host-selected model, one explicitly
selected Note, Send, streamed text, Stop, and token usage. It uses the existing
`netcattyView.executeCommand` surface. It has no direct network access or Node API.

The runtime entry and package manifest are pending the parent's shared contract
and SDK decision. This directory is not yet an installable plugin.
The command names in `panel.js` are example-local command IDs, not host RPC methods.
A menu or command ID grants no authority to read a resource.

The QA harness binds these commands to `ModelInvocationBroker` and
`SelectedContextAuthority`. The production runtime must bind them through the
approved canonical SDK methods, with host permission checks and provenance.
The local deterministic provider proves the pipeline. It does not perform model
inference, use paid credentials, or read a real user's data.
