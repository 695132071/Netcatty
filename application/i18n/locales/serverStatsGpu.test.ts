import test from "node:test";
import assert from "node:assert/strict";

import { enTerminalMessages } from "./en/terminal";
import { esTerminalMessages } from "./es/terminal";
import { ruTerminalMessages } from "./ru/terminal";
import { zhCNVaultMessages } from "./zh-CN/vault";
import { zhTWVaultMessages } from "./zh-TW/vault";

test("per-GPU stats strings exist in every locale", () => {
  const labels = [
    [enTerminalMessages, "GPU Device Usage", "GPU {{index}}"],
    [esTerminalMessages, "Uso de cada GPU", "GPU {{index}}"],
    [ruTerminalMessages, "Использование видеокарт", "GPU {{index}}"],
    [zhCNVaultMessages, "GPU 设备使用率", "GPU {{index}}"],
    [zhTWVaultMessages, "GPU 裝置使用率", "GPU {{index}}"],
  ] as const;

  for (const [messages, devices, indexLabel] of labels) {
    assert.equal(messages["terminal.serverStats.gpuDevices"], devices);
    assert.equal(messages["terminal.serverStats.gpuIndex"], indexLabel);
  }
});
