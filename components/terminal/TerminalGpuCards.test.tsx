import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "../../application/i18n/I18nProvider.tsx";
import type { GpuDeviceStats } from "../../application/state/useServerStats.ts";
import { TerminalGpuCards } from "./TerminalGpuCards.tsx";

function renderCards(gpus: GpuDeviceStats[], gpu = 40) {
  return renderToStaticMarkup(
    <I18nProvider locale="en">
      <TerminalGpuCards
        gpus={gpus}
        gpu={gpu}
        gpuName="NVIDIA GeForce RTX 4090"
        gpuMemUsed={2048}
        gpuMemTotal={24576}
      />
    </I18nProvider>,
  );
}

const card = (index: number, utilization: number | null, name = `NVIDIA A${index}`): GpuDeviceStats => ({
  index,
  name,
  utilization,
  memoryUsed: 1024 * (index + 1),
  memoryTotal: 8192,
});

test("one GPU uses the same per-core bar, colors, and spacing", () => {
  const markup = renderCards([card(0, 73, "NVIDIA GeForce RTX 4090")], 73);

  assert.match(markup, /GPU Device Usage/);
  assert.match(markup, /GPU 0/);
  assert.match(markup, /NVIDIA GeForce RTX 4090/);
  assert.match(markup, /73%/);
  assert.match(markup, /1\.0\/8\.0G/);
  assert.match(markup, /grid gap-1\.5 max-h-\[260px\] overflow-y-auto/);
  assert.match(markup, /min-w-\[160px\]/);
  assert.match(markup, /line-clamp-2/);
  assert.match(markup, /title="NVIDIA GeForce RTX 4090"/);
  assert.doesNotMatch(markup, /max-w-\[88px\]/);
  assert.match(markup, /h-1\.5 bg-muted rounded-full overflow-hidden/);
  assert.match(markup, /bg-amber-500/);
  assert.match(markup, /text-amber-400/);
  assert.match(markup, /repeat\(1, 1fr\)/);
});

test("eight GPUs stay in four scrolling columns", () => {
  const markup = renderCards(Array.from({ length: 8 }, (_, index) => card(index, 10 + index)));

  assert.match(markup, /repeat\(4, 1fr\)/);
  assert.match(markup, /max-h-\[260px\] overflow-y-auto/);
  assert.match(markup, /max-w-\[26rem\]/);
  assert.match(markup, /line-clamp-2/);
  assert.match(markup, /title="NVIDIA A0"/);
  assert.doesNotMatch(markup, /max-w-\[88px\]/);
  for (let index = 0; index < 8; index += 1) {
    assert.match(markup, new RegExp(`GPU ${index}`));
  }
  assert.match(markup, /text-emerald-400/);
  assert.doesNotMatch(markup, /repeat\(8,/);
});

test("high utilization uses the CPU red threshold and unknown cards stay muted", () => {
  const markup = renderCards([
    card(0, 95, "NVIDIA H100"),
    { index: 3, name: "NVIDIA A100", utilization: null, memoryUsed: null, memoryTotal: null },
  ], 95);

  assert.match(markup, /bg-red-500/);
  assert.match(markup, /text-red-400/);
  assert.match(markup, /95%/);
  assert.match(markup, /GPU 3/);
  assert.match(markup, />--</);
  assert.match(markup, /repeat\(2, 1fr\)/);
});

test("a summary without per-GPU rows falls back to one aggregate bar", () => {
  const markup = renderCards([], 12);

  assert.match(markup, /min-w-\[160px\]/);
  assert.match(markup, /h-2 bg-muted rounded-full/);
  assert.match(markup, /12%/);
  assert.match(markup, /2\.0\/24\.0G/);
  assert.match(markup, /text-emerald-400/);
  assert.doesNotMatch(markup, /grid gap-1\.5/);
});
