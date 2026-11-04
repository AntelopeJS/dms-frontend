export {};

/** @typedef {import("../server-module.ts").DmsServerMethod} ServerMethod */
/**
 * What `registerAuth` declared. The hooks are read as plain functions, as the
 * server calls them.
 *
 * @typedef {object} AuthDeclaration
 * @property {string} [signInPath]
 * @property {readonly string[]} [signInExempt]
 * @property {(event: import("../server-module.ts").DmsServerEvent, session: import("../server-module.ts").DmsSession) => Promise<import("../server-module.ts").DmsSession | undefined>} [refreshSession]
 * @property {(session: import("../server-module.ts").DmsSession) => import("../server-module.ts").DmsPublicSession} [publicSession]
 */
/** @typedef {import("../server-module.ts").DmsRouteRule} RouteRule */
/**
 * A module that has a `dms.server.ts`.
 *
 * @typedef {object} ServerModuleDeclaration
 * @property {string} id
 * @property {number} [priority]
 * @property {import("../server-module.ts").DmsServerSetup} setup
 */
/**
 * One `registerRoute` call.
 *
 * @typedef {object} RouteRegistration
 * @property {ServerMethod | readonly ServerMethod[]} method
 * @property {string} path
 * @property {import("../server-module.ts").DmsServerHandler} handler
 * @property {import("../server-module.ts").DmsServerRouteOptions} [options]
 */
/**
 * What a module's setup declared, by kind, in declaration order.
 *
 * @typedef {object} ModuleDeclared
 * @property {RouteRegistration[]} routes
 * @property {AuthDeclaration[]} auth
 * @property {Readonly<Record<string, RouteRule>>[]} rules
 * @property {{ pattern: string, options?: import("./backend-proxies.mjs").ProxyOptions }[]} proxies
 */
/** @typedef {ServerModuleDeclaration & { declared: ModuleDeclared }} DeclaredModule */
/**
 * A route a module serves, one per method.
 *
 * @typedef {object} ServerRoute
 * @property {string} path The normalized path
 * @property {string} pathIdentity The path with its parameters made anonymous
 * @property {string[]} params The parameter names, in path order
 * @property {RegExp} matcher
 * @property {string} id The serving module
 * @property {number} priority
 * @property {number} order The declaration's rank in its module
 * @property {string} method
 * @property {import("../server-module.ts").DmsServerHandler} handler
 * @property {boolean} sameOrigin
 * @property {number} bodyLimit
 * @property {boolean} overridesBackend
 */
/**
 * The auth hooks of the module that provides them.
 *
 * @typedef {object} AuthProvider
 * @property {string} id
 * @property {number} priority
 * @property {string} [signInPath]
 * @property {import("./path-patterns.mjs").CompiledPathPattern[]} [signInExempt]
 * @property {AuthDeclaration["refreshSession"]} refreshSession
 * @property {AuthDeclaration["publicSession"]} publicSession
 */
/**
 * What the modules declared, ready to serve.
 *
 * @typedef {object} ServerDeclarations
 * @property {ServerRoute[]} routes
 * @property {AuthProvider | undefined} auth
 * @property {import("./route-rules.mjs").ResolvedRouteRule[]} rules
 * @property {import("./backend-proxies.mjs").BackendProxy[]} proxies
 */
