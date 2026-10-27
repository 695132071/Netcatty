export default {
  activate(context) {
    const operations = { backends: 'listBackends', targets: 'selectTargets', chats: 'listChats', open: 'openChat',
      send: 'send', read: 'read', history: 'history', stop: 'stop', close: 'closeChat' };
    for (const [name, operation] of Object.entries(operations)) context.subscriptions.add(context.commands.registerCommand(
      `com.netcatty.globalagent.${name}`, (params = {}) => context.agent[operation](params),
    ));
  },
};
