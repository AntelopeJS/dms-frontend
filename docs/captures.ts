/**
 * The screenshots of the dms-frontend docs, taken on the Helio demo. The
 * onboarding scene stops on the administrator step, so it runs on a project
 * that no administrator has set up yet.
 */
export default [
  {
    id: "onboarding-administrator",
    route: "/onboarding",
    steps: [
      { action: "fill", selector: 'input[name="name"]', value: "Helio" },
      {
        action: "click",
        selector: 'button:has-text("Continue to administrator")',
      },
      { action: "wait", selector: 'input[name="firstName"]' },
    ],
    output: "docs/images/captures/onboarding-administrator.webp",
  },
];
