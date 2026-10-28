/**
 * The backend prefixes the DMS declares in its `dms.server.ts`, declared
 * through `DMS_BACKEND_PROXIES` for the tests that run the frontend server
 * without the DMS: the renderer proxies no path on its own.
 */
export const DMS_BACKEND_PROXIES = JSON.stringify([
  { path: "/api/**" },
  { path: "/dms/**" },
]);

process.env.DMS_BACKEND_PROXIES = DMS_BACKEND_PROXIES;
