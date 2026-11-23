/** A Vue component, as the workspace's `vue-shims.d.ts` types one for the lint. */
declare module "*.vue" {
  const component: import("vue").DefineComponent;
  export default component;
}
