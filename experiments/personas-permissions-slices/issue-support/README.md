# Personas and permissions — issue support

Support for the seven implementation issues under [#323](https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/323).

## Open the mockup

Download `personas-permissions.zip`, extract it, and open `personas-permissions.html` in a current browser. The HTML includes all CSS, JavaScript, icons, and sample data. No installation, server, or network access is required.

Use the top navigation for Members, Intent, Workflow, and Platform admin. The controls above the app switch example users and scenarios. They are mockup controls, not product UI.

This is a UI reference, not production code. It simulates permissions locally; the real application must use backend permission results and its existing React components.

## One screenshot per issue

| Slice | Screenshot                                                                 | Try in the HTML                                                                                                                                                                   |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1    | [01-space-members.png](screenshots/01-space-members.png)                   | Open **Members**. Change Space access, add a member, or use the remove button.                                                                                                    |
| P2    | [02-local-roles.png](screenshots/02-local-roles.png)                       | Open **Members**, set **Company sign-in → Disabled**, and click Maya’s business roles.                                                                                            |
| P3    | [03-platform-mappings.png](screenshots/03-platform-mappings.png)           | Open **Platform admin** and click Developer’s IdP values. For exclusions, open **Members**, keep company sign-in enabled, and click Leo’s business roles.                         |
| P4    | [04-viewer-questions.png](screenshots/04-viewer-questions.png)             | Open **Intent** and select **Nora Patel · Viewer**. Try Questions, Stage review, and the discussion button.                                                                       |
| P5    | [05-stage-responsibilities.png](screenshots/05-stage-responsibilities.png) | Open **Members** and click **See who can decide and contribute**. The **Intent → Rules → Preview only · P5** control illustrates the preview phase.                               |
| P6    | [06-permissions-in-context.png](screenshots/06-permissions-in-context.png) | Open **Intent**. Compare Alice (Decision Maker), Maya (Contributor), Sam (discussion only), and Nora (Viewer). Try **Who can act?**, the fallback examples, and **Stage review**. |
| P7    | [07-workflow-roles.png](screenshots/07-workflow-roles.png)                 | Open **Workflow**, keep **Editable team copy**, and click Edit for a stage. Compare **System workflow**, which requires a copy before editing.                                    |

The issue text defines what each PR must deliver. Screens may show features from other slices for context. All data and identities shown are examples.
