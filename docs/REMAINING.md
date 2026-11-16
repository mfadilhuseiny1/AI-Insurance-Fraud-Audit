# Remaining work (as of commit after e2b0f3d)

Everything below is NOT done yet. Branch: `claude/gifted-sagan-maxkbo`.

## 1. External pipelines (doc 08 "External pipelines with Pipeline Builder")
Done: outputs compile to SQL (`web/src/lib/externalSql.ts`) and run in Databricks / Snowflake
(`POST /api/pipeline/external/run`). Verified: the compiled SQL against DuckDB gives the same rows as the JS engine
for every supported step (16 cases), and the Databricks / Snowflake statements parse (sqlglot). Not verified:
a run against real Databricks and Snowflake accounts (none available here). Still missing:
- done since: string, arithmetic, conditional, unpivot, window, explode and hash steps compile (23 DuckDB cases match
  the JS engine; the Databricks / Snowflake statements parse), and expectations are checked in the warehouse. Still
  not pushed down: pivot (needs the data's values), date / time steps (format letters differ per warehouse), arrays,
  structs, geospatial; done since, 2026-10-12 (b52804b): date / time steps (date part, truncate, add, difference,
  current date / time, make date, Unix time, time zone conversion, next weekday, tumbling time windows, casts with
  formats) and pivot compile for Databricks, Snowflake and DuckDB — Java format letters are translated per dialect
  (Snowflake pieces it has no code for are built from expressions); pivot is two-phase: the runner reads the pivot
  column's distinct values in the warehouse first (at most 200), then each becomes a conditional aggregate. Tested:
  21 DuckDB cases give the JS engine's rows, 54 Databricks / Snowflake statements parse (sqlglot), 12 refusals, the
  16 earlier cases still pass. Not tested against real warehouses (Snowflake expression pieces, MONTHS_BETWEEN,
  TIMESTAMPADD, NEXT_DAY, the runner's values round trip). Differences: pivot columns come out sorted, text read as
  dates must be ISO 8601, two-digit years differ, Databricks assumes a UTC session. Still refused: sliding windows,
  offset letters with a time zone, letters k K z V O Q, Mode / First / Last / percentiles in a pivot, floating /
  timestamp pivot columns;
- Databricks Connect serverless sessions (the source's SQL warehouse runs the statement); a classic cluster is
  reached through its Thrift path (`org_id` in the connection config, else 0);
- BigQuery stays "Not available" (doc).

## 2. Not yet verified end to end (built, but only unit-tested)
- Regular snapshots (Build settings → Advanced → Regular snapshots; runner `snapshotReason`):
  never run in a real build.
  Done since (2026-10-14): run in real incremental builds (the app's pipeline-runner route and runner.ts, unchanged,
  behind a second API on the real data): every N incremental builds, after N APPEND transactions and every N days
  each trigger a SNAPSHOT build with the reason on the build record, read all rows and reset the counters; builds in
  between append only new rows; output equal to a full recompute every time; the setting saved and read back into
  the Build settings dialog. 114 checks (twice). No defect found. Not done: the dialog not clicked; the day trigger
  tested by moving the stored time; behaviour notes in runner.ts: the Nth-build snapshot happens on build N+1, an
  empty incremental build counts, the switch on with no limits never snapshots and does not warn.
- Sign-in + markings with the FULL API (tests used a small test app): check Files, Pipeline
  Builder, Lineage, builds (runner uses the service token passed in `/api/pipeline-runner`),
  shared links, and that pages still load after sign-in.
  Done since (2026-10-14, SEC): run against a full API with sign-in on (own auth store, the real build runner) as
  "(test)" users with different markings / Project roles — 267 checks; and read-only on the real data as the JKN
  demo accounts (lineage graphs equal to the "View as" colours, hidden datasets / pipelines refused or not named on
  every route) — 47; pages after sign-in — 107. Leaks found and fixed: a marked item inside a shared folder was
  listed, downloaded and zipped through the link (api/drive.py: left out of links); `POST /api/pipeline/datasets/
  deploy` overwrote a marked dataset and recorded deploys reading inputs the user cannot read; pipeline output file /
  definition writes to marked targets; virtual (database) writes needed only Viewer on the connection (now Editor);
  input versions and pipeline summaries named hidden datasets / pipelines; schedules could be added / turned on /
  run now without the inputs' markings, and their runs / history were readable without a role; the lineage timeline
  and health rules showed hidden pipelines' builds; saved lineage graphs named hidden nodes and could be overwritten
  / deleted by anyone (now owned; graphs saved earlier have no owner). Lineage build plans only plan what the caller
  sees; builds check the starter can build every step; build records only with their pipeline; only the runner updates
  build records. Tokens checked: a transform build's token acts as its user, Node-RED tokens reach only their
  workspace, expired / revoked tokens 401, the service token in no user response. Earlier suites green (governance
  51, batch3 39, batch4 41 — was 40 / 1, batch6 58, security 32, sign-in off 6). Not done: the old
  `/api/pipeline/streams` routes have no owner / marking model (any signed-in user can read, push to or delete a
  stream and its push token — a design change); a Project-scoped schedule firing on its own does not re-check input
  markings (only its creator / enabler / "Run now" are checked); no browser clicks.
- Code Repositories debugger UI: backend tested, UI never opened in a browser. Done since, 2026-10-12: run in
  headless Chrome for the first time (the real CodeEditor / DebugPanel / useDebugger bundled, the real debug API on a
  second uvicorn, repository "debugger-ui test"; 67 checks: gutter, conditional and refused breakpoints, run to a
  breakpoint, step into another file / over / out with buttons and F8 / F10, variables expanded as a table, frames,
  console in the selected frame, continue, restart, stop, pause of an endless loop, a breakpoint added while running,
  an exception, console mode; 16 API checks). Fixed: console assignments undone on Python 3.12 (frame locals now read
  once per pause, like pdb), variables not refreshed after a console command, the call stack left clickable after
  Stop (409), "stop at the first line" skipped when another file had breakpoints, backslashes in traceback paths.
  Added: watch expressions (per repository, evaluated in the selected frame at each pause and after console commands,
  statements refused, 3 s limit; `PUT /api/code-repos/{repo}/debug/sessions/{sid}/watches`). Not done: the real
  Next.js page's toolbar not clicked (a stand-in page reproduces its wiring); a watch stuck in one long C call ends
  only by Stop or the 300 s timeout; `@transform.using` and Spark transforms not debugged in the browser. Done since
  (2026-10-13, c578379): all three — watches run off the paused thread with a 3 s limit (copyable values in a helper
  process killed and restarted past the limit, others on an interruptible helper thread; Pause interrupts), watch /
  frame requests wait per watch, out-of-order replies ignored, `@transform.using` / Spark results shown per output;
  the real Code Repositories page clicked in headless Chrome (45 checks: toolbar, F8 / F10 / F11 / Shift+F11,
  breakpoints, call stack, console, watches, a stuck C-call watch, Pause, Stop, `@transform.using`, Spark stepping)
  plus 20 worker, 16 API and 67 stand-in checks. Still not done: a watch on a non-copyable value stuck in a call that
  holds the GIL ends only by Stop or the session timeout. Found: a Spark transform cannot read a dataset with an
  unsigned integer column (`code_pyapi.spark_frame`: "uint8 is not supported in conversion to Arrow").
- Data Connection sync checks (sync status / freshness) against the real PostgreSQL tables. Done since (2026-10-13,
  4ddf101): checks set on a sync or export (status, freshness, new `sync_row_count` min / max; table `dc_sync_checks`,
  `/api/health/syncs/...`), evaluated after each source run, in the background loop and when the panel opens; one
  in-app notification when a check starts failing and one on recovery (claimed in the database, so concurrent
  evaluators send one; subscribers must still see the connection); a Health checks panel and list badges. Tested: 44
  checks against the "(test)" schema `bsai_test_sync` plus 58 + 18 + 3 earlier ones. Not done: the panel not clicked in
  a browser; export checks wait for the background loop (no hook in exports.py); Data Health's monitoring-view page
  has no field for `sync_row_count` yet.
  Done since (2026-10-13, DCS2): an export runs its checks before writing — an enabled row count check (this run's
  rows or the target's total afterwards) that would fail stops the run with its reason and nothing truncated or
  written; status / freshness checks and runs with nothing to write never stop it; the export's own checks are
  evaluated as each run ends. Data Health monitoring views take `sync_row_count` monitors (rows counted: run / total,
  minimum, optional maximum); a monitor added from a `?add=` link is named by the API. Tested: 30 new checks (stopped
  run, untouched target, plural reasons, monitors created / evaluated / edited), the 44 + 58 + 18 + 3 earlier ones,
  and the SyncChecks panel and the monitoring dialog clicked in headless Chrome (29). Not done: syncs into the
  platform are not stopped by a failing check (evaluated after the run); `/api/health/resources` took 5+ minutes on
  the real data (lineage graph rebuild), not investigated.
  Done since (2026-10-14, DCS3): a sync into the platform runs its row count checks before the dataset transaction
  commits — a snapshot, incremental or upsert run that would fail one (this run's rows, or the dataset's total
  afterwards) fails with the reason, its file is removed and the previous version, row total and cursor / delta
  link stay as they were, so the next run reads the same rows again; a run bringing no rows (also an upsert run
  that only compacts) is never stopped. `/api/health/resources` answers from the last graph build's listing kept
  on disk (rebuilt in the background) and from each pipeline's schedules cached by the file's time and size: a
  fresh process about 1,000 s -> 0.2-1.7 s, warm 0.01-0.02 s, output byte-equal to the earlier code. A pipeline
  file that changed is read again before answering, but one whose schedules are already known is waited for 1.5 s
  at most (an 11 MB pipeline took 14-28 s to read): the listing then shows its previous schedules until the read
  ends (`SCHED_WAIT_S` in health_checks.py; None waits always). Tested: 26 + 20 gate checks (snapshot / incremental
  against real PostgreSQL, upsert against a mock ODP service), 33 on the listing (equivalence, no stale entries
  after schedules / pipelines / syncs / checks change, restart), the 58 + 18 + 3 + 47 + 30 earlier ones. Not done:
  the first start with no cache files still builds the graph and reads every pipeline (minutes); a second save of
  a pipeline in the same second with the same size is not seen; the new help line in the SyncChecks form was not
  clicked; equivalence checked with sign-in off.
- Table exports into applications (Salesforce, HubSpot, Airtable, ActiveCampaign, Act! CRM, Adobe Commerce) and the
  new Salesforce / HubSpot connectors: tested against mock APIs built from the vendors' docs and end to end on the
  real database, not against live accounts (none available here).
- Digest emails (only the webhook path was tested).

## 3. Known gaps / follow-ups
- Markings and Project roles: code repositories are not in Projects, so they have markings but no Project roles. Data
  source connections carry markings (done since: a Markings box on each connection; users without them do not see
  it and cannot browse, preview, add sources on or export to it; tested with sign-in simulated; the sources already
  synced from it are Files datasets with their own markings) (media sets are folders: folder markings apply). Background work (schedules,
  automations) runs as the system and is not limited by markings. Done since (2026-10-14, BGM, api/run_as.py):
  scheduled pipeline builds, Automate (effects and conditions), scheduled Contour / Code Repository / Logic flow /
  SQL definition rebuilds, Foundry Rules runs, time series alerting and Workflow Builder object triggers run as the
  user who set them up — their markings, groups and Project roles — and fail with the reason, writing nothing, when
  that user is missing, deleted, deactivated or lost a marking / Editor role (never falling back to the system;
  administrators do not bypass markings); a Project-scoped schedule re-checks the markings of its pipeline, inputs
  and output folders against its owner each time it fires (the SEC finding), retries too; Foundry Rules fails the
  whole run when one rule cannot read its input; failures are recorded on the job. With sign-in on, jobs saved with
  no owner (e.g. while sign-in was off) stop until an Editor saves them again. Tested: 76 checks with sign-in on
  (each kind: owner with access, lost marking / role, deactivated, deleted, no owner, admin-created), 9 with sign-in
  off (as before), the SEC harness (267). Not done: a started Project-scoped build still reads its inputs with the
  service token (markings checked when the schedule fires, not again during the build); scheduled Data Connection
  syncs / exports still run as the system; Foundry Rules outputs do not carry their inputs' markings; object
  monitors, health checks, modeling objectives, Iceberg maintenance, autopilot and approvals not reviewed;
  server.py starts the Logic flow / SQL-write schedulers on import (any process importing it can run them).
  Done since (2026-10-15, RAR): the jobs left unreviewed — object monitors, Iceberg maintenance tasks and Autopilot
  alerts already ran as their owner / per subscriber (ba1387a), batch deployments and the inference-history flush
  too (55f5e47, d861617); Data Health checks and the orphan-file sweep stay platform jobs (metadata only, read
  filtered per viewer, notices only to subscribers who still see the sync). Fixed: an approved change applies only
  while its approvals still count — each reviewer still active and eligible, the requester still active (a request
  saved while sign-in was off is not applied with it on); otherwise nothing is applied, the request / task goes back
  with the reason, the history and a "Not applied" notice say so, a later approval retries; a model evaluation
  scheduled on new versions records its outcome (`last_run`: version, status, reason, build) and builds nothing when
  its owner lost access. Tested: 23 checks with sign-in on, 7 off, BGM 76 + 9, BGM2 59, SEC 267. Not done: Ontology
  proposals (ontology_branches.py) not reviewed; the approvals page and `last_run` not shown / clicked.
- Fixed (2026-10-14, STR-SEC): the old `/api/pipeline/streams` routes had no access model (any signed-in user could
  list, read, push to or delete a stream and see its push token). A stream now has a home — the Files folder it was
  created in, or the pipeline that writes it — whose markings and Project roles apply (Viewer lists and reads,
  Editor pushes, sees the token and deletes; creating needs Editor on the folder); a stream without a home belongs to
  its creator and administrators (2 of the 3 existing streams, which had no creator, are now visible to
  administrators only); a stream can carry its own markings (`pipeline_stream:<id>`); no read access is a 404, the
  token is returned only to those who may push and never in lists; machine clients push with the token alone on
  `POST /api/pipeline/stream-push/{id}` (public path; a caller without the token gets 401 whether or not the stream
  exists). Tested: 268 checks with sign-in on (7 users × 6 streams × every route, token exposure, token pushes, a
  marking added / removed live), 13 with it off (incl. listeners' direct calls), the SEC harness (267). Not done:
  pipeline inputs that read an old stream are not checked against this model (pipeline_datasets `_ref_items`,
  lineage, schedules); listeners have no access model of their own (any signed-in user can see a listener's events
  and delete it with its stream); the stream pages were type-checked, not clicked.
- Single sign-on was tested against a mock OIDC provider and self-signed SAML responses, not yet against real
  Google / Microsoft / Okta tenants. SAML requests are not signed (most IdPs accept that) and there is no single
  logout (SLO). Done since (2026-10-14, SSO): AuthnRequests signed with RSA-SHA256 (Redirect: over
  SAMLRequest&RelayState&SigAlg; POST with `BLUESANDAI_SSO_SAML_IDP_BINDING=post`: an enveloped signature), the SP
  key / certificate uploaded or generated once and kept encrypted in the sign-in store (one pair for every API
  process), SP metadata with the signing certificate, AuthnRequestsSigned / WantAssertionsSigned and SLO endpoints;
  single logout — Sign out (POST /api/auth/sso/logout) ends the session here first, then sends the browser to the
  IdP with a signed LogoutRequest or to an OIDC provider's end_session_endpoint with id_token_hint; IdP-initiated
  LogoutRequests (GET / POST /api/auth/sso/saml/slo) end the sessions of that NameID / SessionIndex and are answered
  with a signed LogoutResponse; unsigned, wrongly signed, SHA-1, wrong issuer / destination, expired, future-dated
  and replayed messages refused and audited. Cipher's licence rate limit now goes through rate_limits.take (shared
  by API processes). Tested: 76 checks with a mock SAML IdP verifying our signatures with its own code and a mock
  OIDC provider (an old cookie gets 401 after logout), 10 on the Cipher limit across two processes, the earlier SSO
  checks (41), the SEC harness (267). Not done: real IdPs not tried; only the SQLite sign-in store tested; OIDC
  back- / front-channel logout not built; encrypted NameIDs in logout requests refused.
- Rate limits and failed-attempt counters are kept in memory (per API process). Done since (2026-10-14, RLS,
  api/rate_limits.py): sign-in failures (per user, IP, two-factor code, password reset, invitation), the listener
  limit (100 / s) and webhook execution rate limits are kept in PostgreSQL — failures as rows counted over the
  sliding window, limits as one counter row per key and window raised by a single statement that never passes the
  limit — so they hold across API processes and restarts; each process keeps its own window of allowed uses as a fast
  path (a full window refuses with no database call), expired rows are deleted on a background thread at most once a
  minute; with the database unreachable, failures are counted in the process's memory (as before; sign-in stays
  available) and added to the database count once it is back. Tested: 29 unit checks (500 concurrent takes at limit
  300 give exactly 300, database down / back), two API processes with sign-in on (a lockout holds on both and over
  restarts, the window expires, 400 wrong sign-ins from 16 threads all counted, 500 takes at limit 250 give 250), the
  listener / webhook callers, the SEC harness (267). Hot path: an attempt check 0.10 ms p50, an allowed limit 0.14 ms.
  Not done: Cipher's licence rate limit (api/cipher.py, security-owned) is still per process — fix: `rate_limits.take`
  in `_rate_limit`; fixed one-second / one-minute windows let all processes together allow up to twice the limit
  across a boundary; simultaneous wrong passwords can all pass the check before one is counted (as before).
- Fixed: a schedule turned on or off from Build Schedules is no longer undone by a pipeline editor's stale autosave
  (toggles are stamped; an older copy keeps the stored state). The open editor still shows its old switch until it
  reloads. Tested on the save hook, not with two browser windows.
- Compute usage is an estimate (1 vCPU per job/task manager).
- Keyed process UDFs and the time series / geotemporal output monitors were tested with the Python API and Java
  harness, not yet in a running app.
  Done since (2026-10-14, e36d227): run in an app — a second API on the real data with the real build runner
  (runner.ts) behind it, everything through HTTP as the UI does (repository tasks / commit / checks / tag, pipeline,
  deploy, records through the stream proxy, monitoring view and monitors). A keyed process UDF (SensorWindow from the
  template) with per-key state and event-time timers feeds a time series and a geotemporal output: windows emitted
  only after the watermark, in the stream, the Time Series DB and the archive; state restored from the checkpoint
  after a redeploy. Output monitors ("points written", "geotemporal observations sent") fire and resolve as data
  arrives; wrong monitor types refused. Fixed: a processing-time timer never fired while the input was idle (the job
  now runs once over an empty batch when a checkpointed timer is due). 30 + 7 checks. Not done: the Next.js runner
  route and the Data Health page not clicked (the real runner.ts ran in a stand-in server); the monitors' 5-minute
  window counts whole minutes (up to ~6 minutes of writes); the kept "(test)" monitors keep firing in their own
  views in the live API.
- Table exports into Act-On (list contacts, upsert by e-mail), ADP (one event per row: business / personal e-mail,
  mobile and landline changes) and Acumatica (contract-based REST, configured entities): done, tested against a mock
  server only. Other ADP events are not mapped.
- Resource queues: done (Resource Management → Resource queues). Streaming jobs and syncs do not take leases.
  Done since (2026-10-14, RQL): streaming jobs, streaming syncs, Data Connection syncs and exports take leases in their
  Project's queue like builds, so queue limits hold for all work: a run waits (first come, first served; it says
  where it waits and how many are ahead — a sync shows "queued", the queue page names each job's kind) and releases
  its lease when it ends, fails, is stopped, cancelled or replaced. Leases are kept in PostgreSQL (every API process
  sees one queue; memory without it), renewed by a heartbeat — a streaming job's progress reports renew its own — a
  dead holder process on the same machine is cleared at once, others expire after their time limit (60 s in the API,
  300 s for streaming jobs). Tested: 57 checks on a "RQL limit 1 (test)" queue with real PostgreSQL (builds as before,
  a sync / export competing with a build in both orders, leases released on success / failure / stop / cancel, a
  long streaming sync keeping its lease past its time limit, a killed holder's lease dropped), 7 without PostgreSQL,
  the SEC harness (267). Not done: a real streaming deploy through the web runner (stand-in build records); holders
  on other machines (they expire); runs queued over an API restart; a real MQTT broker.

- Done 2026-10-14 (5a301c4): code repositories are in Projects and Project roles decide access — Viewer reads /
  clones / fetches, Editor commits / builds / pushes / publishes functions (main and global branches) / recalls
  versions / runs live previews, Owner changes settings / moves / deletes; markings still apply on top. Repositories
  without a Project are moved once, in the background, into "Code repositories (migrated)" (Everyone → Editor, so no
  one loses access; it cannot be renamed or trashed). Also closed: git push open to Viewers, function publishing open
  to Viewers, branch publish / releases / rebase without checks, scan reports and UDF runs without checks. Tested: 216
  checks with sign-in on (Owner / Editor / Viewer / outsider / Editor missing a marking / admin), the SEC harness 267,
  the TS function, debugger and global-branch suites. Not done: on migrated repositories only administrators can change
  settings or delete until someone gets Owner on the migrated Project (383 of 385 have no recorded creator); artifact
  settings and external systems stay at Editor; model_assets / sddi / logic_flows / linter / workflow_lineage routes to
  repositories not audited; the UI not clicked; the migration runs at the next start of the real API.
  Done since (2026-10-15, RPO): repositories have their own owners next to the Project's roles; settings, artifact
  settings and external systems need Owner (Owner on the Project or one of the repository's owners — the docs give
  settings to repository owners), with a 403 naming the role and the owners, and the pages show them read-only to
  others. An owner migration (`api/migrate_repo_owners.py`, or an administrator's
  `POST /api/code-repos/tools/owners-migration?dry_run=`) adds owners from the creator, the first committer in the
  audit log or the output folder's creator — never at startup, dry run by default, adding only, logged and audited.
  Its dry run on the real data: 395 repositories, none resolvable (no creator, no commit authors, no folder
  creators), so all stay administrator-managed until someone is given an owner role (nothing written). Tested: 176
  checks over HTTP with sign-in on (6 roles × settings / artifacts / external systems, the migration on test data:
  dry run equals the applied run, adds only, idempotent), CRP 216, RRA 191, BGM code repositories 6, SEC 267, 35
  clicks in headless Chrome. Not done: a Viewer is refused by the sign-in middleware's Editor message before the
  Owner check; `auth.py` says "a Editor".
- Done 2026-10-14 (06edea5): Data Connection syncs and exports record an owner (whoever saved them; saving requires
  being able to run them) and scheduled runs act as that owner ("Run now" as the clicking user), checked before any
  queue lease, connection or write — connection markings, target folder / dataset markings and Editor role for syncs,
  source dataset markings and read role for exports — failing with "did not run: ..." and writing nothing; streaming
  syncs run as their owner and re-check the owner's markings every 30 s and on resume (stopped with the reason when
  lost); Foundry Rules outputs (datasets and object types) carry the union of their inputs' markings. Tested: 59 + 16
  checks, the SEC harness 267, BGM 76, and the Data Connection / SAP / RQL suites. Not done: Hyperauto and SDDI start
  syncs from their own threads as the system (they should carry the requesting user); streaming syncs have no Project
  (markings only); a new Foundry Rules output exists briefly before its markings are applied.

- Done 2026-10-14 (aee0972): listeners have an access model like the old pipeline streams (2285f09): a home Files
  folder / Project decides (its markings and roles), else the creator and administrators, else administrators only;
  markings on the listener's stream apply too. Viewers list / open / read events (endpoint URLs and the basic-auth user
  hidden), Editors also see endpoint URLs and edit / start / stop / rotate / set expiry / move / delete; no access →
  404; tokens never in listings, secrets never returned; the stream moves and is deleted with the listener under its
  own check; `PUT /api/listeners/{id}/home`; existing listeners copy their stream's home and creator (the one existing
  listener, "RLS listener (test)", is administrators-only until moved). Inbound pushes unchanged (endpoint token +
  secret). Tested: 497 checks with sign-in on (7 users x 6 listeners, every route, marking added / removed, migration,
  move), 14 with sign-in off, the SEC harness 267. Not done: listeners have no marking of their own (their stream's
  apply); a listener cannot be moved back to "no folder"; the page not clicked; `t_streams_on.py`'s check that the
  token-only push path is not public predates 2285f09 (which made it public) and needs updating.

- Done 2026-10-14 (ba1387a): the remaining background workers run as their owner through api/run_as.py —
  object monitors (evaluations as the owner; blocked with the reason on `state.blocked` when the owner is gone or lost
  an input type, members kept; subscribers without access skipped, not failing the rest; objects that only left the
  owner's view never reported as removed; monitors / activity hidden from callers who cannot see the input; saving
  without `expires_at` no longer crashes), modeling objective evaluation builds (as the user who started them,
  re-checked: dataset read access and output folder Editor before the model runs), Iceberg maintenance tasks (the
  task's owner, re-checked each run: markings, Editor, Owner on protected tables; manual runs carry the caller),
  Autopilot (alerts never name automations a subscriber cannot see; skipped subscribers reported). Health checks and
  approvals needed no change. Tested: 51 checks with sign-in on, the SEC harness 267, Autopilot 55, Iceberg MERGE /
  maintenance suites. Not done (outside these files): model_deployments `_run_batch` and model_assets' "on new
  version" evaluations run as the system; streaming monitoring views run health monitors as the system; approvals do
  not re-check that requester / approvers are still active at invoke; Automate skips an `objects_removed` run for a
  deleted object (t_migrate.py's "deleting an object runs it once more" fails — api/automate.py).
  Done since (2026-10-15, AUTO): the run itself came back in 55f5e47; the deleted object now also reaches the
  effects — with its last known values as the owner sees them (property policies applied), marked `"deleted": true`,
  the run recording `deleted: [keys]`, its notice linking to the automation (a template naming the object's
  properties failed before); an object the owner could not see is counted as hidden, never named or used. Action /
  Logic / function effects now also receive deleted objects. Foundry Rules outputs were already marked first (c2799c8,
  re-verified 25 / 25). Tested: 18 checks with sign-in on (9 / 18 on the old code), t_migrate 72, BGM 76, BGM2 59, the
  Foundry Rules suites, SEC 267. Not done: visibility is judged when the run executes, not at the deletion instant;
  digest mode with deletions, an action effect on a deleted object and the UI not tested.
- Done 2026-10-14 (FRM): Foundry Rules outputs and object type materializations (api/ontology_edits.py `build()`)
  are created already marked — a new output's markings are set under a fresh id before its file is stored under that
  id (the run fails and the file is deleted if the id was taken meanwhile); an existing output gains the inputs'
  current markings before its rows are replaced and is narrowed after. Tested: 40 rule runs / 40 materializations
  (30 creates each) while an in-run probe, an HTTP poller without the marking and a separate process (~283,000 polls)
  read — never an unmarked output or a row; markings right at first sight (the old code fails 4 / 2 of these checks);
  the Foundry Rules suites, t_bgm 76, t_bgm2 59, sec/run_sec.py 267. Still create-then-mark (found, not changed —
  mark before writing as `foundry_rules._create_marked_dataset` does): pipeline deploy (pipeline_datasets.py ~343),
  code repository transform outputs (code_repos.py ~2445, ~2644), sql_writes.py Parquet (~548) and Iceberg (~507-521,
  593, 645, 665) writes, iceberg_catalog.commit (~828), time series sync records (timeseries.py 252, 692 — settings
  only), streaming stream records (streaming.py 307). Worse, read from the code (not tested): SQL writes never record
  the inputs' markings on the Iceberg table's snapshots, so the next markings refresh (after a later commit or
  maintenance) drops the markings `_propagate` set — pass `snapshot_extra={"foundry.markings": …}` in `_table`, as
  `pipeline_datasets._deploy_iceberg` does. No input markings at all: Contour "save as dataset" (contour.py 454), Code
  Workbook `dataset_out` (code_workbook.py 588), preparation outputs (only the folder's markings apply).
- Done 2026-10-14 (RGR): model batch deployment runs act as their owner ("Build now" as the clicker; triggered runs
  as `owner`, else `created_by`) — active user, viewer on objective and model, read on the input (markings / Project
  role), editor on output folder and dataset — else the run fails "did not run: <reason>", health failed, nothing read
  or written; enabling / saving triggers makes the saver the owner only if they could run it (403); batch deployments
  now need a role on their objective to be seen / changed (404 otherwise). Monitoring-view monitors run as their owner
  (else the view's creator): access lost → `blocked` with the reason, nothing measured, no alert opened / resolved, no
  notice; saving a monitor on a resource the user cannot see is refused. Automate `objects_removed`: a deleted object
  is judged by its last state as the owner (c594d55 counted it as hidden and skipped the run; t_migrate.py 72 green
  again). Tested: 22 checks on a full API with sign-in on, sec/run_sec.py 267, container deploy / stream / DCS
  monitoring suites. Behaviour change once the API on 8000 restarts: batch deployments created by "system"
  (`dep-92a79b34ce1c` "Skor bulanan faskes (demo)", `dep-ead00caf763a`, `dep-f185cd9e284c`) fail their triggered runs
  "has no owner it can run as" until an Editor enables one or saves its triggers; monitors without an owner show as
  blocked until saved. Not done: live deployments have no role check of their own; live inference-history flush
  writes as the system; stream / sync monitors covered by code, only dataset monitors proven with sign-in on.
  Done since (2026-10-15, LMD): every model deployment route checks access — a direct deployment follows its model's
  Files item (markings, Project role), an objective live / batch deployment its Modeling Objective role plus the
  objective Project's markings (a live one also the served release's model); hidden ones are 404. Viewer sees,
  queries (/v2, single I/O, its function); Editor configures, scales, starts / stops, publishes, builds, sets
  triggers, syncs the history; Owner deletes and creates / switches / removes the inference history (the docs'
  edit-inference-ledger permission); creating an objective deployment needs Editor with those markings; GET returns
  `my_role` and the panel shows only what the role allows. The inference-history flush writes as the history's owner
  and writes nothing when the owner lost the dataset's marking / Editor or was deactivated (reason on the history,
  Sync answers 409; requests kept until access is back). Tested: 271 checks with sign-in on (5 users × direct /
  objective-live / batch deployments × every route; denied calls never reach the model), the SEC harness (267),
  earlier replica / model-function suites. Not done: Docker container deployment suites not re-run; the panel not
  clicked; model workers simulated in the sign-in-on suite.
- Done 2026-10-14 (HSD): HyperAuto and SDDI start their syncs as the requesting user — create / proposal / retry /
  "Create syncs and integrate" / build checked before anything is written (403 with the reason: a missing marking on
  the connection, folder or dataset, no Editor on the target folder / pipeline / where new syncs go; SDDI builds also
  need Editor on the generator repository, read on the raw / metadata folders, Editor on the output folder and
  permission to run code); the background thread runs as that user, refuses to run as the system with sign-in on
  ("did not run: <reason>", also when access is lost between request and thread) and writes "Running as <user>" to
  the progress; an existing sync the user cannot use is never reused; new syncs record the user as owner. Tested: 16
  end-to-end checks over HTTP with sign-in on, 42 in-process, the HyperAuto suite with a real build, sign-in off.
  Not done: SDDI's build progress line not checked over HTTP with sign-in on; t_sddi.py's 2 ontology-step "exists"
  failures come from object types kept by earlier runs.
- Done 2026-10-15 (BGM3): a build's identity is checked during the build, not only at the start — a clicked build /
  Deploy / Rerun runs as the clicker (any identity in the request body ignored), schedules as their owner (Project-
  scoped ones record owner and Projects), Data Lineage jobs as their starter (kept across retries / auto-restarts); a
  build whose user is gone or deactivated fails "Did not start" before the runner. The runner calls
  `POST /api/pipeline/builds/{id}/access` before every input read, output write and streaming batch, and sends
  `X-Bsai-Build` on every call; the API's pipeline endpoints check the build's identity from it (dataset reads /
  deploys, pipeline read, file / definition / media outputs, virtual tables, external pipelines, old-stream records
  and pushes). A refusal stops the build "Stopped: <reason>" (an input-read refusal was a plain "Could not read
  input"), and streaming refusals are never retried as transient. Old pipeline streams follow their home (Viewers
  read, Editors write, the home's markings). Tested: 51 in-process checks (incl. an input marked mid-build), 18 with
  the real runner and sign-in on (lost marking stops at the input read, Viewer-only output stopped at the write,
  deactivated user never starts, a streaming job stopped at its next batch without auto-restart), sign-in off 11,
  sec/run_sec.py 267 with the current runner, pages 107, BGM 76, BGM2 59, keyed-process UDF suites 30 + 7. Not done:
  drive item reads, datasources, views, streaming ingest, time series and ontology endpoints do not check
  `X-Bsai-Build` themselves (covered by the runner's access call only); the shared sec/runner.cjs bundle is older
  (rebuild it from runner.ts).
  Done since (2026-10-15, XBH, api/build_calls.py): data source tables, Views (and every dataset / source behind
  one), streaming ingest (read, push, keys, reset, delete, a pipeline's output stream), time series syncs (register,
  write, read, delete) and the Ontology (objects list / get / delete, applying an action, registering an object type
  from a pipeline output) check the build's identity from `X-Bsai-Build`: a build whose user lacks or loses a
  marking / role is refused (403 naming the marking or role, never the hidden item); calls without the header
  unchanged; a finished build's header refused. Tested: 79 checks in-process with sign-in on, 16 with it off, 19 with
  the real runner (four refusals only these endpoint checks catch: a View over a marked dataset, a marked time series
  sync, an object type output by an ontology Viewer, an output stream marked mid-run), the BGM3 suites 51 + 18, SEC
  267. Not done: drive item reads (MFD); objects and actions are checked on the object type's markings and the
  ontology role only — object-level visibility and the action's own rules still run as the service token.
  Done since (2026-10-15, MFD): Files item reads made by builds (item, content, folder listings, zips) are checked as
  the build's identity (listings / zips leave out what it may not read); a move into a marked folder or a restore
  bumps markings_version so other API processes enforce it on their next request (~0.3 s in the test) and this
  process drops its markings caches at once; Iceberg MERGE runs DuckDB without external access (read_csv /
  read_parquet / file paths / URLs refused with a plain message, normal MERGEs unchanged). Tested: 40 checks with a
  second API process (20 / 40 fail on the old code), the MERGE suite 108, SQM2 79, SEC 267. Not done: the real runner
  reading Files with the header (played in-process); a move commits a moment before the version bump (two stores).
  Done since (2026-10-15, OBJ): Ontology object and action calls made for a build run as the build's user (a
  user-run build as its user, a Project-scoped schedule as its owner): objects list / keyword filter / get / delete,
  Object Explorer search / export / object view (which had no build check at all) and action apply see and do exactly
  what that user's own request would — object and property security policies, restricted views applied to a type,
  mandatory controls, hidden objects, the action's permissions and submission criteria (refused with the criteria's
  own message, worded for the build). Tested: 114 checks with sign-in on (35 new: results equal the user's own
  requests, a group change mid-build narrows the next read), XBH 79 + 16 + 19 with the current runner, SEC 267. Not
  done: `GET /api/restricted-views/{rid}/rows` with the build header still returns every row (restricted_views.py,
  security-owned: enforce + acting_for in rows / preview / table_for_ref); /search/regex, /semantic/*, scenario
  search, /explorer/bulk-action, object lists and link reads still run as the service token for builds.
- Done 2026-10-15 (SQM): markings on SQL writes and Iceberg commits. Confirmed on the old code: a SQL write recorded no
  markings on its Iceberg snapshots, so the next commit or maintenance refresh unmarked the table and a user without
  the marking read the marked rows (403 → 200). Now `sql_writes._table` records the inputs' markings
  (`snapshot_extra={"foundry.markings": …}`; a write reading its own table also carries the rows it read); a commit
  whose parent's rows stay in the table (append / delete / compaction / partial overwrite) keeps the parent's markings
  on the new snapshot, so expiring a marked snapshot no longer unmarks surviving rows (a clean full replacement +
  expiry still unmarks, as doc 11 describes); `commit` / `commit_job` put the snapshots' new markings on the table
  before the metadata pointer moves (a failure to mark fails the commit) and narrow after; `refresh_markings` runs
  under the table lock; new Iceberg tables and Parquet outputs are created already marked (reserved id), existing
  Parquet outputs gain markings before the replace; Iceberg markings come only from snapshots (`stop_propagating` now
  respected on SQL writes); `_write` retries Windows PermissionError on os.replace (SQL writes failed with WinError 5
  while a reader held the record). Tested: 49 checks (23 / 49 on the old code), a 24-round stress run of writes and
  maintenance under an in-run probe, an HTTP poller without the marking and a separate process (45,338 polls) — no
  unmarked output or marked row seen; SQL write / equality-delete / merge / maintenance suites, frm 25 + 8, sec 267.
  The 24 real Iceberg tables needed no migration (read-only scan). Not done: an empty CTAS from a marked input has no
  snapshot to carry its markings (a later refresh drops them; column names only); Iceberg Custom SQL in
  iceberg_maintenance.py records no input markings (pass the table's `main_markings` as `snapshot_extra` there);
  `auth.effective_markings` caches 5 s per process — several API processes not tested.
  Done since (2026-10-15, ICM, verified): all three were fixed by 5b65b52 — an empty CTAS commits a row-less
  snapshot carrying the markings (kept through refreshes, empty / non-empty inserts and deletes, compaction, expiry,
  Custom SQL, CREATE OR REPLACE and INSERT OVERWRITE with empty results), Iceberg Custom SQL records the table's and
  MERGE sources' markings on every snapshot, and a marking change through one API process is enforced by another on
  its next request (a reader polled 358 times across the change was refused from the change on). Fixed on the way:
  replacing a populated table with zero rows (CREATE OR REPLACE / INSERT OVERWRITE with an empty result, an emptying
  rollback) failed with "division by zero" in PyIceberg's file split — no data files are written for zero rows now.
  Tested: 150 checks (95 / 150 on the code before 5b65b52), the empty-CTAS section 49, SQM 49, SQM2 79, MERGE, ICE 53,
  SEC 267. Not done: a table marked only through its inputs is still listed by name to a user without the marking
  (its data refused; listings check item / folder markings only, auth.can_discover).
- Done 2026-10-15 (RRA): code repository roles (5a301c4) checked in the routes outside `/api/code-repos` that read or
  change something tied to a repository — model_assets (adapter upgrade plan / upgrade, versions with an adapter,
  external models: Viewer; evaluation runs and "evaluate on new versions": Editor + code execution, the schedule runs
  as its recorded owner, ownerless ones do not run), logic_flows (validate / run: Editor on the output repository; its
  name only to who can see it), linter (fixes changing repository settings: Owner; a user's sweep no longer resolves
  recommendations of repositories they cannot see), workflow_lineage (index / search / node / code only for functions
  whose repository the caller sees; `upgrades/apply` checks the function and returns per-resource `errors`). A hidden
  repository answers 404, a visible one without the role 403. Tested: 188 checks over HTTP with sign-in on
  (route × Owner / Editor / Viewer / no role / missing marking), 191 in-process, sign-in off 26, CRP 216. Still open
  in api/sddi.py (audit, not fixed): list / get / explore / preview / ontology preview / migration preview show the
  generator repository's files, pull requests and builds to anyone (list should filter by Viewer, get 404);
  delete / sever / migrate check nothing; configure and merge call the code-repo branch / commit / PR functions
  directly, bypassing the URL role check (need Editor).
- Done 2026-10-15 (MKC): code repository transform outputs (`@transform.using` and `@transform_df` dataset paths in
  api/code_repos.py) are marked before their rows are written — `_precheck_constraints` returns the markings it
  computes; a new output gets them under a fresh id then is stored there (an unmarked copy under another id is deleted
  and the build fails), an existing one gains them before the replace and is narrowed after. Tested: 38 checks with
  real transform builds under an in-build probe, an HTTP poller without the marking and a separate process (~598,000
  polls; 24 stress builds, 18 new outputs) — never unmarked or readable (HEAD fails 8); frm 25 + 8, sec 267, CRP 216,
  RRA 191, BGM 76. Not done (worse than a window): file and media-set transform outputs (files branch of
  `_write_outputs` ~2490-2502, `_write_media`) never inherit input markings at all; Iceberg table / virtual outputs,
  Java transforms writing their own outputs, the SQL `.sql` path and branch builds not touched or tested.
  Done since (2026-10-15, MKF): file outputs (the output folder carries the inputs' markings before any file is
  written, new files stored under pre-marked ids, replaced files widened before their bytes change, SNAPSHOT builds
  narrow the folder afterwards), media outputs (the set and each item id marked before write_build, rolled back on
  failure; a build never narrows a media set), Iceberg outputs (inputs from media sets, folders and tables count; a
  new table is created already marked; Project constraints checked before the transform runs) and virtual-table
  outputs (registered under a pre-marked id, widened before a write, narrowed after) are marked before they become
  visible; `file:///` warehouse paths work in the transform runner without importing the API there. Tested: 60 checks
  (every output kind from marked inputs never listed or readable without the marking during or after builds, Project
  refusals, 16 parallel builds with a separate-process poller), MKC 38, SEC 267. Not done: Java transforms writing
  their own outputs, the SQL `.sql` path and branch builds.

- Done 2026-10-15 (d8a6928): Pipeline Builder outputs are marked before they become visible — deploy and the build
  runner's dataset, file / definition and media set outputs carry the union of their inputs' markings (markings saved
  under a fresh id before the store, existing outputs widened before their contents are replaced, narrowed by
  propagate afterwards; Project constraints checked first, 409). Tested: 39 end-to-end checks with sign-in on and the
  real runner (4 output kinds, built twice, then 6 stress builds, three readers without the marking polling throughout
  never saw an unmarked output; 27 / 39 on the old code), BGM3 51 + 18, SEC 267, regular snapshots 114. Not done:
  Iceberg-format deploys create the table empty and unmarked and rely on the Iceberg commit to mark it before rows
  land (no Project-constraint check either); writes to outputs/file, outputs/definition and outputs/media without
  X-Bsai-Build inherit no markings.
  Done since (2026-10-15, IDO): an Iceberg-format deploy works out its inputs' markings and the Project constraints
  first (409 before anything is written) and creates the table already marked — a real leak fixed on the way: the
  refresh after PyIceberg's schema-only first commit narrowed a new table to its snapshots' markings (none yet), so
  it was readable unmarked until rows landed; tables now keep their creation markings while they have no snapshot
  (also for code_repos.py / sql_writes.py tables). Writes to outputs/file, outputs/definition and outputs/media need
  `X-Bsai-Build` of a queued / running build and are checked as its identity (incl. that it can still read the
  pipeline's inputs); without it they are refused (403), also for the service token. Tested: 53 checks with sign-in
  on and the real runner (two builds and 5 stress builds watched by three readers without the marking — never an
  unmarked table; Project refusals; headerless / unknown / finished-build writes refused), MKD 39, BGM3 18 + 51,
  SEC 267, sign-in off suites. Not done: Iceberg deploys to a branch; the 149cf72b SEC runner bundle predates
  17b08b7 and sends no header (rebuild it from runner.ts).
- Done 2026-10-15 (92bed47): every SDDI route checks the generator repository's markings and Project roles (Viewer
  list / get / explore / previews, Editor delete / configure / merge / ontology apply / migrate, Owner sever; 404 for a
  hidden repository, 403 naming the role otherwise); create checks the connection's markings and Editor on the target
  folders and Project before writing anything; instance views hide connection / folder names, files and object types
  the caller cannot see. Tested: 146 checks with sign-in on (7 of the 25 new ones fail on the old code), SEC 267, HSD
  16 + 42, RRA 191, CRP 216. Not done: SourceConfig / PipelineConfig YAML in the repository still shows folder paths to
  its viewers (as in Code Repositories); HyperAuto's explore lists a connection's sync names unfiltered; the UI not
  clicked.
- Done 2026-10-15 (5b65b52): markings changes are seen by every API process at once — each item-markings change bumps
  a `markings_version` row in the same transaction and each process's markings cache checks it per request (re-read
  after 0.1 s), so a marking added or removed in one process is enforced by the others on the next request (7–9 ms;
  4 checks fail on the old code; a lookup costs 0.2 ms on SQLite / 0.05 ms on PostgreSQL once per request); Iceberg
  maintenance Custom SQL (INSERT / UPDATE / DELETE / MERGE) records the markings of what it reads on its snapshots and
  runs DuckDB without file / URL access; an empty CTAS from marked inputs commits a row-less snapshot carrying their
  markings. Tested: 79 + 49 checks incl. two API processes on ports 8171 / 8172, SEC 267, the Iceberg MERGE /
  maintenance / permission / equality-delete suites. Not done (other files): a Custom SQL `MERGE INTO ... USING
  (SELECT * FROM read_csv('<server file>'))` still reads server files (api/iceberg_merge.py opens DuckDB with external
  access on); moving an item into a marked folder changes its markings outside `_set_item`, so it can stay readable
  unmarked for up to 5 s (the move path in db.py / drive.py should call `auth.markings_changed`).

- Done 2026-10-15 (e6a74f1): Contour save-as-dataset / build, Code Workbook dataset_out and Preparation save /
  update / save-to-branch outputs carry the union of their inputs' and their own item's markings already at their
  first write (api/marked_outputs.py); time series syncs and pipeline output streams are marked before their record
  is stored. Tested: 65 checks with readers polling during first writes (79 first sightings from another process, all
  marked), 19 on the union of four markings, SEC 267, MKC 38, the Contour suites. Not done: streaming connector syncs
  gain no inherited markings.
  Done since (2026-10-15, STRM): a stream carries the markings of every streaming sync writing into it (worked out
  on every access check, so marking a sync hides its stream at once); a sync can be created with markings (the
  caller must hold and be allowed to apply them) and the sync and its new stream are marked under fresh ids before
  they are stored; each batch records the sync's markings on the stream for good (also on deleting the sync); a
  stream's archive dataset is marked before its rows are stored. Streaming monitoring: stream / sync / sync-job
  monitors already evaluated as their owner (55f5e47); each subscription now has an owner and an alert, digest or
  manual resolve goes only to subscriptions whose owner (and, for an e-mail address, that platform user) can still
  see the monitored resource (the reason kept as `skipped`); hidden monitors are 404 to change, delete or resolve.
  Tested: 48 checks with sign-in on (22 fail on the old code), 12 off, RQL 57, streams 268, keyed monitors 30 + 7,
  BGM2 59, SEC 267. Not done: batch Data Connection syncs store the synced dataset with only the folder's markings,
  not the connection's (datasources._store_new); the Files markings panel does not show a sync's live markings on
  its stream until the first batch; the sync dialog has no markings field; the archive loop runs as the system;
  stream markings never shrink; no real MQTT / Kafka broker.
  Done since (2026-10-15, DCM): batch Data Connection syncs mark what they write with the connection's markings —
  every file (snapshot, replace, incremental, upsert / delta, merged views) created under a fresh id already marked
  (`marked_outputs.create_from`, streamed), the sync folder and existing view files widened before a run reads or
  writes, markings a run applied taken off again only after a successful run once the connection drops them (never
  hand-set ones); a Project constraint the marked dataset would break refuses creating / running the sync (409) or
  fails a scheduled run before it writes; syncs are listed / run / deleted only by users holding the connection's
  markings; marking a connection marks its already-synced datasets at once (auth.set_item_markings). A backfill
  (`api/backfill_sync_markings.py`, admin `POST /api/datasources/sources/markings-backfill?dry_run=`, one connection
  or all; dry run by default, adds only, idempotent, audited): its real-data dry run widens 0 datasets (none of the
  79 connections is marked). Tested: 75 checks with sign-in on, twice (150k-row snapshot, incremental and upsert syncs
  of a marked "(test)" connection with pollers in separate processes never reading or listing an unmarked file),
  8 off, DCS 58 + 18 + 3 + 47 + 30 + gates, RQL 57, STRM 48, BGM2 59, SEC 267. Not done: removing a connection's
  marking narrows its datasets only at each sync's next successful run; HyperAuto / SDDI checked by reading.
  Done since (2026-10-15, ARC): the archive loop runs as the archive's owner (whoever last set it up; older archives:
  the owner of a sync writing into the stream) — owner gone / deactivated / without a marking / without Editor →
  nothing written, the reason kept on the archive as `blocked`; no owner → refused, never the system; on-demand runs
  need Editor on the folder and the dataset's markings. The new-sync dialog has a markings field (only markings the
  user holds and may apply; hidden with sign-in off; for an existing stream it shows the markings it carries). A reset
  narrows the stream's recorded markings to hand-set ones, the markings of syncs still writing into it and all of a
  pipeline output stream's (markings recorded only for deleted / retargeted / unmarked syncs' old records are
  dropped with those records); the archive dataset never loses one. A reset whose running sync's owner lacks a
  stream marking succeeds and leaves that sync stopped with the reason (`not_restarted_syncs`; it answered 403
  after resetting before). Tested: 49 checks on a full API with sign-in on (readers without the marking never read
  the archive's data), 26 dialog checks in headless Chrome, streaming / keyed-process / RGR / sec 267 suites. Not done:
  the `blocked` reason not shown in ArchiveSection.tsx / StreamTabs.tsx, the stream page's reset message does not
  show `not_restarted_syncs`; the archive timer firing on its own and a real broker not tested.

- Done 2026-10-15 (4ac00ba): user schedulers (SQL write schedules, Logic flow schedules, recipes, the peering relay,
  linter sweeps) start in the API's startup hook, each guarded, instead of on import — tests and scripts that import
  server.py no longer run the owner's schedules. Tested: an import test (none of the five threads start). Not done:
  other background threads still start on import (autopilot alerts, model deployment monitor, ontology datasource
  watch, registry GC, workflow builder schedules, Workshop edit history, kernel cull); a served-API start with these
  schedulers was not run here (its test needs a PostgreSQL URL).
- Done 2026-10-15 (0615242): Ontology branches and proposals follow access — seeing / editing / reviewing /
  merging / closing follow Ontology roles and the markings of what a branch changes (hidden changes and conflicts
  reported without content), approvals count only while the reviewer still holds the role (owner-only changes such as
  roles need an owner's approval), merges run as the person merging and are refused while the author is deactivated,
  a proposal made stale by main needs a rebase and a fresh review. Tested: 71 checks with sign-in on (owner / editors /
  author / viewer / no role / editor without the marking), and the earlier branch suites (BR2 20, branch context 42,
  functions on branches, merge regress 6). Not done: the branch UI not clicked.

- Done 2026-10-15 (1a43e2a): the remaining ontology routes act as the build's user for build calls
  (X-Bsai-Build): semantic search and KNN, scenario search and scenario object view (the scenario is resolved as its
  owner), Object Explorer bulk actions, object lists, object links, interface links, join-table link edits (write on
  both object types) and restricted view rows (also on a branch). Also fixed for every caller: bulk actions validate
  each object as a single application would (permissions, submission criteria), so a bulk run cannot do what one by
  one is refused; the interface links route (`/interfaces/.../links/{constraint}`) answered 422 since 885a02a because a
  helper carried the same route decorator. Tested: 89 checks with sign-in on (OBJ2 block on the XBH / OBJ setup: v1 /
  m1 / none / out builds, object and property policies, a restricted view on a type, links across it), the full XBH /
  OBJ suite 147, SEC 267, Workshop KNN 22. Not done: test_ann_api.py's "first query answered (exact while the index
  builds)" fails on the committed code as well (not from this change). The code transform runner's Windows Iceberg
  path fix (RIP) was already in 88347d0: the MKF Iceberg checks pass 10 / 10 without the test shim.

## 4. Python transforms (doc 23 "Python")
See [`python-transforms/REMAINING.md`](python-transforms/REMAINING.md): nine modules with what is missing, a plan, and
the source documentation sections verbatim.

- Done 2026-10-13 (4b7fddb): Spark reads every Arrow / pandas type it lacks — uint8/16/32 → short / int / long,
  uint64 → decimal(20,0) (values above the signed range kept), float16, date64, zoned / nanosecond timestamps → UTC
  microseconds, large / view / dictionary / extension types, nested lists / structs / maps (safe casts; >38-digit
  decimals and times of day as strings); `spark_frame` goes straight from Arrow (nullable ints stay ints), Spark outputs
  are collected as Arrow (timestamps stored without a zone, as before), Code Workbook Spark inputs use the same
  conversion. Tested: 25 checks with real Spark builds on "types nullable (test).parquet" and a new "spark types
  (test).parquet" (round trip and re-read), plus the earlier Spark incremental / debugger / Code Workbook tests. Not
  done: interval (month / day / nano) columns; a non-UTC Spark session time zone.

## 5. Media sets (doc 32 "Media sets (unstructured data)")
Done: media set settings over Files folders (`api/media_sets.py`, `/media-sets`). Not done yet:
- Done since, 2026-10-13 (68c9821): Pipeline Builder media set outputs go through the set's checks (path / size limits, formats, media type by content, conversion to the primary format) and, for transactional sets, one transaction per build — committed only when every item succeeds, aborted with a 400 naming the file otherwise, 409 when one is open, items no longer written staged as deletions; media sync "Path matches" is a regular expression searched in the path from the source's root (old glob values like `*.png` still recognised; a regex like `colou?r` would be read as a glob), recorded on the run; S3 sources are streamed for media syncs (a 160 MB object synced with 15 MB peak memory; the table reader still loads objects for Parquet). Tested: 46 new checks (a local S3 stub, no real bucket) and the earlier 60 + 7 + 36 media sync checks; not run from the Builder UI.
- Audio transcription: Python `transcribe()` and Pipeline Builder's "Transcribe audio" step (Media; text, timestamps
  or segments; media set inputs list audio and video files) and Workshop's "Audio and transcription" widget (player +
  segments, click to seek; not tested in a browser) are done (Whisper through transformers). Done since (2026-10-12,
  803678d): HLS streaming (`/api/media-sets/items/{id}/hls/playlist.m3u8?channel=&pattern=` and its segments; one
  ffmpeg pass to 6 s MPEG-TS segments, H.264 without B-frames + AAC, kept per the pattern's policy; one-off renders
  swept after 15 min, half-written ones after 1 h) and audio channel selection (`channel=all|mix|N` on audio,
  transcription and waveform; item metadata reports channels and layout; byte ranges on the audio pattern and on
  `/content`); the preview has a channel select, per-channel Transcribe (click a segment to seek) and an HLS toggle
  where the browser plays HLS natively. Tested: 46 in-process checks on "Audio channels (test)" and "Video HLS
  (test)" (kept) and in headless Chrome (HLS played natively, mix-down switch, channel 1 waveform and transcript,
  seek). Not done: hls.js for browsers without native HLS (the .m3u8 link always shows), video seeking through
  `/content` ranges only API-tested, long-video render time not measured (a render blocks a worker thread; 30 min
  timeout), a recompute pattern re-encodes on every range request.
  Done since (2026-10-13, 8d9a81c): HLS renders run as background jobs (2 ffmpeg workers, the source copied off the
  request thread with fetch progress, `GET /hls/status`, cancel by `DELETE /items/{id}/hls/render`, the playlist answers
  202 while rendering), playback starts from the first finished segments (a growing playlist, then VOD), a recompute
  audio playback is encoded once for all its range requests. Measured on a 20-minute 720p "(test)" video in S3:
  playable 71 s after the request (mostly the S3 fetch), render 90.5 s, ffmpeg peak 374 MB. Tested: 66 checks
  (`test_mr.py`) plus the 43 / 46 earlier media checks. Not done: the growing playlist not tried in a browser, no
  hls.js; render state is per process (lost on restart). Done since (2026-10-13, 4a9f1e4): thumbnails / frames,
  waveforms, audio transcodes and transcriptions as background jobs (`api/media_jobs.py`: two workers; 202 with
  Location after 8 s, inline for items ≤ 16 MB; `GET /access/{pattern}/status`, `DELETE …/job`; long transcriptions in
  ~300 s pieces, cancellable between them; metadata probes in the background), one reference-counted local copy per
  source shared by every job, HLS and byte ranges (idle 30 min / 4 GB LRU); the web polls with progress and cancels
  on abort. Tested: 39 job checks (one fetch for frame + thumbnail + audio of a video; cancel on the 20-minute video),
  5 piece checks, the 46 earlier media checks. Not done: the web not clicked in a browser, no full-length
  transcription of the 20-minute video; the older media-sync test now sees one more refused file (test files added
  for db10fba), not a regression. Done since, 2026-10-13: job state across restarts — each queued / running job keeps
  a small record (owner process, rewritten every 2 s); a graceful stop ends running jobs at once and leaves the
  records; at startup interrupted shared outputs (HLS renditions, stored transcriptions) are queued again, one-off
  recompute jobs are marked failed ("the API process computing this stopped (a restart)…"), finished outputs are found
  again and never redone, jobs owned by another live API process are left alone (status follows it, cancel → 409); a
  transcription stops at the next decoded token (stopping took 900 s inside a Whisper piece, now ~5 s); Cancel buttons
  for HLS renders and transcriptions; fixed: the Reports History panel covered the old-revision preview's Restore /
  Back buttons. Tested: 60 in-process restart checks, graceful stop, Whisper cancel, 29 checks with real API processes
  restarted on a side port, the earlier job / piece / media / render suites, and in headless Chrome 19 media set and
  15 Reports preview checks. Not tested: a hard kill of the live API.
- Workshop's Image annotation widget (the selected object's image, its annotation objects as labeled boxes, a rectangle
  tool creating new ones with a create action: link, box as JSON fractions and label through the parameters setting
  those properties) and Audio recorder widget (MediaRecorder, uploaded to the ontology media folder, then a create or
  modify action gets it in its media parameter, on the selected object) are done, checked in headless Chrome with real
  mouse drags and a fake microphone (module "Audit kuitansi (test)"). PDF viewer annotations: the same widget on a PDF
  shows it page by page and the box records its page (checked on a 2-page PDF). Spreadsheet annotations: on an
  xlsx the widget shows the sheets, highlights annotated ranges with their labels and creates one from cells dragged
  across (the box property holds {"sheet", "range": "B2:C3"}). Done since (2026-10-12): polygon and point tools, editing (move, resize, move or remove a polygon vertex, relabel)
  and deleting a drawn annotation through configured modify / delete actions (their submission-criteria messages
  shown), PDF text-span annotations (text selected on a page stored with its page, offsets, quote and line boxes;
  GET /api/workshop/pdf/{ref}/text/{n} and /span), and read-only modules offering no tools; the widget now lives in
  `ImageAnnotation.tsx` with its geometry in `annotationGeometry.ts`. 83 geometry checks in Node, 54 API checks
  in-process, and 86 checks in headless Chrome with real mouse input on the module "Annotations (test)" (from an
  esbuild bundle with sign-in off, not the Next server; the first two re-run at commit). Not built: editing or
  deleting spreadsheet-range annotations, changing a text span's range, touch input (done since, 2026-10-13: a Range
  tool on spreadsheets — pick, drag to move, corner handles to resize, kept inside the sheet, saved through the modify
  action and deleted through the delete action with Undo and submission-criteria messages, an overlapping range
  already picked stays picked; a picked PDF text span gets end handles dragged over the page's text, the server
  returning the exact quote and line boxes; touch — larger hit areas, scrolling blocked only while drawing or on a
  handle, "Remove point" on a tapped polygon point, cancelled touches restore the shape, "Use selected text" turning
  the phone's text selection into a draft; 130 + 83 geometry checks in Node, 65 + 54 in-process API checks and 131 in
  headless Chrome with real mouse and emulated touch; not tested on a real phone; no Escape / Delete shortcuts on
  spreadsheets; ranges across sheets not supported). Earlier not built: polygon or point annotations, editing or
  deleting a drawn box, text-span PDF annotations.
- Uploads with progress (XHR) now send the session cookie: with sign-in on and the API on another origin they failed
  with "Sign in to use BluesandAI".
- Markings per media item: done (Files hides marked items from users without the markings, and code builds read only
  the items their user may see, with a note in the build log; 3 checks). Restricted views and granular policies on
  media references are not built.
- OSDK media (`fetchMetadata` / `fetchContents` / `uploadMedia`): there is no OSDK here.
- Access patterns registered by API with a chosen persistence policy (recompute / persist / cache for a time):
  every pattern is persisted after the first request. Done since (2026-10-12, 803678d): `GET/POST
  /api/media-sets/{fid}/access-patterns`, `PUT/DELETE .../{name}` — built-in patterns per schema with a stored policy
  (persist / cache with `ttl_seconds` / recompute) and registered patterns (a built-in transformation with fixed
  parameters under a name, outputs under `@name-`); a policy change drops stored outputs; responses carry
  `X-Persistence-Policy` and `X-Pattern-Cache: hit|miss`; an "Access patterns" panel on the Details tab. Not done:
  outputs stored before this change keep their old cache keys (not migrated).
- Virtual media sets for OneLake / Azure Blob Filesystem (no ABFS connector); Pipeline Builder's media set inputs
  do not list virtual items yet (Code Repositories do); `external_systems` sources in Python transforms.
- Data Connection's (copying) media sync writes into a folder, not into a media set with its schema checks. Done since
  (2026-10-12, 79838d4): `POST /api/datasources/connections/{id}/media-sync` takes `target_media_set_id` — files go
  through the media set's registration (formats, conversions, size / path limits), refused files are listed per file
  and retried when the file or the set's formats change, a transactional set gets one transaction per run (aborted on
  failure, 409 when one is already open), unchanged files (mtime + size) are skipped, a changed file replaces the item
  (the old one kept as overwritten); the Media sets panel has a Target choice and per-file results. Tested: 23
  in-process checks with a filesystem connection "Media sync (test)" into "Media sync images (test)" and "Media sync
  documents (test)" (kept). Done since (2026-10-13): files are streamed through a temporary file instead of memory
  and checked by content as well as extension (a text file or GIF named .png, a PNG named .pdf are skipped with the
  reason); a touched file with the same SHA-256 is not rewritten; sync filters (ignore items not matching the schema —
  off makes such a file fail the run —, a path glob, a file size limit, exclude already synced); `propagate_deletions`
  (off by default: the docs give no rule for copying syncs) soft-deletes the item of a file removed at the source; a
  transactional run commits only when every file succeeded (before, one failing file still let the rest commit), a
  transactionless run keeps what arrived and ends "partial"; each run records status, written / skipped / unchanged /
  deleted / failed counts and the skipped files with reasons. Two call sites left broken by an interrupted session
  (every media sync was failing in the working tree, never committed) are fixed. 60 + 7 checks in-process (re-run at
  commit); the Editor check was forced to deny rather than tested with a marked account. Done since (2026-10-13, later): the Media
  sync panel shows a run as succeeded / partially failed / failed (with "transaction aborted"), every count, the
  failed and skipped files with reasons, the last run again after a reload, and a "Sync filters" box with the four
  filters plus "Propagate deletions"; uploads, transaction staging and build writes into a media set are checked by
  content like the sync; a wholly failed run answers 400 with the run in the error (partial runs stay 200). 36 more
  checks in-process and 21 in headless Chrome on the real panel (the earlier 60 + 7 re-run at commit). Not done:
  "Path matches" is a glob here while the docs describe a regular expression; the Files upload route and Pipeline
  Builder's media set output can still put a file into a media set folder without these checks (`api/drive.py`,
  `api/pipeline_runtime.py`: not changed); only the filesystem source was tried (an S3 source still reads each object
  into memory in its connector); a partial and an aborted run were not seen in the browser.
- DOCX / PPTX to PDF keeps the text only (no LibreOffice for a faithful conversion).
- Not run against a live API after the sign-in merge: tested in-process (TestClient on the real database).

## 6. Geospatial and geotemporal (doc 31 "Geospatial and geotemporal")
Done: geopoint / geoshape / GTSR property types, saved maps with object / track / EML / template / raster / choropleth /
added-object layers, curated sources, Pipeline Builder CRS / area / length / geoshape / GTSR transforms, the legacy
`geospatial-tools` library. Done since (2026-10-12, e5ac140): vector tile (MVT) layers — `web/src/lib/mvt.ts`, a
dependency-free MVT 2.1 decoder (protobuf, geometry commands, holes, multi-parts, all value types, gzip through
DecompressionStream) and `VectorTileLayer`; in the Map app a "Vector tiles" data source (URL template or TileJSON with
"Read TileJSON", a one-tile Test, source layers, id property), stored as a `tiles` layer with `config.format: "vector"`,
colored by a property (categories or a range, legend), features selectable in the selection panel (`ext:<layer>`), zoom
to the TileJSON bounds; in Slate's map widget `type: "vector"` layers and `choropleth` with `layerSource: "Vector Tile"`
(see section 20). Tested: 19 decoder tests (hand-encoded tiles and the MapLibre demo tile), 7 against a local tile server,
2 API checks, and clicked through in headless Chrome on map "Vector tiles (test)" and Slate app "Vector map (test)"
(kept; they point at the stopped local tile server). Done since (c8e9c72): a tile proxy for servers without CORS
(`api/tile_proxy.py`, GET /api/geo/tile-proxy; admin allow-list in Map admin; every resolved and redirected address must
be public — loopback / private / metadata / mapped forms refused — and the connection is pinned to the checked IP; 5 MB,
20 s, tile / JSON types only; no cookies or auth forwarded; 64 MB LRU cache with ETags; redacted request log), failed
tiles retried with back-off (1–16 s, 5 tries) and a "Retry now" control, labels (hover / always, minimal / card, no
overlaps) in the Map app and Slate maps. Tested: 96 proxy unit checks (address forms, DNS answers, redirects, limits),
34 live checks against a local tile server, 23 decoder / label tests, 14 checks in headless Chrome (map "Vector tiles
proxy (test)", kept). Not done: no real third-party tile server tried (TLS / SNI not exercised live), the egress
policy path untested, "search inside a shape" on a vector feature untested. Done since (2026-10-13, 645e6fa): "Search inside this shape" on any vector-tile polygon in the selection panel (pieces clipped to their tiles and merged into one MultiPolygon, so a feature cut at tile edges is searched whole: before, the clicked piece found 1 or 3 of 4 hospitals), the tile proxy checks the egress policy before resolving and on cache hits; tested: 34 checks (egress policies, TLS / SNI against a local HTTPS server with a test CA, demotiles.maplibre.org through the proxy), 5 clip / merge tests, 14 of the real Map page in headless Chrome (4 matches, equal to the exact polygon and the Explorer geo filter), and the 96 + 34 + 14 + 23 earlier ones; map "Vector tiles shape search (test)" kept. Not done: only loaded tiles are merged (a shape beyond the view is searched where visible); the Explorer geo filter takes one ring (no holes / multi-parts). Not done yet:
- Mapbox Boundaries v4 as a Marketplace product (no Marketplace, no Mapbox data licence): boundaries are any GeoJSON in
  Files; the v3 → v4 ID mapping tables are not shipped.
- Gotham / Gaia proper: no type mapping, Map Rendering Service or Gotham object views — the Map app plays Gaia's role.
  Function-backed EMLs run AIP Logic functions, not TypeScript Functions on objects.
- Pipeline Builder object type outputs: no "Geotemporal series → From this pipeline" link on a property, and they are
  not published into Ontology Manager (add the GTSR property there); the geotemporal series sync output has no Styles,
  hot / cold storage settings or Geotemporal Series interface.
- NITF rasters and File geodatabases (`gdb_to_dataframe`) need GDAL (clear errors); GeoJP2 only through its GeoTIFF box
  (no GMLJP2); Rasterio is not installed for transforms.
- Done since: external tile servers and feature services (ArcGIS, OGC API Features, GeoJSON) as map layers (tested
  against mock services, 6 checks; the layer loads the whole service up to 2,000 features, not per view). Done since:
  geospatial search in Object Explorer — the "is in area" filter on geopoint / geoshape properties: within km of a
  point (great-circle), a box or a polygon; shapes match when they intersect (search API filter op `geo`; tested
  in-process, the filter chip compiled, not clicked; no map drawing of the area). Done since: WMS / WMTS capabilities — the tile layer form
  reads a service's layers and fills the URL template (WMTS {z}/{x}/{y} from ResourceURL or KVP GetTile on Web Mercator
  matrix sets; WMS GetMap per tile with {bbox-epsg-3857}); tested with mock capabilities documents, not a live
  service; the form compiled, not clicked. Not done: WMTS services found only through OperationsMetadata endpoints
  other than the capabilities URL, non-Mercator layers. Done since, 2026-10-13 (`api/geo_wmts.py`): tile URLs from the
  layer's ResourceURL template, then OperationsMetadata KVP or RESTful GetTile endpoints (other hosts too, their own
  query strings kept; WMS GetMap keeps its endpoint's query string, e.g. MapServer `?map=`); layers not drawable
  directly in Web Mercator (EPSG:4326 / CRS84 / any CRS pyproj knows, Mercator sets with other matrix ids, WMS without
  EPSG:3857) are reprojected on the server — `GET /api/geo/warp/{id}/{z}/{x}/{y}.png` (signed-in users, 32-hex ids,
  z / x / y checked) samples the closest-resolution source tiles per pixel, every upstream request through the
  existing SSRF-guarded tile proxy (allow-list, public addresses only, pinned connection, redirects re-checked);
  CRSs that cannot be shown get a reason in the form. 46 unit checks (mock OGC / GeoServer / MapProxy / ArcGIS /
  MapServer documents, 4326 vs 3857 placement checked numerically, exact pixels on coded tiles), the 96 + 34 proxy
  SSRF checks, and 29 against a local mock WMTS / WMS server incl. the real Map page in headless Chrome (0 wrong of
  30,602 sampled pixels). Not done: no real third-party service tried. Done since, 2026-10-13 (3e29d57): bilinear sampling (auto: nearest for paletted / class layers, bilinear for imagery; partly transparent pixels blended without a fringe; neighbouring source tiles read; `?sampling=`), geographic matrices laid out over 0–360° drawn west of Greenwich, 360° sets blended across ±180°; tested against an independent pyproj + numpy reference: 72 checks over EPSG:4326, UTM 48S, LAEA Europe WMTS and a UTM WMS (0 wrong pixels), 88 antimeridian / edge checks, the 46 WMTS, 96 + 34 tile-proxy (SSRF guard unchanged) and 33 Map page checks; a WMS request crossing the antimeridian is not split; bilinear is clamped at a regional matrix's edge (done since,
  2026-10-13: a WMS tile crossing the antimeridian of any CRS whose east-west axis is a straight function of longitude
  — geographic incl. other prime meridians and units such as EPSG:4807, cylindrical such as EPSG:3832 — is fetched as
  one GetMap per side on one shared pixel grid, in parallel through the SSRF-guarded proxy, and stitched; UTM / conic
  / azimuthal never split; bilinear sampling fades out over the last half pixel at a regional WMTS matrix edge instead
  of clamping; 18 hand-worked split checks, 212 against a mock WMS through the in-process API and proxy (refusals for
  hosts not allow-listed and loopback, 4,456,444 pixels, 0 wrong), 127 edge and 72 earlier checks, plus 46 + 96; no
  browser run of a split tile). (Workshop's map widget: points only, see section 20; done since, 2026-10-13 (68ba025): geoshape properties drawn as polygons / lines with styling and a legend (category colors assigned per value so they never collide), overlay layers in order, map templates, shape click and an optional box selection tool (shift adds, Esc pans) writing the layer's selected-objects variable and the module selection, holes and the antimeridian handled, KNN variables on `rank_type`; tested: 118 geometry checks in Node, 25 + 14 API checks, 29 box-selection + 84 shape + 23 earlier checks of the real widget in headless Chrome with real mouse input (2,000 polygons); not built: lasso / polygon selection, drawing, measuring, the timeline.)
- Not run against the full API in a browser with sign-in on (tested with the ontology, time series and geo routers and
  Playwright, sign-in off).

## 7. Microsoft Excel (doc 33 "Transforms Excel Parser")
Done: transforms-excel-parser on Apache POI (tables, multi-row merged headers, forms, several outputs, error
DataFrame, incremental helper), the bundle as a built-in backing repository, a repository template. Not done yet:
- The javadoc archive of the real library is not shipped; classes and methods follow the docs' examples, so code
  using other parts of the real API (e.g. other header extractors or sheet selectors) may not compile.
- Done since: workbooks are parsed on the executors (the files spread over the default parallelism; only the parsed
  records reach the driver). POI's memory use per workbook applies as on Foundry.
- Formulas without a cached result (files written by tools that do not evaluate formulas) read as their cached value.
  Done since (2026-10-12, f60abc4): the Java parser calculates them with Apache POI's evaluator (cross-sheet references,
  ranges, named ranges, dates by the cell's format incl. 1904 workbooks, Excel errors as text); unsupported functions,
  cycles and parse errors read as empty with a `warning: ...` row in the error DataFrame (a transform that fails on any
  error row now also fails on these). Tested: 49 checks on openpyxl-written workbooks against hand-worked values, per
  file and through a local Spark parse; a saved result and a plain workbook unchanged. Not done: references to other
  workbooks (empty + warning); files with fake saved results (xlsxwriter's `<v>0</v>`) keep them; the Python readers
  `api/dataset_reader.py` `excel_to_csv` and `api/pipeline_parse.py` `parse_excel` still read such cells as empty
  (`data_only=True`; `api/drive_import.py` already calculates them with the `formulas` package); not run as a real
  repository build.
- Code Assist preview (VS Code) does not exist here, so its class-loader issue does not either.

## 8. Dataset Preview (doc 18 "Dataset Preview")
Done: the app (`/datasets`), CSV parsing options, uploads, history / branches, compare, Time Travel, issues, metadata.
Not done yet:
- Streaming datasets (done: a stream's archive dataset has Live / Archive views, Stream and Metrics tabs, Troubleshoot
  mode): a stream is not itself a Files item, so it is archived into one first; the archive rewrites the whole
  current view each time (stored as an APPEND transaction); pipeline-written streams have no job metrics (only
  streaming syncs report checkpoints, lag and utilization). Done since (2026-10-13, 261614c): the archive reads only
  records past the last archived offset and stores a real APPEND (offset and watermark kept, columns widened); a full
  rewrite only for the first archive, a deleted archive, a reset stream, offsets going back, unarchived records
  dropped, an archive changed outside, or types that cannot be appended — each run and its reason in an archive
  history (Stream tab); job metrics for pipeline-written streams sampled from the checkpoint every 30 s (records in /
  out, lag, checkpoints, throughput; 7 days per minute), a pipeline job card and Troubleshoot steps. Tested: 38
  in-process checks (archive after appends and after each forced rewrite identical to a full rewrite, schemaless
  streams, every rewrite reason, metrics), project "STR streaming archive (test)" kept. Not done: the dataset is still
  one Parquet file (rewritten, a full copy per transaction for Time Travel); several checkpoints within one sample
  count as one, checkpoint duration / failures / utilization still sync-only (the runner does not report them); not
  opened in a browser, no real streaming pipeline run.
- Done since: Analyze in Contour (dataset actions menu → a new analysis on the dataset). Build opens Data Lineage. Iceberg tables have their own page (section 9).
- Reading is in memory: a dataset over 512 MB is previewed from its first 200,000 rows (Parquet) or its first files /
  bytes (raw), flagged "Partial preview"; filters, statistics and SQL apply to that part. Spark is not used. Done
  since, 2026-10-13: out of core — a big dataset is read as one Parquet file on disk by DuckDB (a file kept in S3 read
  in place with parallel ranged GETs; its schema from the footer alone), so rows, filters, row search, sort, statistics,
  charts and SQL cover the whole dataset, not the first part; the page says which path it used. 371 checks that the
  in-memory and out-of-core paths give identical rows, statistics, charts and SQL, and a run on a 642 MB Parquet
  dataset kept in S3 ("big-parquet (test)"): summary 3.3 s with +6 MB, first page 0.8 s, charts 0.1–0.2 s, SQL group
  by 0.3 s (the first open, which copies the file to disk, took 49 s). Not tested: the page in a browser (compiled and
  linted).
- Datasets written by pipelines and code builds keep their schema from the build (no schema edits on Parquet).
- Done since: branches of raw datasets (header + and History → Create branch), issue assignees, watchers and
  notifications (inbox, and email when configured).
- Not run in a browser with sign-in on (tested with sign-in off against a real PostgreSQL Files store).

## 9. Iceberg tables (doc 11 "Iceberg tables")
Done: Foundry's Iceberg REST catalog (`/api/iceberg`: PyIceberg, Spark's Iceberg runtime and other REST clients; API
tokens and OAuth2 client credentials with read / write scopes; X-PLTR-Branch branch isolation; excluded endpoints on
branches), Iceberg tables as Files items and in Dataset Preview (Preview at a branch or snapshot, Snapshots with
trends and schema versions, History, Branches and tags, Details with the metadata JSON, properties, main branch
protection and markings, Maintenance), all-or-nothing build transactions with pinned reads and retry on conflict,
`transforms.tables` in Python transforms (single node and Spark, append-only incremental, Spark changelogs with
`changelog()` / `apply_changelog()`, MERGE INTO / UPDATE / DELETE / ALTER through `identifier`), Pipeline Builder
inputs and "Foundry Iceberg table" outputs, Data Connection syncs (overwrite / append / update, cursor-incremental),
maintenance tasks (compaction, rewrite manifests, expire snapshots, orphan files, Custom SQL) with schedules and the
daily orphan sweep, Control Panel → Iceberg table settings (enable, BYOB locations, defaults, project / namespace
overrides, disaster recovery window), Resource Management (storage of main's latest snapshot, maintenance and sync
compute), the Iceberg Tables app (catalog, connecting clients, Snowflake integration SQL, OAuth2 applications, syncs).
Not done yet:
- Client-side encryption is a setting only: it makes new tables format version 3, but data files are not encrypted
  (PyIceberg and this catalog have no Iceberg table encryption yet).
- Format version 3 tables are written by Spark (transforms on Spark, external Spark); PyIceberg cannot write v3, so
  single-node transforms, Pipeline Builder, syncs and the compaction / manifest procedures refuse v3 tables.
- Credential vending returns the bucket's configured FileIO credentials (no STS / SAS minting, no remote signing);
  S3 / ABFS / GCS locations are configured but only local storage was tested.
- OAuth2 applications act as the user who registered them (no separate service users); scopes limit them.
- Custom SQL is a subset (CALL procedures, ALTER TABLE, INSERT / UPDATE / DELETE); MERGE INTO runs in Spark transforms.
  Done since (2026-10-12, c959a02): MERGE INTO in Custom SQL without Spark (`api/iceberg_merge.py`: sqlglot parse, DuckDB
  evaluation; WHEN MATCHED [AND] UPDATE SET … / * | DELETE, WHEN NOT MATCHED [BY TARGET] INSERT … / *, WHEN NOT MATCHED BY
  SOURCE UPDATE | DELETE; sources: Iceberg tables, datasets / views, `this`, subqueries / CTEs, VALUES, each checked for
  read access; copy-on-write of only the data files holding changed rows plus inserts in one OVERWRITE snapshot,
  insert-only as one APPEND, a no-op makes no snapshot; Spark's MERGE_CARDINALITY_VIOLATION and schema / type / null
  refusals; main-branch protection as UPDATE; maintenance jobs now run as the user who started them or the task's
  creator). Tested: 108 checks (every clause combination, partitioned target, dataset / VALUES / subquery / this
  sources, one snapshot per MERGE with time travel, rows equal DuckDB's own MERGE, 12 refusals), 13 maintenance
  regression and 3 permission checks; protection and access tested by patching auth (sign-in off). Not done: format-v3
  tables (sent to Spark), equality delete files, SQL Studio's console still refuses MERGE.
  Done since, 2026-10-12 (e55dfe6): equality delete files are read — `api/iceberg_eqdeletes.py` patches PyIceberg 0.12
  (which refuses them): a delete applies to data files with a lower sequence number and the same partition (or is
  global when unpartitioned), rows match null-safe (struct keys too) and are dropped as position deletes, so filters,
  projections, limits and count() still work; installed on every PyIceberg import, also in single-node Python
  transforms (`code_tables.catalog`); compaction and replace_contents remove the delete files they applied. Tested:
  47 checks against hand-computed rows (one / two key columns, nulls, sequence order, delete then re-insert, mixed
  with position deletes, partitioned and re-partitioned tables, time travel) through Preview, the SQL console,
  Pipeline Builder inputs, exports, Custom SQL UPDATE / DELETE / MERGE, compaction, upsert; a reader written from the
  spec equals the patched scan on all snapshots of the "(test)" tables; the MERGE (108) and maintenance (13) suites.
  Not tested: a Python transform reading such a table (the hook was added there after the tests), Spark transforms
  (the Iceberg Spark runtime is not installed); other PyIceberg versions log a warning and stay unpatched.
- Done since: virtual Iceberg tables — the "Iceberg REST catalog" connection (Polaris, Snowflake Open Catalog / Horizon,
  Unity Catalog, Glue with SigV4, Nessie…; `connectors/iceberg_conn.py`): namespaces as schemas, previews, syncs
  (cursor ranges pushed down as Iceberg row filters) and virtual-table reads, tested against this platform's own
  REST catalog as the external one (a hospital financial audit case, 11 checks), not against a vendor catalog.
- Marketplace packaging, Jupyter in Code Workspaces and incremental indexing
  of Ontology object types from Iceberg tables are not built. Pipeline Builder incremental Iceberg inputs use the
  row-count watermark over rows in append order.
- Main branch protection maps iceberg:bypass-branch-protection to the Owner role; the maintenance operations map to
  Editor (no custom role sets).
- Not run with sign-in on (tested with sign-in off against a real PostgreSQL Files store, PyIceberg 0.12 and the
  Iceberg Spark runtime 1.9.2).

## 10. Ontology (docs 01–07: Overview, Ontologies, Object and link types, Action types, Functions, Interfaces, Ontology design)
Done on branch `bluesandai123` (see the README's "The Ontology's model"). Not done yet:

### 03 Object and link types
- Needs systems that do not exist here: Gotham type mapping, Gaia object creation and drawing (MILSTD 2525C),
  Marketplace packaging (products, stable / deduplication modes), restricted views (and mandatory controls mapped to
  restricted-view marking columns), CBAC classifications.
- Done since: join tables backed by a dataset, with "Generate join table" (`api/ontology_link_datasets.py`, link type
  menu → Join table dataset); users' link edits are kept apart from the dataset rows.
- Done since: column-wise multi-datasource object types (`api/ontology_mdo.py`, Datasources tab → Additional
  datasources). Row-wise MDOs are not supported, as in Foundry.
- Done since: writeback datasets as materializations (`api/ontology_edits.py`, §10a).
- Done since: mandatory control properties take allowed markings / organizations (values outside them are refused,
  including from actions), are always required and hidden by default; a user needs every marking and one of the
  organizations; on multi-datasource object types a control secures only its datasource's properties. Not done:
  failing a whole re-index on disallowed dataset values (they become null), classifications (CBAC).
  Done since (2026-10-15, ORV): a datasource can "fail the re-index on disallowed values" (`invalid_values`; default
  unchanged: they become null) — property types, value types and required properties checked, the whole re-index
  failing with nothing written; every run carries a bounded report (counts per column / property / kind, the first
  20 rows), shown on the Ontology indexing page, the Datasources tab (a "Disallowed values" card, the report of the
  last failed run, also when saving the mode is refused) and the new-object-type dialog; the changelog card says
  the last row by transaction and row order wins (no ordering column: sort upstream). A manual re-index failing on
  a duplicate key now also records a failed run with its report. Tested: mode off identical to HEAD over 7 steps
  (bad values of every kind, incremental, append, full, changelog), 41 + 19 checks, the RI3 / RI4 storage and race
  suites, equiv 32, verify_watch 69, 24 clicks in headless Chrome. Not done: the S3 read path, two processes in fail
  mode, sign-in on; GET /api/ontology/indexing takes ~150 s on the real data (1,696 types), so the page waits.
- Done since: struct fields mapped to scalar interface properties (`"prop.field"`): validated, read by interface
  searches and views, written by interface action rules (the rest of the struct kept).
- Done since: object and property security policies (`api/ontology_security.py`, §10a).
- Done since: media sources per media property (media sets) and an upload destination; values outside the sources
  are refused, uploads from action forms go to the destination.
- Done since: type classes with behavior — `hubble:media_url` / `icon` / `thumbnail` render URLs as media,
  `hubble:default_sort_descending` sorts Object Explorer, `hubble:quick_filter` offers filter chips, analyzers
  (`analyzer:*` or the Interaction setting: not_analyzed, not_indexed, whitespace, simple, standard, english with
  simple stemming); the Sortable render hint is enforced on string properties whose hints are set. Done since: the
  deprecated `geo:latitude` / `longitude` / `geojson` / `altitude` — Map draws a latitude + longitude property pair
  as points ("lat+lon") and geo:geojson strings as shapes, area filters included, and features carry the altitude
  (tested in-process; Object Explorer's geo filter and Notepad maps still read only geopoint / geoshape; no 3D view).
  Done since (2026-10-12): language analyzers written in Python (no stemming library) — french, german, spanish, portuguese, italian, dutch, russian (stop words, elision, light stemmers after Lucene's, written from memory of the algorithms and not checked against Lucene's test vectors), arabic and combined_arabic_english (normalization, one prefix and common suffixes stripped), japanese / korean / chinese (overlapping bigrams: no morphological dictionary here); the same analysis on stored values and queries; chosen by the Interaction setting or an `analyzer:<name>` type class; 258 word checks and 45 search checks on "Analyzer search (test)". Limits: no verb conjugation, German compounds are not split, no Arabic broken plurals, a CJK pair matches wherever it stands. The property editor's new options were compiled, not clicked. Done since: `vertex:link_merge` (on a type or its property: Vertex Search
  Around offers the objects beyond it — "… via <type>" — and draws the intermediaries as grouped edges; tested
  in-process; done since: link_merge_incoming / _outgoing on a single link type — its target / source side becomes the
  intermediary only along that link, toggled from the link type's menu in Ontology Manager; tested in-process, the menu compiled, not clicked). Done since: an Indonesian analyzer (every plausible root
  of a word: "dirawat" finds "perawatan", "diperiksa" finds "pemeriksaan"; 18 word checks and a search test).
- Done since: converting foreign-key / join-table link types into object-backed link types (link type menu → Convert to object-backed; existing links become backing objects). Done since: the old join table dataset stays in sync after conversion (rewritten from the backing objects' links when they change, checked every 30 s; POST / DELETE …/join-table-sync; tested in-process; no UI button to stop it).
- Done since: the New object type dialog picks ontology groups, generates Create / Edit / Delete actions that only chosen users or groups may run (submission criteria), and sets an object security policy. Done since: plural name, icon and color in the dialog (compiled, not clicked). Done since: "Generate a backing dataset" — an empty Parquet dataset (documents folder) with a column per property, registered as the datasource (tested in-process; no folder picker in the dialog, the route takes a folder).
- Done since: incremental re-index — objects whose values did not change keep their record and updated_at, nothing is written when no object changed, the run reports written / unchanged; the row limit is configurable (`BLUESANDAI_ONTOLOGY_MAX_ROWS`, default 50,000). Not done: the whole dataset is still read on each re-index, so very large types stay slow to index. Done since, 2026-10-12: objects are built incrementally — after each index `ontology/indexing/<type>.rows.arrow` keeps each row's primary key and a hash of its mapped columns (with a signature of dataset, mapping, key, property types, hasher and the store's state); a re-index builds only new or changed rows, rows with user edits (now or at the last index), rows the indexing checks change, and rows of shards another writer rewrote — compared by position first (an APPEND builds only the tail), then by key — and writes only changed shards; it builds every row when the hash file is missing or stale, the signature changed, the type has several datasources, a single-file store was written since, or on Full re-index. Tested: 32 checks where an incremental sharded type, an incremental single-file type and a fully rebuilt type stay identical (keys and property hashes) through updates, same-content versions, appends, deletes + inserts, reordering, NaN / empty values, user edits, schema and mapping changes and every fallback; the 69 auto re-index checks; on 200k rows a re-index takes 8–13 s instead of 10–19 s (the dataset read, store load and indexing checks remain); the owner's 10 dataset-backed types hash fine (read only). Not tested: a concurrent write during an index, the live API. An edit makes the next re-index of a single-file type build every row. Done since (2026-10-13, d3a0579): datasets of 2 MiB+ read by byte ranges (S3 or local) and decoded per row group in 65,536-row batches; when every transaction since the last index is an APPEND only the new row groups are read (row-group fingerprints next to the row hashes); changelog datasources (`changelog`, `deletion_column`: last row per key wins, a Boolean column deletes); `run["read"]` statistics shown in the Changelog step. 400,000 objects, every step identical to a full re-index (13 checks): APPEND 10.6 s / 163 MB vs 32.3 s / 521 MB full, changelog APPEND 11.6 s vs 29.8 s, a SNAPSHOT with 2,500 changes 28.5 s / 38 MB vs 32.7 s / 409 MB; re-run at 20,000 rows and the storage suites (40 + 74 + 43 checks, temp dirs). Not done: ~8–11 s fixed cost at 400k (loading and comparing stored objects), no UI for the changelog setting, the S3 rewritten-during-read path not exercised. Done since, 2026-10-13: a re-index no longer loads every stored object — when the store is as the last index left it, the stored key set comes from the hash file (minus user deletions, plus user-created objects) and only the keys the run touches are loaded and saved (`ontology_store.save(..., count=)` reads and rewrites only those keys' shards, or reports `whole_set_needed` for unshard / re-shard / single-file stores); a Full re-index or a store another writer changed still assembles everything; at 400k the fixed cost per run went from 5–8 s to 1.5–2.5 s (first re-index 7.6 → 1.5 s, 380 → 66 MB; APPEND 10k rows 10.6 → 5.1 s; SNAPSHOT runs ~19–22 s, still reading and hashing the whole dataset). The changelog setting has UI: a Changelog card in the Datasources tab (on / off, a single Boolean deletion column, Save / Discard) and in the new-object-type dialog (a repeating column can be the key only with changelog on). 13 + 13 checks identical to a full re-index at 400k and 20k, 32 + 40 + 69 earlier suites, 480 crash-at-every-step checks of the count save and the 40 + 43 + 74 store suites (temp dirs), 8 changelog API checks and 24 clicks of the setting in headless Chrome with the in-process API. Not tested: two processes writing during a re-index, the S3 rewritten-during-read path, sign-in on.
- Done since (2026-10-12, bbc5086): sharded object storage (`api/ontology_store.py`) — a type reaching 20,000 objects (`BLUESANDAI_ONTOLOGY_SHARD_THRESHOLD`) moves on its next save to `objects/<id>.shards/` (shard = crc32(primary key) mod a power of two, ~2,048 objects each, a manifest renamed into place as the commit; new shard files are written, never rewritten in place); a save rewrites only shards whose content changed, or only the edited keys' shards (`apply_edits`); smaller types keep the single file byte for byte. Every module reads and writes through `ontology.load_objects` / `save_objects` / `objects_stat`. Tested in-process (37 checks): 50,000 objects, one edit rewrites 1 of 32 shards (13 ms vs 229 ms for the whole file), crashes at each step of migration and saves, a stray single file kept aside, re-sharding on growth, readers during saves; the owner's types are below the threshold and were left untouched. Shards shrink and unshard since b2367c2 (when another process unshards a type, its dead shard cache entries are dropped since 2fda104; 74 shrink / unshard checks with crash injection at every step and 43 cache checks with subprocess saves); the running API on port 8000 still has the old code (restart needed before any type crosses the threshold). Done since (2026-10-12): a sharded type that shrinks below half the threshold moves back to one file (temp file fsynced, marked in the manifest, renamed, manifest deleted as the commit, shards removed), leftovers of interrupted saves are cleaned by the next save, and — a defect of the earlier code — a save no longer fails with PermissionError on Windows while reader threads of the same process keep the file open (readers pause up to 1 s while a save retries its replace; reproduced on the earlier code: 9 of 43 saves failed, now 0 of 150). 1,468 checks on temporary directories only: every crash point of both directions, aborted in-process and with the saving process killed, leaves the complete old or new state and the next save cleans up; hysteresis; a 5,000-object round trip; cache freshness; readers during saves. Not covered: power loss (the plain single-file save does not fsync), two processes saving one type at once.
- Done since (2026-10-14, RI3): SNAPSHOT re-index of large types skips unchanged row groups — each run records a
  fingerprint per row group (hash of the bytes of the columns it reads); a group seen before (even moved in the file)
  is not decoded and its rows come from the last index, except groups holding a user-edited row or an object missing
  from the store, and moved groups of changelog datasources (a key whose later versions were removed forces a full
  read); S3 datasets read from the newest transaction's local copy when its MD5 matches the ETag
  (`BLUESANDAI_ONTOLOGY_LOCAL_COPY=0` turns it off); run statistics show groups skipped. 400,000 rows: SNAPSHOT with
  20 rows changed 20.8 s → 1.1 s, 1,000 updated / deleted + 500 inserted 24.2 s → 2.6 s, rows shuffled 29.5 s → 2.4 s,
  50,000 changed 25.9 s → 17.8 s. Tested: 26-step 400k bench each compared with a full re-index, 40 + 32 equivalence
  checks, 33 unit, 40 + 74 + 43 storage checks on temporary directories, 13 at 400k. Not done: S3-only reads (local
  copy off or stale) are no faster (the bytes must be fetched to fingerprint); the auto re-index watcher suite failed
  2 of 5 runs (a parallel re-index by the live API process, not proven unrelated) (done since, 2026-10-14, RI4: two causes — a real race: every process importing server.py ran its own watcher on the same data directory, so two could re-index one type at one version and the second recorded an extra 0-change "datasource update" run; now one re-index of a type at a time across threads and processes (an OS byte lock in indexing/.reindex.lock, re-entrant in a process; a re-index asked for waits up to 600 s then runs anyway, the watcher's step waits 30 s and decides again from the type as stored, reporting a change another holder dealt with as "by": "another re-index"), and one background watcher per data directory (indexing/.watcher.lock; BLUESANDAI_ONTOLOGY_WATCH_ALL=1 turns it off); and faults of the suite itself — it counted reads of the API's background threads and assumed a 2 s settle window. Tested: a two-process race on HEAD fails 4 / 4 and passes 4 / 4 now, the corrected suite 10 runs in a row, 33 overlap (threads, processes, a killed holder) and 24 lock checks, the RI3 storage suites and bench; the overlap test failed once on its own ordering while other suites loaded the machine, then passed twice. Not done: the POSIX branch of the lock not run (Windows here); the live API still runs the old code until restarted); multipart ETags other than 8 MiB
  parts only tested synthetically.

### 05 Functions
- Done since: TypeScript v2 functions — exported functions of a repository's `ts-functions/src/**/*.ts` are published with its Python functions (`language: "typescript"`) and run with Node (`api/functions_ts.py`, `api/ts_runtime/`): signatures read by the TypeScript compiler (string, Integer / Double, boolean, Timestamp, arrays, `Osdk.Instance<T>`, `ObjectSet<T>`, custom types), an injected `Client` (object sets with where / fetchPage / fetchOne / aggregate / asyncIter), `createEditBatch` edit functions declared by `Edits.Object<T>`, staged writes with `WriteableClient`, `UserFacingError`; they run as the caller (job token) and work in function-backed actions. Tested end to end against an in-process API. Not done: TypeScript v1 (decorators), `@osdk/foundry`, npm dependencies of the repository, a TypeScript repository template, use in Pipeline Builder (Python only, like Foundry). Done since, 2026-10-12 (bde3bff): `where()` takes `$and` / `$or` / `$not` at any depth (plus property `$not`, term matches, `$within` / `$intersects`, array `$contains`; malformed clauses fail at the call; paging to 100k, `nextPageToken`, grouped aggregations), v1 decorators (`@Function`, `@OntologyEditFunction`, `@Edits`, `@Query`) with synchronous `Objects.search` / `Filters` / links through a worker thread and recorded edits (`@Edits` enforced), a TypeScript functions repository template (README, package.json, tsconfig, example query / edit / unit tests) in the new-repo dialog, and commit checks that compile TS files and run `*.test.ts` unit tests. Tested: 61 where() checks against an independent Python evaluation (70 random nested clauses), 84 template / v1 checks, the 53 TS query / nested staged write checks. Not done: `@osdk/foundry`, npm dependencies, type errors in checks (syntax only), v1 phrasePrefix / link presence filters; the new-repo dialog not clicked. Done since, 2026-10-12 (eb1091f): `@osdk/foundry` (users, groups, datasets and files, folders, projects, Ontology objects / links / actions / queries, `Functions.Queries.execute`; sub-package imports; `PalantirApiError`; missing APIs say "not available"), type errors in commit checks (the `typescript` compiler API from web/node_modules against bundled SDK types, non-strict, about 0.3 s per check, `BLUESANDAI_TS_TYPECHECK=0` turns it off), v1 `phrasePrefix` / `prefixOnLastToken` and `link.isPresent()`; tested: 14 type-check, 16 platform and 17 v1 filter checks, the docs' v2 examples type-check, and the earlier TS suites (49 direct / interface edits, 40 nested staged, 84 template / v1, 61 where, 53 queries); not run: the real LLM call through `Functions.Queries.execute`; still not done: npm dependencies, media set and other platform APIs, Arrow `readTable`. Done since, 2026-10-12: in a TS staged-write run, what a called function writes without staging (an action it applies) joins the run's edits right after the call and at the end (`POST /api/ontology/staged-writes/{sid}/direct`, as the Python runtime since cdcc5c8 — before, such an object was lost); interfaces in TypeScript v2 — `Osdk.Instance<Interface>` inputs / outputs published as `interface:I` (the registry checks the object implements it), `$objectType` / `$as(Type)`, struct fields mapped, `Edits.Interface<I>` declares every implementing type, and `batch.create(I, { $objectType, ... })` / `update` / `delete` edit through the interface (struct fields merged into the current value, the primary key's interface property refused, bad edits refused at the call). Tested: 49 checks with a published "(test)" repository (11 direct-write checks, failing on the previous runtime; 38 interface checks incl. staged runs, function-backed actions and edit permissions) and the 40 + 84 + 61 + 53 earlier TS suites. Done since, 2026-10-13 (065c331): v2 `where()` takes `{ $interval: { $match, $prefixOnLastTerm, $ordered } }` (phrase prefix / prefix on the last term in any order / whole-word phrases); tested: 38 checks (90 random nested `$and` / `$or` / `$not` clauses equal in TS, the Python SDK and a reference evaluator; 6 `$interval` cases, 3 refusals) and the 8 TS3 suites (334 checks); other `$interval` rules (`$anyOf`, `$allOf`, `$maxGaps`) are refused.
- Done since: Python functions as Pipeline Builder UDFs — Reusables → User-defined functions imports published functions without Ontology types; the step maps columns to inputs, runs the function once per row in one repository-runner call (POST /api/functions/tools/pipeline-udf/run, 10,000 rows per call) and writes the result to a new column; a struct comes out as JSON text (there is no struct column type), a failing row gets null; `FoundryClient()` raises EnvironmentNotConfigured inside a UDF. Tested end to end with a published "(test)" repository (the runner), not clicked through in the Builder UI.
- Done since: functions on global (Ontology) branches — publish towards a version target on a branch (function page → Versions → Global branches, POST /api/functions/publish-branch): a "Branched pre-release" used only by runs on that branch (`branch` on execute), newest publish wins for the target; merging the branch publishes the target on main from the last branched release, closing drops them. Tested end to end with a "(test)" repository. Done since (2026-10-13, ef785b1): Workshop / AIP Logic / actions in a branch context — each open branch has a persisted Ontology scenario (reads see main plus the branch's edits, actions write only there, merge / close end it), `POST /api/ontology/branches/{id}/context`, `/branches/{id}/logic/{logic_id}/run`, function lookups take the branch from the scenario header; rebasing — `/api/functions/branches/{id}/status` and `/rebase` (newer main versions, stale targets retargeted, 409 for a target main already has, pinned resources listed), a stale target blocks the merge; Workshop `?branch=` with a branch bar and "Rebase functions". Tested: 42 + 6 in-process checks and the earlier branch-function test (main unchanged), 16 checks of the Workshop page in headless Chrome. Done since (2026-10-13): branch controls on the pages — AIP Logic (a Branch select; the run and its history name the branch and the function versions that ran), Logic Flows (an "AIP Logic runner" automation built or scheduled on a branch; a schedule whose branch is closed or merged is refused and paused), and the function page (Run on a branch with the version the branch resolves to — `GET /api/functions/{fid}?branch=` —, branch chips in the run history, an "On a branch" card with pre-releases, rebase and retarget); closed, merged and unknown branches are refused by name. 20 + 26 checks in-process, the earlier 42-check branch suite still green, and 24 checks in headless Chrome on the three real pages (bundled without the Next router or styles; the first three suites re-run at commit). Not tested: with sign-in on; a scheduled flow through the cron tick (the scheduled run was called directly); streaming a function on a branch from the Run tab; the retarget box and the Logic Flows create dialog (compiled only).
- Done since: Workshop module variables from function outputs — a function widget writes its result to an output variable; other widgets read it as `$var:name` (function inputs, so functions chain; filter values of data widgets) and `{{name}}` in text widgets. Variables live for the session (not saved with the module); checked by typecheck / lint and a compile of the page, not clicked through in a browser.
- Done since: consistent snapshots — a run with snapshots (the version's setting "enabled", or "default" for function-backed actions) sends `x-bluesandai-snapshot`; each object type is frozen at the run's first read of it, so later reads (objects, links, searches, aggregations) see the same data while writes always use the live data. Tested in-process. Done since, 2026-10-12: one point in time per run — `functions_registry.execute` opens the snapshot when the run starts and releases it in a `finally`; while any snapshot is open, object and join-table link writes keep pre-images of only the objects they change (copy-on-write; a sharded type reads only the changed objects' shards), so every type the run reads, whenever it reads it, shows its state at the run's start; queries called inside the run share its snapshot (only the outer run closes it); `apply_edits` always writes from live data; at most 256 open, 15 min expiry kept. 36 in-process checks on "(test)" types (read A, another writer edits A and B, B read as before the edit incl. searches / aggregations; writes stay live; concurrent runs independent; memory released; links; a sharded type; nested queries) plus the earlier snapshot, scenario, staged-write and edit tests. Workshop and AIP Logic reads stay live (the docs give snapshots to function-backed actions and their queries only). Not done: writes from another process are not seen (that type is pinned at its first read); an object deleted after the run started returns at the end of the type's order; not tested with a real published repository run in a subprocess or the TypeScript runtime.
- Done since: `foundry_sdk.FoundryClient()` inside Python functions with the read scopes of Foundry's function client — `admin.User.get` / `get_current`, `admin.Group.get`, `functions.Query.execute` (API-named queries and a Palantir model's CreateChatCompletion, answered by the default model), `media_sets.MediaSet.read`; datasets are refused (`api/platform_sdk.py`). Tested in-process. Not done: orchestration (builds, schedules) and the rest of the platform API surface.
- Done since: the ChatCompletion function interface (registered models) — `@function(implements="ChatCompletion")` with a first input `messages: list[dict]` (checked on publish); its latest release is listed with the language models (`function:<id>`) and every language model call of the platform (AIP Logic, Pipeline Builder's LLM step, agents) can use it, structured answers parsed from its JSON text. Tested end to end with a published "(test)" repository. Done since (2026-10-12): the Embedding function interface — `@function(implements="Embedding", dimension=…)` (signature and dimension checked on publish) is a registered embedding model `function:<id>`, listed wherever an embedding model is chosen (semantic search config, vector properties, Pipeline Builder's Text to embeddings, vector indexes, the Model Catalog) and used by the platform's embed paths, with the dimension checked on every answer; a ChatCompletion function returning `Iterator[str]` streams (POST /api/functions/llm/chat/stream, a "Try it" box in the Model Catalog); the Model Catalog in Code Repositories lists registered chat and embedding models; models of a repository the caller cannot see are not listed and refused; query vectors of registered models are not cached. 65 checks in-process with "(test)" repositories computing embeddings locally (publish refusals, every embed path, dimension mismatches, semantic and KNN search finding the expected objects, stream order, the earlier ChatCompletion checks). Not checked: the UI (compiled only), a real second user (visibility was simulated), a Vector Storage index run with a registered model, TypeScript functions implementing an interface. AIP Logic, Pipeline Builder's LLM step and agents still take a registered model's joined text (no streaming there).
- Done since: interfaces as Python function inputs and outputs (Foundry has them in TypeScript v2 only) — `from ontology_sdk.ontology.interfaces import X` (an object of any implementing type, read through the interface's properties, `as_object()` for the concrete object) and `interface_object_sets.XObjectSet` / `client.ontology.interfaces.X` (where / iterate / take / count over every implementing type); the registry resolves `{object_type_id, primary_key}` and `{objects: [...]}` inputs. Done since (2026-10-12): interface parameters in Workshop function widgets — an input typed by an interface, an array of it or an interface object set is bound to the selected object, an object / object set variable or every object of the interface (checked through the functions execute route and 19 checks of the value helpers; the config field compiled, not clicked). Not done: interface edits from functions. Done since, 2026-10-12 (cdcc5c8): `edits.interfaces.<Interface>.edit / create / delete` in Python functions (interface properties written to the mapped type properties, structs merged, the key property not updatable, `edits=[<Interface>]` covers implementing types, actions enforce declared types and permissions); also fixed: object / list / object set arguments a Python function passes to a query arrive in the registry's shape (wrong types refused), and a nested function's non-staged writes inside a staged run are kept (`POST /api/ontology/staged-writes/{sid}/direct`, merged at each sync, returned in `direct` at the end). Tested: a before / after script (each fix fails on the previous code, passes now), 98 PF checks and the earlier function suites (nested staged, snapshots, TS queries, staged writes, interfaces, scenarios, Workshop interface widgets). Not done then: the same direct-edit collection and interface edits in TypeScript (follow-up running).
- Done since: staged writes in Python functions — `@function(beta=True, edits=[...])` with a `WriteableClient` first parameter (injected, not an input); `client.ontology.staged_writes()` edits go to a hidden temporary scenario synced before every read (header `x-bluesandai-scenario`), so searches and aggregations see them; the function returns any value, its edits are committed by the function-backed action, and an exception discards them. Tested in-process (runner calls routed to a test client). Done since, 2026-10-12: nested staged-write calls — a query or staged function called from a staged run (`client.ontology.queries.<name>(…)` or `functions.Query.execute`) runs in the caller's hidden scenario as a layer (`<scenario>~<layer>`), reads the caller's staged edits, and returns its own edits to the caller (later edits win), so the action commits them together; any failing nested call discards every staged edit (as the docs say), even when the outer function catches it; a staged function may be called through `/queries/{api}/execute` only inside a staged run; a Python run can call a TypeScript staged function (the transaction found from the run's job token). 40 in-process checks on "(test)" types (two levels deep, the SDK path, caught and uncaught failures, actions committing or applying nothing, a TS nested call through Node on a side uvicorn) plus the snapshot (36), staged, scenario, edit and TS staged-function tests. Done since (2026-10-12, 55b7a41): queries callable from TypeScript functions (`export const config = { apiName }` publishes a TS query; `client(query).executeFunction({...})` or `$Queries.<name>` calls TS, Python and model functions with arguments checked against the signature and typed results — objects as `Osdk.Instance` loaded in the run's scenario, object sets as `ObjectSet`; inside a staged run a query reads the staged edits, a staged query's edits join the caller's batch, any failing nested call discards everything) and nested TS staged calls join the caller's transaction without a signed-in user (`BLUESANDAI_STAGED_PARENT`); TS functions now check their scalar inputs. Tested: 53 in-process checks (TS→TS / TS→Python, refusals, one transaction across TS and Python staged queries, caught and uncaught nested failures, function-backed actions, sign-in off) plus the 40 nested staged-write checks. Not done: (`where()` with `$or` / `$not` in the TS runtime — verified done since bde3bff, 2026-10-13: 37 checks running each case as TS `where()`, the Python Ontology SDK and an independent evaluator on 60 "(test)" objects, incl. 90 random nested `$and` / `$or` / `$not` clauses 4+ levels deep and the `$interval` cases); the UI and a signed-in / job-token run not tested; a nested function writing without staging (e.g. applying an action) is overwritten at the caller's next sync. (TypeScript staged writes exist since a077eb4: the TS runtime's writeable client stages edits the same way.)
- Done since: attachments and media in Python functions — `Attachment.read()` / `get_metadata()`, `Media.get_media_content()` / `get_media_metadata()` / `get_media_reference()` (object properties of those types come wrapped), `FoundryClient().ontology.attachments.upload(path, name)` (My Project / Ontology / Attachments) and `.ontology.media.upload_media(body=, filename=)` (the property's upload destination when given), through `api/ontology_attachments.py` (50 MB per file). Tested in-process (the runner's platform calls routed to a test client), not in a repository runner subprocess. Done since: uploads no object refers to after 24 hours go to the trash (hourly sweep, or POST /api/ontology/attachments/cleanup for admins; tested in-process).
- Done since: Quiver function cards — a published function on the canvas (Function button), inputs as values or the analysis's object set cards, the result as a number, table, aggregation or object set; saved with the analysis. Not done: Slate function integration (Slate is being built in a separate session), Marketplace packaging of functions (needs a Marketplace).

### 04 Action types
- Done since: batched execution of function-backed actions — the function must take one list-of-structs input (checked), the rule maps struct fields, a batch (apply-batch, inline edits) runs the function once with an entry per call and applies all edits as one group; a single call passes a one-entry list. Tested with an in-process stand-in function, not with a published Python function.

### 06 Interfaces
- Done since: interfaces in Pipeline Builder outputs — an object type output can "Register in the Ontology on deploy" (first deploy creates the object type from the output dataset, later deploys re-index it) and implement Ontology interfaces with a per-property mapping, validated like any implementation (POST /api/ontology/object-types/from-pipeline-output). Tested in-process against the endpoint; a deploy from the Builder UI was not clicked through.
- Done since: interface-based object sets in Workshop — an interface is a widget source (the objects of every implementing type under the interface's properties, plus an "object type" column; filters, grouping and metrics work on it). Done since (2026-10-12): actions on a selected interface object from Workshop — a button or an inline action on an interface source runs the concrete action for the selected object's type (POST /api/workshop/interface-action: the action chosen for that type, else the interface's action constraint as the type maps it, else an interface action, else the configured action when it is the type's own), parameters prefilled, refusals naming the type and the reason; 38 checks in-process on "(test)" types and the module "Interface functions + actions (test)". Not checked: anything in a browser; the inline action form (compiled only, it uses the first configured action); interfaces that extend another. Done since, 2026-10-12 (80e8179): the inline action form offers every configured action that applies to the selected object (`POST /api/workshop/interface-actions`: the type's own action first, then the constraint as the type maps it, then the listed actions; the others returned as refused with the reason), a menu when several apply; constraints and actions found through interfaces that extend another (also a fix to `/interface-action`, which looked only at the first implementation); 23 in-process checks on "WS3 … (test)" types and the module "WS3 interface inline actions (test)"; the menu compiled, not clicked; the action button still runs one action.
- Done since: interfaces as function types (see 05). Not done: a generated OSDK.
- Marketplace packaging of interfaces.

### 07 Ontology design
- The design review is heuristic (names, property overlap, null rates, counts); it cannot judge domain meaning.
- Done since: review history (a snapshot whenever the findings change: score, counts, findings added / resolved) and
  branch reviews (the branch's version of the ontology, findings new / resolved vs main, shown on the proposal tab;
  snapshots carry the proposal), and merge blocking (a setting: proposals whose branch introduces high-severity
  findings cannot merge until they are fixed or dismissed).
- Done since: team races (drill → Team race): a live timer and scoreboard, participants join from their browser and
  the object types, links and searches they open in Object Explorer / object views are recorded as their path,
  answers are judged (auto when equal to the expected answer), finishing turns them into sessions; JKN demo drill
  "Validasi ontologi klaim JKN (demo)". Fixed since: Object Explorer searches, object views and Insight searches only
  showed the recording badge and did not report — they now send the type, links followed, terms and object opened
  (compiled, not clicked through); Quiver object set cards report too. Not done: capture from Workshop, a
  multi-browser run (tested in-process only).
- Done since: "Run with an AI agent" queries the data — step by step searches (filters, links followed) and
  aggregations as the signed-in user, until it answers; path, searches and a transcript are recorded and answers
  matching the expected answer are judged correct (the plan-only mode remains). Run with gemini-3.5-flash on the JKN
  demo drill: 2 of 3 answered correctly; the third needs a per-claim difference (tarif RS − INA-CBG), which the
  agent's search / aggregate tools cannot compute, so it is recorded as "no path". Done since: a derived expression for the agent — a safe
  arithmetic formula computed per object as `derived`, usable in filters, sorting and aggregations. Rerun with
  gemini-3.5-flash: questions 1 and 2 right; on question 3 the agent did compute tarif_rs − tarif_inacbg per claim
  but left out the risky-claims filter and summed negative differences too (−89,000 instead of 1,157,000), a
  reasoning slip rather than a missing tool. Done since: published functions as agent tools (the agent sees up to 30 functions without edits, calls one with JSON
  inputs and reads its value; tested with the model stubbed, not in a real drill run — no published function fits the
  JKN questions).

### Not yet verified end to end (built, tested in-process only)
- A function calling a REST API source or webhook (`/api/functions/sources/*`): the test database had no Data
  Connection tables, so only the refusal path ran.
- Automatic re-index when a backing dataset updates (`ontology_datasources._watch`, every 30 s): done since,
  2026-10-12: run against real Parquet datasets in Files (S3-backed, project "Auto re-index (test)", 69 checks with
  `watch_once()` called in-process): change detection by one Files lookup without reading the file, a version indexed
  within 2 s of its stamp confirmed once by content hash, failures recorded once and not retried until the dataset /
  mapping / types / row limit change, the row limit checked from the Parquet footer; covered: nothing changed (no read,
  no write), rows added / changed / removed, same content rewritten (0 written), user edits winning, schema changes,
  empty / bad / trashed files, pipeline SNAPSHOT / APPEND and model deployment writers, 50,000 / 50,001 rows, markings
  inherited. Fixed: a failure recording indexing usage (usage.json held by another process) after the objects were
  saved failed the run and was never retried — now logged only. Not tested: the real 30 s background thread (its body
  is `watch_once()`), the live API before its restart.
- "Run with an AI agent" in drills and `functions.language_models.embed` (both need an OpenRouter key).
- Email delivery of action notifications (only the in-platform inbox was checked).
- The interface implementation dialog and the "From a dataset" wizard were opened, but not clicked through to a
  save in a browser.

- Done 2026-10-13 (5bd4f4f): a nested call's unstaged writes inside a Python staged run join the run's transaction
  (`POST /staged-writes/{sid}/direct/add`); the run's own action writes are collected after each of its calls, so edit
  order holds both ways; any failed nested call dooms the run even when caught; a staged-write function called as a
  plain query is refused ("queries are read-only: …"). TS `where()` `$interval` — `$match` with `$ordered`,
  `$maxGaps`, `$fuzzy` / `$fuzziness`, `$prefixOnLastTerm`, `$anyOf`, `$allOf` (non-overlapping parts, at most 12 in
  any order) — matching the new server-side interval filter of the object search (`interval` op in
  `api/ontology_explorer.py`: typo transpositions count as one edit). Tested: 21 new NW checks plus 47 / 40 / 36 / 98
  earlier staged-write checks and the TS3 suites; 80 TI checks against the REST filter and a brute-force evaluator
  (120 random nested clauses), 59 + 38 earlier ones; 53 TS query checks. Not done: TS still evaluates interval rules
  itself after a narrowing search (it does not send the server filter); a run's own failed action call that it catches
  does not doom the run; nothing run out of process or signed in. Done since (2026-10-13, TI2): TS `where()` sends
  `$interval` rules to the server's `interval` filter in the same search as the other conditions (array properties
  and the phrase-prefix form too), so only matching objects are loaded; a `$match` with more than 12 words in any order
  (the server refuses 13) is still checked in Node; `BLUESANDAI_TS_INTERVAL_LOCAL=1` forces the local check. Tested:
  55 checks on 90 "(test)" objects — 25 cases equal between server and local paths, a brute-force reference and the
  REST search; 2,803 objects loaded against 8,338 locally (every server case strictly fewer); the 80 + 59 TI, 53 TS
  query, 334 TS3, 40 + 36 staged-write checks. Not done: a where() with `$or` / `$not` still loads every object of the
  type; no "too broad" budget for interval rules on the server.

- Done 2026-10-14 (8809321): TS `where()` sends `$and` / `$or` / `$not` with interval and other clauses to the
  server as one filter tree (filter trees in the object search, `api/ontology_explorer.py`), so nested clauses no longer
  load objects for local evaluation (`$or` of two intervals: 79 objects loaded instead of 452); results equal the local
  evaluation, REST and a brute-force reference. Tested: 40 tree checks plus the earlier TS / interval / search suites
  (27 suites; `ts_queries` and `ts_direct_iface` pass when not run concurrently with another suite). The older TI2
  check that looks for a flat interval filter now reports "not sent" for `$or` (the tree is sent instead) — expected.

- Done 2026-10-15 (89a6011): consistent snapshots hold across API processes and keep deleted objects in place —
  open snapshots and the pre-images of what changes are shared through `data/ontology/snapshots/` (an open registry
  and a change log appended before every object save / join-table link write while any snapshot is open; a type's
  first read under a snapshot in any process is the live data with those pre-images put back), deleted objects
  return at their original position (each delete record names its predecessor; undone newest first; sharded types
  too), logs pruned when snapshots close, snapshots of dead processes dropped. Tested: 146 checks with two processes
  on a temp store (fails on the old code), 18 with two API processes on ports 8241 / 8242, the earlier 36 and the
  storage cache / shrink suites. Not done: a published-repository run in a subprocess and the TS runtime not run; a
  write racing the snapshot's registration counts as before the run; a whole-set save that reorders a type is not
  rebuilt in the old order; it reads ontology_store's private `_manifest` / `_seq_map` for sharded delete positions.

## 10a. Ontology apps (docs 09–25 of the Ontology reference)
Audit 2026-10-09: these pages were static mockups with made-up data; each is being rebuilt on the real Ontology.
- Done: Ontology search (doc 09): search syntax (terms, phrases, wildcards, Lucene regex filters gated by the Regex
  queries / Leading wildcards hints) and derived properties at query time (`api/ontology_search.py`,
  `/ontology/search`). Done since: derived properties in Automate object set conditions (filters can test them; computed
  from the object's current links — an edit of a linked object does not trigger by itself) and in the OSDK (search
  `derivedProperties`, the generated TypeScript client's `withProperties`; no Python SDK is generated here); the
  page was not clicked through in a browser (tested in-process: TestClient on the real data, "(test)" object types).
- Done: Ontology scenarios (doc 10, `api/ontology_scenarios.py`, `/ontology/scenarios`). Done since: the Workshop
  widgets (section 20). Done since: scenarios in the OSDK (the scenario header on /api/v2; `withScenario` in the generated
  TypeScript client; no Python SDK is generated here). Not done: persisted
  scenarios stored as objects of an "Ontology Scenario" interface (they are records with a review status). Done since:
  AIP Logic runs in a scenario (the run panel's Scenario picker; reads see it, applied edits go to it, the run records
  it; tested in-process, the picker compiled, not clicked). Done since: functions called inside a scenario read and write in it — the run spec carries the
  scenario and the Python and TypeScript runtimes send it as the scenario header on their platform calls (a function
  with staged writes keeps its own hidden transaction on main); tested in-process with the runner and HTTP stubbed,
  not with a live run. Tested in-process (TestClient, "(test)" types and scenarios kept); the page was not clicked in a browser.
- Done: object and property security policies (doc 22, `api/ontology_security.py`, Security tab,
  `/object-permissioning`). Not done: restricted views and CBAC (products not here), (done since: object types inherit their datasources'
  markings, and owners holding a marking can stop inheriting it — Security tab → Datasource markings; tested with sign-in
  simulated; no existing type had marked datasources), materialization markings (done since: a materialized dataset inherits the object type's
  and its backing dataset's markings, recomputed on each build; tested in-process). Tested in-process with sign-in switched on for the read checks.
- Done: object edits and materializations (doc 24, `api/ontology_edits.py`, `/object-edits`). Before this, a re-index
  overwrote user edits to mapped properties. Not done: edits recorded before this change are not in the layer (the
  demo's earlier objects count as data), multiple datasources, markings on materialized datasets, the Workshop Edit
  History widget. Tested in-process with Files (PostgreSQL) for the dataset re-index and materialization.
- Done: indexing runs and data restrictions (doc 23, `api/ontology_indexing.py`, `/ontology-indexing`), the
  Overview (21) and Object databases (25) pages with real numbers. Not done: Funnel streaming pipelines and direct
  datasources (no streaming-backed object types), changelog (incremental) datasets with deletion columns, a real
  incremental write (a re-index still rewrites the type's object file; "incremental" describes the changelog size).
- Done: Vertex (doc 15, `api/vertex.py`, `/vertex`); since: system flow graphs — the System flow layout (object
  types as columns), icon nodes, curved / orthogonal edges with arrows, objects grouped into edges labelled and sized
  by a count or sum (link merging per graph), the histogram (filter to / out), the series panel (linked objects per
  day / week / month, Open in Quiver), undo / redo; JKN demo graph "Alur risiko faskes JKN (demo)". Not done:
  the sunset model runs (Model Config / Simulation; done since: the recommended route — a What-if panel running
  Actions in an Ontology scenario and comparing the graph's objects with main property by property), Ontology-level
  link merging (done since: edge-direction type classes — vertex:link_primary_direction / link_undirectional /
  link_bidirectional on a link side, set from the link type's menu in Ontology Manager (Vertex arrows: toward either side, none, both), and per graph an Edges
  panel: color, dashed, arrows as the Ontology says / reversed / none / both; the default arrow still points at the
  target, not the Ontology's documented one-to-many default; tested in-process) (done since: derived property and Search Around functions — published
  functions taking the selected objects (one object per call, an array or an object set) and returning objects add
  them with edges kept on the graph; returning a value they are derived properties of a layer, usable as the label;
  tested in-process with stubbed function runs — no published function here takes a graph's object types; done since: a media layer —
  a Files image under the graph, annotations as labelled rectangles set by numbers, not drawn with the mouse, objects
  pinned by pixel-coordinate properties; validation tested in-process, the drawing compiled, not looked at in a browser), Marketplace. Done since (2026-10-12): the Workshop "Vertex: Graph" widget (`GraphWidgets.tsx`: a saved graph or a template run with parameters from variables, drawn like the Vertex page, read-only; selecting nodes selects the object in the module and writes the selected objects — and every object on the graph — to object set / filter variables; events on selection; in a browser on "Graph widgets (test)": the demo graph drew, choosing a node set the variable and filtered the table beside it; not built: zoom to an object set, sub-graph selection, in-graph actions, time configuration, saving from the widget; done since, 2026-10-12: zoom to an object set (a variable, optionally of one type; the view fits those objects, "Show the whole graph"), in-graph actions on the selected object (none / chosen / all of its type, up to 3 buttons + "More actions…", the platform's action form, events and reloads after applying, off in kiosk mode), Search Around from the selected nodes (link types with counts, added objects placed right of their source, kept only in the widget, output variable, "Remove N added") and "Save as new graph" (never over the configured graph); 25 in-process API checks on real data, 38 helper checks, 49 checks of the real widget in headless Chrome with recorded API answers; not tested: Search Around through link-merged hops and from several objects in the browser, the settings panel (compiled only), the real app on port 8000 before its restart; still not built: sub-graph selection, time configuration; done since,
  2026-10-12 (cdcf599): sub-graph — a variable keeps only the connected parts holding its objects (optionally of one
  type), "Objects on graph" outputs only those; selection tools — box select (Shift-drag or Box mode), Shift-click,
  a Select menu (neighbours, connected, same type, all, invert, clear), one output variable per object type; time —
  a window from two date / timestamp variables or the widget's own panel reloads the related events, objects outside
  it are faded, the selected time limits event badges, and node readouts (`/api/vertex/readouts` now takes start /
  end) cover the window up to the selected time with threshold colors; 91 helper checks, 14 time-API and 25 earlier
  API checks on real data, 102 checks of the real widget in headless Chrome with recorded answers; not checked in
  the real app page). Done since: saved selections (with the graph) and saved styles
  (named layer / edge styles applied to any graph), the Notepad Vertex graph widget, time series readouts on nodes (a
  layer's time series property: last / mean / min / max / first in the label, threshold colors; 50 nodes at most). The flow view was compiled,
  not looked at in a browser.
- Done: Machinery (doc 16, `api/machinery.py`, `/machinery`), with subprocess hierarchies (a process nested through a
  link type covers the objects linked to its parent's; metrics and outputs can focus on parent states; tested
  in-process, the Nested panel compiled, not clicked through in a browser; a subprocess shows its parent's states as a
  strip above its graph, with child counts, clicking one focuses on it). Done since (2026-10-12): parent and subprocess as one nested drawing —
  a state with subprocesses expands in place into a box holding each direct subprocess's graph, counted over the
  objects linked to parent objects in that state; expand / collapse all, metric views, Sankey and selection on both
  levels; edges route around boxes (`web/src/lib/machineryLayout.ts`; 25 layout checks in Node — no overlap, children
  inside their box, no edge through a box, the flat layout unchanged — and 18 read-only API checks that the nested
  counts equal the scoped metrics; the page compiled, not opened in a browser; back edges are now drawn as right-angle
  routes; grandchildren are not nested; the Workshop Machinery widget keeps the flat drawing). Not done: the
  Marketplace log pipeline (the log is computed in the API instead). Done since
  (2026-10-12): the Workshop "Machinery" widget (`GraphWidgets.tsx`: one process with its states, transitions,
  metric views and Sankey thickness; an input object set variable for the root process; clicking states or
  transitions writes their objects to an object set and / or filter variable — objects currently or ever in a state,
  ever or last through a transition; POST …/metrics and the output route take the input keys; 24 API checks, and in
  a browser on "Graph widgets (test)" the process drew and choosing a state filtered the table beside it). Not
  built: custom metric views with conditional coloring, several processes in one widget, the path explorer. Done
  since, 2026-10-12: custom metric views (a node metric — built-in or a property aggregate — with number formatting
  and first-match coloring rules, an optional edge metric and Sankey edges; in the view selector, can be the first
  view), several processes as tabs with their own input and outputs (hidden tabs still write outputs; a subprocess
  without its own input uses a shown process's), and the path explorer (paths by frequency with count, share and
  duration, hover highlight, selecting paths — Ctrl adds — sets the output); `skip_invalid` on POST …/metrics (an
  aggregate on a property one type lacks comes back empty with the reason); config editors. 35 in-process API checks
  (aggregates against the output route's objects, path counts equal to their output) and 39 of the widget in
  headless Chrome on module "Machinery widget extras (test)", plus the earlier 18 + 25 + 24 and the Vertex widget's
  102. Not built: the duration distribution panel, zoomed node cards with three metrics, a parent tab's selection
  narrowing a subprocess tab, coloring rules on edges; not opened in the real app. Done since, 2026-10-13: all four —
  a duration distribution panel (POST …/processes/{pid}/distribution: histogram of the selection's durations with
  count, mean, min, max, p25–p99; selected buckets narrow the output exactly, POST …/output takes `duration` and
  `now`), zoom / pan (wheel, + / − / fit, drag) with nodes becoming cards with three metrics when zoomed in, a parent
  tab's selection narrowing its subprocess tabs (`ancestor_keys` on metrics, paths, output and distribution; a badge
  with each tab's selection count), and coloring rules on edges; arrowheads keep their size on Sankey edges. 73 API
  checks against a reference built from the raw history, 40 of the widget in headless Chrome, plus the earlier
  35 + 39 + 102 + 18 + 25 + 24. Done since (2026-10-13, 268f7a9): metric pinning (up to 3, per viewer,
  config defaults), transition nodes per action (count, mean duration, edges labelled per state; click selects the
  transitions), subprocesses drawn inside their states (click focuses with the objects in that state), "Focus…" into a
  parent or subprocess with the selection carried and a "Back" button, every ancestor and descendant selection
  narrowing (`descendant_keys`, at most 200,000 keys). Tested: 35 new API checks (incl. a 3-level tree built in
  memory), 43 of the widget in headless Chrome, and the 73 + 35 + 40 + 39 earlier ones. Not done: no real 3-level
  Machinery resource (grandchild narrowing tested in memory only), grandchildren are not drawn inside states,
  transition nodes tried on one-action processes only, not opened in the real app.
- Done: Foundry Rules (doc 17, `api/foundry_rules.py`, `/foundry-rules`). Not done: time series rules (sunset), Taurus (legacy; nothing to migrate here), Workshop Rule Editor / Proposal Reviewer widgets (done since, 2026-10-12:
  `RulesWidgets.tsx`, config `fr_*` — the Rule Editor on one workflow with its rule list, Create New, Submit changes as
  a proposal or a direct save when proposals are off, Propose delete, a subset of logic boards, Contour import on /
  off, a read-only Rule Viewer mode; the Proposal Reviewer with status / kind / text filters, a field-by-field diff
  (prior values struck through, changes yellow), comment, Approve / Reject; selected rule and proposal as string /
  array / object set / struct variables, selection / submit / review events. Tested: 13 in-process checks (submit,
  approve, reject, re-review refused, diff fields, previews, a broken rule refused; workflow "Rules widgets workflow
  (test)", module "Foundry Rules widgets (test)") and in a browser (selection fills the variable, a condition
  changed and submitted, the diff shown, approved → rule v2). Not tested: Create New, Propose delete, Reject,
  Contour import and events in a browser; the own-proposal block with sign-in on. The rule form is a copy of the
  Foundry Rules page's (`FoundryRuleEditor.tsx`): the page could import it. A stale proposal (made against an older
  rule version) still applies over newer versions; done since, 2026-10-12 (0a8d83b): the page uses
  `FoundryRuleEditor`; edit / delete proposals record `base_version` and approving a stale one is refused (409, the
  reason given; reject still works; older proposals without it count as stale when the rule's content differs from
  their recorded old values), a form opened at an older version cannot submit, the proposal lists and the Proposal
  Reviewer show "stale — rule changed since" with Approve disabled; 21 in-process checks and in a browser (page and
  widget); no rebase / merge (the doc describes none)), Spark
  execution (rules run in memory, up to 100,000 input rows). Done since: Contour import — a path (with the paths it
  starts from) becomes a new rule's logic: filters (between as two conditions), simple aggregations, kept columns;
  wildcard / regex / negated conditions, SQL expressions and other boards are listed as left out (tested in-process:
  the imported rule gives the path's totals; the editor's Import button compiled, not clicked).
- Done: Dynamic Scheduling (doc 20, `api/dynamic_scheduling.py`, `/dynamic-scheduling`). Not done: Workshop widgets
  (Gantt, Program Scheduling, Calendar) as embeddable widgets (Program Scheduling done since, see below), TypeScript suggestion / search / metric functions.
  Done since: several resource object types per puck (extra foreign keys as row sections; rules, utilization and
  suggestions cover them; set on the board through the API — no board editor; auto-assign fills the first section
  only) and puck styling layers (Layers tab). Tested in-process on "Sched crew + vehicle board (test)"; the Gantt
  sections and the Layers tab were compiled, not clicked through in a browser.
  Done since, 2026-10-12 (0890d25): the Workshop widgets Scheduling Gantt and Scheduling Calendar (`SchedulingWidgets.tsx`,
  config `ds_*`): a saved board; the Gantt has resources as rows with a section per dimension, a time window from
  fixed dates, date variables or the board's timeline, gridlines, utilization, a "now" line, pucks dragged in time and
  between rows (the board's save handler snaps them), unscheduled pucks dropped on rows, suggested slots; the calendar
  has month / week / day views, first weekday and hour range, optional drag mode; both have search (outline, Enter
  selects), a rule-violations filter, local or UTC times, moves saved directly or staged in the scenario of a
  variable, the selected puck as object set / array / string and filter variables plus events. Tested in-process
  (13 checks, module "Scheduling widgets (test)": board data, staged and direct moves, suggestions, unknown puck
  refused, module config) and in a browser on a second API (selection filters a table, search, month → week → day,
  a drag saved 09:00 → 11:30 and moved back, 16 suggestions, editor config). Not built: the change log / review
  changes panel, right-click menus, operating-hours shading, drag-to-create, Program Scheduling, a search-results
  variable. Not tested: `ds_events`, the scenario variable from the UI, the calendar's drag in a browser.
  Done since, 2026-10-12 (75281a4): a change log of this session's moves / creates (undo one or all through exact
  moves, refused when the puck moved since), Review changes for a scenario (edits before → after, rules still broken,
  discard per edit, Apply through the board's submit, then a fresh scenario), drag to create (Shift + drag on a Gantt
  row or in the calendar's week / day view → the create action's form prefilled, optional apply without the form),
  operating-hours shading (daily, weekdays, ranges or the board's working-hours rule), grid precision 15 min – 1 month,
  search groups with highlights and "Place" (`POST /api/scheduling/boards/{id}/recommend`: built-in or a function,
  the doc's ISearchResult shape) and the results as variables, right-click menus on pucks and rows (built-in and
  configured action / event items), row selection as a variable. Done since (2026-10-12, ddb9258): the Program
  Scheduling widget (`program_scheduling`, `ps_` config; `POST /api/scheduling/program/data | plan | save`) — task
  (bars), phase (background, read-only) and milestone layers, rows nested by sortable grouping properties with roll-ups
  (extent, count, late, duration-weighted progress), dependency arrows (broken red / dashed, cycles and hidden
  predecessors marked, hover highlights the chain), drag / resize checked on the server in warn / block / push mode,
  moves saved through the layer's save action or staged in a scenario, now line, timeline from dates or variables
  (local or UTC), detail card, right-click menu, selection outputs, color rules. Tested: 51 in-process checks and
  24 in headless Chrome (module "Program Scheduling (test)" over "Tugas / Fase / Milestone Audit JKN (test)"). Not
  clicked: scenario mode, push / block, Ctrl+click multi-select, event menu items, timeline variables / UTC; close
  milestone labels overlap. Tested: 36 in-process checks (exact move / undo,
  searches, create in a scenario, review, apply on the test board) and in a browser with synthetic events (find
  slots → place → change log → undo, Shift + drag form prefilled, search variable, menus). Not built: Program
  Scheduling, collapsing non-operating hours, timeline zoom, allocation behaviours, header / row metric functions,
  separate row and puck search functions. Not tested: Apply and "apply immediately" from the UI, a real
  function-backed search, real mouse drags.
- Done: configured Object Views, versions and comments (doc 13, `api/object_views.py`, `/object-views`). Not done:
  branching object views, profiles, Marketplace. Done
  since: attaching files to comments (a Files picker; names and download links on the comment); widget tabs over
  linked objects — filters on a linked objects tab, a chart tab (group by a property; count / sum / avg / min / max;
  bars or pie), a linked object views tab (cards). Tested in-process on Search Station (test); the tabs and their
  editor were compiled, not clicked through in a browser. Not done of the legacy widgets: map, time series and
  free-form HTML widgets inside a tab (done since, 2026-10-12, commit after 946283c: a Map tab — the object's
  geopoint / geoshape and the linked objects of one link type with a label, bounds, objects without a location
  counted; a Time series tab — the object's series, optionally with its linked sensors, or linked objects' series (up
  to 12) with a default range; an HTML tab — an allow-list sanitizer on the server (no scripts, event handlers,
  javascript: / vbscript: / data: URLs, dangerous CSS), `{{property}}`, `{{objectId}}`, `{{objectTypeId}}` values
  escaped even in unquoted attributes, shown in a sandboxed frame without scripts or same-origin access under a CSP;
  editor fields for all three. Tested: 58 in-process checks (validation, save / publish / restore, map features,
  series equal to the series route) and 12 more over 70 attack snippets (entity-encoded and control-character URLs,
  mXSS through noscript / xmp / textarea, CSS url / image-set / comment tricks, placeholder injection); in a browser
  on a second API: map with linked sensors, the HTML card in its sandbox, the linked series chart. Types "OV Widgets
  Site (test)", "OV Widgets Sensor (test)". Not tested: saving a view from the editor UI (API only), light theme of
  the HTML frame, a linked geoshape, phone width; a placeholder inside `<style>` shows escaped text literally).
- Done: Ontology export / import / cleanup (doc 14, `api/ontology_manage.py`, `/ontology/advanced`). Not done:
  migration to project-based permissions and the legacy ontology roles migration (ontology roles are the model here),
  conditional formatting rule sets across ontologies (formatting is stored on the properties).
- Done: Object Monitors (doc 12, sunset; `api/object_monitors.py`, `/object-monitors`). Done since: evaluation as each
  subscriber — notified only about the objects they can see, metrics from their view, actions run with their
  permissions, deleted users skipped (tested with sign-in simulated). Done since: realtime over Search Around inputs (an edit to any type on the path re-evaluates; links kept in join
  tables are not edits and wait for the schedule). Done since: text-match, array and geo filters
  in realtime too (linked filters stay scheduled). Done since, 2026-10-12: migration to Automate — a dry run (`POST /api/object-monitors/{id}/migrate/dry-run`: the automation that would be made, what maps, what does not and why), migrate (created through Automate's own create, linked both ways, the monitor paused and locked), undo (refused when the automation was edited since) and `migrate-all` (with dry run); "Migrate to Automate…" on every monitor, "Migrate all…" in the header, a banner and Undo on migrated monitors; threshold monitors migrate only with a published function standing for the condition; metric increased / decreased monitors are refused (Automate here has no "metric changed" condition). Fixed: evaluations of one monitor could overlap, so a monitor whose action edits the added object notified and acted three times — now one at a time. 72 in-process checks on "(test)" monitors (left paused); the owner's monitors untouched (the two "Demo:" JKN monitors are refused: their types have security restrictions that an automation cannot check per subscriber); threshold migration tested with a stub function only; the page compiled and linted, not clicked.
- Done: Vulcan for meshes (doc 19, `api/vulcan.py`, `/vulcan`, three.js 0.180). Not done: DXF engineering drawings
  and LAS / LAZ point clouds (no loaders here), part coloring / transforms from functions, the Workshop Vulcan
  widget (done since: section planes at any orientation — offset, tilt and turn with Horizontal / Front / Side presets,
  saved as position + quaternion and loaded back; the math checked numerically, the viewer compiled, not looked at). The viewer was
  type-checked and compiled but not opened in a browser against a running API.
  Done since, 2026-10-12 (8f415f0): DXF drawings and LAS point clouds, loaders written here (`web/src/lib/vulcanDxf.ts`,
  `vulcanLas.ts`; no package): ASCII DXF — lines, (LW)polylines with bulges, 3D polylines, circles, arcs, ellipses,
  splines, points, text labels, INSERT of blocks (rotation, base point, arrays, BYBLOCK / layer-0 colors), layers with
  colors, off / frozen layers hidden; LAS 1.0–1.4, point formats 0–10, scale / offset, 64-bit counts, classes,
  intensity, RGB (8-bit detected), color by RGB / elevation / intensity / class, clouds over 3M points thinned,
  positions kept relative to the centre. Refused with a message: LAZ (compression bit or LASzip VLR), binary DXF, DWG
  saved as .dxf. A side panel lists layers / classes (recolor, hide, X-ray); picking and the section plane work on
  lines and points; `api/vulcan.py` accepts dxf / las / laz, sniffs unnamed files from their first 64 KB and returns
  `kind`, `refusal` and the LAS header; `model_unit` normalised (m / mm). Fixed: the 3D canvas was cleared right
  after loading (nothing showed, the demo mesh included) and React's double mount left a spare renderer. Tested: 43
  parser checks on hand-made files, 21 in-process API checks (type "Vulcan drawings and point clouds (test)"), and
  in a browser (drawing, both clouds, picking, refusal messages, the demo mesh). Not tested: real-world DXF / LAS
  files, large files (parsing runs on the main thread), saving annotations on these objects (the annotation schema
  lookup takes the first CAD type only); mesh files are still fetched without credentials.
  Done since, 2026-10-12 (2ef8eec): the Workshop Vulcan widget (`vulcan_viewer`, config `vc_`,
  `web/src/components/workshop/VulcanWidget.tsx`) on a viewer shared with /vulcan (`components/vulcan/VulcanScene.tsx`):
  CAD object from an object set / array / string variable (first object) or fixed, part coloring from a variable,
  selected part as a two-way string variable, click X / Y / Z, measurement distance outputs, fallback color /
  background / mesh style, toolbar and sidebar switches, each tool can be turned off, saving off while editing.
  Tested: 11 logic checks, 6 in-process API checks, and clicked in a browser on "Vulcan widget (test)" (kept): picking
  and outside selection, the measurement outputs, the DXF widget with tools off; /vulcan unchanged. Not done: camera
  bindings, Grid / Component scene modes, transform tool and gizmo, several models at once, annotation / measurement
  object-set inputs, `selectedOpacity`; saving annotations from the widget not clicked.
- Demo data for these apps: `POST /api/demo/jkn/ontology` (JKN facility risk; "(demo)" / "Demo:" titles, kept).
- No mockups left among the Ontology apps.
- Needs products that do not exist here: Marketplace packaging (13, 14, 15, 17), Taurus (legacy Foundry Rules),
  DXF / LAS / LAZ in Vulcan (meshes are done), restricted views and CBAC (22),
  Funnel streaming pipelines and OSv1 / Phonograph (23, 25).

- Done 2026-10-15 (2620ca6): the edits layer's materialized datasets carry the union of the object type's
  markings, every datasource's markings (backing and additional, folders included) and the type's mandatory controls
  — created already marked, widened before a rewrite, Project constraints checked first (409); a watcher adds a
  marking an input gains within ~2 s and a rebuild narrows one it loses. Multiple datasources: per-datasource
  conflict resolution (`PUT /object-types/{id}/edits/datasources/{dataset_id}/config`, timestamps from that
  datasource). Edits made before the layer existed: a one-time backfill at the next start (and `POST
  /api/ontology/object-edits/backfill?dry_run=true`) from stored values that still differ from the datasource (a dry
  run on the real data finds nothing to backfill). Also fixed: the edits overview listed types the caller cannot see,
  history / summary showed hidden property values, build-now / remove had no Editor check. Tested: 37 checks with
  sign-in on (12 first materializations polled by readers without the markings), SEC 267, the earlier
  materialization test (its throughput count fails on the old code as well as the new: the test's own datasets pile
  up). Not done: no UI for the per-datasource setting; a gained marking takes up to ~2 s; a removed materialization's
  dataset keeps its last markings; the live API runs it (and the one-time rebuild of existing materializations) only
  after its next restart.

## 11. Semantic search (doc 08 "Semantic search")
Done: `api/ontology_semantic.py` (KNN on vector properties, ranked keyword search (BM25), hybrid RRF, HyDE, query
enriching / extraction, embed objects, chunk object type setup), Object Explorer "Search by meaning", Workshop semantic
search box, AIP Agent Studio "Ontology semantic search" tool, AIP Logic "Semantic search" block, Python SDK
`nearest_neighbors(query=, num_neighbors=, vector_property=)`, `keyword_search`, `hybrid_search`, `combine_with_rrf`.
Not done yet:
- Done since: the Semantic Search page (`/ontology/semantic-search`): playground (modes, HyDE, augmentation, RRF k,
  per-method ranks, the object with its media beside the results) and setup (embed a property, chunk object type,
  chunk preview); README section. Real embeddings verified (baai/bge-m3 through OpenRouter on the 130 JKN demo
  resumes); HyDE and query augmentation run with gemini-3.5-flash on 2026-10-10 (hybrid search over the same
  resumes): HyDE wrote a hypothetical passage, enrich expanded the keywords (DBD, dengue, DHF…); extract first cut
  the query "pasien demam berdarah dirawat lama" down to "dirawat."; the default extraction prompt was reworded to
  keep subjects and qualifiers (now "pasien demam berdarah. dirawat lama.").
- Done since: Pipeline Builder "Chunk string" Recursive strategy — a prioritized separators list (default paragraphs,
  lines, sentences, words; characters last), long pieces split with the next separators, pieces merged up to the
  chunk size with overlap (checked with jiti on the function; the step form compiled, not clicked).
- Done since: the property editor sets a vector property's embedding model (with a dimension mismatch warning) and
  source text property (persisting through the object type API checked in-process; the editor compiled, not clicked).
- Workshop: PDF Viewer widget with highlighting of the matched chunk; KNN as an object set variable usable by any widget.
  Done since (2026-10-12, 72df316): `POST /api/workshop/pdf/{ref}/locate` finds a passage in the PDF's text layer
  (case / whitespace-insensitive, across pages, else the longest found start or end; `matched` share) and returns line
  boxes per page; the PDF viewer's `pdf_highlight_prop` / `pdf_highlight_variable` draw them and a "Passage · page N"
  button scrolls the viewer (not the page) to it; chunk types now carry their document's media property. Variable
  definition `knn` (object set, object set filter or array variables; text from a variable or fixed, or a numeric
  array as vector; semantic / hybrid / keyword; k) is recomputed when its query changes; widgets apply it as a ranked
  set (rank order, a relevance column; an explicit sort wins). Tested: 22 in-process checks (KNN by text and vector,
  ranked sets in queries and charts, locate on full / cross-page / partial / missing passages, refusals, chunk media
  with writes stubbed) and in headless Chrome on module "PDF chunk + KNN (test)" (JKN dengue / heart-failure chunks,
  highlight and scroll at 200% zoom, both KNN variables recomputed on a new query). Not done / not tested: a vector
  query from an array variable and array-type KNN variables in the browser, `pdf_highlight_variable` in the browser,
  chunk setup creating a real chunk type (stubbed); a KNN variable with no query or no results leaves widgets
  unfiltered. Kept test data: module "knn invalid (test)", an empty folder "PDF chunk + KNN (test)" (the module and
  PDFs are in "Pencarian semantik (test)").
- Done since (2026-10-14, KNN): Workshop queries on a ranked object set (KNN variable values, primary-key lists) read
  only those objects (`_object_rows(type, pks)` through `ontology_store.get_many`, same permission / visibility
  checks) instead of the whole type, and an unfiltered semantic search box ranks with `rank_type` (ANN when current,
  exact top-k otherwise) and reads only the hits. On 6,000 objects: k=10 ranked set 6,000 → 10 records, semantic box
  k=5 6,021 → 26; keyword / hybrid boxes still need every row (2 full loads → 1). Tested: 35 checks of identical
  responses old vs new (sort, group, filters, limits, missing keys, Quiver snapshot), the ANN / shard / fast-path
  suites, the Workshop map and WCU API suites (one wmap check asserted the old internal call and was updated in a
  copy). Not done: the scenario / snapshot path of the partial read, a type with hidden objects (an unfiltered ANN
  box may rank differently within the visible keys).
- Done since (2026-10-14, KNN2): a KNN variable with no query or no results is an empty object set (widgets on it
  show nothing; it reads no objects; "Open in Quiver" carries no objects with a note) — the docs do not cover the
  case; vector values must be numbers. Chunk setup creates a real chunk type ("Dokumen resume klaim chunk KNN2
  (test)", 99 chunks, bge-m3); two bugs fixed in `api/ontology_semantic.py`: the document ↔ chunk link names were
  swapped (new chunk types only; the earlier `lt-cf72886f35a9` keeps its names) and a second setup on one type
  failed with a 409 after creating the type (a free link name is picked first). Tested: 32 in-process checks, 35 in
  headless Chrome (a vector query from an array variable, array-type KNN variables by text and vector,
  `pdf_highlight_variable` on a multi-page PDF), the KNN / ANN / Workshop KNN suites. Not done: layout and the
  variables editor not clicked (bundle without the page / Tailwind); the KNN set keeps rank order although the docs
  say it cannot be sorted by relevance.
- Multimodal models (Pix2Struct, UDOP) and custom / Live Modeling Deployment embedding models (OpenRouter models only).
- Done since (2026-10-12, 3aa8e0c): ANN for KNN (`api/vector_ann.py`) — an IVF index (numpy k-means) per object type
  and vector property for types of 5,000+ objects (`BLUESANDAI_ANN_MIN`), its probe width calibrated at build to
  recall@10 ≥ 0.97 (not used when no width reaches it), candidates re-scored with the exact cosine, an index older
  than the objects skipped (exact scan) and updated incrementally in the background, `exact` on the KNN / search
  APIs; exact scans use numpy. Tested: recall@10 1.0 on "ANN vectors (test)" (6,000 × 384) and the sharded
  "ANN shards (test)" (8,000 × 128), 19 in-process checks (filters, edits, reload, hidden vectors), synthetic 20k
  benchmarks. Not done: the UI does not offer `exact`; a request on 6,000 objects is still dominated by loading them
  (~500 ms), not by the search (done since, 2026-10-13: an "Exact KNN" checkbox on the semantic search page;
  `/semantic/search` and `/semantic/knn` read only the top hits' records — the index picks k+16, each record gets the
  usual type-marking / row-visibility / property-security checks, deeper exact rounds when checks leave too few, the
  full-load path kept for scenarios, function-run snapshots, a stale index or a write during the query; a current
  index file is read in ~8 ms instead of a rebuild. Warm KNN 127 → 45 ms on 6,000 × 384 and 124 → 43 ms on 8,000 × 128
  (17 ms without usage metering, which rewrote usage.json per query — batched since 2026-10-13: counts kept in memory
  and flushed every 5 s / 500 records / at exit, merged with the file, readers exact; 15.6 ms → ~25 µs per query; 29
  storage checks on temp dirs (one run hit a Windows lock in the test's own direct read; re-runs green) and the usage
  API unchanged on a snapshot of the real file; a hard kill loses up to 5 s of counts; the API on port 8000 runs the
  old code until restarted), cold 768 → 614 / 419 → 294 ms, recall@10 1.0;
  14 + 6 earlier and 18 new in-process checks (never a whole-type load, results equal to the full scan, filters,
  hidden vectors and objects, refusals; permissions simulated). Done since (8638c8e): `exact` in Object Explorer's search API,
  Agent Studio's semantic tool and AIP Logic's semantic block on `rank_type` (top hits' records only); re-checked with
  the 18 + 14 + 6 in-process checks. Not done: the Workshop KNN variable still loads the whole type). Done since (2026-10-12, b1445db): an in-process read cache in `api/ontology_store.py` — each
  parsed object file / shard kept frozen in an LRU keyed by [size, mtime_ns, inode] (plus a crc32 check while the file
  is under 3 s old, git's racy-timestamp rule, so same-tick in-place edits are seen), every load thawed into fresh
  containers (callers may mutate them), this process's writes cached, stale shard entries dropped when the manifest
  changes, budget `BLUESANDAI_ONTOLOGY_CACHE_MB` (default 512, 0 = off). Semantic KNN on "ANN vectors (test)"
  (6,000 × 384) 327 ms → 73 ms warm; list objects 308 → 60 ms. Tested: 40 unit checks in a temp objects dir
  (mutation isolation at any depth, other-process saves, forced-mtime same-size edits, shards re-parsed only when
  changed, 4 readers against 40 saves, budget / eviction / off), the 37 sharding checks and the ANN tests. Not done:
  the first load after a change is 25–100% slower than a plain parse (parse + freeze); an in-place edit of a file
  older than 3 s that also restores its old mtime is not detected; the running API on port 8000 still has the old
  code until its next restart.
- Fixed (2026-10-12): JSON saves shared one fixed temp file per target (`<name>.tmp`), so two writers at once (threads,
  or the API and another process) could leave a damaged file — `data/ontology/usage.json` got a stray `}` and every
  action apply returned 500 until it was repaired. `ontology._write` now writes its own temp file per write
  (mkstemp in the same folder), fsyncs, renames with the Windows retry, removes the temp on failure, and serializes
  writers of one path in the process; single-file object saves in `ontology_store.py` likewise (unshard keeps its
  fixed name on purpose); 26 other modules with the same pattern got a unique temp name. Tested in temp folders: 8
  threads + a second process writing one file for 6 s while a reader parses it — before 9,933 bad reads and 167 write
  errors, after 0 in 4 runs; two processes saving one type, shard / unshard cycles, failed and interrupted saves. Not
  done: the other modules were only compiled; `server.py`, `sql_studio.py`, `restricted_views.py`,
  `dataset_projections.py`'s per-projection temps and `artifact_repos.py`'s `.part` temp keep the fixed name; a hard
  crash mid-write leaves a uniquely named temp that nothing sweeps.
- Not verified end to end: the UI in a browser
  (`next build` was not run after these changes).

## 12. SQL in Foundry (doc 12 "SQL in Foundry")
Done: SQL Studio (`/sql-studio`, `api/sql_studio.py`): data and object mode reads, worksheets (private / project,
versions, drafts), AIP, Format, charts, CSV download; the SQL console in Dataset Preview. Not done yet:
- Done since: writes (CREATE / INSERT / UPDATE / DELETE / ALTER TABLE, transaction blocks, `adhoc`), SQL definitions
  (Job spec, rebuilds, schedules, lineage) and Ontology SQL functions. MERGE is not in Foundry's dialect.
- Done since: the SQL console in Data Lineage (bottom panel → SQL, for datasets and object types). Done since: an SQL tab
  on Ontology Manager's object type page (object mode; the query path checked in-process, the tab compiled, not clicked). Transaction blocks undo written rows, not schema / property changes made earlier in
  the block.
- Queries run on one node (DuckDB over Arrow tables read into memory), not on Spark / Furnace. Done since, 2026-10-13
  (f51850f): out of core — Parquet datasets of 32 MB or more are scanned from disk by DuckDB (S3 ones through a local
  cache, big raw datasets through Dataset Preview's Parquet copy), each query on its own connection with a 2 GB
  memory limit, its own spill folder and at most one thread per 64 MB (`BLUESANDAI_SQL_THREADS`), locked to the files
  it references; restricted views over big datasets are applied batch by batch into cached filtered files (per
  reader, policy and version, 16 at most). Before, only the first 200,000 rows of a big file were read. Tested: 21
  queries (joins, aggregates, windows, set operations, decimal / timestamp / list / binary columns) identical to the
  previous path with disk scans forced; 34 security checks with sign-in simulated (row policies on small and 300k-row
  views and in joins, Project role and marking refusals, the locked connection refusing other files); a 25M-row
  (539 MB) "(test)" dataset at a 256 MB limit: 8 queries equal the in-memory reference, peak memory 217–479 MB instead
  of 1.8–4.0 GB. Not tested: the S3 cache path, big CSV datasets; still one node, not Spark.

## 13. Time series (doc 30 "Time series")
Done (commits 1d45b8c, 52c0e39): Time Series Catalog syncs, TSPs and sensor object types, qualified series IDs,
interpolation, the card engine (Quiver), derived series with Ontology saving, function-backed series, alerting in
Automate, FoundryTS / `timeseries_sdk`, sync markings and severing, usage, the Workshop widgets and map tracks. Not done:
- Measures: there is no legacy Measure model here, so there is nothing to migrate (sensor object types only).
- Code Workbook FoundryTS: the Code Workbook app is a legacy viewer that does not run code.
- Done since: TypeScript Functions on time series — in the TypeScript v2 runtime an object's time series property has
  `getFirstPoint()`, `getLastPoint()`, `getAllPoints({ $before, $unit } | { $startTime, $endTime })` and
  `asyncIterPoints()`, read through the platform's series route (tested in Node with the API stubbed).
- Restricted views as time series object type data sources (markings and severing only).

## 14. Transforms common (doc 29 "Common")
Done: `displayTransformsList` / `datasetPreview` (Task Runner, API), build environments, debug jobs, the multi-output
advisor (`/transforms-common`). Not done:
- Done since: Gradle-based local preview from a clone — template version 3 adds `gradlew` / `gradlew.bat` /
  `gradle/bluesandai_local.py` (Python standard library only), which run `displayTransformsList`, `datasetPreview`
  (`--printMode=table`, `--inputFiles`, `--outputFiles`) and `checks` remotely on the pushed branch, as Foundry's
  local preview does (7 checks). Other Gradle tasks are not emulated; the VS Code extension's Preview tab does not
  exist.
- Transforms versions: one runtime per language is installed, so there is no adjudication, no automatic fallback to
  an earlier version and no module pinning. A debug job can only use an earlier repository environment that is still
  installed; the platform environment (no dedicated meta.yaml packages) cannot be restored once it changes.
- Builds made before this change have no recorded environment.

## 15. Containers (doc 28 "Containers")
Done: Docker Artifacts repositories, the registry API (/v2), image requirement checks, docker save uploads, the
container runtime (Docker or Docker in WSL, with a push relay), `transforms.sidecar` on Spark (`/containers`). Not done:
- Done since: bring-your-own-container transforms (`.with_container(image, tag)`, `api/byoc_slot.py`: the transform's
  Python runs here and `os.system` / `subprocess` run in a container of the image as user 5001 with
  `$USER_WORKING_DIR` shared; preview refused; tested 10 checks with an image that has no Python), zstd layer
  inspection and registry garbage collection (POST /api/containers/registry/gc; 5 checks).
- Container-backed model assets: done (`api/model_assets.py`, `api/model_container.py`, `/container-models`): a model
  owning a Docker Artifacts repository, versions pairing images (port, env, args, exec command, memory, telemetry) with
  a ContainerModelAdapter from a Code Repository, test runs from the model page and `ModelInput(model, version)` in
  Python transforms; 13 checks with the docs' mirror example (busybox httpd CGI image), plus the page in headless
  Chrome. Not built: live or batch deployments of a container model (Modeling Objectives still records them only),
  multiple containers sharing one volume (each container gets its own shared folder), `use_sidecar=True` model
  inputs in Spark executors (the model runs in the driver), registering adapters as a published Model Adapter Library.
  Done since, 2026-10-12 (1ec075c): live deployments of container models — the version's images start as containers
  per deployment (ports, env, command, memory limit, `--restart on-failure:3`); a health monitor every 15 s
  (`BLUESANDAI_DEPLOY_MONITOR_S`) checks the worker, each container and its ports, replaces the worker after two
  failed checks (a dead worker at once) with back-off, giving up after 6; container logs reach the deployment logs
  with telemetry on; stop / delete / upgrade remove the old containers even after the worker was killed (label),
  starting workers stopped while starting clean themselves up, the WSL keepalive of a killed worker is ended; a new
  model version upgrades direct deployments; batch deployments rebuild when their input dataset changes (switch);
  a containers strip and a Restarting state in the deployment panel. Tested with real containers in WSL Docker (46
  checks: start, endpoints, removed container → restart on the 2nd check, killed worker → restart and cleanup,
  logs, stop during start, upgrade with the memory limit, batch rebuild on input change / not on unchanged input,
  Python deployments unchanged; no container or keepalive left). Not tested: delete of a container deployment, the
  give-up after 6 restarts, the monitor inside the live API, the panel in a browser. Not built: replicas,
  autoscaling, CPU limits (stored only) (done since, 2026-10-13 (c343de9): replicas with scale up / down recorded, CPU and memory limits applied to the containers, autoscaling on requests in flight per replica with a cool-down, a registry garbage-collection schedule, replicas and limits in the deployment panel; tested with real containers in WSL Docker: 89 replica checks, 70 Python-replica checks, the 48 + 46 earlier deployment checks, no container or keepalive left; the panel not opened in a browser); batch rebuilds wait for the monitor (the dataset commit hook is not wired). Done since,
  2026-10-12: a dataset commit starts the rebuild of batch deployments reading it at once (in a background thread,
  only when the API loaded `model_deployments`; an input changed while a run read it is rebuilt again right after),
  and a worker that does not answer within its start timeout is killed with every process it started (psutil tree:
  the `wsl.exe` keepalive and docker calls). 48 checks with real WSL Docker containers: the commit hook, the start
  timeout leaving no worker or keepalive, restart give-up after 6 with back-off, delete of a container deployment
  (no container left). Not tested: the hook and monitor inside the live API before its restart.
- Executors are Spark tasks on one machine: the shared-volume path and localhost port of an executor's sidecar are
  redirected inside its Python worker (open / os / os.path / socket.getaddrinfo), not separate pods; code reaching
  the volume through other means (a subprocess, C extensions) sees the real path.
- Only a cut-down telemetry check (sh and tee present). The ~10 GB layer size is flagged, not enforced (Foundry
  "strongly recommends" it). Registry auth is Basic with an API token (no token service); garbage collection is on
  demand (no schedule); pushes from a machine other than this one need TLS or an insecure-registries entry.
- GPU profiles pass `--gpus all`, which fails without a GPU in the container runtime.

## 16. Linter (doc 19 "Linter")
Done: 30 rules on real metadata (11 more listed as not applicable), sweep schedules, recommendations (modes, filters, snooze, assign, fix proposals),
impact tracking (`/linter`, `api/linter.py`). Not done:
- Done since: "Schedule builds Contour analysis" is a real rule (saved datasets a Contour analysis rebuilds on a
  schedule; recommends Export to Pipeline Builder; tested in-process). Rules about what this platform does not have
  are listed as not applicable: Code Workbook schedules (workbook datasets build on demand), dataset
  projections, schedules' abort-on-failure, exceeded-duration mode, ignore lists, declared inputs and targets,
  descriptions, self-triggering.
- Spaces do not exist: a sweep schedule's resource scope is Projects. Code repositories belong to the Projects of the
  datasets they write.
- Done since: Spark builds record the optimized and physical plans of what they wrote; "Spark plan potentially
  non-deterministic" reads them (the code only before a first build) and a new rule flags cartesian products /
  broadcast nested loop joins in physical plans (4 checks).
- Still heuristics: lightweight / local Spark use is read from the transform's code; "should be view" compares row and
  column counts; compute estimates come from build durations (resource_usage.py), not billing.

## 17. Preparation [Sunset] (doc 21)
Done: preparations, the changelog engine, column stats and fixes, preview mode, saved datasets (updating / one-off),
saved versions, Project scoping with Project references, Data Lineage (`/preparation`). Not done:
- Done since: Analyze opens the saved dataset in a new Contour analysis (SQL Studio stays one click away); it needs a saved dataset.
- Done since: output dataset branches (branch selector with Create branch, Save to another branch, saved versions per
  branch); a branch's datasets are the copies under `_branches/<branch>/` Dataset Preview shows.
- Expressions are Spark SQL transpiled to DuckDB, not Contour's expression language; statistics are exact over the
  whole dataset (read into memory), not sampled.
- Project references exist only for Preparation's scoping (there is no Project details panel listing them).

## 18. Recipes [Sunset] (doc 22)
Done: dataset recipes with conditions, schedules, previews, recipients, run history, expiration, mute / pause,
notification settings (`/recipes`). Not done:
- Done since: object type and time series recipes, and report recipes (Reports → Actions → Email on a schedule: the
  report rendered by headless Chrome as its author sees it, emailed as an attached PDF or an in-email image).
- Dataset previews stay in the notification body and the email (HTML table). Report recipes need Chrome or Edge on
  the server (`BLUESANDAI_CHROME`) and email set up.

## 19b. Demo: JKN facility risk audit
`/demo-jkn` (synthetic hospital records + 20 screening rules as Python transforms). The rules are screening
heuristics on the demo's own record layout: real use needs the facility's SIMRS / e-Klaim / V-Claim exports mapped to
it, BPJS's official rule thresholds (e.g. the full list of 144 FKTP diagnoses, INA-CBG tariffs per region and class)
and clinical review of each finding. No ontology objects, case management or Workshop app are built on the findings.

## 19a. SAP (doc 06)
Done without the Palantir add-on: delta-token syncs over SAP's own ODP OData services (extractors, CDS views with
change data capture, SLT) and OData v4 change tracking (Data source wizard → Incremental → "Delta token"), tested
against a mock ODP v2 service (10 checks), not a real SAP system. Not done:
- Everything that needs the Palantir Foundry Connector 2.0 add-on (its table / BW InfoProvider / BEx / extractor
  endpoints, resource checks, STXL long-text decompression, /PALANTIR/* transactions): the add-on is not available.
- Long texts: read them where SAP exposes them as OData (S/4HANA text entity sets); STXL's compressed cluster format
  and READ_TEXT over RFC (SAP NW RFC SDK) are not supported.
- OData v4 deletions in a delta are counted, not written (ODP v2 deletions arrive as rows with ODQ_CHANGEMODE = D).
  Done since (2026-10-12, 2bef6af): v4 entity sets get a trailing `ODQ_CHANGEMODE` column (null on full / initial
  reads, `U` for added or changed entities in a delta, `D` rows carrying the deleted entity's key — read from the
  entry or parsed from its `@id` / `id`: composite, quoted, percent-encoded, absolute and key-as-segment ids; no key →
  the run fails asking for a re-sync); `$link` / `$deletedLink` entries skipped; `net_changes()` and `GET
  /api/datasources/connections/delta-sources/{id}/current` give the current rows of a delta source. Tested: 34 checks
  against mock ODP v2 and OData v4 services (the 10 ODP checks unchanged; after two deltas the current state equals a
  full read). Done since (15037b0): an "upsert by key" write mode (`delta_write: "upsert"`, set in the wizard or by `PUT
  /api/datasources/sources/{id}/delta-write`; key columns and ODQ_CHANGEMODE required) — the first load is a SNAPSHOT,
  each delta an UPDATE whose single file holds the current rows (ODQ_CHANGEMODE kept only on request); switching log →
  upsert compacts on the next run without a re-sync; change-log mode stays the default; also fixed: opening a delta
  source with runs crashed (text cursors). Tested: 55 checks (21 new: refusals, Products and composite-key Lines upsert
  sources equal a full read after two deltas, mode switches, 3,500 changes on 6,000 rows in 2.8 s). Not done: ODP v2
  upsert not run end to end (shared merge code covered), upsert reads the current dataset into memory, the UI only
  type-checked; v4 sources created before this change lack the column (re-create them); not tried
  against a real SAP / OData v4 system. Done since (2026-10-13, 4ddf101): ODP v2 upsert end to end, a streamed
  out-of-core merge (DuckDB, spilling past a memory limit: 3M current rows + 200k changes 1,186 MB → 247 MB extra,
  identical output), older v4 sources get ODQ_CHANGEMODE on their next run (the change log rewritten once), the
  wizard's write-mode step clicked in headless Chrome (16 checks); 74 delta checks. Still not done: no real SAP / OData
  v4 system; the dataset preview of a source still loads every file.
  An existing source cannot be switched to delta tokens (create a new one).

## 19. Peer Manager (doc 20)
Done: network connections (MPX invite codes), File data relay channels, peer connections (request / approve /
activate, status, security change requests), ontology peering with mappings, concurrent and sequential jobs with
acknowledgments, peer profiles (`/peer-manager`). Tested between two live enrollments on this machine. Not done:
- File peering (Gotham files, Gaia maps): there is no Gotham here.
- S3 and Lattice CDS channels; HTTP channels are the network connections; Multipass certificates and egress / ingress
  policies (a network connection is a URL and a shared secret over HTTP; use HTTPS between machines).
- Done since: marking mapping across enrollments, join table link type peering (link edits are sent at once, and
  sequential jobs catch up) and Automate's "Skip peering events" — tested between two live enrollments (19 checks).
- Spaces (peer connections are between Projects), mesh remote strategies and Marketplace / DevOps distribution of
  peer profiles; source data peering sends the object type's current objects (here objects and edits share one
  store).
- The pull path (one side Egress only) and File relay channels were not tested end to end. Done since (2026-10-12,
  e6e7af5): both tested end to end between two API processes (ports 8041 / 8042, project "Peering demo (test)"), 67
  checks, and 14 defects fixed in `api/peering.py`: the pulling side never pulled (the hello now completes its network
  record), the non-calling side could not approve / activate / map (control messages are queued and served at
  `GET /remote/messages` + ack), duplicate payloads piled up (superseded, deletions carried), one failed payload
  blocked pulls (reported and resent), concurrent payloads moved the watermark, remote markings and the network check
  on the non-calling side; relay channels are now used whenever configured (objects and links), files carry and are
  checked for their origin enrollment and connection, applied oldest first, written atomically, failures recorded per
  channel, `POST /api/peering/channels/run`; the page has Pull now and Run channels now. Not done: control messages over
  a relay channel (a relay-only connection without any network cannot be approved or mapped), the 60-second loop itself
  (the test calls `tick()`), the new buttons not clicked in a browser.
  Done since, 2026-10-12 (a636159): control messages over a relay channel — a relay-only connection completes the
  hello, request, approval, activation, entities, mappings, markings, security requests and enable / disable, then
  objects, links and deletions both ways, all as signed relay files with a per-remote sequence number; files are
  applied strictly in sequence order (duplicates dropped quietly, files after a gap held until it arrives); the
  receiver writes one signed acknowledgement ("applied up to N", missing numbers) per run; the sender keeps files
  until acknowledged and rewrites reported-missing ones at once, and unacknowledged ones after 120 s
  (`BLUESANDAI_PEER_RELAY_RETRY_S`); tampered, foreign and misaddressed files are still refused (`*.failed`); channel
  rows show the sequence state. Tested: two API processes that cannot call each other (0 HTTP calls) sharing a relay
  folder, 63 checks (full setup and data flow, a lost file, a lost last file, a lost control message, duplicates,
  late arrival, reverse-named files, refusals) and the earlier 67 pull / relay checks. Not done: acknowledgements are
  not listed as jobs; a connection with a relay export but no import channel back gets no acknowledgements (no
  resends); the page was type-checked, not opened.
  Done since (2026-10-13, PR2): acknowledgements listed as Ack jobs (sequences newly acknowledged, cumulative, missing,
  relay or network); a relay export without an import channel back is acknowledged over the network connection
  (`POST /remote/relay-ack` or queued for the remote's loop), with a warning on creating a channel with no way back;
  imported edits and links relayed at once to the receiver's other connections, never back over the one they came
  from (fingerprints of received objects per connection and mapping, dropped on a local change; objects already
  holding the incoming values not rewritten), so chains of peers neither echo nor ping-pong. Tested: a real two-peer
  loop with the page clicked in headless Chrome (68), three peers A–B–C on the real loop (22), relay-only (63), pull /
  relay (67), the older 20-check suite (19 after a test-stub fix). Not done: a ring of peers editing the same object
  at once can let a slower relayed copy overwrite a newer value (no origin version check); echo-skipped objects are
  re-fingerprinted every run; the page not opened in the real app. Done since, 2026-10-13: every edit and deletion
  carries its origin version (origin clock + peer id, unchanged when relayed); the newest wins, ties by origin id, so
  every peer settles on the same value; deletions leave versioned tombstones (an older edit never resurrects, a newer
  one does); echo skipping compares versions, so skipped objects are not fingerprinted again; import jobs count
  `stale_skipped`; fixed: a deletion that could not be sent (peer offline, a refused pulled payload, a disabled
  connection) was lost — undelivered deletions are now kept per connection and mapping
  (`data/peering/pending_deletions.json`) and re-sent with each export until delivered ("N owed deletions sent
  again"). Tested with real API processes and the real background loop: a ring A → B → C → A (67) and a four-peer full
  mesh (68), each with concurrent conflicting edits, a peer killed and restarted, and a two-way partition healed; plus
  60 + 63 + 67 + 22 + 19 earlier peering checks. Not tested end to end: owed deletions after a disabled-then-enabled
  connection or a refused pulled payload.

## 20. Application Building (docs 01–13 of the Application Building reference)
Planned order: Slate, custom widgets, Developer Console / OSDK React applications, Pilot, Carbon, Autopilot, Solution
Designer, Workflow Lineage, Workflow Builder and Use Cases, then the rest of Workshop and Automate. The earlier pages
for these apps were local prototypes (browser storage, no backend) and are replaced one by one.
- Slate (doc 03): done (`api/slate.py`, `/slate`, `/s/slate/<permalink>`; README). Demos: "Review klaim JKN (demo)"
  (object set with Handlebars filters and aggregations, SQL over the findings dataset, functions, object context in a
  dialog, events, two pages) and "Formulir laporan publik JKN (demo)" (public, anonymous reports through secure upload
  into the folder "Laporan publik JKN (demo)"). 38 API checks; view, edit, merge and the public form checked in
  headless Chrome. Not built: the OSDK panel inside Slate functions (comes with the OSDK, phase 3), Code Workspaces
  applications (Streamlit / Dash / Shiny), Phonograph writeback (legacy), Checkpoints (no Checkpoints application
  here: slate.showCheckpoint closes at once with status "no-checkpoint"), platform-wide uploaded JavaScript libraries, merging inside one
  element (a conflict is resolved per element), SQL security helpers checked against an information schema (names are
  validated as identifiers instead). Done since: the Segmented control, Date range picker, Calendar, Image gallery,
  Tree, Graph, Map, Gantt, Heat grid, Tree map, Resource selector and Time series widgets; the global actions scrollToId,
  setWindowTitle, exportWidget (PNG / PDF through an SVG foreignObject; cross-origin images inside a widget are left
  out), Broadcast channels (create / close / broadcast, slate.getBroadcast), sendMessage to child / opener / parent
  windows with slate.onChildWindowClosed, logout, openAppsPortal, saveView / loadView and "Get shareable view" (views
  keep widget interaction state and local variables, for any page, not only the home page as in Foundry). The demo
  "Review klaim JKN (demo)" has a page "visual" (v15): status and date filters over SQL queries feeding a Gantt of stays
  per ward, a heat grid of status × class, a tree map of tariff gap per diagnosis, the faskes map and tree, the referral
  graph, a calendar of stays, the daily claims time series, a resource selector, export and share buttons, a broadcast
  channel. 9 API checks (views: save, read, 404, 413; the queries) and in headless Chrome: every widget rendered, the
  filters narrowed the Gantt (40 → 11) and the heat grid, a message from another BroadcastChannel reached the page,
  map / graph / tree selections, the heat grid exported (44 KB PNG), a saved view restored its status filter, the
  resource selector listed Files. Not done: Raven map layers (vector-tile layers done since, 2026-10-12, e5ac140:
  `type: "vector"` with `vectorTileOptions` — vectorTileUrl, layerName, featureIdKey, featureIdWhitelist strings or
  regexes — base / hover / click styles, colorProperty / colorMode / colorScale / labelProperty, and choropleths with
  `layerSource: "Vector Tile"` coloring tile features from ids / values; a click sets the selection state and fires
  `selectionChanged`; no layer editor, configured as JSON like the other layers). Done since (2026-10-12, fd6f469): the graph's
  camera (wheel zoom at the pointer, zoom / fit buttons, background pan in the viewer, `zoomScaleRange`,
  `hideLabelsScale`; state `camera`, event `camera.changed`, action `fit`) and node dragging (`nodes.changed`; in Manual
  layout the editor saves the positions in the document), calendar drag-to-create (`rangeSelectionEnabled`, state
  `selectedRange` {start, end, days}, event `rangeSelected`), the tree's search box (filters and highlights, state
  `searchText`, event `searchText.changed`). Tested: 14 unit checks of the camera / day-range maths, and clicked in a
  browser on "Slate graf, kalender, pohon (test)" (kept): events set variables, a node drag in the editor saved as
  version 2. Not done: hour ranges (week / day views have no hour grid; done since, 2026-10-12: an hour grid in week / day views —
  timed events placed by start / end, overlaps side by side, an all-day row, a now line, drag on the grid creates a
  timed range snapped to `slotMinutes` (5–60, default 30) across days, `hourStart` / `hourEnd`, `firstDayOfWeek` (also
  the month view), `timeZone` local / UTC (the range carries it; UTC ranges are true instants); fixed: date-only events
  started at UTC midnight; 57 geometry checks in Node (local, New York, UTC) and 34 in headless Chrome with real drags
  (Jakarta and New York); not built: moving / resizing timed events (the docs give no property or event), zoom; not
  tested: touch, the real Slate editor and runtime), adding the new event is left to the app's
  events; dragging on Force Directed graphs and touch input not tested.
- Marketplace packaging (Slate doc 03, custom widgets doc 05): products as downloadable JSON packages, like
  Workshop's. Slate: lint (dependencies — object / action types, functions, Logic, datasets named in SQL, REST API
  sources as warnings — and errors for missing resources or shared variables marked as parameters), local variables
  marked as Marketplace parameters (string / boolean, in the Variables panel), Package (the published version, every
  page) and Install product (inputs become the variables' defaults, dependencies mapped). Widget sets: Package (a
  release with its files, the SDK's Ontology resources) and Install product (a new widget set with that release, the
  resources mapped, Ontology APIs off until an administrator enables them). 14 checks: the demo Slate application and
  the demo widget set packaged; "Paket Slate (test)" packaged with a parameter and installed as "Slate terpasang
  (test)" (twice, by two test runs), "Widget terpasang (test)" installed and its widget loaded (all kept); a missing
  dependency and an unsafe path refused. Not done: a Marketplace store and DevOps product editor (download and
  install the files), library files copied for the Code Sandbox widget, pre-built OSDK bundles.
- Custom widgets (doc 05): done (`api/custom_widgets.py`, `/custom-widgets`, Workshop → Custom widget; README). Demo:
  widget set "Widget audit JKN (demo)" (a widget grouping claims' RS − INA-CBG difference by a column through the
  host's OSDK; clicking a group filters the module) in the Workshop module "Selisih tarif per diagnosis (demo)". 28 API
  checks; the module, the playground and the editor in headless Chrome. Not the real `@osdk/widget.client` packages:
  bundles talk to the host through `window.BluesandaiWidget` (the same parameters / events / OSDK model), so a
  Foundry-built bundle needs that thin adapter; no Foundry Code Repository template with npm CI/CD (no npm registry
  here) and no `@osdk/cli widgetset deploy` endpoint (upload the .zip); object sets travel as {objectType, filters}
  rather than object set RIDs. Done since: Marketplace packaging (see above). Done since: parameters bound to
  module variables in Workshop (a scenario parameter to a scenario variable; `scenario` on the widget's OSDK calls
  reads objects and applies actions in that scenario), and Workshop's display optimization applies to custom widgets.
- Developer Console / OSDK React applications (doc 04): done (`/developer-console`, `api/developer_console.py`,
  `api/osdk_api.py`, consent page `/oauth/authorize`; README). Demo: "Portal verifikasi klaim JKN (demo)", a hosted
  plain-JS site using its generated SDK (sign-in with PKCE, aggregates by status, claims in verification, the
  "Ubah status verifikasi klaim (demo)" action) at /api/dc-hosting/portal-verifikasi-jkn-demo/. 36 API checks (the
  generated SDK run from Node), the whole sign-in and action flow in headless Chrome. Not built: the real
  `@osdk/client` / `@osdk/react` / `@osdk/react-components` packages (the generated SDK is this platform's own small
  client with an OSDK-like API: `client(Type).where().fetchPage()`, `aggregate`, `applyAction`, `executeFunction`) and
  React templates (no npm registry or Node builds here: build elsewhere and upload the site); Python / Java SDKs and
  OpenAPI specs; code repositories bootstrapped from a React template, VS Code workspaces and PR previews; object set
  subscriptions (a websocket API in Foundry). Done since: action VALIDATE_ONLY (and refusing invalid actions with the
  validation result, returnEdits), attachments and media through the OSDK API (and `client.attachments`,
  `client.media`, `validate` in the generated SDK), a service user per backend application (created by an
  administrator from the application's Sharing tab: a user without a password named svc-<application>; removing it
  deactivates the user, tokens are revoked on each change), and "Applications with access to your account" under
  Account settings (what each reaches, revoke). 26 API checks; the account section and the service user panel in
  headless Chrome. Left by the test: the backend application "Backend OSDK (test)" and its deactivated service user
  "svc-backend-osdk-test", an attachment "catatan osdk (test).txt" and a media file "kuitansi osdk (test).png". Not
  done: the validation lists each parameter as VALID / INVALID with one message (not Foundry's typed constraint
  evaluations); media uploads return this platform's Files item as the media item (no media sets behind media
  reference properties here); a consent screen that lists previously granted scopes.
- Pilot (doc 06): done (`/pilot`, `api/pilot.py`; README). Checked with a real model (Gemini 3.5 Flash): a JKN
  verification queue reusing "Klaim JKN (demo)" (locked: no properties added), design, 10 invented seed rows, the
  app previewed on them, plan mode approved and built, deployed ("Antrean verifikasi klaim (demo)" at
  /api/dc-hosting/antrean-verifikasi-klaim-demo/, signed in with OAuth on real data in headless Chrome). Generated
  code quality depends on the model (the first version's status summary read 0: refine it from the chat). Not
  built: React / OSDK React output (plain JavaScript on this platform's SDK, no Node builds or containers here), image
  attachments, a separate subagent thread view (agent turns are labeled messages), ontology promotion through
  branches and proposals (deploy writes to main after its checks), dependency status and upgrades.
- Carbon (doc 09): done (`/carbon`, `api/carbon.py`; README). Demo: "Portal audit JKN (demo)" (promoted; tabs for
  the Workshop module "Selisih tarif per diagnosis (demo)", the Slate application "Review klaim JKN (demo)" and Klaim
  JKN; faskes, findings and the OSDK portal in the + menu; home columns; a What's New page). 10 API checks; the
  workspace, its tabs (embedded modules without the sidebar), What's New and the editor in headless Chrome. Not
  built: per-organization promotion lists (one organization here), dark mode per organization, Marketplace
  packaging. Done since: an "Open in" menu on object pages listing the workspaces' discoverable modules for the
  object's type (Workshop modules open with ?object=<pk>; compiled, not clicked). Done since: parameter values on Workshop / Slate shortcuts (module interface external IDs, `v.<variable>`,
  `page`), and navigation between modules — an embedded Workshop module's "open module" event opens that module in a
  workspace tab with the event's parameters (tested by posting the message; no demo module has such an event); also
  an "Open in" menu on Object Explorer's object type results (the module opens in a workspace tab:
  `/carbon/<id>?module=<type>:<id>`), checked in headless Chrome on Klaim JKN.
- Autopilot (doc 08): done (`/autopilot`, `api/autopilot.py`; README). Demo: workbench "Alur verifikasi klaim JKN
  (demo)" over Klaim JKN (states layak bayar / dalam verifikasi / ditunda, inferred) with the disabled automation
  "Tunda klaim selisih tarif tinggi (demo)" (runs only when retried from Autopilot; it sets a claim to ditunda). 18
  API checks (the test retries one claim and puts it back); Kanban, object timeline, graph, activity and events in
  headless Chrome. Which action edit an automation made is matched by time (each automation run claims the closest
  action run on its object), since action runs started by automations are recorded under the user who started them;
  a manual edit in the same second can be credited to the automation. Not built: Marketplace packaging. Done since
  (2026-10-12, a3b5f11): token counts for AIP Logic effects (a usage hook adds each model call's tokens to its Logic
  and automation run, per model; events table column and total, object history, timeline metric, Logic node panel
  with 7-day runs / tokens), saved graph layouts (drag nodes; saved per user or shared by editors; reset to the
  automatic layout), alert notifications (bell dialog: subscribe with optional email, editors manage subscribers;
  alerts computed with each subscriber's access, delivered once through notify.deliver — check and mark-seen atomic
  per workbench across processes with a lock file — a background check every 5 minutes and after changes, an alert
  for automations failed in the last day). Tested: 55 in-process checks (run 3+ times; 10 racing checks deliver one
  notification; email stubbed), and in the browser pane (dialog, drag-save-reload-reset, token figures). Not tested:
  a personal layout from a signed-in browser, real email, the 5-minute timer firing on its own, nested Logic runs'
  token isolation. Test data kept: workbench "Alur klaim JKN (test)", Logic / automation "Ringkas klaim (test)"
  (disabled), one admin subscribed in-app. The API on port 8000 runs the code it loaded at 16:10 (a partial
  version of this work) until its next restart.
- Solution Designer (doc 10): done (`/solution-designer`, `api/solution_designer.py`; README). Demos: "Arsitektur
  audit klaim JKN (demo)" (from the JKN reference pattern, the Klaim JKN object type and the verification action
  linked, an Ontology group, an AIP Critic conversation and implementation plan) and "Rencana antrean verifikasi
  klaim (demo)" (AIP Architect: concept graph and a data model that reuses the JKN object types). 26 API checks with
  a real model (Gemini 3.5 Flash); the editor (selection, drag, Ctrl+B, delete / undo, PNG export, Critic, viewer
  mode) and the plan PDF in headless Chrome. Not built (streaming of AIP Architect / Critic answers, AIP Assist on the
  documentation card and resizing by any edge done since, 2026-10-12, 24c2ad3: SSE routes `.../architect/implement/stream`,
  `.../critic/ask/stream`, `.../assist/stream` with partials then the saved result, Stop / close cancels the model call,
  fallback to the plain call; an Ask Assist dialog with follow-ups and a model picker; 8 resize handles with a 120×40
  minimum; drags no longer lose their last pointer move; 43 API checks with real Gemini streams and 30 in headless
  Chrome with replayed answers on "Streaming AIP checks (test)"; cancelling mid-answer against a real server not
  tried; minimized nodes have no resize handles): AI FDE handoff, live co-editing (a stale save is refused with 409 and
  asks to reload), the lineage graph opened focused on
  the diagram's resources (Open in Data Lineage opens the graph). Done since, 2026-10-12 (c599966): Open in Data
  Lineage focused on the diagram's resources (`POST /api/solution-designer/lineage/focus` maps object types, action
  types, files and imported nodes to lineage ids, `/lineage?nodes=…`, missing ones named); minimized nodes resize by
  their edges and corners (width only); "Create this link type" on a connection AIP Architect proposed (`POST
  /diagrams/{did}/edges/{eid}/create-link-type`: one-to-many as a foreign key on the many side found by name and
  type, one-to-one either side, many-to-many or forced as a join table; refusals 400 / 404 / 409) and "Open link
  type"; a stale save opens a Resolve dialog comparing both versions (keep mine / keep the server's). 33 in-process
  checks run on fresh "(test 2)" / "(test 3)" types; the UI compiled and linted, not clicked. Still not built: AI FDE
  handoff, live co-editing beyond the conflict dialog. Done since: "Create this object type" on a proposed (AIP Architect)
  node — the object type is created with its properties, primary key and title, and the node becomes a resource node
  linked to it (a new version; tested in-process, the button compiled, not clicked); proposed link types are not
  created.
- Workflow Lineage (doc 12): done (`/workflow-lineage`, `api/workflow_lineage.py`; README). Demo: graph "Alur kerja
  audit klaim JKN (demo)" (Klaim and Faskes JKN, the verification action, the hold automation, the Workshop module,
  the Slate application, the widget set, two OSDK applications, the new Logic function "Ringkas risiko klaim (demo)"
  and Gemini 3.5 Flash, with a text note). 21 API checks (criteria copy on (test) actions, then reverted; model
  replacement on the demo Logic, then put back); the graph, details, provenance highlight, color modes, Workshop
  panel, weekly views, replace-model panel, save and `?add=` in headless Chrome. Not built: global branches (every
  change is on main), proposals for bulk deletes (no bulk delete), bulk Ontology role grants, Marketplace products, trained models, Gaia nodes
  (done since: Vertex graphs, Notepad documents and templates, Machinery processes that reference Ontology resources
  are nodes linked from those resources), model requests attributed to the resource that made them (usage is per model),
  Workshop variable provenance, live deployment panels, service log search, AI FDE graphs, a non-admin "View as"
  check in the tests (no non-admin user here).
- Workflow Builder (doc 11): done (`/workflow-builder`, `api/workflow_builder.py`; README). Demo: "Triase klaim JKN
  (demo)" (claim changes → selisih → an LLM risk sentence → fork at params.ambang Rp300 ribu → hold the claim, or
  do nothing). 18 API checks with a real model: sandboxed previews (main unchanged), a failing condition, a manual
  run on main (the claim put back), a deployed trigger fired by a real edit (then undeployed); the editor and a
  preview in headless Chrome. Not built: Build a transform with no-code operation boards (named expressions
  instead), and preview runs still appear in the action's own run log. Done since: LLM tool calling in a loop
  (object query, function and action tools; the model answers with a tool call or the final answer, each call and
  result recorded in the run; typed outputs shaped at the end) and copy / paste of nodes and whole workflows with
  their subgraphs between graphs. Demo graph "Asisten verifikasi klaim JKN (demo)" (a claim's risk with the
  risiko_klaim function, similar claims by diagnosis, the status action when the risk is high; a struct answer and a
  subgraph that writes a summary). Checked with a real model (Gemini 3.5 Flash): on claim …111 the model called the
  function and the object query and kept the claim (low risk); a variant holding scores ≥ 0.9 made it apply the
  status action to claim …043 in the preview sandbox (main unchanged); the workflow copied in headless Chrome and
  pasted into "Tempel workflow (test)" (kept) ran with its subgraph. Done since (2026-10-12, 14d01d3): native provider tool
  calling (OpenRouter `tools`, Gemini function declarations keeping thought signatures; JSON-in-text fallback for
  registered models, routes without tools or `tool_mode: "json"`), parallel tool calls in one turn (queries and
  functions concurrently, actions in order, results in the model's order), streamed preview / execute
  (`/preview/stream`, `/execute/stream`, SSE; a closed stream stops a preview) and `wb.previewStream` /
  `executeStream`. Tested: 49 checks with stubbed providers (both providers, fallbacks, refusals, cancel mid-turn,
  main untouched), and gemini-3.5-flash, qwen3.8-flash and gpt-6-luna calling two tools in parallel on "Tool calling
  stub (test)". Not done: the editor still uses the non-streamed preview (no live model text, no `tool_mode`
  selector); a real model without tool use not tried (done since, 2026-10-12 (96982a3): the editor previews on the
  streamed route — model text as it arrives with a cursor in the run card and node panel, tool-call turns with
  arguments / results / errors and parallel calls grouped, Stop (and a new preview or an edit) closes the stream and
  keeps the partial text, a "Tool calling mode" selector (Auto / Native only / JSON-in-text), errors inline; Run now
  streams too (no Stop: a run on main finishes); fixed: `tool_mode: "native"` no longer falls back to JSON silently,
  a stop mid-answer says "stopped: the preview was closed", plain Use LLM nodes stream their text; tested: 23 checks
  of the stream client against the in-process API with a stub model, 27 checks of the real editor in headless Chrome
  with recorded SSE (stable over 6 runs), the 34 earlier stub checks; no real model, not in the Next.js page).
  The property filter of an object trigger compares with the last value seen per object.
- Use Cases [Sunset] (doc 13): done (`/use-cases`, `api/use_cases.py`; the mockup is replaced). Demo: "Audit klaim
  JKN (demo)" on the demo Project (migrated), with the Workshop module "Selisih tarif per diagnosis (demo)" added,
  Active status (shows the disparity warning: the JKN types are Experimental) and documentation. 15 API checks; the
  use case pages in headless Chrome. Not built: the "back to use case" breadcrumb inside other applications,
  "Actions > Create use case" in the Files Project view (create from the Use Cases home instead), documentation
  stored on the Project cover page (kept on the use case). Done since: Workshop modules are found from their Files
  items in the Project (modules of other Projects can still be added by hand).
- Automate (doc 07): the engine moved to `api/automate.py` (ontology.py keeps the records and routes and delegates).
  Demo: "Klaim ditunda → beri tahu verifikator (demo)" (claims entering the ditunda set notify the verifikator;
  enabled). 17 API checks (set entry / exit, property-filtered modification, retries + fallback + manual retry, cron
  in Asia/Jakarta and a real cron run, run on all with dropped objects and a digest, a dependency, expiration,
  muting) plus the Autopilot regression; the editor and the cron preview in headless Chrome. Done since:
  function-generated object sets, function-backed threshold logic, execution modes (once for all objects, per
  batch, per group) for action / Logic / function effects, function-generated notifications, attachments (Notepad
  documents and templates, Contour analyses rendered to PDF / inline images by headless Chrome), mute for everyone
  and auto-mute, manual executions in batches with parallelism. Demo functions in the repository
  "fungsi-automate-jkn-demo" (v1.0.1: klaim_ditunda_tarif_tinggi → ObjectSet, antrean_ditunda_padat → boolean,
  pesan_klaim_ditunda → Optional[Notification], hitung_klaim); demos "Klaim ditunda bertarif tinggi → verifikator
  (demo)" (function set, function-generated notification with the Notepad template "Ringkasan klaim ditunda (demo)"
  attached) and "Antrean klaim ditunda padat (demo)" (function-backed logic), both enabled; "(test) mode eksekusi
  fungsi" and "(test) auto-mute" disabled and kept. 22 API checks (two claims entering the set gave one
  notification with the function's heading and a 1-attachment PDF of a generated document listing them; a boolean
  change ran the effect; 11 claims in batches of 4 → 3 executions, once → 1, per class → 3; manual batches over the
  function's set; ten failures auto-muted; a muted trigger recorded without effects; an expired mute lifted) and the
  editor / detail page in headless Chrome. Not done: email is not configured here, so attachments were rendered but
  not sent; function-backed conditions are polled (every N minutes, at least 1), not live; "once per subscriber"
  evaluation of function sets (one evaluation as the owner); combining Automate-defined and function-backed logic in
  one threshold; manual batches run back to back (not 1 minute apart); the attachment rendering locale. Still not
  built: Metric changed [Sunset], streaming conditions on stream-backed objects, third-party application ownership
  and Project-scoped history visibility, global branches, event retries for dropped trigger events. Autopilot and
  older readers still look only at the first effect (`effect`).
- Workshop (doc 02) core concepts: done for layouts (pages, tabs, overlays), variables, events, routing (URL
  variables), state saving (share links), publishing and versioning, embedded modules (module interface) and the
  input / display widgets listed in the README. Demo: "Verifikasi klaim interaktif (demo)" (faskes selector into
  a URL variable, tabs of claims by status, a drawer with the claim's properties and the status action, a summary
  page with a pivot table and the embedded "Selisih tarif per diagnosis (demo)"). 9 API checks; view and edit in
  headless Chrome. Since then: variable transformations, function / aggregation / property / SQL query variables,
  struct and timestamp types, external IDs, lineage, variable-backed pages / tabs / overlays, conditional visibility,
  loop layouts, module derived properties, value and conditional formatting. The demo adds a summary text
  (aggregation + transformation), a tab picked by `?tab=t2`, Rp formatting with red / green selisih, and a loop of
  the five largest selisih (SQL struct array) as cards of the child module "Kartu klaim (demo)"; 9 API checks and
  view / edit (Variables editor, lineage, SQL preview) in headless Chrome. Then layouts: module header
  (horizontal / vertical, collapsible, favorites), sections (grid / rows / columns / toolbar / flow, collapse
  events), reflow of hidden and collapsed widgets, style formatting, overlay options, layout templates, outline,
  cut / copy / paste with same or duplicated variables. The demo has a header with page and section buttons, a
  collapsible section around the loop, a styled summary page and overlay options; 5 API checks and view / edit in
  headless Chrome. Sections are widgets on the 12-column grid, not Foundry's nested split tree (a rows or columns
  section is the split); collapsed vertical headers hide their widgets (no icon-only tabs); saved module colors and
  section drop zones (drag and drop from other applications) are not built. Then visualization widgets: object set
  title, Vega chart, map, Gantt chart, timeline, stepper. The demo's page "Peta & jadwal" uses them (faskes on a map
  from the new dataset "Lokasi faskes JKN (demo)" with illustrative coordinates, inpatient stays per faskes as a
  Gantt chart with deferred claims in red, risk alerts on a timeline, claims per risk category in Vega-Lite with the
  clicked bar in a variable, a stepper towards the queue page); checked in headless Chrome. Not done in them: map
  shapes and polygons, overlay layers and map templates (points only); Gantt layers across several object types,
  time zones and timeline start / end variables; timeline layers and ontology icons; Vega selections as object set
  filters (string output only) and the AIP spec generator; object set title drag. (Done since, 2026-10-13, WGT:
  Gantt data layers each with its own source / filters / colors / hover properties, events without an end excluded,
  drawn as points or ended at a variable, time zone local / static / from a variable (axis on the zone's wall clock),
  window start / end variables read and written by pan / zoom / Fit, per-layer selections and events, row order;
  timeline layers with titles from the title property / a property / `{{property}}` text, ontology icons and colors,
  a legend toggling layers, an active-object variable; Vega point / interval / date-bucket selections written as
  object set filter variables; object set title honours filter variables and drags the filtered set. Tested: 18
  in-process checks against raw counts (module "Gantt, timeline & Vega layers (test)"), 39 checks of the real widgets
  and panels in headless Chrome, the map widget harness 22 / 23 (the failure: a synthetic PointerEvent rejected by
  setPointerCapture in MapCanvas.tsx, a harness artefact). Not done: the AIP spec generator; not clicked in the real
  Workshop page; the demo modules do not use layers. Done since, 2026-10-14, WVG: the AIP spec generator — the author's prompt and the data inputs' names, fields and types (never rows) go to the platform's language model (`POST /api/workshop/vega/generate`, one retry with the reasons); the answer is offered only after the server checked it (`/vega/validate`: JSON, Vega-Lite v5 / Vega v5 schema, known marks, fields that exist or that the spec's transforms make, data only by input name or inline — no url data, href, loader or external addresses), previewed on the widget's own data, iterated on the current spec, an edited spec checked again before Accept, selection parameters the spec defines offered for linking. Tested: 39 API checks (real gemini-3.5-flash answers and stubbed refusals) and 27 in headless Chrome (generate, preview, Accept, the generated selection filtering the object set, refused edits), the earlier Workshop suites green; module "Vega AIP spec generator (test)" kept. Not done: not clicked in the real Workshop page; Vega (non-Lite) generation tried through the validator only; a Vega widget's selections only write their variables once the sources list has loaded (~10 s on a cold server).) Found on the way: a `.parquet`
  uploaded through Files gets `application/octet-stream` (mimetypes does not know it), so it is not listed as a
  dataset source; the demo dataset's type was set to the Parquet type directly (`drive.py` left as is). A second copy
  "Lokasi faskes JKN (test) duplikat - boleh dihapus.parquet" was made by mistake and is left for you to delete.
  Then collaboration, writeback and AIP widgets: comments, inline action, AIP chatbot (on AIP Agent Studio agents,
  which now take Workshop variables as application state) and AIP generated content. The demo's claim drawer has the
  status action inline (replacing the button), comments with faskes references and the action log, and an AIP Logic
  risk summary; the page "Asisten" has the agent "Asisten verifikasi klaim JKN (demo)" with buttons that send
  questions through the textbox variable, its answer in a variable, and LLM advice for the chosen faskes. 4 API checks;
  view mode in headless Chrome (one "(test)" comment was posted and kept; the inline action was not submitted, to
  keep the demo claims as they are; the comments and inline action panels were typechecked, not clicked). Not done:
  the agent writing variables (read-only application state), streaming (the answer appears whole) and temperature
  for direct LLM content (`/api/functions/llm/chat` takes neither), comment notifications to everyone who commented
  (only @mentions notify), passing comment text to an action, the action table layout and CSV upload, pre-fill from
  an object set variable, Apply to scenario, invalid-form hiding; AIP Analyst. (Done since, 2026-10-13, WAI: AIP
  generated content and the AIP chatbot streamed (`/api/functions/llm/chat/stream` streams provider models and takes
  model / temperature; agent sessions `.../messages/stream` with steps, variable writes and answer chunks), a
  temperature setting; the chatbot's agent writes Workshop variables the author marks read and write through a
  `set_variable` tool, wrong types refused; comments notify everyone on the thread (commenters and earlier mentions
  who can still see the object, `notify.deliver`) and can run an action with the comment's text / users / object /
  author; inline action table layout (live per-row validation, current values, keyboard moves, add / remove rows),
  CSV upload, pre-fill from an object set variable, hidden when the criteria fail, Apply to scenario in the table.
  Tested: 45 in-process checks with the real model (gemini-3.5-flash) and stubs for refusals, 34 checks of the real
  widgets in headless Chrome (module "AIP & aksi inline WAI (test)", object type "Klaim WAI (test)" kept). Not done:
  the "can still see the object" check not exercised with sign-in off; the table's checkpoint justification; live
  validation of the first 200 rows only; not clicked in the real Workshop page; AIP Analyst.) Found on the way: in newer Chrome
  `scrollIntoView` returns a promise, so an effect written as `useEffect(() => el.scrollIntoView())` crashes the page.
  Then module settings: auto-refresh with a Data Freshness widget, kiosk mode, redact mode, translations (manual and
  AIP), used colors, Performance Profiler. The demo watches Klaim JKN (pause / resume buttons in the queue), shows
  its freshness in the header, has kiosk mode on, English translations (an en-US browser sees the English header,
  pages, tabs and buttons) and a saved color behind the summary page; 2 API checks, and in headless Chrome: a change
  to the claims' objects file reloaded the widgets, kiosk was read-only, redact masked the text, AIP filled 26
  translations (not saved), the profiler timed the load. Not done: kiosk sessions are enforced in the browser only
  (no scoped server session, no Control Panel allowlist or launch history; the API still accepts writes from a kiosk
  page); redact uses the browser's masked-text style, not a custom font; auto-refresh watches whole object types
  (not filtered object sets) by polling, not by push; the profiler times data loads (queries, computed variables),
  not rendering; translations cover the strings listed above (not table column titles or pivot aggregations); saved
  colors apply to backgrounds only. Then filtering: object set filter variables, Filter List, Exploration Filter
  Pills and Search Bar, Prominent Terms. The demo's page "Eksplorasi" filters the claims (keyword, status histogram,
  care type, length of stay and admission date ranges, the faskes type through the Faskes link, "has a risk alert"
  through the alerts link), with a search bar, filter pills, prominent diagnoses, a table and a count, and extracts
  the chosen statuses into an array variable; 10 API checks (in, all / any, two variables, keyword, linked property,
  has / has no link, refusals, empty values) and the interactions in headless Chrome. Done since, 2026-10-12: union
  object sets of several types (a data source "Union of several object types…": shared property IDs share a column,
  an `object_type` column added; works in every widget's query), advanced keyword syntax (Simple / Advanced / Regex
  switch; AND / OR / NOT, brackets, quoted phrases, * / ? wildcards, the doc's precedence; at most 500 characters, 64
  terms, 16 brackets; `api/workshop_search.py`), regex search (the Ontology's regex syntax, only on properties with
  "Regex queries", a 2 s budget per query with the `regex` package, patterns ≤ 300 characters) and an opt-in prefix-only
  "contains" (also on linked objects). 10 earlier + 58 new in-process checks (advanced syntax checked against set
  algebra of plain keyword results, refusals, the budget stopping (a|aa)+c, unions of Klaim + Peringatan) and 21 in
  headless Chrome with the in-process API answering. Not done: the Workshop page's union picker only compiled; a
  union cannot use linked-object filters; advanced terms match like the simple keyword (not the full-text
  analyzers); under heavy load the 2 s regex budget once stopped a plain `.*`; a parse error shows once per count
  query. (Done since, 2026-10-13, WSU: advanced terms go through each property's analyzer, as Object Explorer's
  keyword search (on unions with each member type's analyzers; columns without one still match as substrings;
  leading wildcards only on "Leading wildcards" properties); linked-object filters on unions — one link per member
  type or every link to a target type, a member type without the link has no linked objects; refusals for links /
  sub-filter properties no type has. Tested: 68 new in-process checks (each analyzer, 15 queries equal to the
  Explorer search, unions equal to per-type results, has / has-no link on Klaim + Peringatan; object type "Catatan
  audit klaim (test)" kept), the earlier 10 + 58 and 21 headless Chrome checks. Not done: the Filter List cannot pick
  the union link forms yet (done since, 2026-10-13 (926f36f): it can — "a link per member type" with a dropdown per
  member type, or "every link to <type>", rows showing which link each member type uses or "no link: no linked
  objects", linked properties across every linked type marked "(only X)" when partial, value counts per union;
  tested: 37 checks in headless Chrome with real clicks (union picker, every-link Has 130 / No 14, per-type 14 / 28,
  linked-property filters) equal to per-type API answers, plus the 68 + 21 + 103 + 32 + 37 earlier checks; changing a
  link setup while its filter is active keeps the old filter until cleared; the Exploration Search Bar still offers
  links on single types only); link filters on interfaces; nested link filters; not clicked in the real app. Done
  since, 2026-10-13: the Exploration Search Bar offers the union link forms ("Every link to <type>", each member
  type's link, "· not on …" for member types without it) and an interface's link types; filters through interface
  links use each implementing type's own link (a type without it has no linked objects), the sources list them with
  direction, refusals for unknown interface links, interface links on unions and links from no implementing type; a
  filter whose link setup changes moves to the new link when the item still filters the same property and no other
  item uses that link, otherwise it is cleared (also for removed items). 22 in-process checks and 37 in headless
  Chrome on an interface held in memory ("Klaim atau peringatan (test)", nothing written to the Ontology), plus the
  37 + 68 + 21 + 103 + 32 + 37 + 10 + 58 + 21 earlier ones. Still not done: nested link filters; linked properties of
  an interface-target link come from the actual linked types.) Still not done: timeline and
  distribution components, charts and pivot tables (done since, 2026-10-12 (6fa7998): timeline and distribution components — server-side histograms (`Query.histogram`, auto / day / week / month / year intervals, numeric bins), brushing by mouse, keyboard and typed ranges, counts following the other filters, range summaries on pills; the Vertex widget also adds a variable's objects to the graph and exports the whole graph as PNG; 103 in-process checks against counts computed from the raw rows, 32 + 10 helper checks and 37 + 22 checks of the real widgets in headless Chrome; not checked in the real app page)
  writing filter variables (charts still use the module filters), linked filters grouped and collapsible (they show
  inline), property and link menus limited to prominent / visible ones (all are offered). Then objects and
  resources: Object View, Edit History, Action Log Timeline, Linked resources, Media Uploader, Resource List, and
  Markdown tables, highlights, object references and annotations. The demo's page "Objek" (a claims table, the
  claim panel, audit notes in Markdown referencing a claim, its faskes and its alert, the edit history — tracking on
  for Klaim JKN from now on —, the action log, the faskes locations file linked to claim …111, resource lists of the
  demo file and the JKN object types, an uploader, the full object view); 10 API checks (an edit on a "(test)" ticket
  recorded with before / after, then put back) and the page in headless Chrome (one "(test) bukti uploader.png" was
  uploaded and kept). Not done: Markdown annotations were typechecked but not shown with real annotation objects (no
  annotation object type here; Ontology work left alone); the Object View panel shows the type's visible properties
  (not a configured panel layout) and the full view's header and tabs cannot be hidden, nor a module interface
  mapped into its tabs; edit history is a Workshop-side log (turned on per object type from the widget, not Ontology
  Manager) and starts at the moment it is turned on; Resource List has no tags, favorite or prominent object types,
  image thumbnails or Carbon tabs; Media Uploader writes to Files folders (not datasets or media sets, no branches,
  no mobile camera); linked resources are kept by Workshop (Files has no object links). Done since (2026-10-14, WOV): the Object View widget's panel takes its layout from the type's published Object View (Standard / Configured, viewers may switch); the full view can hide its header and tabs, go back to the initial tab when the object changes, and run a Workshop module inside a tab with its interface variables mapped from this module; Resource List shows prominent and favorite object types (a star per item: the viewer's favorite object type, or the item's star in Files), image thumbnails on cards (an image file itself, or a Files image per item at top / right / bottom / left) and a per-item style. Tested: 32 API checks and 105 in headless Chrome with real mouse / keyboard on the widgets and both configuration panels (types "WOV fasilitas (test)" / "WOV catatan (test)" and two "WOV … (test)" modules kept), the earlier Workshop suites green. Not done: not opened in the real Workshop page (bundled widgets, own CSS); thumbnail bytes came from a stand-in; the mode menu is for the panel only; the thumbnail is typed as a Files ID (no picker); Files tags, Carbon tabs, icon colour override and the panel's interface mapping not built. Done since (2026-10-14, WRL): a thumbnail picker on Resource List items (the Files picker limited to images, preview, name, clear; the typed ID kept), "Choose…" / "Use this folder" for static Files items, an icon colour for the list and per item (item, then list, then the object type's Ontology colour — object type lists now show the type's colour by default); Media Uploader into media sets (a chosen set or a string variable; the set's formats when no extensions are set; plain sets item by item, transactional sets in one transaction per click, aborted on any failure; the output variable gets the media reference, the path variable the path) with module lint for missing / virtual sets; 21 API checks, 31 checks of the real Workshop page on `next dev` in headless Chrome (uploads checked against the API, a refused .txt), the WOV suites (32, 105) and the earlier Workshop suites green; media sets "WRL unggahan (test)" / "WRL unggahan transaksi (test)" and the module "WRL widgets (test)" kept. Not done: media set branches, mobile camera, Files tags, Carbon tabs, the panel's interface mapping; the open-transaction error and the abort only checked through the API; the "Resource List Files resources are not detected" lint warning never fires (inside the object-type-source loop). Then documents, video,
  telemetry and analysis: PDF Viewer, Video Display, Observability Chart, Free-form Analysis, AIP Analyst. The demo's
  page "Dokumen & analisis" has the generated "Pedoman verifikasi klaim JKN (demo).pdf" searched for the selected
  claim's diagnosis, the generated "Rekaman antrean verifikasi (demo).mp4" with scene key frames and a seek input, the
  status action's executions, AIP Analyst on the claims and a free-form analysis with the saved public path "Klaim
  ditunda per faskes (demo)"; 18 API checks (with a real model) and the page in headless Chrome. Not done: PDF text
  annotations (area annotations only; no annotation object type here to show them on), media from datasets,
  compute modules in the Observability Chart (none here), Free-form Analysis "Open in Quiver" and "Copy to Notepad",
  and AIP Analyst's own tool set (one query per question; Foundry's AIP Analyst docs are not in the reference set).
  (Done since, 2026-10-14, WFA: Free-form Analysis "Open in Quiver" — a new analysis from the path as it is (object
  set or table card input, filters / filter variables / Filter cards as filtered table cards, metric / bar / pie / line
  / pivot / heat grid / waterfall / object table / selector cards mapped; keyword / search / regex / geo filters and
  Linked objects kept as fixed lists of up to 10,000 objects; unmapped cards listed) — and "Copy to Notepad" (with
  "Enable copy for Notepad" on a saved path: chosen cards as embedded Quiver chart widgets in a new or existing
  document). Tested: 68 in-process checks (every card's numbers against the widget's own queries, three paths incl.
  the demo's), 19 in headless Chrome with stand-in Quiver / Notepad pages. Not done: no time range (Quiver's default
  applies), boolean compare case differs, dataset / restricted view inputs untested, not opened in the real Quiver /
  Notepad pages. Done since (WCU): Open in Quiver sets all time when the path has no time filter, else the bounds of
  its date / timestamp filters; the Comments widget shows display names for authors, mentions and action-log users
  (`GET /api/workshop/comments/{type}/{pk}/people`: only ids on that object's feed, only username / display name,
  404 when the object is not visible); Map "Search within" also searches map-template layers (the Map app's object
  search with the drawn shape, the layer's filters kept); an outside change of the selected time / start / end
  variables turns View latest off. Tested: 18 API checks, 37 in headless Chrome, the WMW2 / WFA / WAI suites. Not
  done: `$comment:author` passed to an action is still the user id; found template objects are not highlighted.) Found on the way: Gemini refuses an empty string in a schema enum; JSON schema mode often failed to parse the
  analyst's plan (2 minutes of retries), so the plan is asked as text first (about 5 seconds). Then cross-application
  interactivity and display optimization: mount / unmount behavior, drag zones, section drop zones, Object List
  reordering, App Pairing and commands. The demo's page "Lintas aplikasi" (draggable claims, a review drop zone that
  filters a table, a priority list ordered by dragging, pairing code JKN-DEMO, a draggable "Klaim ditunda" title, the
  command "pilihFaskes"); the deferred claims tab never unmounts, the top-selisih loop and the full object view mount
  on screen; 2 API checks and in headless Chrome: a dropped row and a dropped object set filtered the review table,
  reordering wrote the order, a posted command switched faskes and page, a visited tab stayed mounted, two paired
  windows shared a selection. Done since (2026-10-13): the Map app and Vertex are pairing partners
  (`web/src/lib/appPairing.ts`, a Pair control in both: enter or generate a code, peers live; `?pair=<code>`): an
  object selected in a paired Workshop module is selected in the Map and in Vertex and the reverse, with the Workshop
  widget's own messages; an object the receiving app does not show is ignored quietly (Vertex can opt in to adding
  it); nothing is sent while unpaired; a closed or navigated-away window leaves at once. Fixed in the Workshop
  widget: it answered every hello with a hello, so two paired modules pinged each other without end, and a closed tab
  stayed a peer for 40 s. 74 unit checks of the channel logic and 60 checks in headless Chrome with the real Workshop,
  Map and Vertex pages in one browser (an esbuild bundle and a stub API, not the Next server; re-run at commit with the
  widget fix). Not tested: vector-tile map layers, Vertex's histogram / saved-selection paths. Not done: Gotham applications (Gaia, Graph) as pairing partners (pairing is
  between windows of this platform that implement the channel), enrichment of Gotham objects,
  commands into other applications (they would have to listen for the message), keeping only the never-unmount
  widgets mounted (their whole tab, page or overlay stays mounted), and an animation of each mode in the panel.
  Found and fixed on the way: a restart marks running pipeline builds failed — a streaming job of another tab was
  interrupted once (it restarts from its checkpoint); pipeline builds are now checked before a restart. Then the
  platform: modules as Files items with Project roles, branching on global branches, Marketplace packaging. The demo
  modules ("Verifikasi klaim interaktif", "Kartu klaim", "Selisih tarif per diagnosis") are now in My Project; the
  "(test)" module "Modul uji branching (test)" and the installed "Modul terpasang (test)" are kept; the test branches
  were closed. 26 API checks (Files items, moving, a branch with a conflict rebased with a resolution, approval, merge,
  protection, lint errors, package and install with an input and missing dependencies) and the branch selector,
  Changelog, approval, linter and install dialog in headless Chrome. Not done: denial for users without a role was not
  tested (no non-admin user here); Files does not open a .workshop item in Workshop (it shows its icon and type);
  module changes are not tasks of the global branch's proposal (they are reviewed in Workshop, and an unapproved one
  stays on the branch when the global branch merges — marked "not merged"); the global branch merge path itself was not
  exercised (an Ontology change and a reviewed proposal are needed); there is no Marketplace store or DevOps product
  editor here: a product is a downloadable JSON package installed from the Workshop home. Then Scenarios [Legacy] on
  Ontology scenarios: scenario variables, Scenario Manager / Selector / Summary, "Load data from scenario", scenario
  comparison in tables, aggregation and property variables in a scenario, actions applied to a scenario, the scenario
  event. The demo's page "Skenario" (a manager, a selector of scenarios to compare, the RS-01 claims with compared
  scenario columns, the status action on the active scenario, "apply to the Ontology", layak-bayar counts on main and
  in the scenario, a summary); 5 API checks and in headless Chrome: a scenario created, an action applied in it (1
  object), the table showed 2 scenario columns and 2 changed cells, 101 vs 102 layak bayar, the summary 1 action. The
  scenario "(test) skenario Workshop" is kept (the Ontology was not changed). Not done: duplicating a scenario, models
  and domains (Foundry's legacy scenario models — no models here), visualization widgets (charts, maps, pivot) loading
  from a scenario (only the table / list / metric family through the query API), "save" filling a scenario object's
  type class automatically (it persists the scenario and optionally runs an action with the id and name), and "apply"
  needs an action type with an Apply scenario rule (done since, 2026-10-12 (a71809a): duplicating a scenario
  (`POST /api/ontology/scenarios/{id}/duplicate`, edits / links / applied actions copied, New / Saved / Updated
  badges), saving a scenario to a scenario object (`POST /api/workshop/scenarios/{id}/save`, preview, id / name /
  parameters filled from the `scenarios:` type classes, id locked, create then update; a save form in the Scenario
  Manager and Duplicate / Save button events), maps, Vega, Gantt, Timeline and pivot tables loading from a scenario
  like the charts; tested: 34 + 7 API checks, 25 checks comparing charts / Vega / map / pivot of an original and its
  duplicate with values computed independently from the scenario's objects (main data byte-identical), 32 + 30
  checks of the real widgets in headless Chrome (record and replay); not tested: Gantt and Timeline on their own, a
  save-then-update round trip in the browser; the Save button event saves without the form; still not done: models
  and domains, apply without an Apply scenario rule). Then mobile: the Mobile device type, the Mobile Navigation Bar,
  the QR Code Reader, the Current Location Manager and the mobile app launcher (`/m`). The demo module "Verifikasi
  lapangan JKN (demo)" (My Project; pages Antrean, Pindai, Detail klaim, Ringkasan, Tentang; a filter drawer; the
  navigation bar with a "Lainnya" submenu) has the current location with the nearest faskes from "Lokasi faskes JKN
  (demo)", deferred claims opening their detail page, a QR reader for the SEP number and a barcode reader for several
  codes with a prompt; 7 API checks (launcher list and search, QR and EAN-13 decoding, a non-image refused) and in
  headless Chrome emulating a 390 px phone with a fake camera showing a QR code / a barcode and a fake location: the
  launcher opened the app, the location showed "Near RSUD Contoh Sejahtera (169 m)", a QR scan from the camera found
  claim …111, its detail page kept "Pindai" highlighted, Back / Forward moved between pages, the submenu opened the
  drawer full width, two barcodes went through the prompt into the array, a denied location showed the warning, the
  status action form filled the screen with 16 px inputs; the editor showed the module at phone size. Not done: no
  Mapbox (the preview names the nearest row of a chosen source instead of a reverse-geocoded address); PDF417, Data
  Matrix and Aztec are only read where the browser has BarcodeDetector (Chrome on Android, Safari on macOS — not Chrome
  on Windows or Safari on iOS, where the platform decoder reads QR and 1D codes only); the camera loop sends a frame
  every 0.6 s to the API when the browser cannot decode; the navigation bar is set in Settings (not a Layout section);
  Button Group menus are not turned into bottom drawers; the launcher is a web page (no installable app, no Carbon
  embedding of the icon); access from phones needs the network setup the docs describe (VPN, MDM browser or an
  allowlist) — not tested on a real phone. Then value and conditional formatting of time series (the doc's scope: time
  series property columns in the Object Table and time series displays in the Metric Card): summary columns with
  sparklines, the time series metric card with a sparkline, the full numeric value format (fraction / integer /
  significant digits, grouping, notations) for every formatted widget, "between" rules and rules coloring the
  sparkline. New demo data: the dataset "Klaim harian faskes JKN (demo).parquet" (90 days of daily claims and tariff
  gap per faskes, illustrative), the sync "Klaim harian faskes JKN (demo)" and the object type "Faskes JKN – deret waktu
  (demo)" (backed by "Faskes JKN deret waktu (demo).parquet", two time series properties); the demo module's page "Deret
  waktu". 8 API checks (a sum equals the raw points' sum, all-time count 90, last = the latest point, bad range 400, a
  non-time-series property an error per object) and in headless Chrome the table's colored values and sparklines, the
  metric cards after selecting RS-01 and the editors. Done since, 2026-10-12 (80e8179): color scales (two or
  three colors on text, fill, sparkline or text + sparkline; table bounds from the rows shown unless fixed, metric
  cards with fixed bounds; a matching rule wins) and rules testing change, change % or trend (least-squares slope
  per day) over the range, computed from the sparkline's points (30–40 buckets, not the raw points); 21 checks against
  a Python computation on "Klaim harian" and the real components rendered in headless Chrome; the editors not
  opened in the real Workshop page. Done since, 2026-10-13 (eb5f8f6): a column's summary and sparkline follow its rolling window (`rolling`, `rolling_agg`; the column editor's Rolling row), all time series columns load in one request per page of 500 rows (`POST /api/workshop/ts-columns/batch`, up to 50 columns, errors per cell) so rows past 500 fill (before: 2,100 cells of a 1,200-row table stayed empty), the Metric Card's sparkline follows the rolled series; tested: 30 in-process checks (7 column setups incl. 7-day mean / 3-day sum / 14-day std equal to values computed from the raw points; columns without a window equal the old per-column code) and 21 checks of the real table and editor in headless Chrome against the HEAD version (3 requests → 1); not in the running app; the server still evaluates each cell separately; other column transforms and the Value Change summarizer not built (done since, 2026-10-13 (7972bf9): Value Change — the aggregation over the range minus the previous period or an offset like 1y, as a difference or percent, with current / previous in the tooltip and both periods drawn; std, difference, relative difference, integral (unit, linear / left / right), product and time-weighted average; transforms in order after the rolling window: cumulative, periodic, derivative, integral, formula ($X / $A / @property), time shift; the column editor's transform list; rules and color scales test the new summaries. Tested: 84 checks (25 new setups equal values computed from the raw points, the 7 old setups identical to HEAD) + the 30 earlier, 19 in headless Chrome; not built: value at a time, a periodic alignment timestamp, fixed / relative-end custom ranges, the Metric Card on the new options). Earlier: Not done: the summary of a table column ignores rolling windows; one
  request per column for up to 500 rows (no paging of the series); the Ontology-level value formatting of properties is
  separate (this is local to the module, as in the doc).
  Done since (2026-10-13, 25ce801): the Metric Card on the newer summaries / transforms and custom ranges (exact,
  open-ended, relative with an end offset), value at a time (exact time, offset from now or now; series / previous /
  next / nearest / linear interpolation; change against an earlier value), periodic alignment and window type, a time
  range transform. Tested: 77 API checks against raw points plus the 30 / 84 earlier ones, 23 in headless Chrome on
  module "Metric Card deret waktu TSC3 (test)" plus the 19 / 21 earlier browser checks. Not done: no "enum" variant of
  value at a time; "now" with the series' own interpolation is empty past the last point.
- Workshop integrated with the other applications (after modules became Files items with versions and scenarios):
  Files opens `.workshop` and `.slate` items in their applications; use cases find the Project's modules; custom
  widget parameters bind to module variables and their OSDK calls work in a scenario; Autopilot's graph shows a module
  as a human step for every action it can apply (buttons, inline actions, table / list actions, events, the mobile
  navigation bar); Workflow Lineage's Workshop nodes carry their Files item (bulk move) and versions, read the
  module's variables / settings as well as its widgets, and "Publish Workshop" publishes the latest version of the
  selected modules; Carbon shortcuts take parameter values and open modules in tabs on "open module" events. 17 API
  checks ("Modul use case (test)" was created in the demo Project and kept) and the redirect from Files, the Carbon
  tab and the publish panel in headless Chrome. Autopilot's Workshop edges also include modules that only reference an
  action in an Observability chart (any `action_type_id` in a widget counts).
- Found and fixed on the way: a deploy created a link type between two existing (locked) object types; links now
  follow their object types' permissions (the stray test link was deleted).
- Found and fixed on the way: Workshop object rows bypassed property security policies (hidden properties such as
  names showed in tables and widgets).

- Done 2026-10-13 (11c54e1): Workshop Map widget tools — lasso and polygon selection (holes, Shift to add, Enter /
  Esc / Backspace), drawing points / lines / polygons into GeoJSON variables both ways (single draw mode, antimeridian
  split, Select within), geodesic length / perimeter / area measurements, a timeline over the layers' `time_column`
  (window or cumulative, start / end variables both ways, playback, lock). Tested: 117 + 102 geometry checks in Node,
  78 in headless Chrome with real mouse / keyboard (module "Map tools (test)" kept, "Tangkapan Nelayan (demo)" for the
  timeline), the earlier 84 + 23 map suites and 6 on the real Workshop page. Not done: shape editing (Modify),
  geospatial object / track search, the Selected time variable, Auto pause, View latest, 12 / 24-hour format.
  Done since (2026-10-13, WMW2): a Modify tool (drag / add / remove corners, move a whole shape, holes, Esc cancels;
  written to the drawn- and selected-shape variables on release); Search within sent to the server (a Workshop `geo`
  filter on geopoint / geoshape or a latitude / longitude pair, GeoJSON or a box, antimeridian-aware, through Object
  Explorer's geometry reader; up to 5,000 per layer, the found objects selected); layers load only the objects in
  view after each move; the timeline's selected time (a variable both ways, a draggable marker), Auto pause at the
  times of an array variable, View latest, 12 / 24-hour clock. Tested: 25 API checks, 70 Node checks, 63 in headless
  Chrome with real mouse / keyboard, the earlier 117 + 102 Node and 23 + 84 + 78 browser checks. Not done: object
  track search (tracks are not drawn in Workshop), Search within on map-template layers, a selected time set from
  outside while View latest is on is pulled back; not tried on the real Workshop page.

- Done 2026-10-14 (ad3f50a): Workshop Object View, Edit History, Action Log and Linked Resources accept interface
  sources (the implementing type's published Object View; the standard panel reads interface properties through the
  type's mapping, unmapped ones shown as —; `GET /api/workshop/interface-object/{iface}/{type}/{pk}`); Resource List
  Files tags (a Tags content option, tag chips, a viewer tag filter; `/api/workshop/resource-tags`, `.../of`,
  `/resources/tagged`); the packaging lint now warns for Files resources and a missing Files item / thumbnail is a
  packaging error; scenario duplication (a71809a) checked. Tested: 37 API checks, 29 on the real Workshop page in
  headless Chrome, the earlier WRL 21 / WOV 32 / WOV UI 105. Not done: the docs' module panel for interface Object
  Views (no Workshop module panels here); not tested signed in.

## 21. Analytics (docs 01–11 of the Analytics reference)
Audit 2026-10-09 (B buildable, P needs a product that does not exist here):
- Done: Fusion (doc 09, `api/fusion.py`, `/fusion`; was a mockup). Done since: live co-editing — other users' selected
  cells are outlined and their edits arrive every few seconds while they edit (polling, not a socket; edits are saved
  per cell and merge on the server, the last write wins on the same cell; compiled, not tried with two browsers); the `ts.*` time series functions on time
  series syncs — timeseries, count, min / max / mean / stddev, first / last value and timestamp, difference, scale,
  shift, time_range, last, derivative, integral — shown with a sparkline; one kind of sync per sheet;
  conditional formatting rules — comparisons, text, empty, between and color scales over computed values; the fill
  handle with formula shifting and number series; `query_params` (the URL's parameters) and `url_encode`; about 70
  more library functions: statistics, sumif / countif / averageif, sumproduct, ifs / switch / choose, regex, text
  formats, date arithmetic, networkdays, array helpers; the manual "update sources" mode, where lookups keep the
  data read at the last update; sheet syncs, a whole sheet's used range written to a dataset. Not done: Lime indexing (done since, 2026-10-12 (807639c): a SQLite index per dataset version on chosen key columns under `data/fusion/indexes/` answers all five lookup functions and every modifier except neq-only with the scan's exact rows and order (the index narrows, the scan's rule decides); stale indexes never answer, a new version is scanned and the index rebuilt (inline when small, background when large); manual-update documents do not use indexes; an Indexed datasets panel (status, lookups through the index vs scanned with reasons, one-click index on the filter columns, sync / remove); 68 checks (about 5,000 lookups and formulas identical with and without the index, staleness, permissions, caps, cleanup) and a 500,000-row timing test: 68 lookups in about 1.4 s instead of about 50 s; the panel not opened in a browser, not inside Find and use data, branches not indexed separately, index status per API process)
  (any Parquet dataset in Files can be looked up), the rest of Fusion's ~400 library functions (done since: 77 more — SUMIFS / COUNTIFS / AVERAGEIFS / MAXIFS / MINIFS, XLOOKUP, HLOOKUP, IFNA, ISERROR, SEQUENCE, FILTER, rounding, combinatorics, trigonometry, regression and moment statistics, DATEDIF, YEARFRAC, WORKDAY, DAYS360, text and information functions; 70 checks against spreadsheet results; about 230 now; done since: element-wise operators on ranges and arrays — B1:B4 = "x", A1:A4 * 2 — giving arrays, so filter / sumproduct / countif take them; done since, 2026-10-12: 299 more names, about 547 now — the documented Fusion functions for arrays, text, dates, aggregates, lookup modifiers (eq … fuzzy, token matches) and validation, plus financial (pmt, npv, irr, xirr, depreciation …), probability distributions and tests, database functions (dsum …), engineering (base conversions, bit operations, convert), more statistics, references (xmatch, offset, indirect, take / drop …) and information functions; find / search / replace / match / index / ceiling / floor / date_format take their documented extra forms; fixed: every arithmetic operator also computed x ** y, so =10*365 gave #ERROR; 1,084 checks against the docs' and spreadsheet examples, 477 of them against scipy, and the 212 formulas of the 39 stored documents give the same results as before. Not built: the functions that need UI rendering (checkbox, datepicker, chart.*, action.open_url / open_markdown_panel), object functions (cells hold no objects), the submit_to_region_with_* variants, 2-D array results (mmult, transpose, linest …), complex and Bessel functions, bond functions, let / lambda; $A$1 absolute references are still rejected; done since, 2026-10-12: $A$1 / $A1 / A$1 references (with sheet names; one shifting rule shared by server and browser for fill, paste, sort and row inserts — 1,245 cases compared), 2-D results that spill right and down (transpose, mmult, minverse, munit, linest with statistics, trend, growth; #SPILL! when blocked, a result reading its own spill area is circular), checkbox and datepicker cells (`PUT /api/fusion/documents/{id}/control`, locked cells refused), chart.bar / line / chart / options drawn as SVG in the cell or as a sized panel, let / lambda, action.open_url (http / https only, checked on server and in the browser) and action.open_markdown_panel; 107 new checks (matrix functions against numpy, Excel's linest example) plus the 1,084 library checks, the formulas of the stored documents unchanged; the editor not clicked in a browser; still not built: spilling filter / sort / sequence, the A1# spill-range syntax, object functions, submit_to_region_with_* (both done since, 2026-10-12 (4f877e6): object cells with RIDs `ri.ontology.main.object.<type>.<pk>`, object(rid) and object(type, pk), object_set(set, [property, value]…) from a saved exploration or list (filters with modifiers, at most 200), object_dropdown(object set, …) beside the old form, get_property (an object set gives every value), get_object_rid / get_object_type_id, read as the caller (markings, object security, hidden properties); submit_to_region_with_key / _lazy / _and_timestamp / _and_timestamp_lazy and action.submit_to_region_with_options / submit_options (rows matched by key, updates or appends, should_submit, submitEmptyCells / succeedWhenNoRows, this or another editable document, all or nothing); 61 in-process checks on the JKN demo objects and every submit variant, the 1,084 / 1,949 / 107 / 108 library checks and the 282 stored formulas unchanged; the page not clicked; the lazy variants' region cache not built (done since, 2026-10-14: the `_lazy` keyed submissions keep what they read of the target table region — position, headers, the row of every key — in memory between clicks (64 regions, an entry valid only for the exact stored bytes it was read from, so any edit, sort, appended row, other action, restore or other user's submission reads the region again); every keyed submission finds its rows through a key index and moves the cells below the region once for all appended rows (2,000 rows into a region of 2,000: 12.5 s → 0.015 s; a second click on a kept region 0.23 s → 0.0013 s); a keyed submission stopped by a locked cell or an unknown column now writes nothing (rows before the locked cell used to stay written); `object_set()` with the same type and filters is read once per recalculation. 33 checks — 3,000 random documents equal to the earlier code in results, toasts, errors and stored text, 17 on real documents ("Fusion region cache (test)" and its target kept) — the 58 stored documents' 796 cells unchanged, the earlier Fusion suites as before, with corrected copies of the 15 + 1 checks whose expected values changed with the Excel error values. Not done: object-function results are not kept between recalculations; the cache is per API process; the page not clicked (no web change); the Forms suite not re-run); the UI-rendering functions below were already built), complex / Bessel / bond functions (done since, 2026-10-12: complex numbers — complex, imreal / imaginary / imabs / imargument / imconjugate, imsum / imsub / improduct / imdiv / impower / imsqrt, imexp / imln / imlog10 / imlog2 and the twelve trigonometric / hyperbolic im* functions, "i" / "j" suffixes, 15 significant digits as spreadsheets show them; besselj / bessely / besseli / besselk; bonds and discounted securities — price / yield / duration / mduration, the coup* family, accrint / accrintm, disc / intrate / received, pricedisc / pricemat / yielddisc / yieldmat, tbill*, oddfprice / oddfyield with every day-count basis; isomitted; 1,949 checks, 920 against cmath and 840 against scipy and the docs' / Excel's examples; the 1,084 library, 107 2-D and 108 dynamic-array checks and all 227 formulas of the stored documents unchanged); done since, 2026-10-12 (a94c400): dynamic arrays — A1# spill references (#REF! when the cell does not spill, moved when copied), 2-D inline arrays {1, 2; 3, 4}, operators / & / if element-wise with broadcasting (=A1:B3 spills), spill collisions resolved by sheet order (#SPILL!), sort / sortby / unique / filter / sequence / randarray / take / drop / choosecols / chooserows / vstack / hstack / tocol / torow / wraprows / wrapcols / expand, spilling textsplit / xlookup rows / frequency / mode.mult / index(r, 0, c), map / reduce / scan / byrow / bycol / makearray, omitted arguments; 108 checks against Excel / Sheets examples (document "Fusion dynamic arrays (test)"), the 107 2-D and 1,084 library checks, the 223 earlier formulas of the stored documents unchanged; differences: vstack / hstack / wrap / expand pad with empty cells (Excel #N/A), {10, 20} stays a column, sequence(0) is an error; not built: isomitted, #CALC! / #N/A codes; the page not looked at in a browser; done since, 2026-10-14 (FX): #N/A (na(), Excel-style lookups finding nothing, the padding of vstack / hstack / wraprows / wrapcols / expand / textsplit) and #CALC! (empty filter / sequence(0) / randarray(0) / take-drop to nothing, a lambda with several values or uncalled), isna / ifna / iserr / iserror / iferror / error.type as in Excel and element-wise on arrays (the Fusion docs say nothing on error codes), {10, 20} a row and {1; 2} a column, isomitted was already built (be804b3); the web shows error codes from the same table as the API (checked in Node); a formula-bar bug that dropped the first typed character fixed; tested: 118 engine checks, 48 in headless Chrome on the real page (typing formulas, spills, #SPILL!, checkbox / datepicker / chart.* / action.label), the 56 stored documents' 340 formulas unchanged; 15 checks of earlier suites (fu3 library 5, fu3 dynamic 9, agent_fusion 1) expected the old behaviour and now fail by design); done since, 2026-10-13 (4eecea9): `action.label(type, label, [icon], [intent])` as a button, link or tag with about 70 Blueprint icon names mapped to the app's icons (the old `action.label(text, intent)` still works), clearing a control's selection shows the formula's own value again (an unbound datepicker no longer goes blank); tested: 146 engine checks (1,517 formulas shifted identically by API and web), 58 API checks, the 108 dynamic-array and 107 2-D checks, 6 icon checks; the library suite keeps its 13 older expectations of flat lists where results now spill; not clicked in a browser. Tested in-process (TestClient, "(test)" document and
  dataset); the editor was compiled, not clicked through in a browser.
- Done since: scheduled builds of Contour's saved datasets (every hour / 6 hours / day / week, run as the user who set
  the schedule, failures recorded on the saved dataset).
- Done: Contour (doc 03; `api/contour.py`, `api/contour_engine.py`, `/analytics`; was a browser-only page with one
  path, whose localStorage analyses are not migrated). Done since: expressions in Spark SQL, Contour's expression
  language (an analysis setting, translated to DuckDB with sqlglot; DuckDB SQL stays the default); "Export to
  Pipeline Builder" creating the pipeline for paths on one dataset (translated to SQLite, checked on a sample; tested
  in-process, the result compared with SQLite; the pipeline was not opened in the Pipeline Builder page). Done since (2026-10-12): the export
  also takes paths using REPLACE / EXCLUDE / RENAME (expanded into column lists), pivot (a CASE per value, the values
  read from the data at export time and said so) and unpivot (a UNION ALL per column), unions (a union node by name
  plus a step restoring column order and types) and several sources (an input per dataset; join, enrich, semi / anti,
  intersect and subtract boards as join nodes; another path as its own nodes) — `api/contour_pipeline.py`; each
  rewritten step is compared with the board's own result at export time and refused when it differs; 68 checks, the
  exported pipeline run by the web app's pipeline engine (Node, sql.js) and compared row for row with the path; the
  dialog compiled, not clicked; no exported pipeline was deployed. Still refused, with the reason: object type
  sources, pivot with median / stddev / distinct, over 200 values or on boolean / timestamp values, join keys of
  different types, a join giving one column name twice, a union of a text with a number column. Unpivoted decimals
  lose a trailing ".0" in Pipeline Builder. Done since (2026-10-13): engines for large inputs
  (`api/contour_scale.py`, `api/contour_spark.py`, an Engine setting per analysis and a badge on results) — above 1,000,000
  rows or 128 MB (settable per analysis and by environment) a dataset is not read into memory: DuckDB scans its Parquet
  file lazily (needed columns and row groups, filters pushed down) and spills to disk past a memory limit, running the
  same SQL as the in-memory engine; Spark is opt-in per analysis (or above a row count when set): the boards as Spark
  SQL on the local session, falling back to DuckDB with a note for boards it does not cover (scatter / map, Cipher,
  object type and restricted view sources, some pivots and casts) or when Spark fails. Saves, builds, CSV export and
  Code Workbook's Contour nodes use DuckDB. 86 checks (every board on every engine against the in-memory result, the
  scan plan, saved datasets, routes; re-run at commit), the earlier Contour suites, and the 134 paths of the 91
  existing analyses: the scan tier equal on all, Spark equal on 109 and falling back on 25. Known Spark differences:
  the last digits of floating sums, the order of rows tied in a sort, text of extreme doubles. The Engine field and
  badge were compiled, not clicked. Not done: a Spark cluster (the session is local), Spark for scatter / map boards. Done since, 2026-10-12 (03264a7): scatter / map boards beyond simple SVG — a canvas scatter (points up to
  a limit, default 10,000, max 50,000, density cells beyond it; color by category or scale, size by a column, log axes,
  least-squares trend line; brush / Ctrl-brush / legend selections filtering the boards below, wheel zoom) and a map
  board on the Map app's map (points, clusters, heatmap on canvas; choropleth from a GeoJSON boundaries file in Files
  or a GeoJSON column, lines; legends, layer toggles, tooltips, Fit to data; click / circle / polygon selections, a
  remove mode); 39 server checks on a 30,000-row "(test)" analysis against numpy / shapely, 25 checks of the real
  components in headless Chrome with saved answers (basemap off); not clicked in the app, the settings panels and the
  boundaries picker only compiled; a map layer's "size" is not implemented, a GeoJSON-column shape cannot be selected.
  Done since (2026-10-13, c017458): a point layer's size by a numeric column (linear / log / square root, a 4-bin
  legend with rows lacking a size counted) or a preset, cluster size scaling and colour, layer opacity, an initial
  viewport, legend / layer-toggle switches; GeoJSON-column shapes (choropleth and lines) selectable by click, a new box
  tool and the polygon tool (md5 shape keys, both DuckDB engines; Spark falls back to DuckDB for map boards); the map
  no longer re-fits on every rerun. Tested: 35 API checks against shapely, 19 on the JKN demo facilities, 38 bundle
  and 18 real-app checks in headless Chrome, the earlier Contour suites. Not done: opaque shapes cover sized points
  (canvas below the SVG), hover on a sized point only tested in the bundle.
  Done since (2026-10-13, CM2): layers drawn in the board's layer order (dragged in the settings; consecutive canvas
  layers share one canvas, so points can sit above shapes), hover tooltips on the topmost layer under the pointer;
  map boards on Spark — contour_viz's DuckDB queries translated with sqlglot (isfinite, log10, `/` as DOUBLE) for
  every layer and selection, falling back to DuckDB with a note when a layer reads text / timestamps as numbers,
  writes fractional columns as text, or has a non-text GeoJSON column. Tested: Spark vs DuckDB map results on 17
  layers and 8 selection kinds (t_spark_map.py), the engine suite, 13 earlier Contour suites, 21 + 38 bundle checks
  in headless Chrome. Not done: floating cell aggregates may differ in the last digits on Spark; not clicked in the
  real app.
  Done since (2026-10-13, CS): scatter boards on Spark — contour_viz's scatter queries (points, density cells past the
  point limit, color scale / categories, size range, trend line) and their selections (brushed rectangles, Ctrl-brush,
  legend categories) translated with sqlglot; DuckDB fallback with a note when x / y / size is not numeric, the color
  column is a timestamp or non-category type, or a scatter is switched to its rows (DuckDB's LIMIT has no order); no
  trend line when x does not vary (both engines). Tested: 112 checks of Spark vs in-memory DuckDB vs the scan tier
  (counts / cells / categories exact, other numbers within 1e-9; log axes, DECIMAL brushes, date / boolean categories),
  the 12 Contour regression scripts, the map / engine suites updated for scatter on Spark (48 + 91). Not done:
  last-digit differences in trend / averaged sizes / log10 documented, not removed; not clicked in the real app.
  Done since (2026-10-14, CT): columns a scatter or map reads as numbers are cast on Spark exactly as DuckDB's
  TRY_CAST casts their type — text parsed by DuckDB's rules (whitespace, '+-7', '1_000', nan / inf accepted; hex and
  'd' / 'f' suffixes not), booleans as 0 / 1, dates and timestamps NULL — so text / boolean / date / timestamp x, y
  and size columns, timestamp color categories, map layers reading text as numbers and scatters switched to their rows
  (inputs of at most 5,000 rows) run on Spark instead of falling back; old dates / timestamps read as written
  (CORRECTED rebase). Still on DuckDB with a note: datasets with a time-zoned timestamp or a time-of-day column, row
  switched scatters over 5,000 rows, float columns a map writes as text, non-text GeoJSON columns. Tested: 6 + 67 +
  169 checks of Spark vs in-memory DuckDB vs the scan tier, the earlier scatter / map suites (112 / 48, flipped where
  they expected the fallback), engines 91, viz 39, export 68 and the 12 Contour regression scripts; the real
  /analytics/[id] page on a throwaway Next dev server in headless Chrome (66: engine badge, map layer order — points
  above opaque shapes clickable, shapes on top when moved — brushes / legend / point / shape selections equal to
  DuckDB). Not done: tie-breaks of sorts / limits and last digits may still differ between engines; local Spark
  only; not tested signed in.
  Done since: co-editing — presence avatars, others' saves load while
  this copy has no unsaved changes, and a save made from an older revision is refused (the newer one is loaded and
  the user told; tested in-process, the page compiled, not tried with two browsers).
  Tested in-process ("(test)" analyses and datasets) plus the kept JKN demo "Risiko fasilitas kesehatan JKN (demo)";
  the pages were compiled, not clicked through in a browser.
- Done: Insight (doc 04) branches, static lists, object set references and copies, publishing paths as object sets.
  A branch here is an Ontology scenario (data edits on top of main): Ontology branches (schema changes in
  `ontology_branches.py`) have no read-through for data, so object types changed only on a branch are not analyzed
  there. Done since: filters on a linked property ("On a link": objects with a linked object matching, or without one)
  and the "contains any word from", "contains phrase" and "matches terms within" (gap, order, negation) search types
  (`ontology_explorer.py` filter ops `any_word` / `phrase` / `within` / `linked`), Vega charts on SQL results
  ($SQL / $SQL.column), Group By rows that filter the results while selected, and the platform branch taskbar ("Use in
  every app" keeps the branch for the browser tab: every app's Ontology requests use it, the app header shows it with
  Exit; apps with their own API clients, e.g. Vertex, keep their own scenario setting; compiled, not clicked through). Tested in-process ("(test)" list, object set and scenario); the page was compiled, not clicked
  through in a browser.
- Done since: Quiver cross filter cards (charts subscribed to it filter its object set and each other; on canvases and
  dashboards; in the JKN demo "Risiko faskes JKN (demo)").
- Done: Quiver table cards (doc 05; `api/quiver_tables.py`): transform tables (object sets, datasets, tables,
  manual values), charts, value cards, Vega plots, on the dashboard; Quiver chart / dashboard widgets in Notepad;
  drill path capture from object set cards. Not done: most of the ~200 single cards as separate cards (a transform
  table's SQL expressions cover the numeric / string / date / boolean / array operations), time series columns in
  transform tables (done since: a time series, search or event set card as a transform table's input; done since,
  2026-10-12: time series columns — a table over an object set card takes `series_columns` [{property or
  "sensor:<name>", op, range, at, points}]: last / first / mean / min / max / sum / count / std / median / range, value
  at a time, first / last timestamp and a sparkline per row, over the analysis' range, the full series, a fixed or a
  relative range; at most 2,000 series reads per run, unreadable series give empty cells; `api/quiver_series.py`; 57
  checks against values computed from the raw points; the editor section and sparkline cells compiled, not opened in
  a browser; done since, 2026-10-12 (578c88a): rolling / periodic / cumulative / derivative / integral / shift /
  sample / filter / dsp transforms as series columns (chained, windows read before the range so the first value has a
  full window), a "Time series unit" operation, series columns on a table whose input is another table (traced back to
  the object set card; refusals for dropped primary keys, name clashes, loops), and a Grouped time series plot card
  (one line per row of a sparkline column, paged, optional linear aggregation — mean / sum / min / max / median / std /
  range over interpolated series); 85 in-process checks against raw points and hand-worked values, analysis "Plot
  berkelompok (test)" kept; compiled, not opened in a browser; the grouped plot has no CSV export and is not in the
  Report editor's card picker; done since, 2026-10-12 (455cc8f): eight single cards (`api/quiver_cards.py`,
  `SingleCards.tsx`) — numeric aggregation (also over a transform table or number array), column values (unique),
  numeric formula (Quiver syntax with ternary, && || !, $card / $parameter refs read on demand whatever their order,
  cycles refused, AST allow-list, numbers-only arithmetic), floor / ceiling / round, date difference, date part,
  correlation matrix (Pearson / Spearman) and waterfall plot; in the canvas "Single cards" menu, dashboards and
  published dashboards; CSV export for correlation, waterfall, column values and now the grouped plot; 46 in-process
  checks against pandas on the JKN claims (analysis "Kartu tunggal (test)" kept) plus the earlier rolling / grouped
  regressions, and in headless Chrome (formula and column values cards added from the menu, dashboard mode). Not done:
  the rest of the ~190 single cards (done since, 2026-10-12: string operations, comparisons, Boolean formula, create / stepped array, array operations, coalesce, range and range operation cards, range parameters reaching the cards; 188 checks against pandas and hand-worked values, with refusals and cycles; editors compiled, not clicked. done since, 2026-10-12: string selector, property value select, object selector (also an object set of the chosen objects) and transform table row selector ($RS1.column) parameter cards — selections are parameters in table expressions and filters, the canvas selection is the card's default — string / number to date, day / week / month / year to date, object property, Multipass attribute and X / Y range cards; a published dashboard re-runs with a viewer's selections (`POST /api/quiver-tables/dashboards/{id}/run`, saved defaults unchanged; wired in the Object View dashboard tab with "Reset selections"); in the canvas menu under "Selectors (parameters)" and "Dates and data"; 166 + 21 in-process checks (Klaim JKN; no boolean property to test a boolean selector) plus the earlier 46 + 90 + 52 card regressions; editors compiled and linted, not clicked; not wired: selections on the Quiver page's dashboard mode and /quiver/dashboards/[id] (selectors show, viewers cannot change them); done since, 2026-10-12 (b0aff8b): wired — `useDashboardSelections` keeps a viewer's selections for the view only, each re-runs the dashboard ("Updating…", the previous answer kept, late answers dropped, errors shown), Reset selections returns to the saved defaults, cleared on a change of dashboard / version / object / mode; the published page runs at the version shown, the editor's dashboard mode previews the draft without saving; 15 + 21 in-process checks and 45 checks of the real pages in headless Chrome with recorded answers (no app CSS); Notepad's dashboard embed still has no viewer selections; done since, 2026-10-14: the time series single cards — numeric aggregation (incl. time-weighted average, integral, percentile), value at time / enum value at time / latest enum value / unit / start / end date / backing object, regression coefficients (series against time or of a scatter card), shift date / time, time series distribution, scatter plot and heat grid with a regression line; runs send the analysis' root object, the cards re-run on a logic / time range / root change, each menu entry creates its own operation; 123 in-process checks on "Kartu deret waktu tunggal (test)", the 13 earlier Quiver suites green, 32 checks of the real analysis page in headless Chrome against the in-process API (no app CSS, dropdowns set by script); not opened: the published dashboard page and the Notepad widget with these cards; not in the Report editor's card picker), published dashboards and the
  Notepad widget not opened in a browser with single cards), writeback (done since: Action button cards —
  an Ontology action with defaults from constants or value cards, on canvases and dashboards; event sets — from
  objects' start / end properties, optionally matched to the root object, from ranges, time shift, deduplicate; shaded
  on plots and usable as segments; visual functions — a card and its upstream saved with chosen inputs, the Visual
  function card sets them from cards or values), Carbon embedding of dashboards (Workshop already embeds them; done since: an Object View tab
  showing a published dashboard opened for the viewed object — root object and same-type object set cards bound to it;
  tested in-process on "Dasbor per stasiun (test)", the tab compiled, not clicked through), Marketplace. Done since: a save from an older revision of the analysis is refused (two people editing one analysis
  no longer overwrite each other silently; no presence, analyses are not Files items). Done since:
  dashboard publishing (a Files item in a chosen folder, a version per publish with an optional note, a read-only
  viewer at /quiver/dashboards/<id> with earlier versions; Files opens a published dashboard — and Fusion, Notepad, Contour, Code Workbook, Report and Form documents — in its application instead of downloading the JSON; compiled, not clicked). Tested in-process ("(test)" analysis) plus the kept JKN demo
  "Risiko faskes JKN (demo)"; Vega plots and the pages were compiled, not clicked through in a browser.
- Done: Code Workbook (doc 06; `api/code_workbook.py`, `/code-workbook/workbooks/<id>`; the repository-graph viewer
  stays at `/code-workbook/<repo>`). Done since (2026-10-12): Spark profiles per workbook (Environment tab; the
  transforms' profile names; unknown, inconsistent or contradicting profiles refused on save; applied when the
  workbook's Spark session starts — interactive runs, builds and the console — which restarts when they change; in
  the session history and its comparison; cross joins stay allowed by default, as before profiles; 37 checks reading
  the running session's configuration; the tab compiled, not opened in a browser). SparkR: P — the platform's R (4.6.1)
  has no SparkR package (it ships with a Spark distribution, not CRAN); an R node asking for a Spark input fails
  naming what is missing; the path for an installed SparkR is written but never ran. Earlier (done since: R nodes — a function named after the node over its inputs as
  data.frames, run with the platform's R, data crossing as CSV; tested in-process; and PySpark inputs — a Python node takes each input as a
  pandas or a Spark DataFrame, on a local SparkSession kept by the console session; a Spark result becomes pandas
  downstream and when saved; tested in-process, the selector compiled, not clicked); done since: a persistent console session per user, workbook and
  branch, reusing node outputs while the graph is unchanged; copy-paste of a node with its upstream between
  workbooks, reusing imported datasets and renaming clashing nodes; unstructured file access: an imported Files
  folder is a read-only file system in Python nodes) (done
  since: an imported dataset's branch — fixed per node, or the workbook's branch with fallback to master; the Paths view
  and the full-screen editor; multi-node templates: a node and its upstream saved by name, applied in any workbook with
  each template input bound to a node there; Contour nodes: a path's result or a board's data, with parameters; model
  outputs; session history — interactive console sessions and batch builds with compute, requested and resolved
  environments — with compare and pinning: a pinned session cannot reinstall its packages here, runs report the
  packages that differ instead; model outputs: a Python node returning a model passes it downstream, Save keeps it as a pickle other workbooks import —
  tested with a model class written in the workbook, scikit-learn is not installed here). Tested in-process ("(test)" workbook, datasets and exported repository) plus the
  kept JKN demo "Analisis risiko faskes JKN (demo)"; the pages were compiled, not clicked through in a browser.
- Done: Notepad (doc 07; `api/notepad_engine.py`, widgets, templates, versions, lock data, links, DOCX). Done since,
  2026-10-12: readers change selector cards on an embedded Quiver dashboard (`POST /api/notepad/documents/{id}/
  widgets/{block}/run`, viewer access, at most 200 selections, an unsaved draft block accepted, envelope-secured
  documents refused; nothing saved; Reset selections; print resets to the saved defaults, server exports use them);
  the embed now shows every single card; fixed: the map widget measured 0 px high (flex box). Tested: 24 in-process
  checks (answers equal Quiver's own run, document and analysis unchanged, refusals, DOCX / Markdown exports) and 31
  checks of the real page in headless Chrome with recorded answers (map 320 px with markers, selections, print to
  PDF at the defaults); document "Dashboard pilihan dan peta (test)". Not tested against a running API; the doc's
  dashboard version / inputs mapping is not built (the widget embeds an analysis's dashboard; done since, 2026-10-13:
  a published Quiver dashboard widget — a version pinned or the latest with Auto-update (read with the viewer's
  permissions on its Files item), its inputs (root object, parameter cards chosen as inputs, selector cards) mapped
  from fixed values or Notepad inputs and converted per the doc's mapping table, unmapped inputs keep the dashboard's
  defaults; `GET /api/notepad/quiver-dashboards/{id}` lists versions and inputs for the properties panel; DOCX /
  Markdown exports and the caption use the chosen version; 51 in-process checks and 40 of the widget in headless
  Chrome with recorded answers). Not done:
  (done since: Solution Designer diagrams, Quiver chart / dashboard, map, object media preview, Vertex graph and Code
  Workbook chart widgets, and the Object property Markdown editor: raw Markdown editing with a preview through the
  property's inline edit action, refusing to overwrite a value changed meanwhile — no rich-text toolbar; inline edits
  in object property / card widgets and Action buttons on object cards; envelope security — chosen at creation, the
  document's markings bound what it shows, supported widgets only, objects outside the envelope refused, banner in the
  editor and exports; tested with simulated markings, no CBAC classifications here), AIP features (done since: AIP assist —
  write new content, rewrite the selected block or summarize, with the document's text and widget data as context;
  inserted or replacing blocks; off for envelope-secured documents; checked with the model stubbed and one real
  Gemini call, the dialog compiled, not clicked), merging of simultaneous edits (done since: live presence — others' selected blocks are outlined
  and the document reloads when someone else saves while this copy is unchanged; a conflicting save is refused),
  Marketplace packaging. Done since (2026-10-12): the Workshop widgets (`NotepadWidgets.tsx`) — Notepad: Linked
  documents (the documents linking to the selected object as a list, cards or table; fields, default sort; the Active
  Notepad variable holds the chosen document's rid, `ri.notepad.main.notepad.<item id>`), Embedded document (the
  Notepad page's embed mode `?embed=1`, read-only, or `&edit=1` with a reduced editor: edit / preview and save), New
  Notepad button (templates with a version and inputs linked to variables, or a string variable as Markdown or plain
  text; save name and location, or asked from the user; PDF export, open in a new tab, the Created document variable,
  events afterwards) and Export button (PDF or DOCX, file name). The export route takes `format=pdf` (the document
  printed by headless Chrome, like Reports) and `filename`; linked documents are cached per document until it changes
  (31 s → 4 s the first time, milliseconds after, with 110 documents in S3). 8 API checks in-process and the test
  module "Notepad widgets (test)" in a browser (a development build against a second API, sign-in off): 5 linked
  documents listed, choosing one showed it embedded with the reduced editor, both buttons created their documents
  and showed them, the export link carried the format and file name. Not checked: the widgets' configuration panel
  (compiled only), the PDF route with sign-in on (in-process it returned a PDF of the sign-in page), "Show outline
  when embedded", the `notepad:notepad_rid` type class on action parameters (the rid is a plain string variable). Done since: generation limits as a setting (admins, Notepad → Settings: objects per
  section generator, nested, table rows; up to 500 / 2,000 / 10,000; one setting for the platform, not per space). Done since: "Copy for Notepad" in Contour (boards), Quiver (cards), Vertex (graphs) and Code Workbook (nodes),
  pasted from Notepad's insert menu (kept in the browser). Locking is a snapshot for every widget (Contour widgets are not
  kept interactive). Version history lives in `data/notepad_versions` (local disk, also with S3 storage).
  Tested in-process ("(test)" documents; batched functions with a stubbed function — none is published here) plus
  the kept JKN demo template "Template laporan risiko faskes JKN (demo)" and its generated document; the pages were
  compiled, not clicked through in a browser.
- Done: Forms (doc 10, sunset; `api/forms.py`, `/forms`; was a mockup); since: map picker, resource picker, user
  properties field and the Code Editor (the draft as YAML). Not done: the geocode picker (P: needs a geocoding
  service; the map picker takes coordinates), per-user sharing roles on one form (done since: the Sharing panel — users by username as respondent, viewer or
  editor beyond the Project's roles, markings still applying, shared forms in the list; tested with sign-in
  simulated; done since: respondent links — signed-in users with a link fill the published form, with expiry and turn off; tested with
  sign-in off), Slate / Object Explorer embedding sections (the fill page can be iframed), mobile layout checks.
  Tested in-process; the pages were compiled, not clicked through in a browser.
  Done since, 2026-10-12 (8353e78): embed mode — `/forms/<id>/fill?embed=1` (the doc's `embedded=true` reloads with
  it) without the platform chrome, `noHeader`, `progressOnly` (progress bar), `forceDarkMode`; prefill from the URL
  (`field.<id>`, a field's own "URL parameter", or a bare field ID) and from an object (`object_type` + `pk`; a form
  on that type edits it) through `POST /api/forms/<id>/prefill`, ignored values listed with reasons; in an iframe the
  page posts `bluesandai.form.height` and `bluesandai.form.submitted` (ids only) to the parent; the `FormEmbed`
  component (resizing iframe, trusts only its own frame and origin); an Embed panel in the editor (URL, HTML and
  `<FormEmbed>` snippets, live preview logging messages); a confirmation message setting; 16 px phone gutters.
  Tested: 33 in-process checks (prefill coercion of every field type, bad values, the 500-parameter limit, embedded
  submissions, object edit, reserved / duplicate URL parameters; forms "All field types (test)", "Edit ticket
  (test)"), and in a browser at 375 px (embedded page: no horizontal scroll, prefill, iframe height follows the form,
  submit message received, object edited). Done since, 2026-10-12: `FormEmbed` placed in Workshop as the
  Form widget (`form_embed`, `fe_` config: prefill rows from variables or fixed text — objects / object sets give keys,
  dates ISO text, multi-value fields lists; the edited object from an object / object set variable and its type; on
  submit the response id and the edited or created object into output variables, events, the other widgets reloaded,
  a new blank form, a confirmation; hide title, progress bar only, maximum height; preview while editing the module
  does not submit); 18 in-process checks of the forms API flow the widget uses (prefill of every field kind, edit
  object, create, unpublished form refused); compiled and linted, not clicked; a created object's key reaches the
  output variable only for editors of the form (the submitted message carries ids only). Not done: `forceDarkMode` and
  Copy buttons not proven. Done since, 2026-10-12 (63ef589): a Form tab in configured Object Views (`form_id`,
  prefill from fixed values or `{{property}}` of the object, conditional forms by property eq / neq, hide title;
  validated on save; the view reloads after a submit), the platform sidebar as a drawer below 768 px (top bar with a
  menu button; desktop unchanged, measured at 1280 px), the Forms editor at phone width (scrolling tab strip, smaller
  padding). Tested: 12 in-process checks; in a browser at 375 px the plain fill page and every editor tab have no
  horizontal scroll, the object page's form tab prefilled and submitted (type "Form embed ticket (test)", kept).
  Not done: "Create linked object form" (prefill from the last linked object), the object page header does not
  refresh after a form submit, the Object Views editor at phone width. Done since, 2026-10-13 (11fad50): a "Create linked object form" mode on Form tabs (the new object's key field gets this object's key, `{{last.property}}` values or every field copied from the last linked object by a chosen sort, the created object linked through `POST /api/ontology/object-views/{type}/{pk}/linked-form` by foreign key or join table), the editor stacks below 768 px with no horizontal scroll, repeated tab ids are renamed on save; ConfiguredObjectView calls `onObjectChanged` after a submit. Tested: 36 in-process checks and 79 checks of the real pages in headless Chrome with the app's CSS at 1280 and 375 px (type "Form embed note (test)", links and forms "(test)"). Still needed: the header refresh — one line in the object page (a security-session file): `onObjectChanged={load}` on its ConfiguredObjectView (tested on a copy of the page).
- Done: Reports (doc 08, sunset; `api/reports.py`, `/reports`; was a mockup with made-up legacy reports); since:
  Contour board and Quiver card widgets (report parameters drive Contour parameters; in every export). Not done:
  merging simultaneous edits (done since, 2026-10-13 (fbbce89): a save from an older revision is merged three ways — base = the revision loaded, theirs = the stored one, mine = the save — field by field over settings, parameters and widgets (add / remove / move / edit); conflicts (same field changed differently, edited vs deleted, moved to different places) come back as a 409 and are settled per field in a merge dialog, the choices only applying to the revision they were shown against; saves serialised by a lock (one API process); the last 50 revisions kept in data/reports/revisions with list / read routes; tested: 41 in-process checks (incl. 8 simultaneous saves losing nothing) and 17 checks of the editor's dialog in headless Chrome; no history UI, revisions on local disk even with S3 content; earlier: a save from an older revision is refused and the editor keeps the
  unsaved copy on screen; others' saves load while this copy is clean; editing indicators — who else has the report open or is editing it, from
  heartbeats; also in Notepad and Fusion; Quiver time series plots and cards, drawn in the browser — in PDF and CSV (the
  series computed on the server for the analysis' root object and range, up to 20,000 points each) and slides (a native line chart, thinned to about 300 points); converting to Contour: parameters, a path per data widget, the dashboard in the report's order). PDF export needs Chrome / Edge on the API host.
  Tested in-process (PDF not run); the pages were compiled, not clicked through in a browser.
  Done since (2026-10-13, 6ffec8e): a revision history panel (History in the report header: revisions with who /
  when / summary and restored / merged badges, the diff between any two — settings, parameters, widgets added /
  removed / changed / moved — and Restore as a new revision through the three-way merge, conflicts settled in the merge
  dialog); revisions stored next to S3 content (`reports/revisions/<id>.json`), local histories carried over, at most
  `REVISIONS_KEPT`. Tested: 43 history and 41 merge checks in-process (S3 read failures stubbed), 18 in headless Chrome
  including 375 px width. Not done: a read-only preview of a whole old revision; one API process assumed. Done since (2026-10-13,
  42db8f3): Preview of an old revision (`POST /api/reports/{id}/revisions/{rev}/data`: the revision's widgets on
  today's data, read-only with a banner, Restore, back to the edited copy, outdated answers dropped), saves and
  restores locked across API processes (a PostgreSQL advisory lock per report, or a leased lock file without a
  database; 503 after 30 s), atomic local writes, an unreadable history never overwritten. Tested: 22 new checks
  (lock file across 3 processes, lease take-over), 41 merge + 43 history checks, and two real API processes: 48
  concurrent saves with none lost (21 of 48 lost with the old per-process lock). Not done: the preview not clicked
  in a browser; restores not run in the two-process test.
- Done: SQL & BI (doc 11; `api/sql_bi.py`, `/sql-bi`): a PostgreSQL wire-protocol endpoint and a REST query
  endpoint. Tested with psycopg 3 (extended / simple protocol, text and binary results, parameters, prepared
  statements, catalog queries, read-only refusal, token check) and the PostgreSQL JDBC driver 42.7.4 (metadata,
  getTables / getColumns, prepared statements past the server-side threshold, dates, timestamps). Not tested: Power
  BI, Tableau, Excel, Qlik and psqlODBC themselves (not installed here). Done since: result streaming (no row limit
  on the wire protocol: simple query, Execute with a fetch size, SQL cursors DECLARE / FETCH / CLOSE; tested with 2.5M
  rows through psycopg and portal pages through a raw protocol client), the Spark SQL dialect (options -c dialect=spark, SET dialect, REST "dialect"; translated with sqlglot); query cancellation (the protocol's
  CancelRequest, tested with psycopg's cancel; REST timeouts, a list of running queries and cancel by id), TLS
  (BLUESANDAI_SQL_TLS_CERT / _KEY, optionally required; tested with psycopg and a self-signed certificate), OAuth
  application tokens as the password (the application's object types only; tested with a simulated token) and the
  Branch setting (`options=-c branch=…`, `SET branch`, REST "branch"; datasets fall back to master). P: Foundry's own ODBC / JDBC
  drivers and the vendor-specific connectors (.mez, .taco).

- Done 2026-10-14 (7425b2d): Fusion keeps object-function reads between recalculations (`fusion._kept`: per user
  identity and function inputs, reused only while the objects, object / link type definitions, join-table links and
  the exploration / list they read are unchanged — also edits by another process — with object type access checked
  again on every reuse; scenarios, snapshots, extra datasources, semantic / interface explorations never cached; 4,096
  entries; results handed out as copies). Recalculation of "Fusion objects and submissions (test)" 136 ms → 4.6 ms. The
  page drops cell-save responses older than one it already showed. Tested: 28 cache checks, 39 in headless Chrome on
  an esbuild bundle of the real page (object cells, cached recalculation, an outside edit seen, submit buttons), the
  earlier Fusion suites (pre-existing array-shape failures unchanged). Not done: the page not run under next dev or with
  sign-in on; a cell save still takes ~1 s (the S3 document write).
- Done since (2026-10-14, FS): Fusion cell saves write-behind — a save writes an fsynced local log (`data/fusion/wal/`,
  with its hash) and answers; a background thread writes S3, merging rapid edits and retrying with backoff; reads use
  this process's copy, else a pending log, else S3; per-document edit / flush locks shared by every API process
  (released by the OS on a crash; 503 after 30 s held); pending saves flushed at shutdown and recovered at start;
  submissions into another document hold its lock; with write-behind off a pending log is honoured (it could
  overwrite a direct save before). Co-editing polls compare a content hash (`revision`) as well as the Files
  revision (several saves now land within one second) and drop poll answers older than an edit. Median cell save
  ~800 ms → ~12-19 ms. Tested: 64 checks (latency, 50 edits → 1 S3 write, processes killed before / during a flush
  lose nothing acknowledged, two processes × 25 edits, 4 threads × 10, co-editing converges 5 of 5, locked cells
  still 409), the 118 engine checks, stored documents unchanged, 48 in headless Chrome, the FU4 cache checks. Not
  done: api/forms.py saves Fusion documents without the shared lock (not ours); Files raw downloads see a save once
  flushed (~0.25 s); a document deleted mid-flush may leave its S3 object.

- Done 2026-10-14 (569e859): Quiver object set single cards — Filter object set (property and linked-object
  conditions incl. one of / contains / regex / wildcard / between / empty, nested all / any / not groups, values typed
  or `$ID`), Set math (union / intersection / difference of up to 10 sets of one type), Switch to linked object set
  (either direction), Status filter (open / closed during a range from start / end date properties), Object view —
  each an object set usable by tables, charts, other cards and selectors, in CSV, published dashboards, Reports and
  Notepad; every single card (time series cards included) listed in the Report and Notepad card pickers and in report
  data. Tested: 69 checks on the JKN demo objects against values computed from the stored objects (13 refusals), 34 +
  25 + 32 in headless Chrome (esbuild bundle of the real pages), 19 regression suites incl. Reports t_hist / t_merge.
  Not done: "Defined by property" and "Import saved object set" cards; a report widget carries an object set card's
  first 50 objects only (the analysis CSV has all); not run under next dev.
- Done since (2026-10-14, QS3): Quiver "Defined by property" (objects of a set or type whose property holds values
  from another card's column / an array card / typed or `$ID` values, typed matching, loops refused) and "Import saved
  object set" (an Object Explorer exploration run now with the viewer's permissions, or an object list; interface
  explorations refused; `GET /api/quiver-tables/saved-object-sets`), plus "Save as object list" on object set cards
  (up to 50,000, a snapshot of the saved analysis); the Reports object-set widget carries up to 1,000 objects with
  the total, pages 50 at a time on screen, prints every row, and its CSV has every object. Tested: 47 in-process
  checks against values computed from the JKN demo objects, 29 in headless Chrome (Quiver page, published
  dashboard, report paging / print / 375 px), the qs2 object / embed / UI suites and t_rp. Not done: the Reports
  t_hist and t_merge suites now fail — their kept "(test)" reports reached the 50-revision cap (t_hist: a restore
  drops the oldest revision; t_merge: a save without its base revision), not re-run on fresh reports; array
  properties not matched element by element; PowerPoint (15 rows) / Markdown (200) / Notepad embeds (50) unchanged.
- Done since (2026-10-14, QS4): "Defined by property" matches array properties element by element (an object
  matches when any element equals a value, compared in the property's own type: numbers as numbers, dates, Booleans,
  exact text; values taken from another set's array property count element by element, struct elements skipped;
  the editor marks array properties); report Markdown exports up to 1,000 rows and PowerPoint slides keep 15, both
  with a "First N of M objects / rows" note when cut (`|` and line breaks escaped in Markdown cells); Notepad Quiver
  card / dashboard widgets carry 1,000 objects (`quiver_tables.EMBED_OBJECTS`; 50 a page on screen, all printed) and
  their Markdown / DOCX exports 1,000 rows with the note; a 1,000-row DOCX table no longer takes minutes (cells read
  once). The Reports t_hist / t_merge suites pass on fresh reports (43 / 41: the earlier failures were the kept
  reports' 50-revision cap, not a bug). Tested: 44 in-process checks against a brute-force reference (6,050-object
  types included) and 22 in headless Chrome, the earlier Quiver / Reports / Notepad suites green. Not done: array
  cells in Quiver tables still show as Python text; PowerPoint does not spread 1,000 rows over slides; the Notepad
  PDF export not run.

- Done 2026-10-14 (0858197): array and struct cells in Quiver views, Reports and Notepad read as values ("a, b",
  "field: value, ...") on screen and in Markdown / DOCX / PowerPoint / PDF exports, and as JSON in CSV (no Python text);
  filters, selectors and "Defined by property" work on array columns; table cards print every row in PDFs. The real
  Notepad PDF export ran through headless Chrome with a Quiver widget holding 1,000 of 1,189 objects (7 MB, 73 pages;
  all 1,000 names, the "First 1,000 of M objects" note, array cells as values). Tested: 72 + 7 + 69 checks, 34 in
  headless Chrome incl. the PDF, the 19 Quiver / Reports regression suites. Not done: chips for array cells in the UI
  (plain text, matching the exports); Notepad's Code Workbook table still uses String().

## 22. Model Integration (docs 01–09 of the Model Integration reference)

Audit of 2026-10-10. B = buildable here, P = needs a product or package that does not exist here, T = exists but
untested. "→ done" rows were built after the audit (see the notes under the table): no row is left at B. Before the audit: container
models (tested), language-model transform inputs (tested), Modeling Objectives as records (deployments and model
functions recorded, never run), Model Studio as an in-browser prototype trainer; `/model-evaluation`,
`/model-migration`, `/model-developer` and the numbers on `/model-integration` were mockups with made-up data.

| Doc | Feature | Status |
|---|---|---|
| 02, 05 | Model resources trained in the platform: `palantir_models.transforms.ModelOutput(path).publish(adapter)`, model versions | B → done |
| 05 | Model adapters: `ModelAdapter` `api()` / `predict()` / `run_inference()` / `load()` / `save()`, `transform()` / `transform_write()` | B → done (adapters of trained, container and externally hosted models) |
| 05 | `@auto_serialize` and serializers: Dill, CloudPickle, JSON, YAML, PyTorch state, Spark MLlib, custom `ModelSerializer` | B → done (Spark MLlib without winutils and a custom `ModelSerializer` tested 2026-10-11) |
| 05 | Serializers for Hugging Face, TensorFlow / Keras, XGBoost | P (transformers, tensorflow, xgboost not installed) → done (packages installed 2026-10-10) |
| 05 | API types: Pandas, Spark, Parameter (enforced), FileSystem, NDArray, MediaReference, Object, ObjectSet; `ModelApiColumn`, `DFType` | B → done (ObjectSet tested 2026-10-11) |
| 05 | `ModelInput(path or rid, model_version=, branch=, use_sidecar=)` loading a trained model in a transform | B → done |
| 05 | `use_sidecar=True` (adapter in its own environment), `sidecar_resources`, GPUs | B → done for a separate process; P for GPUs |
| 05 | `DistributedInferenceWrapper` (Spark executors) | B → done (local Spark) |
| 05, 02 | Experiments: `create_experiment`, `log_param(s)`, `log_metric(s)` with steps, `log_image`, `log_table`, `log_plot`, error handlers; published with the version | B → done (error handlers tested 2026-10-11) |
| 05 | Experiments with Plotly figures / MLflow autologging | P (plotly, mlflow not installed; a figure's JSON is accepted) → done |
| 05 | Model page: versions, API, adapter, Experiments tab (compare up to 5, charts, parallel coordinates, images, tables) | B → done |
| 05, 02 | Evaluations: `@pm.transforms.evaluation(set)`, `ModelInput.create_evaluation`, metrics / images / plots / tables, subsets, committed only when the build succeeds | B → done |
| 05 | Built-in evaluators `evaluate()` with `RegressionEvaluatorConfig` / `ClassificationEvaluatorConfig` | B → done (computed without scikit-learn) |
| 05 | Evaluations tab: sets, grouping by version, compare, run ad hoc, schedules on new versions | B → done |
| 05 | Models uploaded as files (publish from files in a dataset), adapter upgrade without retraining | B → done (2026-10-11) |
| 05 | Spark ML models and Spark distributed training | B → done (local Spark only, 2026-10-11) |
| 05 | scikit-learn examples (binary classification, upload a scikit-learn model) | P until scikit-learn is installed (ask first) → done |
| 05 | Import a Hugging Face model | P (transformers and model downloads) |
| 05 | Container models | T → tested before (13 checks); live / batch deployment of them: B → done (direct, objective live and batch, tested with Docker in WSL) |
| 05 | Externally hosted models (`init_external`, `ExternalModelContext`: base URL, configuration, credentials) | B → done; SageMaker / Vertex AI / Databricks examples P (no accounts) |
| 05 | Instrumentation and telemetry of models (logs from adapters) | B → done (2026-10-11: request span, custom spans, logs per request) |
| 05 | Model Adapter Library / Model Training repository templates | B → done |
| 05 | Language model transform inputs | T → tested before |
| 01, 03 | Train in Jupyter® Code Workspaces (`palantir_models.code_workspaces`) | P at the audit → built on RunPod pods (see below) |
| 03, 06 | Model Studio: a studio resource, trainer, inputs mapping and filters, parameters, compute, training runs, config versions, model + experiment output | B → done (training jobs; was an in-browser prototype) |
| 06 | Model Studio trainers on AutoGluon (LightGBM, CatBoost, XGBoost, FastAI, stacking / bagging) | P (AutoGluon not installed); numpy trainers instead |
| 04 | Train models with GPUs | P for transforms and Model Studio; possible in a Jupyter workspace on a RunPod GPU pod |
| 04 | Marketplace packaging of models, live deployments and model functions | P (no Marketplace products) |
| 02, 04, 08 | Model functions: publish for a live deployment, call from Python functions (`FoundryClient().ontology.queries.<name>`), row-wise publishing, versions on API change | B → done |
| 08 | Direct model deployment: start / stop, query, auto-upgrade on a new version, type casting, logs and run history, metrics | B → done |
| 08 | Direct deployment autoscaling, replicas, schedule overrides, flame graphs, monitoring views | P (one process per deployment here; settings kept) |
| 08 | Live deployment REST API: multi I/O `/v2` and single I/O endpoints, error codes | B → done |
| 08 | Objectives: submit a model resource version (not free text), custom submission metadata | B → done |
| 08 | Objective checks (reviewers, approve / reject / comment, evaluation-based checks, archive, filter) | B → done |
| 08 | Staging and production releases, release history, deployments upgrading on release | B → done |
| 08 | Archive submissions | B → done |
| 08 | Objective live deployments that serve (status, health, query, disable / delete, logs) | B → done |
| 08 | Objective batch deployments that run (input → output dataset, rebuilt on release) | B → done |
| 08 | Model inference history dataset | B → done |
| 08 | Objective settings: appearance, advanced naming | P (cosmetic / legacy) |
| 09 | Automatic evaluation: evaluation datasets, evaluation libraries (binary classification, regression), subsets (string, fixed-width, cut-offs, multi-field), inference and metrics per submission | B → done |
| 09 | Evaluation dashboard: dataset (and transaction), select / search models, subset tabs, plots | B → done |
| 09 | Custom metric views (pinned metrics, tabs) | B → done |
| 09 | Custom evaluator libraries (`Evaluator.apply_spark`, docstring params) | B → done |
| 07, 09 | `foundry_ml` dataset-backed models, MetricSets, Upgrade Assistant campaigns | P (foundry_ml never existed here: nothing to migrate) |
| 07 | Migration helper: find repositories importing `foundry_ml` and suggest `palantir_models` code | B → done |

Done since the audit (tested in-process: 29 checks for trained models, 48 for deployments / objectives / evaluation;
the pages were compiled and linted, not clicked through in a browser):
- Models trained in Python transforms (`api/model_lib.py`, `api/model_assets.py`, `/model-assets`): ModelOutput
  publish (version committed only when the build succeeds), adapters and API types, auto_serialize with Dill / JSON,
  ModelInput by path with branch / pinned version, `use_sidecar=True` in a worker process, experiments (params, stepped
  metrics, tables), evaluations with the built-in classification evaluator and subsets, Run against a version, test
  runs with type casting; since (10 checks): CloudPickle / YAML / PyTorch serializers, `log_image` (Pillow and PNG
  bytes), figure JSON plots, NDArray and typed parameters, multi-output `run_inference`, FileSystem outputs through
  `transform_write`, evaluations scheduled on new versions. Spark ML models cannot be saved on this Windows machine:
  Hadoop needs winutils.exe (HADOOP_HOME), which is not installed (a clear error says so). Fixed on the way: the
  ontology_sdk shim modules answered `__file__` with a generated class, which broke `import torch` in any repository.
  DistributedInferenceWrapper now runs on the Spark executors (mapInPandas: each task loads the version from its spec
  and predicts its partition in chunks; same results as the driver, 5 checks). MediaReference and Object inputs
  work in a transform: each reference reads its file (S3 too) and the Object arrives by primary key (6 checks); container
  models now have a Files item of their own next to their repository (made for older ones when models are
  listed), so ModelInput finds them by path too (4 checks).
- Deployments that run (`api/model_deployments.py`): direct and objective live deployments, `/v2` and single I/O
  endpoints, model functions through the gateway, batch deployments rebuilt on release, inference history, logs, run
  history; container models in a direct deployment (Docker in WSL: containers start with the deployment, the
  adapter's API is recorded on the version, /v2 answers, no container left after stopping; 3 checks). P: autoscaling,
  replicas, GPUs, flame graphs (one process per deployment).
- Modeling Objectives on model versions: metadata fields, checks (manual and evaluation-based), archive, staging /
  production releases, deployments, automatic evaluation and the dashboard; since: 6 more checks for the regression
  evaluator, multi-field subsets and pinned tabs.
- Model Studio as training jobs (`api/model_studio.py`, `/model-studio`, was an in-browser prototype): 14 checks
  (classification with a test dataset, filters and probabilities, configuration versions, excluded models, regression,
  time series forecasting by series); since: retraining when the training dataset gets a new transaction (2 checks).
  Not done: GPU resources. Done since, 2026-10-12: dataset filter pushdown — a run scans the training / test dataset
  lazily with polars (local file, or the S3 object; small objects fetched in one GET) with the configuration's filters
  as the scan predicate and only the columns the trainer needs; each pushed predicate keeps a superset of the rows the
  pandas filters keep and the job still applies them, so the training rows are row for row those of a full read
  (dtypes of a full read restored; timestamp-as-text comparisons keep the whole column's text format); filters that
  cannot be translated (or follow one that cannot) run after the read, a failing scan falls back to a whole read and
  says so; the run records `data_read` (rows / columns read vs total, rows kept, filters pushed / after the read, bytes)
  shown in the run sidebar. Tested: 44 in-process checks (every filter kind with the same outcome, rows and metrics as a
  whole read, fallbacks, categorical columns) and an equivalence suite of 5,306 filter / column-type cases on S3 and
  local datasets with and without statistics / pandas metadata (3,851 pushed, no fallback, frames identical). The run
  sidebar compiled and linted, not clicked; the API on port 8000 needs a restart to use it.
- Externally hosted models (POST /api/model-assets/external, Models page): 8 checks against a local HTTP scoring
  service standing in for the hosted model (credentials sealed and not returned, configuration, new versions, live
  /v2, batch refused). P: the SageMaker / Vertex AI / Databricks / OpenAI examples (no accounts), egress policies.
- Model Training and Model Adapter Library repository templates (`api/code_model_templates.py`): 8 checks (train →
  version, inference and a regression evaluation after pointing at the model, the library's checks pass).
- The mockups are replaced with live pages (`api/model_overview.py`, 10 checks): `/model-integration` (counts, latest
  versions, objectives), `/model-evaluation` (Evaluation Center), `/model-developer` (adapters in use and how to write
  one), `/model-migration` (the foundry_ml migration helper: code in Code Repositories and Code Workbooks still using
  foundry_ml, a palantir_models rewrite built from the code's paths, a replacement model or ignore). The Code Workbook
  scan was not tested (no workbook uses foundry_ml); the suggestions are templates, not AIP-generated.
- Custom evaluator libraries (`api/model_evaluators.py`, Model Evaluator Library template): 8 checks (the documented
  Configurable Row Count Evaluator, tagged, discovered from its docstring, configured with a column and a value,
  run on local Spark over the dataset and each subset). Untagged repositories are offered too, marked unpublished.
- `/model-experiments` lists model experiments and evaluations (GET /api/model-overview/experiments) and the older
  objective records. Not done: GPUs; Marketplace packaging.
- Since (2026-10-10, with the user's OK): scikit-learn, XGBoost, TensorFlow, MLflow and Plotly installed (transformers
  and torch were there). 12 checks in transforms on the JKN facility-risk test data: a scikit-learn pipeline trained
  under `experiment.as_mlflow_run()` with `mlflow.sklearn.autolog()` (parameters arrive typed, metrics too; a throwaway
  SQLite MLflow store, its params / stepped metrics / PNG artifacts copied in when the block ends; tags and other
  assets dropped, nested runs refused) and a Plotly ROC figure (AUC 0.82 on the test facilities); XGBoost
  (`XGBoostSerializer` now reloads the estimator type the file records, or a plain Booster: XGBoost 3 refuses the
  base class; AUC 0.80); Keras with `mlflow.keras.MlflowCallback` (per-epoch loss as a stepped series, `.keras`
  format, AUC 0.81); a Hugging Face model (`HfAutoModelSerializer`, built from a config: nothing downloaded).
  AutoGluon is not installed yet: it needs pyarrow 24 and the running API holds pyarrow 25's DLLs (install with the
  API stopped). Importing a Hugging Face model from the Hub was not tried (a download).
- Jupyter Code Workspaces on RunPod (`api/code_workspaces.py`, `api/workspace_client.py`, `/code-workspaces`): a
  workspace with a GPU / CPU choice, dataset aliases (read / write) and model aliases (adapter skeleton generated);
  Start creates a pod from RunPod's PyTorch image (JupyterLab on 8888 behind RunPod's proxy) whose start command
  installs the client from the public URL (https://hexa.bluesandai.com, `public.ps1`); `Dataset.get(alias)`,
  `ModelOutput(alias).publish`, `ModelInput(alias)` in notebooks; stop when idle, resume, terminate. 19 checks with
  RunPod mocked and the pod simulated by a separate Python process running the real client package against a real
  HTTP server; since, one real run (2026-10-10, RTX A4000 community pod, $0.17/h): the JKN notebook "Notebook risiko
  faskes JKN (demo)" trained a PyTorch MLP on the GPU from the 20 indicators (holdout recall 0.82, precision 0.84),
  wrote "skor_holdout_notebook (demo)" and published "model_risiko_faskes_notebook (demo)" 0.1.0 with its experiment;
  the platform loads its PyTorch weights for test runs. The pod is kept stopped (disk only). Fixed by it: pyarrow
  pinned below 20 (the image's NumPy 1.x), the Jupyter link opens /workspace. Secure-cloud A4000s were unavailable
  at the time: the page shows RunPod's refusal, pick another GPU or the community cloud. Not built: VS Code
  workspaces, notebooks run as scheduled transforms, managed conda environments (`maestro`), Dash / Streamlit apps.
  Since: a pod gets a secret of its own instead of a job token: it reaches only that workspace's pod endpoints
  (/api/code-workspace-pod/<id>/..., acting as the owner) and is refused everywhere else (3 more checks with sign-in
  on). The demo workspace's pod predates this and keeps its 30-day job token until it is terminated.
- Since (2026-10-10): model functions are in the functions registry. A live deployment's published function is listed
  in `/api/functions` (id `mf-<apiName>`, kind Query, a "Model" badge in Functions) with its inputs (columns of a
  row-wise function, or a tabular input as `array<struct>`) and versions, so Workshop, Actions and Automate pick and
  run it like any function (`run_function` / `function_info` / `check_ref`); runs, metrics and monitors are recorded
  per function (monitors set by the deployment's editors). The detail page links to the model or objective and hides
  the repository tabs. Checked in-process: the demo objective's function scored a facility (probabilitas 0.012),
  missing inputs fail as a recorded run, a version ref that does not exist is refused, and a failure fires a monitor.
  Since: row-wise model functions are Pipeline Builder UDFs (Reusables, User-defined functions; a step's rows go to
  the deployment in one inference request, the output row lands as a JSON column); tabular ones are not offered
  (7 checks with the demo function). A row-wise function can take an Ontology object: on the deployment's Function
  tab, an object type and a property per model column; the registry lists `object:<Type>` plus the unmapped columns
  and the object's properties (read with the caller's permissions) fill the row (8 checks with "Indikator risiko
  faskes (test)" objects; the binding editor was compiled, not clicked through in a browser).
- Pages checked in headless Chrome (2026-10-10) on the production build behind the public proxy, signed in with a
  short render session: /model-integration, /model-assets (list, a model's Overview / Experiments / Evaluations /
  Live deployment), /modeling-objectives (Models, Releases, Deployments, Evaluation dashboard, Settings),
  /model-studio, /model-experiments, /model-evaluation, /model-developer, /model-migration, /code-workspaces,
  /container-models: no script errors and no failed API calls (apart from the API being restarted by another
  session during the run); screenshots looked right with the demo data. Fixed from it: a metric logged once is shown
  as a value (not a lone dot on a stretched axis), the API error names the site when the API is same-origin.
  Forms (create / submit / release / configure) were not filled in through the browser; the API tests cover them.
- Demo "Prioritas audit faskes JKN (demo)" (`api/demo_jkn_models.py`, POST /api/demo/jkn-models; kept): built and
  checked in-process (released model recall 0.85 on the holdout, batch scoring 300 facilities, the function answers,
  both checks evaluated). Fixed while building it: an optional evaluator column a model does not produce (a
  probability) now leaves out the metrics that need it instead of failing the evaluation.

- Since (2026-10-11; 50 checks in-process on the JKN facility-risk "(test)" data, kept): the last audit rows.
  - Models uploaded as files: `palantir_models.transforms.copy_model_to_driver(dataset.filesystem())` copies a files
    dataset (a folder) to the driver; a scikit-learn pickle uploaded to "model files (test)" is published by a
    transform and predicts what the file predicts.
  - Upgrade model adapter without retraining (model page → Inference configuration → Upgrade model adapter; GET / POST
    /api/model-assets/{id}/versions/{version}/adapter-upgrade): a new version (patch number) with the adapter source at
    the latest commit of its repository branch and a byte-identical copy of the model artifacts. The dialog shows the
    commit and the changed source files; the upgraded adapter is loaded in its own process first, so an adapter that
    lost its module / class name or cannot load the artifacts creates nothing. The new version records the upgraded
    API, direct deployments on the branch upgrade to it, objective submissions are not moved. Models from Model
    Studio and externally hosted models are refused (no adapter in a repository).
  - Instrumentation and telemetry: every inference call of a model process gets a span over the whole call
    ("model inference", with the model, version and request id); the global OpenTelemetry tracer provider is set, so
    spans the adapter creates with `trace.get_tracer(__name__)` nest under it, and `logging` lines are kept per request.
    Deployments store them (traces.jsonl, 7 days) and show a Traces tab (waterfall + that request's log lines); a test
    run on the model page shows its spans. A failed call's span has status ERROR. Not done: exporting to an external
    OpenTelemetry collector, `opentelemetry-instrumentation` of outbound requests (not installed), spans of models
    used inside transforms (only test runs and deployments report them), custom metrics (Foundry has none either).
    Done since (2026-10-14, MOT, api/model_telemetry.py): spans exported to an OpenTelemetry collector over OTLP/HTTP
    JSON — off by default, an endpoint + headers set by an administrator on the model page's Telemetry card (header
    values encrypted, never returned; or `OTEL_EXPORTER_OTLP_*`), batches of 512 from a bounded queue, 429 / 503
    retried, egress-checked, never waiting in a model call ("Send a test span" checks it); an adapter's outbound
    urllib / requests / httpx calls get CLIENT spans and a W3C `traceparent` header; models a Code Repository
    transform receives (in-process, sidecar, container) record each inference call, linked to the build
    (`transform.run_id`) and listed on the model page with their span waterfall; test runs, live deployments and
    batch runs are exported too. Tested: 68 checks against a stub collector (OTLP JSON shape, batching / retries,
    a slow or down collector not slowing or failing queries, traceparent parent ids in a real model process, two
    real transform builds) and the 25 earlier telemetry checks. Not done: calls on Spark executors
    (DistributedInferenceWrapper) and Pipeline Builder models are not traced; container models were tried with a
    fake adapter only (no Docker); urllib3 / http.client used directly are not instrumented; no protobuf / gRPC; the
    Telemetry card was type-checked, not clicked.
  - Spark ML models: on Windows without winutils.exe `SparkMLAutoSerializer` writes the pipeline model's JVM object
    with Java serialization instead of Spark's Hadoop writer (readable by the same Spark version only); the
    documentation's Iris random forest is trained, published, reloaded by a ModelInput and scores 150 rows (0.99).
    Spark distributed training: the `KUBERNETES_OPEN_PORTS_ALL` profile exists (nothing to open on one machine) and
    `xgboost.spark.SparkXGBClassifier` trains on local Spark with 2 workers (PySpark 3.5 lacks mapInPandas' `profile`
    argument, which xgboost 3 passes: it is accepted and left out); its Booster is published with XGBoostSerializer.
    Not done: GPUs (`EXECUTOR_GPU_ENABLED`), live deployment of a Spark ML model (not tried; Foundry discourages it).
    The documentation's Booster adapter names its `__init__` argument `booster` but serializes `model=`: here the
    names must match.
  - Checked without code changes: a custom `ModelSerializer`, an `ObjectSet` input read in a transform, experiment
    error handlers (FAIL raises, WARN logs once, SUPPRESS is silent), and the container model "Mirror model (test)"
    submitted to an objective, served by its live deployment (/v2 too) and run by a batch deployment, with Docker in
    WSL and no container left afterwards.
  - In a browser (a development build against a second API with sign-in off, 2026-10-11): the upgrade dialog showed
    the commits and changed files and "Create model version" made 0.3.2 of "risiko_faskes_dari_file (test)"; a test
    run showed its three spans and log line; the deployment's Traces tab listed the calls and opened one with its
    waterfall and logs; no console errors. Read from the page's text and DOM (screenshots timed out). The running
    API was not restarted (a stream was running): it serves the new routes after its next restart.

- Since (2026-10-12): the Model Library and the objective's pages follow the owner's reference screens of Foundry
  (`web/src/components/models/ObjectivePages.tsx`, `/modeling-objectives`). Without an objective open the page is
  the Model Library: "Explore your models", search by name, filters (project, input / output object type, status:
  Not Started / In Progress / Deployed), a table with name and project, mapped inputs and outputs, the production
  (else staging) model and release, last released, status, and a star per user. An objective has a left navigation:
  Objective (description, an overview in Markdown, the Modeling objective API — each model input and output with
  its Ontology property mapping — and cards for the latest release, relevant files, modules, graphs and chained
  models; "Edit overview" edits the text, the mapping and the links), Models ("Releases and new models": release
  cards, new models, reviewed models with owner, size and review count; "All models": the earlier table; release
  history), a submission's page (Metrics from the automatic evaluation, Model details: architecture, dependencies,
  developer metadata; Reviews: comment / accept / reject, with releases and reviewers beside it; Create new
  release), Comparisons (the evaluation dashboard reshaped: a Comparing bar of coloured model chips with an add
  list, "Viewing metrics on", a model details table with the objective's metadata fields, a metric and chart
  filter, pinned tabs as cards per subset), Deployments and Settings. New routes: GET /library, PUT
  /{id}/favorite, GET / PUT /{id}/overview, GET /{id}/models-meta, POST /{id}/candidates/{cid}/reviews. 23 API
  checks in-process (library rows and statuses, favourites, overview text, links, mapping refusals, reviews) and
  every screen in a browser on a development build against a second API with sign-in off: the library filtered
  and searched, the overview edited and saved, a model opened with its metrics / details / reviews tabs, the
  comparison chips, details table and 7 subset cards drawn; read from the page's text, no screenshot. Not built:
  Share and File / Help menus, attachments and bold / italic in reviews,
  per-objective projects (the Project shown is the released model's), the "Loading input
  datasets" state; modules and graphs are linked by name without a permission check on the linked resource.
  Done since, 2026-10-12: a review requirement — Settings → Review requirement (`required_reviews`, 0–20): a
  submission needs that many approving reviewers (each reviewer's latest accept / reject counts once, comments do
  not) and no reviewer whose latest review rejects it; release to staging, mark as production, the legacy deploy and
  a new deployment of a release are refused (409, with the count) until it is met; `review_gate` on every
  submission; the Create new release / Mark as production / Release to staging buttons disabled with the status
  line ("1 of 2 approving reviews · 1 requested changes") on the submission page, the Reviews panel and the release
  dialog. Automatic upgrades of existing deployments are not gated. Object-type icons: library rows show the
  objective's linked object type's icon and color (and a lock badge when reviews are required), inputs / outputs
  draw their types' icons. 20 in-process checks (objective "Review gate (test)", kept) plus the 16 + 7 earlier ones;
  reviews from other users written directly to storage (one-user harness); compiled and linted, not clicked.
  Done since, 2026-10-12: Share, Markdown and attachments in reviews, per-objective Projects — roles on every
  objective endpoint (viewer reads / reviews / stars; editor changes settings, submits, archives, releases, promotes,
  deploys, saves the evaluation configuration and builds evaluation; owner shares, moves, deletes; no role → 404 and
  hidden from the list and Library; `release_target` stays open so running deployments resolve), a Share dialog
  ("Manage roles": users / groups, role dropdowns, at least one owner kept), a Project chosen on create and moved in
  Settings (the Project's roles apply on top of the grants; objectives with no grants and no Project stay open as
  before), review text rendered as Markdown (HTML escaped, http(s) / mailto links only) with Write / Preview, and
  attachments stored in Files under the Project (PNG / JPEG / GIF / WebP / PDF / TXT / LOG / CSV / JSON / MD, 10 MB,
  5 per review, formats sniffed, HTML / SVG refused; served only to readers of the objective holding the file's
  markings, images inline, the rest as downloads with nosniff). 47 in-process checks (roles simulated by swapping
  the caller: sign-in is off in the harness) and 18 of the real pages in headless Chrome, plus the 16 + 7 + 20
  earlier ones. Not built: link sharing, tagging groups in reviews; not tested with a real signed-in session.
  Done since (2026-10-13, 66d52ea): @mentions of users and groups in reviews (`GET /{id}/mentionable`: only those who
  can read the objective; names from the directory; tagged users and readable group members notified through
  `notify.deliver` with a link to the review, never the author), copy-link buttons (objective, submission, review —
  a review link opens the Reviews tab scrolled and highlighted), the same 404 / no-access page whether or not the
  objective exists, access requests (`POST /{id}/access-requests`, owners notified at most hourly, grant / decline in
  the Share dialog via `?share=1`, the requester told). Tested: 38 in-process checks, 21 of the real page in
  headless Chrome, and the 16 + 7 + 47 earlier ones; objective "Link sharing and tags (test)" kept. Not done: email
  delivery of the notifications, a real signed-in session (callers simulated).

## 23. Security & Governance (docs 01–16 of the Security & Governance reference)

**2026-10-12: security review and docs 01–06.** The public site (hexa.bluesandai.com, `public.ps1`) was stopped:
user code ran on the API host for any user who could edit a Code Workspace. Fixed, in-process tested (TestClient,
sign-in on, scratch auth store, real Files store; 32 security + 51 governance checks) and rendered in headless Chrome
against a scratch API on port 8011 (startup workers off) and a second `next dev` on 8889 (no script errors):
- Code execution (Control Panel → Security): authoring or running code on the API host (Code Repositories,
  Workbooks, Workspaces' terminals and local kernels, function previews / publishing, packages, git pushes) is
  administrators-only by default (or chosen groups, or everyone); scheduled builds need an allowed owner.
- Fixed permission holes: network egress / ingress / trusted proxies and the default retention policy were open to
  any user (now administrators), a dataset's retention needed no role (now Editor), a Viewer holding a marking could
  remove it, AIP Logic and agents had no checks (now their ontology's roles; conversations are their creator's),
  lineage health rules (Editor). Projects without roles are closed (they were open to everyone as Editors); the
  default role of new Projects is none; Files items outside Projects are their creator's (setting
  `files_outside_projects`).
- Developer Console websites are served only from a hosting origin (`BLUESANDAI_HOSTING_URL`, default the API
  address with localhost / 127.0.0.1 swapped) where session cookies are ignored; cookie-authenticated changes must
  come from the platform's origins (CSRF); `/api/pipeline-runner` is not public and checks the service token;
  security headers on the web and API; unclassified reads are metaDataAccess audit lines; background LLM calls are
  audited.
- Docs 03 / 04 now built: roles as operations (discover, read, download, edit, markings, manage) with Discoverer and
  custom roles (Control Panel → Roles); download controls (the Download operation on Files downloads, zips and every
  Download-category export route); file vs data markings (inherited markings hide the data, not the item); marking
  categories (conjunctive / disjunctive / hierarchical classification levels, visible / hidden, category
  administrators and viewers, restricted to an organization) and per-marking Manage / Apply / Remove permissions;
  organizations with guest members and Apply organization / Expand access; spaces (organizations as access
  requirements, inherited roles, role sets), Project templates (variables, folders, new groups and markings, roles,
  constraints) and portfolios (Compass → Portfolios) in `governance_model.py`; Project constraints (applying a
  violating marking is refused, a build inheriting one fails with the marking applied, violations listed in Files);
  classification required on new Projects (setting); restricted views (`restricted_views.py`, `/restricted-views`,
  SQL Studio `ri.foundry.main.restricted-view.<id>`); emulation mode (account menu, banner); `/api/auth/access`
  reports the full verdict.
- Since (same day, 39 more in-process checks, pages rendered in headless Chrome): nested groups, membership expiry
  and realms (groups bound to an identity provider's group, synced at single sign-on); a space's maximum
  classification; Compass's "discoverable" makes a Project's resources discoverable (not readable) outside its space's
  organizations; restricted views on a dataset branch, and a restricted view's policy applied as an object type's
  object security policy (columns mapped to properties); audit lines of unclassified changes carry what was sent
  (top-level fields, secrets redacted); checkpoint reauthentication for single sign-on accounts (two-factor code, or
  a single sign-on in the last 5 minutes); Ontology proposals reviewed, commented and merged in Approvals;
  per-user notification settings (Account → Notifications); Cipher in-line edits (`cipher: editable`), Workshop
  "Decrypt selected areas" on the image annotation widget (regions keyed by channel), "Create pipeline" from a Data
  Manager license, a license picker in Pipeline Builder's Cipher steps, Marketplace packaging of Cipher channels and
  checkpoint configurations (download / install product); Data Lifetime branch scoping, transaction-level provenance
  (outputs record the input transactions they read) and S3 version purging; Code scanning evaluates
  metavariable-regex, metavariable-pattern and focus-metavariable; a posture check of the platform's packages
  against OSV (on request); an OAuth application polling audit log files was tested.
  Sensitive Data Scanner's language-model condition was run against the real model (Gemini): NIK values matched,
  city names did not.
- Not done (nothing to build here): checkpoint types of apps that do not exist in this platform; Compass "Autosaved"
  (nothing autosaves into Projects).

Before 2026-10-10 docs 07–16 were one mockup page (`/security-governance/workspaces`) with made-up data; each is now
an application on the platform's own data (modules in `api/`, pages in `web/src/app/`), listed in Platform Apps.
Tested in-process (TestClient, sign-in on, real Files store; 197 checks: audit.3 18, monitoring 11, Checkpoints 26,
Approvals 22, Cipher 25, SDS 22, Data Lifetime 16, Code scanning 23 + the checks hook, Compass 20, posture 14), the
Pipeline Builder Cipher steps in Node (jiti), and the pages on a production build in headless Chrome against a
separate API on port 8011 (the S&G routers only, no background workers): every page loads without script errors,
and the checkpoint dialog works end to end (428 → prompt → justification → the request retried with the pass → a
record). "(test)" folders, datasets, channels, licenses, Projects and groups made by the checks are kept.
**The main API was not restarted** (a streaming build of another tab was running): it serves the new routes after
the next restart.
- Security auditing (13, `audit3.py`, `audit_monitor.py`, `/security-auditing`): audit.3 lines for user requests of
  every app (a middleware classifies routes into categories; unmatched GETs are not logged) and the sign-in log;
  5-minute log files per organization, `/api/v2/audit/organizations/{org}/logFiles` for SIEMs, readers per
  organization, Developer Console audit-read (api:audit-read); export datasets (audit.3, audit.2 = the earlier
  sign-in log) with retention; detections, alerts, baselines. Not done: an OAuth application actually polling (only
  the refusal path was tested), `requestFields` of unclassified changes only name the route. Since: SQL & BI
  statements that read data (wire protocol and REST) write SQL_BI_QUERY lines (dataLoad / ontologyDataLoad with the
  datasets and object types read, the SQL, row count or error); llmInference lines carry the prompt (the request's
  prompt fields) and the answer (JSON fields, or a streamed answer's events joined), each cut to 8,000 characters
  (`audit3.LLM_CONTENT_MAX`). LLM calls made by background jobs (pipelines, parsing) are not request-scoped and
  are not recorded.
- Checkpoints (08, `checkpoints.py`, `/checkpoints`, `/checkpoint`): 44 checkpoint types bound to routes (login
  handled per session), organization or Project scope (spaces are Projects here), conditions with exemptions,
  four justification kinds, recent justifications, login frequency, reviewable records; the global fetch shows the
  dialog. Not done: the AIP Analyst, Flow Capture, Gaia, Hivemind, Kairos, walkthrough and Upgrade Assistant types
  (those apps do not exist), Marketplace packaging; reauthentication needs a password (single sign-on-only
  accounts cannot answer it). Since: Submit action prompts are shown inside the action form (`/evaluate`) and
  answered with the submission (JSON in X-Bluesandai-Justification); a reauthentication prompt and Ontology
  scenario submissions still use the dialog.
- Approvals (07, `approvals.py`, `/approvals`): Project access, group, marking and reference tasks, eligible and
  invited reviewers, request states, comments with attachments, required checkpoints, nudges, invocation; any 403
  with `X-Bluesandai-Access` offers "Request access". Not done: Ontology proposals are listed with a link (reviewed
  in Ontology Manager), per-user notification settings. Since: groups and markings have managers (Control Panel →
  Groups / Markings, set by administrators) who review requests for their own group or marking.
- Cipher (09, `cipher.py`, `cipher_crypto.py`, `code_cipher.py`, `/cipher`): channels and licenses as Files items,
  Operational / Data Manager / Admin licenses, Pipeline Builder steps, a Contour board, bellaso_python_lib, Decrypt on
  encrypted values in every object table / view; in TypeScript functions a CipherText property (or an encrypted
  value) is a CipherText with `decryptAsync()` / `updateAsync(text)` through the caller's Operational User license
  on its channel (updateAsync is an edit: the function must return Edits). Not done: the `cipher: editable` inline edit, Workshop "decrypt selected areas" for visual obfuscation,
  "Create pipeline" from a license, Marketplace packaging; Pipeline Builder takes the license RID as text.
- Sensitive Data Scanner (11, `sds.py`, `/sensitive-data-scanner`): built-in / regex / overlap / language model
  conditions, markings / issues / Cipher obfuscation actions, one-time, scheduled and continuous scans, media sets
  incrementally, virtual tables (read through their connection; obfuscation writes a managed copy), reversible
  actions. Not done: language model conditions were not run against a real model here,
  media scans reuse the platform's text extraction (OCR / transcription cost applies).
- Data Lifetime (12, `data_lifetime.py`, `/data-lifetime`, Dataset Preview → Details): fixed and latest-view
  policies, inheritance through Data Lineage, overrides, deletions. Not done: branch scoping (branch copies are
  separate datasets here), transaction-level provenance (a downstream transaction inherits from the upstream view
  current when it was built), deleting from S3 versions (storage keeps them per its own policy).
- Code scanning (16, `code_scanning.py`, `/code-scanning`, Checks): runs in `code_repos.run_checks`. Semgrep is not
  installed: rules run on a matcher for the Semgrep syntax (no type-aware matching, metavariable-regex /
  metavariable-pattern accepted but not evaluated).
- Compass (10, `compass.py`, `/compass`, `/search`, Files): Quicksearch (Ctrl+J), tags, Promoted, README.md and cover
  pages, Project activity and access graph, Data Catalog. Not done: Portfolios, Autosaved (nothing autosaves into
  Projects here), discoverability across organizations (the flag is stored). Since: search by creator (a Created by
  filter, or `creator:<username>` in the query); Files records who created each item (`drive_items.created_by`, the
  signed-in user of the request) from now on — items made before, or by background jobs, have no creator.
- Enterprise / Infrastructure security (14, 15, `security_posture.py`): posture checks from live settings and data,
  fixes (revoke tokens, deactivate accounts, review service accounts) and dated attestations for controls outside
  the platform. The guide pages (01–06) now point at the working apps.
- Done since, 2026-10-12 (re-audit fixes): emulation keeps the parent groups of a kept group; markings of hidden
  categories are masked by name everywhere; object-set and analysis exports need Download on their sources; inactive
  users (Security → `inactive_days`, default 30; service users and exempted users excepted) lose API and application
  tokens until they sign in again; tokens have descriptions and can be disabled; third-party applications can be
  disabled, limited to Projects and markings, and pre-consented for organizations; SSO attribute claims are copied
  into user attributes; SCIM 2.0 provisioning at `/scim/v2` (Users and Groups, filters, PATCH; token under Control
  Panel → Security); encrypted scheduled backups with a restore test (`backups.py`, Control Panel → Backups; pg_dump
  of PostgreSQL included) feed the posture checks, plus a hosting-origin check; restricted views as sources in
  Workshop and Contour (read as the viewer, never written to a dataset) and their policy changes follow to linked
  object types; spaces have storage, resource queue, usage account (Resource Management groups by it), Maven group,
  deletion policy and delete; templates create groups with a manager group and space owners may deploy them;
  Portfolios have thumbnails; builds and pipeline deploys check Project constraints before writing; uploads need a
  classification when classification is required; a Marketplace (`/marketplace`, `marketplace.py`) for Workshop,
  Slate, widget sets, checkpoint configurations and Cipher channels. 41 in-process checks plus the 122 earlier ones
  pass; the new pages rendered in headless Chrome without errors. Not done: an administrator code sandbox (needs
  container images), checkpoint types of apps that do not exist here, Compass Autosaved (nothing autosaves into
  Projects here). Done since, 2026-10-12: Space permissions — what a role on a space allows is a set of workflows (see
  the space, create Projects, manage portfolios, manage templates, deploy templates that create groups or markings,
  manage the space); the default roles keep theirs and a space's managers add custom space roles granted to users and
  groups (Control Panel → Spaces → Space permissions); Marketplace installs into a new locked Project, which takes the
  space's inherited roles for locked Marketplace Projects and which no role edits (discover / read / download only)
  until an administrator unlocks it. 24 checks, the 163 earlier ones unchanged, both dialogs rendered.
- Status 2026-10-12, after a heading-by-heading re-check against docs 01–16 (supersedes the older "Not done" notes
  above: Portfolios, the Cipher items — `cipher: editable`, decrypt selected areas, Create pipeline, Marketplace —
  Data Lifetime branch scoping and transaction provenance, single sign-on reauthentication are all done). Done in
  this pass: checkpoint types API export, build log export, frontend export (the browser asks
  `POST /api/frontend-exports/export` before saving Insight, SQL, Pipeline Builder previews and Slate tables; download
  controls apply), Report PPTX export, Custom Widgets allow downloads / camera / microphone (`checkpoints.gate()` in
  the release), group membership expiration update and config, Project marking authorization addition / removal,
  Project reference addition / removal; groups: expiration policy (latest date, maximum duration — new memberships,
  Approvals included, are bounded), revocation notices and the seven-day reminder (Account → Notifications,
  "Group memberships"), contact details (email or Issues; a group can be a Project's point of contact), attributes,
  `access-request:<category>` choices in the Request access form, groups hidden from a Project's request form
  (Owners), approval policies (approvals needed, reviewers); property security markings (object type objects and
  Workshop rows carry `property_markings`; Property list, Object list and Object table show them: responsive, full
  tag, icon only); restricted views in the Marketplace (string / boolean constants compared to columns or groups;
  the backing dataset and named groups are inputs); branching restricted views (add / edit on a global branch over
  the backing dataset's branch of the same name, object types re-indexed on it, owner reviews, rebase by part,
  merge on its own or with the global branch, removal, main-branch protection); Compass Autosaved (an analysis or
  preparation made from a Project's dataset starts in the Project's Autosaved folder; Compass → Project →
  Autosaved, Save to…). 58 checks, the 187 earlier ones unchanged, the dialogs rendered in headless Chrome.
  Not done: checkpoint types of apps or features this platform does not have (AIP Analyst, Flow Capture, Gaia,
  Hivemind, Kairos, Upgrade Assistant, Gotham scoped sessions, Peer Manager exports, API usage metrics, Contour
  dashboard PDF, Workshop function-backed export, Code Repository / Code Workspace log downloads, user intake
  exports), Import from Code Workspace (saves come from the kernel with the pod secret, never an interactive
  request), the two "Planned deprecation" settings (nothing to migrate from); an administrator code sandbox is a
  hardening idea, not a documented feature.

## How to run after pulling
```bash
git pull origin claude/gifted-sagan-maxkbo
pip install -r requirements.txt
```
Restart API and web (`start.ps1`). First start shows "Set up the platform": create the admin account.
`BLUESANDAI_AUTH=off` disables sign-in for development.

## Done since this list was written
- External transforms (doc 02): `transforms.external.systems` (`@external_systems`, `Source`) in Python transforms
  over REST API sources imported in Settings → External systems; requests go through the platform (credentials,
  domains, egress and agent proxy), `get_secret`, and export controls for transforms that read Foundry inputs.
  Database sources are not offered to code (only REST API sources have an HTTPS client).
- Data Connection agents and agent proxy (doc 02): Data Connection → Agents (Project resources, one-time token,
  downloadable `bluesandai_agent.py`, heartbeats and host info, token rotation) and the `agent_proxy` egress policy:
  the host resolves to a loopback listener that relays TCP through the agent's outbound WebSocket (TLS end to end).
  Tested with a real agent process relaying HTTP to a host only it can reach. Agent worker (syncs on the agent) is
  legacy in Foundry and not built.
- HyperAuto V1 / SDDI Cockpit (doc 03): `/sddi` — instances with a generator repository (SourceConfig.yaml /
  PipelineConfig.yaml), source exploration with a shopping cart, config changes as pull requests, stage-ordered
  builds, batch ontology generation, migration to V2 and severing. Tested end to end against PostgreSQL (21 checks).
  Done since: the source explorer's lineage graph (drag, Layout, Undo, + related, + cart; checked in headless Chrome).
  Not built: Spark profiles and
  deploymentSemanticVersion are recorded but transforms run on pandas as snapshots, PipelineConfig workflows /
  enrichments (Palantir-packaged logic) and Salesforce / NetSuite metadata tables (sources are database connections).
- Logic Flows [Sunset] (doc 08 "Connected flows", "Compass File Lister"): `/logic-flows`, connected flows as Project
  Files items, validated on create, Build / schedule / archive, run history; the Compass Files Lister automation opens
  a pull request writing rids.json (merged when ready if configured).
- Spark UI (doc 09): a debug job of a Spark transform keeps Spark's web UI on and captures it through its REST API when
  the job ends (jobs, stages with task metric quantiles and peak memory, SQL plans, executors, every Spark config);
  Common → debug jobs → Spark UI shows it. The Spark History Server is not used: on Windows it (and Spark's event log)
  needs Hadoop's native winutils, which is not installed.
- Artifact repositories (doc 16): Conda, PyPI and Maven formats next to Docker, Search / Publish / Overview, publish
  tokens, recall / unrecall, consumers; consumed by Code Repositories (meta.yaml, build.gradle). External Maven
  artifacts resolve from Artifact repositories and Maven Central (doc 25). Custom checks (Gradle tasks hooked into
  check / test / publish).
- Pipeline Builder transforms (doc 15: gzip / tar, Filter files, Empty file / media set file, Compute if expression
  absent, Assign timestamps and watermarks) and expressions (doc 14: validators, array conditions and set
  operations, struct / map updates, Approximate median).
- Dataset version diff: Data Lineage → a dataset's History → Compare (schema changes, row counts, added/removed rows).
- Java setup script (`setup-java.ps1`: JDK 17, test jars, pyspark) and the per-build job token in Java transforms.
- Schedule permissions (doc 08): Project / user build scope, server-kept owner (last editor), Editor checks on scoped
  Projects and targets, owner checks when a run starts, owner / Project filters in Build Schedules. Pipeline builds
  still write through the runner's service token (the scope is checked before they are queued).
- Sharing Java code between repositories (doc 25 / 16 "Artifact settings"): jars per default-branch commit,
  Settings → Artifacts, build.gradle `compile` coordinates (transitive), the Artifacts app's Shared Java code tab.
- Markings everywhere (doc 08): objects, action types, Lineage nodes, Builds / health / expectations / libraries
  listings, vector runs, monitoring views; Files contents only through checked reads; Views and rollbacks checked.
- Lineage of multi-output transforms (doc 08): every output (datasets, file outputs, media sets) is an edge; an output
  aborted by the latest build stays, marked aborted.
- Schedule usage hygiene: Build Schedules shows duplicate schedules, schedules firing within 5 minutes on the same outputs, and schedules sharing outputs (`GET /api/pipeline/schedules-report`).
- Pipeline Builder's DuckDB local engine (2026-10-20): Build settings → Engine → "DuckDB local" (compute `duckdb`).
  Each output compiles to one DuckDB statement (`externalSql.ts`, `local` inputs; SQL steps may name other nodes as
  tables, Cast after a SQL step compiles to `SELECT * REPLACE`) that the API runs over the Files Parquet datasets on
  disk (`api/pipeline_duckdb.py`, polled runs, so no 300 s fetch limit): no rows pass through the runner. Expectations
  and pivot values run as DuckDB checks, the write goes through `pipeline_datasets.commit_output` (markings, lineage,
  dataset versions, as a deploy). DuckDB is locked down before the editors' SQL runs (inputs registered as Arrow
  datasets, external access off, configuration locked: read_parquet / COPY / ATTACH / INSTALL / getenv refused). The
  editor keeps 1,000 sample rows per input and previews transform nodes in DuckDB over every row
  (`POST /api/pipeline/duckdb/preview`). Verified: "Pipeline Gold Data Sampel BPJS" builds 7 outputs from millions of
  silver rows in 30 s, totals equal to silver; the compiled gold SQL matched the JS engine row for row except
  ROUND(x * 1.0 / n) at .xx5, where DuckDB (like Spark: 1.0 is a decimal) rounds the exact value. Not supported on
  this engine: non-Files inputs, incremental inputs, write modes other than snapshot, non-dataset outputs, LLM /
  model / UDF / union nodes (compile errors name the node). Not checked in a browser session (no session here).
- Data Lineage: a Code Repository transform whose file was deleted from its branch leaves the graph (its builds stay in
  the repository's history); transforms generated from config (no name in their file) are kept.
