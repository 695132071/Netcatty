const button = document.getElementById('greet');
const result = document.getElementById('result');
let chinese = false;
window.netcattyView.onDidChangeEnvironment((environment) => {
  chinese = environment.locale.startsWith('zh');
  document.documentElement.lang = chinese ? 'zh-CN' : 'en';
  document.documentElement.style.colorScheme = environment.theme === 'light' ? 'light' : 'dark';
  document.getElementById('title').textContent = chinese ? '你的第一个插件' : 'Your first plugin';
  document.getElementById('description').textContent = chinese ? '读取并显示你设置的问候语。不访问主机、终端或秘密。' : 'Read your Greeting preference and show it here. No hosts, terminals or secrets are accessed.';
  button.textContent = chinese ? '显示问候语' : 'Show greeting';
});
window.netcattyView.onDidReceiveMessage((message) => {
  if (typeof message?.greeting === 'string') result.textContent = message.greeting;
});
button.addEventListener('click', async () => {
  button.disabled = true;
  result.textContent = chinese ? '正在读取…' : 'Reading…';
  try {
    const response = await window.netcattyView.executeCommand('com.netcatty.starter.greet');
    result.textContent = response.greeting;
  } catch {
    result.textContent = chinese ? '未能读取问候语，请检查权限授权。' : 'Could not read the greeting. Check permission approval.';
  } finally {
    button.disabled = false;
  }
});
