const CACHE = { public: true, maxAge: 300, staleWhileRevalidate: 3600 };

export const modules = [
  {
    id: "rules/mod",
    priority: 3,
    setup(server) {
      server.registerRouteRules({
        "/terms": { ssr: false, cache: CACHE },
        "/no-swr": { ssr: false, cache: { public: true, maxAge: 60 } },
        "/zero": { ssr: false, cache: { public: true, maxAge: 0 } },
        "/area/**": { ssr: false, cache: CACHE },
        "/area/private": { cache: false },
        "/reports/**": { ssr: false, headers: { "x-robots-tag": "noindex", "X-Mixed-Case": "kept" } },
        "/m/**": { ssr: false, headers: { "x-a": "1", "x-b": "1" } },
        "/m/*": { headers: { "x-b": "2", "x-c": "2" } },
        "/m/x": { headers: { "x-c": "3" } },
        "/dup": { ssr: false, headers: { "x-owner": "mod" } },
        "/bad-public": { cache: { public: false, maxAge: 1 } },
        "/bad-age": { cache: { public: true, maxAge: -1 } },
        "/bad-fraction": { cache: { public: true, maxAge: 1.5 } },
        "/bad-swr": { cache: { public: true, maxAge: 1, staleWhileRevalidate: "x" } },
        "/bad-ssr": { ssr: true },
        "/bad-cache-control": { headers: { "Cache-Control": "x" } },
        "/bad-set-cookie": { headers: { "set-cookie": "a=b" } },
        "/bad-vary": { headers: { vary: "x" } },
        "/bad-type": { headers: { "content-type": "x" } },
        "/bad-length": { headers: { "content-length": "1" } },
        "/bad-inertia": { headers: { "x-inertia": "1" } },
        "/bad-version": { headers: { "x-inertia-version": "1" } },
        "/bad-name": { headers: { "bad name": "1" } },
        "/bad-value": { headers: { "x-a": "a\r\nb" } },
        "/bad-text": { headers: { "x-a": 1 } },
        "/bad-object": "rule",
      });
    },
  },
  {
    id: "rules/low",
    priority: 1,
    setup(server) {
      server.registerRouteRules({ "/dup": { headers: { "x-owner": "low" } }, "/only-low": { ssr: false, headers: { "x-owner": "low" } } });
    },
  },
];
