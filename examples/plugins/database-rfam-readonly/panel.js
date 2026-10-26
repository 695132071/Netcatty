/* global window, document */
"use strict";
const query = document.getElementById("query");
const cancel = document.getElementById("cancel");
const result = document.getElementById("result");
const command = (suffix) => window.netcattyView.executeCommand(`com.netcatty.database-rfam-readonly.${suffix}`);
window.netcattyView.onDidChangeEnvironment((environment) => {
  document.documentElement.style.colorScheme = environment.theme === "light" ? "light" : "dark";
  for (const name of ["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary", "--primary-foreground"]) {
    const value = environment.themeTokens?.[name];
    if (typeof value === "string" && value.length <= 96) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
});
void command("endpoint").then((value) => { document.getElementById("endpoint").textContent = value.endpoint; });
query.addEventListener("click", async () => {
  query.disabled = true;
  cancel.disabled = false;
  result.textContent = "Requesting the exact public endpoint…";
  try { result.textContent = JSON.stringify(await command("query"), null, 2); }
  catch { result.textContent = "Public sample failed. Authentication, TLS requirements, and service reachability may be unsupported. No fallback is attempted."; }
  finally { query.disabled = false; cancel.disabled = true; }
});
cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  try { await command("cancel"); result.textContent = "Public sample cancelled."; }
  catch { result.textContent = "Could not cancel the public sample."; }
});
