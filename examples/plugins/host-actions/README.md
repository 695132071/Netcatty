# Host action sample

The sample adds four commands to the command palette. It runs as an offline,
sandboxed browser plugin and requests no network, filesystem, or credential access.

`select` asks Netcatty to share explicitly chosen current hosts. The result contains
saved labels, addresses, usernames, groups, tags, and metadata-only target references.
Group results contain the chosen current members and never include future members.

`create` opens a host-owned SSH draft for `synthetic.invalid`. `edit` proposes a
label change for the first chosen host. Netcatty displays editable fields and the
normalized field diff before either action saves.

`connect` asks Netcatty to confirm a saved-host connection. The confirmation shows
whether saved scripts can run. The acknowledgement contains no session identifier
or terminal data. Selecting metadata never authorizes a connection by itself.

All sample test resources use synthetic hostnames. Native acceptance must use
synthetic hosts and must not establish a real host connection.
