"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createDockerOpsApi, parseDockerContainers } = require("./dockerOps.cjs");

test("listContainers uses plain docker first even when a saved session password exists", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({ systemManagerSudoPassword: "host-secret" }),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      return {
        success: true,
        stdout: '{"ID":"abc123","Names":"web","Image":"nginx","State":"running"}\n',
        stderr: "",
        code: 0,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1");

  assert.equal(result.success, true);
  assert.equal(result.containers.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].command,
    "docker ps -a --format '{{json .}}'",
  );
  assert.equal(calls[0].execOptions, undefined);
});

test("listContainers falls back to sudo when plain docker hits socket permission denial", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({ systemManagerSudoPassword: "host-secret" }),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "permission denied while trying to connect to the Docker daemon socket",
          code: 1,
        };
      }
      if (calls.length === 2) {
        return {
          success: true,
          stdout: "",
          stderr: "sudo: a password is required",
          code: 1,
        };
      }
      return {
        success: true,
        stdout: '{"ID":"abc123","Names":"web","Image":"nginx","State":"running"}\n',
        stderr: "",
        code: 0,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1");

  assert.equal(result.success, true);
  assert.equal(result.containers.length, 1);
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "docker ps -a --format '{{json .}}'");
  assert.equal(calls[0].execOptions, undefined);
  assert.equal(
    calls[1].command,
    "sudo docker ps -a --format '{{json .}}'",
  );
  assert.equal(calls[1].execOptions, undefined);
  assert.equal(
    calls[2].command,
    "sudo -S -p '' docker ps -a --format '{{json .}}'",
  );
  assert.deepEqual(calls[2].execOptions, { stdin: "host-secret\n" });
});

test("listContainers falls back to passwordless sudo when no saved password exists", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({}),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "Got permission denied while trying to connect to the Docker daemon socket",
          code: 1,
        };
      }
      return {
        success: true,
        stdout: '{"ID":"abc123","Names":"web","Image":"nginx","State":"running"}\n',
        stderr: "",
        code: 0,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1");

  assert.equal(result.success, true);
  assert.equal(result.containers.length, 1);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "docker ps -a --format '{{json .}}'");
  assert.equal(
    calls[1].command,
    "sudo docker ps -a --format '{{json .}}'",
  );
  assert.equal(calls[1].execOptions, undefined);
});

test("listContainers does not retry with transport auth passwords that were not saved for sudo autofill", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({
      moshStatsAuth: { password: "interactive-mosh-password" },
      etStatsAuth: { password: "interactive-et-password" },
    }),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      return {
        success: true,
        stdout: "",
        stderr: "permission denied while trying to connect to the Docker daemon socket",
        code: 1,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1");

  assert.equal(result.success, false);
  assert.match(result.error, /permission denied/i);
  assert.equal(calls.length, 2);
  assert.equal(
    calls[1].command,
    "sudo docker ps -a --format '{{json .}}'",
  );
  assert.equal(calls[1].execOptions, undefined);
});

test("listContainers retries with explicit sudo autofill password on mosh or et sessions", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({
      systemManagerSudoPassword: "saved-secret",
      moshStatsAuth: { password: "transport-secret" },
    }),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "dial unix /var/run/docker.sock: connect: permission denied",
          code: 1,
        };
      }
      if (calls.length === 2) {
        return {
          success: true,
          stdout: "",
          stderr: "sudo: a password is required",
          code: 1,
        };
      }
      return {
        success: true,
        stdout: '{"ID":"abc123","Names":"web","Image":"nginx","State":"running"}\n',
        stderr: "",
        code: 0,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1");

  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[2].command,
    "sudo -S -p '' docker ps -a --format '{{json .}}'",
  );
  assert.deepEqual(calls[2].execOptions, { stdin: "saved-secret\n" });
});

test("docker image actions retry with sudo and send saved passwords through stdin", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({ systemManagerSudoPassword: "pa'ss" }),
    execOnSession: async (_event, sessionId, command, timeoutMs, execOptions) => {
      calls.push({ sessionId, command, timeoutMs, execOptions });
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "dial unix /var/run/docker.sock: connect: permission denied",
          code: 1,
        };
      }
      if (calls.length === 2) {
        return {
          success: true,
          stdout: "",
          stderr: "sudo: a password is required",
          code: 1,
        };
      }
      return { success: true, stdout: "deleted\n", stderr: "", code: 0 };
    },
  });

  const result = await dockerOps.imageAction(null, {
    sessionId: "s1",
    action: "rm",
    imageId: "sha256:abc123",
  });

  assert.equal(result.success, true);
  assert.equal(calls.length, 3);
  assert.equal(
    calls[2].command,
    "sudo -S -p '' docker rmi sha256abc123",
  );
  assert.deepEqual(calls[2].execOptions, { stdin: "pa'ss\n" });
});

