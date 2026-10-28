/* global window, document */
"use strict";
const username = document.getElementById("username");
const password = document.getElementById("password");
const query = document.getElementById("query");
const cancel = document.getElementById("cancel");
const result = document.getElementById("result");
const command = (suffix, args) => window.netcattyView.executeCommand(`com.netcatty.database-minimal.${suffix}`, args);
window.netcattyView.onDidChangeEnvironment((environment) => {
  document.documentElement.style.colorScheme = environment.theme === "light" ? "light" : "dark";
  for (const name of ["--background", "--foreground", "--muted", "--muted-foreground", "--border", "--primary", "--primary-foreground"]) {
    const value = environment.themeTokens?.[name];
    if (typeof value === "string" && value.length <= 96) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
});
void command("endpoint").then((value) => { document.getElementById("endpoint").textContent = value.endpoint; });
document.getElementById("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  query.disabled = true;
  cancel.disabled = false;
  result.textContent = "Connecting to the disposable fixture…";
  const credentials = { username: username.value, password: password.value };
  password.value = "";
  try {
    const response = await command("query", credentials);
    result.textContent = JSON.stringify(response, null, 2);
  } catch { result.textContent = "Connection or read failed. Check the fixture, exact endpoint grant, and session credentials."; }
  finally { credentials.password = ""; query.disabled = false; cancel.disabled = true; }
});
cancel.addEventListener("click", async () => {
  cancel.disabled = true;
  try { await command("cancel"); result.textContent = "Example connection cancelled."; }
  catch { result.textContent = "Could not cancel the example connection."; }
});
