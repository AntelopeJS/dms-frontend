export const modules = [
  {
    id: "bare/module",
    priority: 50,
    setup(server) {
      server.registerRoute("GET", "/api/_bare/ping", () => ({ ok: true }));
    },
  },
];
