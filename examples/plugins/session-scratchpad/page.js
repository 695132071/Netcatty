"use strict";
/* global document, window */
const draft = document.getElementById("draft");
const status = document.getElementById("status");
let busy = false;
async function save(clear) {
  if (busy) return;
  busy = true;
  try {
    const text = clear ? "" : draft.value;
    await window.netcattyView.setState({ version: 1, text });
    if (clear) draft.value = "";
    status.textContent = clear ? "Draft cleared." : "Draft saved in this plugin only.";
  } catch { status.textContent = "Could not save this draft."; }
  finally { busy = false; }
}
document.getElementById("save").addEventListener("click", () => { void save(false); });
document.getElementById("clear").addEventListener("click", () => { void save(true); });
window.netcattyView.getState().then((state) => {
  if (state?.version === 1 && typeof state.text === "string" && state.text.length <= 4096) draft.value = state.text;
  status.textContent = "Ready. Use synthetic text for this example.";
  draft.disabled = false;
  document.getElementById("save").disabled = false;
  document.getElementById("clear").disabled = false;
}).catch(() => { status.textContent = "Could not load this plugin draft."; });