test("listContainers runs podman and retries sudo only for the podman socket", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    getSession: () => ({ systemManagerSudoPassword: "host-secret" }),
    execOnSession: async (_event, sessionId, command) => {
      calls.push({ sessionId, command });
      if (calls.length === 1) {
        return {
          success: true,
          stdout: "",
          stderr: "dial unix /run/podman/podman.sock: connect: permission denied",
          code: 1,
        };
      }
      return {
        success: true,
        stdout: '{"ID":"abc123","Names":["web"],"Image":"nginx","State":"running"}\n',
        stderr: "",
        code: 0,
      };
    },
  });

  const result = await dockerOps.listContainers(null, "s1", "podman");

  assert.equal(result.success, true);
  assert.equal(result.containers[0].name, "web");
  assert.equal(calls[0].command, "podman ps -a --format '{{json .}}'");
  assert.equal(calls[1].command, "sudo podman ps -a --format '{{json .}}'");
});

test("listImages reads Podman's JSON array and Docker's JSON lines", async () => {
  const podman = createDockerOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: `[
        {
          "Id": "abc123",
          "Names": ["docker.io/library/alpine:3.20", "localhost/alpine:dev"],
          "Size": 7340032,
          "Created": 1700000000,
          "Digest": "sha256:deadbeef"
        }
      ]`,
      stderr: "",
      code: 0,
    }),
  });
  const podmanResult = await podman.listImages(null, "s1", "podman");
  assert.equal(podmanResult.success, true);
  assert.equal(podmanResult.images.length, 2);
  assert.equal(podmanResult.images[0].repository, "docker.io/library/alpine");
  assert.equal(podmanResult.images[0].tag, "3.20");
  assert.equal(podmanResult.images[0].name, "docker.io/library/alpine:3.20");
  assert.equal(podmanResult.images[1].name, "localhost/alpine:dev");
  assert.equal(podmanResult.images[1].id, "abc123");
  assert.equal(podmanResult.images[0].size, "7MB");
  assert.equal(podmanResult.images[0].digest, "sha256:deadbeef");

  const docker = createDockerOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: '{"ID":"fff","Repository":"nginx","Tag":"latest","Size":"10MB","CreatedAt":"2026-01-01"}\n',
      stderr: "",
      code: 0,
    }),
  });
  const dockerResult = await docker.listImages(null, "s1", "docker");
  assert.equal(dockerResult.images.length, 1);
  assert.equal(dockerResult.images[0].name, "nginx:latest");
  assert.equal(dockerResult.images[0].size, "10MB");
});

test("getStats reads Podman's JSON array and Docker's JSON lines", async () => {
  const podman = createDockerOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: JSON.stringify([{
        id: "abc123def456",
        name: "web",
        cpu_percent: "1.50%",
        mem_usage: "2MB / 1GB",
        mem_percent: "0.20%",
        net_io: "1kB / 2kB",
        block_io: "3kB / 4kB",
        pids: "4",
      }]),
      stderr: "",
      code: 0,
    }),
  });
  const podmanResult = await podman.getStats(null, { sessionId: "s1", ids: ["abc123def456"], runtime: "podman" });
  assert.equal(podmanResult.success, true);
  assert.equal(podmanResult.stats.length, 1);
  assert.equal(podmanResult.stats[0].id, "abc123def456");
  assert.equal(podmanResult.stats[0].name, "web");
  assert.equal(podmanResult.stats[0].cpuPercent, 1.5);
  assert.equal(podmanResult.stats[0].memUsage, "2MB / 1GB");
  assert.equal(podmanResult.stats[0].pids, 4);

  const docker = createDockerOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: '{"ID":"fff111","Name":"db","CPUPerc":"0.25%","MemUsage":"1MiB / 2GiB","MemPerc":"0.01%","NetIO":"0B / 0B","BlockIO":"0B / 0B","PIDs":"2"}\n',
      stderr: "",
      code: 0,
    }),
  });
  const dockerResult = await docker.getStats(null, { sessionId: "s1", runtime: "docker" });
  assert.equal(dockerResult.stats[0].id, "fff111");
  assert.equal(dockerResult.stats[0].cpuPercent, 0.25);
  assert.equal(dockerResult.stats[0].memUsage, "1MiB / 2GiB");
});

