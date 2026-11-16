# SQL Studio integration plan

## Scope

Implement the SQL in Foundry experience described by `software-documentation-reference/Data Integration/12 - SQL in Foundry.md` as a new first-class Platform App in the existing Next.js web app. The feature is a polished interactive mock of Foundry SQL Studio with useful local state, not a backend SQL execution engine.

## Implementation approach

- Add `/sql-studio` with a dark Foundry-style workbench: left resource browser, worksheet tabs, mode selector, SQL editor, run/format/save controls, and a results panel.
- Support both **Data mode** and **Object mode**, with contextual resource lists and query templates.
- Implement local interactions for selecting resources, editing SQL, running queries, changing result tabs (table/chart), saving worksheet state, toggling the AIP side panel, and filtering resources.
- Add SQL Studio to the Data integration category in `web/src/lib/platformApps.ts` so the Platform Apps launcher links to the new route.
- Reuse the existing `Icon`, colors, borders, typography, and interaction patterns; add only focused SQL Studio styles where utility classes become unwieldy.
- Copy the supplied SQL Studio reference screenshots into `web/public/sql-studio-reference` for maintainable local visual reference without changing the source documentation.

## Project structure

- `web/src/app/sql-studio/page.tsx`: route and workbench state.
- `web/src/components/sql-studio/`: SQL Studio-specific editor, resource browser, and results components kept separate from the existing data apps.
- `web/src/lib/platformApps.ts`: Platform Apps registry entry and route.
- `web/public/sql-studio-reference/`: supplied reference assets.

## Design direction

- **Design movement:** enterprise data-workbench minimalism with a restrained dark IDE aesthetic.
- **Core principles:** information-dense but calm; mode/context is always visible; actions are close to the object they affect; results feel inspectable and reversible.
- **Color philosophy:** deep ink/panel surfaces reduce glare for long query sessions; ocean blue signals executable actions and active context; sand marks saved or trusted worksheet state; green is reserved for healthy execution.
- **Layout paradigm:** a three-zone workbench rather than a centered dashboard: narrow resource rail, dominant editor/results canvas, optional conversational assistant rail.
- **Signature elements:** mode pill, worksheet tabs, monospaced SQL surface, and compact result status bar.
- **Interaction philosophy:** selection updates context without losing work; run state is explicit; unsupported or future actions are represented honestly as disabled/coming-soon states.
- **Animation:** use subtle transitions only; respect reduced motion and avoid decorative motion in the editor.
- **Typography system:** Geist for UI; Geist Mono for SQL and identifiers; clear 11px metadata, 13px controls, 15–18px titles.
- **Brand essence:** a practical SQL workbench for Foundry-style data and ontology exploration; precise, inspectable, connected. Voice is direct and operational, e.g. “Run query” and “Select a resource to inspect its schema.”
- **Wordmark & logo:** preserve the existing BluesandAI mark and shell; SQL Studio is branded through a database icon and mode accent rather than a new logo.
- **Signature brand color:** ocean blue (`#3d8bfd`) for executable focus.
