export const modules = [
  {
    id: "auth/exempt",
    priority: 50,
    setup(server) {
      server.registerAuth({ signInExempt: ["/open", "/one/*", "/deep/**"] });
    },
  },
];