test("image removal targets a selected tag and keeps id removal for dangling images", async () => {
  const calls = [];
  const dockerOps = createDockerOpsApi({
    execOnSession: async (_event, _sessionId, command) => {
      calls.push(command);
      return { success: true, stdout: "", stderr: "", code: 0 };
    },
  });

  const tagged = await dockerOps.imageAction(null, {
    sessionId: "s1",
    runtime: "podman",
    action: "rm",
    imageId: "abc123",
    repository: "localhost/alpine",
    tag: "dev",
  });
  assert.equal(tagged.success, true);
  assert.equal(calls[0], "podman rmi 'localhost/alpine:dev'");

  const dangling = await dockerOps.imageAction(null, {
    sessionId: "s1",
    runtime: "podman",
    action: "rm",
    imageId: "abc123",
    repository: "<none>",
    tag: "<none>",
    force: true,
  });
  assert.equal(dangling.success, true);
  assert.equal(calls[1], "podman rmi -f abc123");
});

test("getStats sums Podman per-interface Network counters", async () => {
  const podman = createDockerOpsApi({
    execOnSession: async () => ({
      success: true,
      stdout: JSON.stringify([{
        ContainerID: "abc123def456",
        Name: "web",
        CPU: 1.5,
        MemUsage: 2097152,
        MemLimit: 1073741824,
        MemPerc: 0.2,
        Network: {
          eth0: { RxBytes: 1000, TxBytes: 2000 },
          eth1: { RxBytes: 500, TxBytes: 250 },
        },
        PIDs: 4,
      }]),
      stderr: "",
      code: 0,
    }),
  });
  const result = await podman.getStats(null, { sessionId: "s1", runtime: "podman" });
  assert.equal(result.success, true);
  assert.equal(result.stats[0].netIO, "1.5KB / 2.2KB");
  assert.equal(result.stats[0].memUsage, "2MB / 1GB");
});

test("listContainers replaces raw nerdctl containerd failures with a stable code", async () => {
  const logged = [];
  const original = console.error;
  console.error = (...args) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const dockerOps = createDockerOpsApi({
      getSession: () => ({}),
      execOnSession: async () => ({
        success: true,
        stdout: "",
        stderr: 'time="2026-10-20T18:31:27+08:00" level=fatal msg="rootless containerd not running? environment variable XDG_RUNTIME_DIR is not set"',
        code: 1,
      }),
    });

    const result = await dockerOps.listContainers(null, "s1", "nerdctl");
    const blob = JSON.stringify(result);

    assert.equal(result.success, false);
    assert.equal(result.errorCode, "nerdctlUnreachable");
    assert.equal(result.error, undefined);
    assert.equal(blob.includes("XDG_RUNTIME_DIR"), false);
    assert.equal(blob.includes("level=fatal"), false);
    assert.match(logged.join("\n"), /XDG_RUNTIME_DIR/);
  } finally {
    console.error = original;
  }
});

test("listContainers keeps a specific nerdctl command error and docker stderr", async () => {
  const nerdctl = createDockerOpsApi({
    getSession: () => ({}),
    execOnSession: async () => ({
      success: true,
      stdout: "",
      stderr: "Error: no such container: abc",
      code: 1,
    }),
  });
  const specific = await nerdctl.listContainers(null, "s1", "nerdctl");
  assert.equal(specific.success, false);
  assert.equal(specific.errorCode, undefined);
  assert.match(specific.error, /no such container/);

  const docker = createDockerOpsApi({
    getSession: () => ({}),
    execOnSession: async () => ({
      success: true,
      stdout: "",
      stderr: "permission denied while trying to connect to the Docker daemon socket",
      code: 1,
    }),
  });
  const denied = await docker.listContainers(null, "s1", "docker");
  assert.match(denied.error, /permission denied/i);
  assert.equal(denied.errorCode, undefined);
});

test("parseDockerContainers formats podman port mappings and exposed ports", () => {
  const docker = parseDockerContainers('{"ID":"abc","Names":"web","Ports":"0.0.0.0:8080->80/tcp"}\n');
  assert.equal(docker[0].ports, "0.0.0.0:8080->80/tcp");

  const podman = parseDockerContainers(JSON.stringify({
    Id: "def",
    Names: ["api"],
    Ports: [
      { host_ip: "127.0.0.1", container_port: 80, host_port: 8080, range: 1, protocol: "tcp" },
      { host_ip: "", container_port: 53, host_port: 5353, range: 2, protocol: "udp" },
      { host_ip: "::", container_port: 443, host_port: 8443, protocol: "tcp,udp" },
    ],
    ExposedPorts: { 80: ["tcp"], 443: ["tcp"], 90: ["tcp"] },
  }));
  assert.equal(podman[0].name, "api");
  assert.equal(
    podman[0].ports,
    "127.0.0.1:8080->80/tcp, 0.0.0.0:5353-5354->53-54/udp, [::]:8443->443/tcp, [::]:8443->443/udp, 90/tcp",
  );
});
