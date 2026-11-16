# AI Insurance Fraud Audit

Audit klaim asuransi kesehatan (JKN) dengan AI, di atas platform data BluesandAI. Isi repo ini:

| Bagian | Dokumen |
|---|---|
| App **AI JKN Audit**: cara menjalankan, port, perbedaan dari platform asal | [README-AIP-JKN.md](README-AIP-JKN.md) |
| Data BPJS **sintetis** (sequential CART synthesis) dan dasar ilmiahnya | [README-SINTETIS.md](README-SINTETIS.md), [synthetic-gen/METODOLOGI.md](synthetic-gen/METODOLOGI.md) |
| Mesin fraud realtime: aturan, model, pre-check faskes, permintaan dokumen | [docs/REALTIME_FRAUD.md](docs/REALTIME_FRAUD.md) |
| Cek klaim terhadap rekam medis SATUSEHAT (FHIR) | [docs/RME_SATUSEHAT_KONTRAK.md](docs/RME_SATUSEHAT_KONTRAK.md) |
| Bukti pemakaian alat dari IoT (sensor arus di kabel daya alat) | [docs/IOT_KONTRAK.md](docs/IOT_KONTRAK.md) |
| App faskes untuk binding IoT ke pasien (`/faskes`, untuk HP) | [docs/FASKES_APP.md](docs/FASKES_APP.md) |

**Yang tidak ada di repo ini:**
- Data BPJS asli. Semua data uji dan model di `testing/` berasal dari data sintetis.
- Kunci dan kata sandi. Salin [.env.example](.env.example) ke `.env.local` lalu isi sendiri.
- Data kerja (`data/`) dan hasil pembangkitan data sintetis (`Data Sintetis/`). Bangkitkan ulang lewat `synthetic-gen/`.

Bagian di bawah ini adalah dokumentasi platform asalnya (BluesandAI Parse).

---

# BluesandAI Parse

Web UI and API for turning documents and scanned books into structured JSON and Markdown.

- `api/` — FastAPI server (port 8000): uploads, parse job queue, progress, pricing, results.
- `web/` — Next.js UI (port 8888): upload → choose tier → run → Rendered / Markdown / Text / JSON
  results next to the page image, Code (cURL) tab, History.
- Files & Projects tab (`/files`, `api/drive.py`): a drive of projects (top level only), folders
  and files. The tree is in PostgreSQL (`drive_items`); file contents are in S3 under
  `drive/<item_id>` (on disk in `data/drive/` if S3 is not configured). Upload limit 1 GB per file
  (`MAX_UPLOAD_MB`). The default project "My Project" (created on startup, cannot be renamed, moved
  or deleted) gets automatic copies: PDFs/images uploaded on Parse → `Document`, finished parse
  results (JSON, MD, TXT) → `Parsed Document`, finished extractions (graph JSON) → `Extracted
  Document`. "Save to Files" (History, parse results, extractions) copies results anywhere else.
- Vector Storage tab (`/vector-storage`, `api/vectors.py`): indexes in the S3 Vectors bucket
  `AWS_S3_VECTOR_STORE_BUCKET_NAME`. "Create index" picks the embedding model (10 OpenRouter models,
  default `baai/bge-m3`), the dimension and cosine/euclidean. "Embed parsed results" embeds completed
  jobs' RAG chunks in the background (one vector per chunk, key `<job_id>:<chunk_index>`, chunk text in
  non-filterable metadata). The model is the index's AWS tag `bluesandai:embedding-model`; embed runs
  are rows in `vector_ingests`. Deleting a parse job deletes its vectors too.
  The Parse tab lists parsed documents under the upload area, with the indexes each is embedded in, and embeds
  one or many from there. An embed run can pick or create the index, re-chunk (size, overlap), prefix a
  contextual header ("Document: <name> · pages") to the embedded text, leave out short and repeated chunks,
  tag every vector with filterable metadata (tenant, access_level, …; Search takes `key=value` filters), and
  skip documents already in the index. "Preview" is a dry run (vectors, estimated tokens and cost, first
  chunks); the run's options are kept in `vector_ingests.options`.
  Each index has a Settings tab, everything off until turned on (`data/vectors/settings.json`): auto-embed
  of new parses (optionally only some tiers, with the options saved from an embed run), a spending limit in
  USD (OpenRouter prices from `/api/v1/embeddings/models`; runs over it are refused or stopped), auto-retry
  of failed runs (every 10 min, 3 times), re-embedding every document into another index (model
  migration), and search keys. A search key (`Authorization: Bearer bsk_...`) works only on
  `POST /api/vectors/v1/search`, searches one index, and the server applies its filter (e.g. tenant=acme)
  over the request's; only its SHA-256 is stored. The rest of the API has no authentication, so it must not
  be reachable from outside. Search modes: vector, or hybrid (vector + BM25 over the parse chunks, fused by
  reciprocal rank); either can be re-ranked by an LLM (`BLUESANDAI_RERANK_MODEL`, default `qwen/qwen3.7-flash`).
- Extraction tab (`/extraction`, `api/knowledge.py`): an LLM turns a parsed document (a completed parse job,
  or a result JSON / .md / .txt from Files) into an ontology-shaped knowledge graph, modelled on the
  ai-muhammadiyah `/knowledge-graph` explorer. JSON is converted to Markdown first, since the model extracts better
  from it: parse results page by page with `elements_to_md` (as `result.md` is made; headers, footers and page numbers
  dropped, `[page N]` markers kept), RAG chunks via their own Markdown, any other JSON into sections, bullet lists and
  tables. The Markdown read is saved as `<id>.source.md` (Markdown button on the extraction page). Then the model designs an OWL-style ontology (classes with a
  hierarchy, object properties with domain/range), or reuses an earlier extraction's so documents line up; each
  ~12k-character window is read for entities and relations held to that schema (enums in the JSON schema), each
  relation with a verbatim evidence quote and page; mentions are merged by name and alias, then optionally by the
  model (AI de-duplication). Models: Gemini 3.5 Flash (Gemini API) and, through OpenRouter, Claude Sonnet 5.5,
  DeepSeek V4 Pro, GPT-6 Luna and Qwen 3.8 Flash (`MODELS` in `knowledge.py`).
- Knowledge Graph tab (`/knowledge-graph`): named graphs, each merging a chosen set of extractions into one graph
  (same name/alias → one node, optional AI entity resolution across documents and languages); nodes and evidence
  keep which extraction they came from. Both tabs export JSON and OWL/RDF Turtle. Runs can be stopped and
  continued: every LLM result is checkpointed in `<id>.parts/` under a hash of its model, prompt and text, so
  Continue (or an API restart) reuses finished parts and only calls the model for the rest. Records and graphs are JSON
  files in `data/kg/` (`extractions/`, `graphs/`); token usage is kept there and never served.
- Foundry-style apps, named as in Platform Apps (`/apps`). The API has no user accounts, so none of this may be
  reachable from outside.
  - Ontology Manager (`/ontology`, `api/ontology.py`): object types (typed properties incl. media = a Files item,
    primary key, title), their objects, and action types that create / modify / delete them. Uploads for media
    properties go to My Project / Ontology. Records are JSON in `data/ontology/`. Link types, interfaces, shared
    properties, value types, ontologies, branches, Object Explorer and Object Views: see "The Ontology's model" below.
  - AIP Logic (`/logic`): functions of inputs and blocks run in order (Extract text from PDF, Join array, Text
    template, Use LLM via `pipeline_ai.chat`, Apply action). Run previews the edits; "Run and apply" writes them.
  - Automate (`/automate`, engine `api/automate.py`, records in `api/ontology.py`): conditions on an object set (an
    object type narrowed by filters, also on derived properties: counts or aggregates over linked objects) — objects added to / removed from / modified in the set (optionally only when
    given properties change), threshold crossed, run on all objects on a schedule —, time (every N minutes or cron
    expressions with a time zone, several allowed; next runs previewed), automation dependencies (after another
    automation completes, optionally only on success), and time series. Condition settings: cycles, skip peering
    events, dropped objects (a per-execution limit), live or scheduled evaluation (digests). Effects run in order:
    AIP Logic, action, function, notification (users / groups or a property holding a user; once for all objects, per
    group of a property, or per object; `{{object.x}}`, `{{objects.count}}` templates; optional email), each with
    retries (backoff), continue-on-failure and a fallback (action or notification with `{{error.message}}`).
    Settings: expiration (pauses itself), administrators, queued or parallel executions; effects run as the owner.
    Runs show each effect's attempts and fallback; failed runs can be retried; manual execution on chosen objects or
    the whole set; per-user muting; an event history (edited, paused, retried, fallback, expired, dropped).
    Function-backed: function-generated object sets (a published function returning an ObjectSet; filters narrow
    it) and threshold logic from a function returning a boolean, evaluated every N minutes against the previous
    evaluation ("Evaluate now" on the automation page); action / Logic / function effects execute once per object,
    once for all objects, per batch or per group (the objects through `{{objects.set}}` or an objects input);
    notifications generated by a function per recipient (a Notification, or None to skip) with attachments — Notepad
    documents, Notepad templates generated with the triggering objects, Contour analyses — rendered to PDF or inline
    images for the email; mute for everyone (until a time) and auto-mute (every effect failed in ≥ 80% of the last 30
    executions); manual executions on a function-generated set in batches with parallelism.
  - AIP Agent Studio (`/agents`, `api/agents.py`): chat agents over object types (all objects in the prompt, or
    schema only) with tools — search, aggregate, get object, chosen actions and Logic functions — answering in a
    JSON tool loop; citations `[[ApiName:pk]]` link to the objects. Sessions are kept per agent.
  - Workshop (`/workshop`, `api/workshop.py`): drag-and-drop modules on a 12-column grid — table, metric, bar / pie /
    line chart, filter, text, action button, image, PDF and spreadsheet annotation (boxes or cell ranges saved as
    annotation objects through a create action), audio recorder (a microphone clip into an action's media parameter)
    — over Files datasets (Parquet) or object types. Filtering and aggregation run in `POST /api/workshop/query`
    (object rows go through the property security policies: values a user may not see read as null).
    Core concepts (`components/workshop/ModuleRuntime.tsx`, `WorkshopWidgets.tsx`): pages, tabs widgets and overlays
    (drawer / modal) each hold their own grid (`parent` of a widget); typed module variables (defaults, URL
    parameters `?v.<name>=`) written by inputs (text, number, date, toggle, string selector from fixed values or a
    column, object dropdown, user select) and read by filters (`$var:name`; an empty variable does not filter),
    function inputs, text and embedded modules; events on buttons, button groups and row selection (set a variable,
    open / close an overlay, switch a tab, go to a page, open a module with variable values, open a URL, refresh);
    object list, property list, links, pivot table, embedded module (its published version, its variables set from
    here) and iframe widgets; Share state (a link with variables, filters, selections and the page); versions on
    every save with a changelog, publishing a chosen version when auto publish is off (viewers see the published one).
    Variables (`components/workshop/VariablesEditor.tsx`, `lib/workshopTransforms.ts`): static, variable
    transformations (a step board of general / math / date / comparison / boolean / array / struct operations),
    function outputs, object set aggregations, object properties and SQL queries over object types
    (`POST /api/workshop/sql`, `@alias` tables and parameters, SELECT only; a scalar, array, struct or struct array
    from the result shape) with automatic / on-event / on-load recompute; timestamp, struct and struct array types;
    external IDs as the module interface (`?<external id>=`); a lineage view and "used by" for each variable; events
    to reset or recompute a variable, put an LLM answer in one and open an object. Layouts: variable-backed page, tab
    and overlay state, conditional visibility (hide if a boolean), loop layouts (an embedded module per array entry
    or object, list or grid, limit or paging). Module derived properties (column math on an object type) and value /
    conditional formatting in tables and metric cards.
    Layouts (`components/workshop/LayoutTools.tsx`, `Canvas.tsx`): a module header (title naming the browser tab, title
    color, icon or logo image, background, horizontal or vertical with width / height, collapsible vertical header,
    favorites per user via `PUT /api/workshop/modules/{id}/favorite`, its own widgets); sections with their own
    layout (grid, rows, columns, toolbar, flow), collapse (expand / collapse / toggle events, collapsed by default);
    in view mode widgets move up into the rows a hidden or collapsed widget frees; style formatting (block /
    contained / floating headers, background shades or a custom color, bordered / shadow / inner / borderless,
    padding) on pages, sections and widgets; overlay header, title, icon, side, backdrop and "on close" events;
    layout templates for an empty page; an outline with conditional visibility indicators; cut, copy, paste and
    duplicate of widgets and sections with their children (also across modules), with the same or duplicated input
    variables.
    Visualization widgets (`components/workshop/VizWidgets.tsx`): Object Set Title (type and count, or the selected
    object; title override, render when empty), Vega Chart (Vega-Lite or Vega spec, inline or from a string variable,
    data inputs from objects, aggregations or struct array variables injected by name, a default theme, selection
    parameters into string variables, "Copy full spec" as the preview), Map (object layers from latitude / longitude
    or "lat,lon" properties of an object type or dataset, label, hover properties, color rules, visibility variable,
    lock, selection with events, basemaps), Gantt Chart (start / end properties, discrete points, no-end handling,
    group rows, smart / new-row / overlap stacking, grid ticks, a now line, color rules, selection events), Timeline
    (vertical or horizontal, newest or oldest first, properties per event, time between events, color rules,
    selection) and Stepper (linear or not, steps with events, completion from boolean variables, an active step
    variable, icons and colors). All read through `POST /api/workshop/query` with the module's filters and derived
    properties.
    Collaboration, writeback and AIP widgets (`components/workshop/AipWidgets.tsx`): Comments (the object comments
    of `api/object_views.py` on the selected object: @mentions that notify, object references that select the object
    and run events, attachments into Files, events after commenting, the object's action log in the same feed),
    Inline Action (the server-driven action form in the page, `ActionForm inline`: one or several action types,
    parameter defaults from variables, a custom title, success events), AIP Chatbot (an AIP Agent Studio agent;
    chosen variables go to the agent as application state, `app_state` on `POST /api/agents/…/messages`; a textbox
    variable that sends when an event sets it; the answer into a variable; reasoning and clickable citations) and
    AIP Generated Content (a prompt with `{{variables}}` or a string variable straight to an LLM, or an AIP Logic
    function with inputs from variables; output variable, title, button label, loading message or spinner).
    Module settings (`components/workshop/ModuleSettings.tsx`, `lib/workshopProfiler.ts`): auto-refresh (watched
    object types polled through `GET /api/workshop/freshness`, a minimum of 10 seconds, off in edit mode, only while
    the tab is visible, events to pause and resume updates) and a Data Freshness widget; kiosk mode ("Open kiosk",
    the content in scope, `?kiosk=1`: the published version without the editor, read-only — actions, inline
    actions, comments and agents that apply actions are off); redact mode (`?workshop_enableRedactMode=true`:
    masked text, striped charts, hidden media; kept when opening other modules); translations (header, pages,
    overlays, widget titles, tabs, buttons, Markdown, steps; per language, manual or with AIP, "Mark as complete",
    preview in edit mode, viewers get their browser language); used colors (saved colors with light and dark values
    as CSS variables, selectable as backgrounds, usage counts; unsaved hex codes with their uses); Performance
    Profiler (`?profiler=1`: module load time, a timeline and the slowest widgets and variables, by page or overlay).
    Filtering (`components/workshop/FilterWidgets.tsx`): object set filter variables (property filters with all / any,
    a keyword, filters on linked objects — `filter_sets` on `POST /api/workshop/query`, links from
    `GET /api/workshop/links/{type}`; a default that may use `$var:` values, and filter value extraction back into
    those variables) applied by any data widget; a Filter List (keyword, histogram, single and multi select, numeric
    and date ranges, linked properties and "has link", counts that reflect the other filters, users adding filters,
    vertical or pills), Exploration Filter Pills (read only, remove, update or add; and / or), an Exploration Search
    Bar (value suggestions, keyword, links, clear) and Prominent Terms (chosen values with their counts).
    Objects and resources (`components/workshop/ObjectWidgets.tsx`, `lib/workshopMarkdown.ts`): an Object View (the
    full object page embedded with `?embed=1`, or a panel: the object, or the set's object view aggregates), Edit
    History (user edits per property with the value before and after, who and when — tracking per object type through
    `PUT /api/workshop/edit-history/{type}`, an append-only log fed by the Ontology edits hook), an Action Log
    Timeline, Linked resources (Files linked to an object: upload, link, unlink — `/api/workshop/resource-links`), a
    Media Uploader (a folder, allowed extensions, several files, file ID and name into variables, an action per file
    with the file identifier) and a Resource List (Files: static, recent, favorites or folder contents; object types;
    object sets; list or cards, three styles, display overrides and events). The Markdown widget adds pipe tables,
    ==highlights== and object references (`:objectreference[text]{objectType="…" primaryKey="…"}`: colors per type,
    selection into the module, events, highlight modes), and annotation objects over the text (character ranges,
    created through an action from a text selection).
    Documents, video, telemetry and analysis (`components/workshop/MediaWidgets.tsx`): a PDF Viewer (pages rendered by
    pdfium — `/api/workshop/pdf/{ref}`, `/page/{n}`, `/search` with match boxes —, keyword search with current / other
    highlights and hit count, a search term and a page number from variables, zoom, annotation objects with bounding
    boxes and new ones from an area selection through an action), a Video Display (byte-range streaming, seeking from
    a variable, key frames every n seconds, from an array variable or at ffmpeg's scene changes), an Observability
    Chart (executions or p95 duration of a function or an action type per hour or day, brushing sets start / end
    variables, expand, run history), Free-form Analysis (a path of cards — filter, metric, text, table, pivot, bar, pie,
    line, heat grid, waterfall, linked objects, object selector — each on the set left by the filters before it;
    saved private or public; the path's filters into a variable) and AIP Analyst (questions about the object set: the
    model plans one query over its columns and the module's derived properties, the query runs with the user's
    permissions, shown as a number, chart or table with the query).
    Cross-application interactivity and display optimization (`components/workshop/CrossApp.tsx`): per widget mount
    (normal, delay until on-screen, eager) and unmount (normal, when off-screen, never) behavior — tabs, pages and
    overlays holding never-unmount or eager widgets stay mounted while hidden; drag zones (object table rows, the
    object set title, the object view icon) dragging objects as `object:<type>:<pk>` text (what Ontology Manager drags
    and the Map application accepts) or an object set; sections as drop zones (label, icon, the dropped objects into
    an object set, object set filter — a `__pk` filter — or string variable, events); Object List reordering into an
    array variable; App Pairing (windows with the same code share selections and chosen variables, BroadcastChannel);
    module commands (a parent window or an embedded page posts `{type: "bluesandai.command", command, payload}`: the
    payload into a variable, then events) and a "send command" event to an iframe widget or the parent window.
    Platform (`components/workshop/PlatformPanels.tsx`): modules are Files items (`<name>.workshop` in a Project or
    folder, like Slate applications): opening one needs the Viewer role on its Project, changing it the Editor role
    (with the Project's markings); older modules are put in a Project with "Put in a Project" / `POST
    /api/workshop/modules/{id}/move`. Branching on global (Ontology) branches: save a module on a branch (main is not
    changed), the Changelog tab (changes per widget, variable, page, overlay, derived property, setting), a three-way
    rebase (main's non-conflicting changes come in; each conflict takes main's, the branch's or a custom version; or
    reject all of main's changes), approvals and rejections, merging into main (rebased and approved), and approved
    module changes merging with their global branch; protected modules are saved to a new branch instead of main.
    Marketplace packaging: installation configuration (string / boolean parameters bound to variables), the packaging
    linter (dependencies; errors for deleted object types, action types, properties or variables; warnings for
    resource lists and custom widgets), a product package (`GET /api/workshop/modules/{id}/package`) and installing
    one (`POST /api/workshop/install`: inputs, dependencies mapped to resources here, a folder).
    Scenarios [Legacy] (`components/workshop/ScenarioWidgets.tsx`, on Ontology scenarios): scenario and scenario array
    variables (also loaded from objects holding scenario ids), a Scenario Manager (main, static and dynamic scenarios,
    create, select the active one, delete), a Scenario Selector (one or several into a variable), a Scenario Summary
    (the scenario's actions and edited objects); data widgets "Load data from scenario" (`scenario_id` on
    `/api/workshop/query`), tables comparing scenarios (a column per scenario beside each differing value),
    aggregation and property variables in a scenario, actions applied to a scenario instead of the Ontology, and a
    scenario event (create, save, apply through an action type with an Apply scenario rule, delete).
    Mobile (`components/workshop/MobileWidgets.tsx`): a Mobile device type (edited at phone size; every grid becomes one
    column of widgets in order, with height and order in the panel; touch-sized inputs; action forms and dialogs as
    full-screen drawers), the Mobile Navigation Bar (up to four single or submenu items with icons and events, a title
    for the browser tab, height, icon-only mode; stack navigation keeps an item highlighted on pages reached from it), a
    QR Code Reader (a full-screen camera view: the browser's BarcodeDetector when it has the formats, else frames
    decoded by the platform with OpenCV — `POST /api/workshop/decode-codes`, QR codes and EAN / UPC / Code 128 / 39 /
    93 / Codabar / ITF —, one code or several, a "Scan code" prompt, a photo instead of the camera, events after
    scanning), a Current Location Manager ("lat,long" into a variable while its page is open, a denial warning, a
    preview with the nearest place of a source: no geocoding service is called) and the mobile app launcher (`/m`:
    search and open mobile modules without the platform's sidebar; `/m/<id>` is view only and each page is a browser
    history entry, so Back / Forward move between pages).
    Time series formatting (`components/workshop/TsFormatting.tsx`): Object Table time series property columns (per
    object a summary — last, first, min, max, mean, sum or count over a range — and a sparkline, from `POST
    /api/workshop/ts-columns`), the time series Metric Card with a sparkline, value formatting everywhere (min / max
    fraction digits, minimum integer digits, min / max significant digits, grouping, compact / scientific / engineering /
    percent notation, prefix / suffix) and conditional formatting rules (comparisons and "between") coloring the text,
    the background, the sparkline or both.
  - Slate (`/slate`, `api/slate.py`, `web/src/lib/slateRuntime.ts`): applications are `.slate` Files items in a Project
    (its roles and markings govern them) with versioned documents of pages, a toolbar, widgets (text / HTML,
    controls, table, charts, containers, tabs, dialogs, toasts, cards, lists, timeline, image, iframe, code sandbox,
    file import, Action, object card; in `components/slate/SlateWidgetsMore.tsx`: segmented control, date range
    picker with shortcuts, calendar (day / week / month, series, paging), image gallery, tree, graph (force directed,
    flow, circle, grid, manual layouts, color scale, directed edges), map (location, heatmap, GeoJSON shape and
    choropleth layers on the shared base maps), Gantt, heat grid, tree map (squarified, categories and densities),
    resource selector over Files, time series from a sync), queries (read-only SQL over datasets; the platform API; Data Connection REST API
    sources as HTTP JSON with JSONPath extractors; secure upload), JavaScript functions with a shared library (run one
    at a time in a Web Worker; lodash, moment, numeral, math.js from the CDN), object sets (filters with Handlebars,
    sort, limit, aggregations), object context, Foundry Functions, shared / page variables (URL parameters, user
    storage), events wired to actions (`{{slEventValue}}`, `{{slDisableAction}}`, slate.navigateTo / redirectToUrl /
    copyToClipboard / downloadBlob / setUserStorage / print / sendMessage (child, opener, parent windows) / scrollToId /
    setWindowTitle / exportWidget (PNG or PDF) / BroadcastChannel create, close, broadcast / saveView, loadView
    (shareable views: `?view=<id>`, `/api/slate/apps/{id}/views`) / logout / openAppsPortal, QUERY.run / exportCsv, VARIABLE.set,
    widget actions), a global stylesheet plus per-widget CSS and classes. Handlebars are Slate's: paths, sub-expressions,
    if / unless / each / with blocks, the core, widget, Foundry and SQL helpers. The editor has the widget list, a
    12-column canvas (drag, resize), the Property / Layout / JSON / Events tabs, Queries, Functions, Platform, Variables,
    Events, Styles, Dependencies and Console panels, Ctrl+K search, undo of deletions, Preview. Versions: every save is
    one, "Always publish when saving", publish / unpublish, tags (`?$tag=`), revert, compare; a save on an old version
    gets the newer one and a three-way merge per element (conflicts resolved with mine / theirs / edited JSON, then a
    preview). Import / export `.slate.json`, Save as. Public applications (administrators create them) serve their
    published version without sign-in at `/s/slate/<permalink>`; secure upload channels and tokens (expiry, count, blob
    size) put anonymous JSON uploads into a folder.
  - Custom widgets (`/custom-widgets`, `api/custom_widgets.py`; Workshop → Custom widget): widget sets are `.widgetset`
    Files items in a Project. A release is immutable: a production build uploaded as a .zip
    (`.palantir/widgets.config.json` with the version and each widget's entrypointJs / entrypointCss or html,
    parameters — boolean, date, number, string, timestamp, objectSet, scenario, arrays — events with the parameters they
    update, requested iframe permissions; camelCase ids, 50 of each) or widgets written in the page's editor (HTML /
    CSS / JavaScript). Widgets run in iframes with an opaque origin (sandbox `allow-scripts` plus the permissions a
    builder grants) and a strict content security policy, loading their files from signed expiring links; every widget
    page gets `window.BluesandaiWidget` (parameters, `emitEvent`, `osdk.objects / object / objectSet / applyAction /
    executeFunction / currentUser`) and the host makes the Ontology calls as the viewer, only on the resources chosen
    in Configure SDK and once an administrator enabled Ontology APIs. In Workshop, parameters bind to values, the
    selected object, a filter or an object type's filtered objects (object set); events update those bindings and can
    open a URL or refresh the module; auto height and the host's color scheme. The playground has parameter controls,
    sizes, themes and a message log; dev mode (per user, 24 hours) loads a development server's widgets instead.
  - Developer Console (`/developer-console`, `api/developer_console.py`, `api/osdk_api.py`): applications are
    `.devconsole` Files items in a Project, each an OAuth2 client — client-facing (public: authorization code with PKCE
    S256) or backend (a client secret, rotated on demand: authorization code or client credentials, acting as its
    creator) — with redirect URLs, the origins its browser code calls from (CORS on /api/v2 and the token endpoint) and
    scopes: object types, action types (bringing their object types) and functions. `/api/oauth2/authorize` sends the
    user to the consent page (`/oauth/authorize`), `token` issues hour-long access tokens (`bsai_oat_…`, limited to
    the OSDK API) and 30-day rotating refresh tokens, `revoke` revokes. The OSDK REST API (`/api/v2/ontologies/default/…`:
    object types, list / search with where (eq, gt, gte, lt, lte, isNull, in, contains, startsWith, and, or, not),
    orderBy and page tokens, derived properties over links (`derivedProperties`; `withProperties` in the generated
    client), Ontology scenarios (`client.withScenario(id)`), aggregate with groupBy, one object, links, apply actions
    (`options.mode: VALIDATE_ONLY` validates parameters, submission criteria and rules without writing; an invalid
    action is refused with the validation; `returnEdits`), attachments (upload, metadata, content) and media
    reference properties (upload for a property, an object's media metadata and content), execute queries; a backend
    application can have its own service user (client credentials then act as it, not as the creator), and users
    review and revoke the applications they granted under Account settings;
    `/api/v2/admin/users/getCurrent`) applies the application's scopes on top of the user's permissions and the
    property policies. "Generate SDK" makes a versioned TypeScript npm package (`.tgz`: typed object types, actions and
    queries, `createClient`, `createPublicOauthClient` with PKCE and refresh, `createConfidentialOauthClient`) with
    docs. Website hosting: static builds uploaded as versions, one live at `/api/dc-hosting/<site>/` (SPA fallback,
    a content security policy with configurable domains).
  - Pilot (`/pilot`, `api/pilot.py`): describe an application or a custom widget set; a session (`.pilot` Files item)
    runs agents on a chosen model (act mode, or plan mode waiting for approval): an ontology architect (object types,
    actions and links, reusing existing ones, within the ontology permissions: create new types or not, modify each
    existing entity or not; links follow their object types), a designer (palette, typography, layout), a seed data
    generator (invented rows) and an app builder (index.html / style.css / app.js on the generated SDK through
    `pilot.js`, or a widget's HTML / CSS / JS on `window.BluesandaiWidget`). Workspace: chat with agent threads,
    Preview on the seed data only (an OSDK API over the session's rows, actions edit them; desktop / tablet / mobile),
    the Ontology graph (existing / proposed, seed data preview, per-entity permissions), Code (edits are versions),
    Pilot logs, versions. Deploy runs checks (SDK references, a Node syntax check), promotes proposed entities
    (optionally loading the seed rows), creates the Developer Console application with those scopes, its SDK and the
    live site; widgets go to a widget set release and a Workshop module.
  - Carbon (`/carbon`, `/carbon/<workspace>`, `api/carbon.py`): workspaces are `.carbon` Files items configured like
    Carbon's YAML — general (navigation out of Carbon on / off, external links, discoverable modules per object
    type), the menu bar's anchored tabs and "+" menu (Workshop, Slate, Object Explorer, objects and object types,
    Notepad, Quiver, Vertex, Map, searches, links; icons and colors), the home page (logo, welcome text, a search bar
    over chosen object types, columns of card or list sections: custom items, object types, all menu items) or a
    module as the home page, access (promoted to the organization's Navigation Menu by administrators, default
    workspace for groups, Carbon as the landing page) and What's New pages (archive, delete; shown once per user).
    The workspace opens without the platform sidebar, modules in tabs (`?embed=1` pages); the editor sidebar has
    General, Home, Menu, Access, Updates, YAML (PyYAML, validated) and Versions (preview, republish).
  - Autopilot (`/autopilot`, `/autopilot/<workbench>`, `api/autopilot.py`): workbenches are `.autopilot` Files items
    that group object types and the automations around them (start from either; related automations come along).
    States are inferred from the objects' status-like properties and the values automations write, then edited
    (property is / contains / is empty, color, card properties, drag to reorder). Kanban (cards with the last change
    and who made it — a person or an automation —, a live mark while an automation runs, bulk "execute for all" per
    state, right-click retry and "filter to linked objects"), a dependency graph (Workshop modules → states →
    automations → actions / AIP Logic, edges for triggers, writes, the states an action sets and the transitions seen
    in action runs; per-resource activity), split view, Automation events (period / status / automation filters,
    objects failing most) and an object panel (history with before → after values, an object timeline with lanes per
    actor and agentic coverage, a preview). Ctrl+F finds an object; alerts flag automations not in the workbench.
  - Solution Designer (`/solution-designer`, `/solution-designer/<diagram>`, `api/solution_designer.py`): diagrams are
    `.sdiagram` Files items (viewers read, editors change and export). An SVG canvas with component nodes (57 platform
    applications and external systems in 9 categories), resource nodes linked to files, object types, interfaces and
    action types (opened in their app; missing or forbidden ones are flagged), concept nodes, groups (members move with
    them; drop to join or leave), text notes and labeled connections; node toolbar, side panel (documentation card,
    colors, icons, tags, overlap order, node traversal, object traversal → create related object type nodes), context
    menus, box select, copy / paste, undo / redo, canvas controls (zoom, fit, lock, dots, auto layout, flow animation,
    edge labels, edge validity, minimized nodes), mini-map, autosave plus Save, versions (preview, restore), import
    (JSON, a whiteboard photo through the model's vision, Data Lineage around a node), export (JSON / PNG at 2x, all or
    the selection), a reference library (7 industry / technical / workflow patterns), `?viewer=true` and
    `?focus=<resource id>`. AIP Architect: wizard → concept graph, implementation patterns per concept (preview, insert),
    a data model for the Ontology node (reusing existing object types), a build walkthrough. AIP Critic: sections,
    chat with drill-down saved on the diagram, an implementation plan (phases, tasks, dependencies, effort) as PDF.
  - Workflow Lineage (`/workflow-lineage`, `/workflow-lineage/<graph>`, `api/workflow_lineage.py`): one index of object
    types (links, interfaces, backing dataset), action types, functions, AIP Logic, automations, Workshop modules, Slate
    applications, custom widget sets, Developer Console applications and language models, with edges from each
    resource to what uses it (found in their configurations). Add resources by search (name, RID, API name, property
    name), by type or every resource in a Files folder; `?add=<kind>:<id>` (Workshop: Ctrl+I) opens one with its
    neighbors; expand up / downstream from each node. Selection details: property provenance (actions, automations,
    Workshop widgets, Slate object sets, links), links, data preview, security, action inputs / edits / criteria / run
    history, function code and metrics, Logic blocks and models, automation condition dependencies; the Workshop
    panel highlights the widgets that use the selection. Color modes: node type, custom groups, ontology and resource
    permissions of a user (View as), failure rate, monitoring, application views (Workshop views are counted from
    now on), model usage (requests and tokens per model: `pipeline_ai.USAGE_HOOKS`), out-of-date functions, ontology
    status, action rule, automation expiration, last modified, project, folder. Bulk changes: copy submission
    criteria from a source action, upgrade function versions in actions / automations / Workshop modules (partial
    or all-or-nothing), replace the model of AIP Logic LLM blocks, move Files resources. Text nodes (Markdown),
    layouts and the documented hotkeys, saved graphs (`.wlgraph`) with presentation frames.
  - Workflow Builder (`/workflow-builder`, `/workflow-builder/<graph>`, `api/workflow_builder.py`): graphs (`.wbgraph`)
    of workflows: trigger (objects added / modified, optionally only when a property changes; a schedule; manual),
    compute (a published function, or named expressions), use LLM (prompt template, typed output, object query,
    function and action tools: run before the call, or — tool calling — chosen by the model in a loop of up to N calls,
    each call and its result shown in the run), fork (cases, Otherwise, after fork), effect (apply an action, notify users, do
    nothing), loop (element and index variables, after loop), subgraphs and calls. Values are `{{templates}}` or
    `= expressions` (a safe Python-like language) over `object`, earlier outputs, loop variables and reusable
    `params`. Previews run real objects in a hidden staged-writes scenario: the path, each node's value and the
    edits are shown, main is not written, and previews re-run live as the graph changes. Execution runs the saved
    version now; deploying a trigger runs it on Ontology edits (`MODEL_HOOKS["edits"]`, chained) or a schedule, as
    the deployer. Run history (send to preview), versions (revert), workflow objects and an object watchlist.
    Copy and paste (Ctrl+C / Ctrl+V or Copy): a node, or a whole workflow from its trigger or subgraph start with the
    subgraphs it calls, through the system clipboard into the same or another graph (fresh ids, parameters added).
  - Use Cases [Sunset] (`/use-cases`, `/use-cases/<id>`, `api/use_cases.py`): a use case is backed by a Project (new,
    or an existing one migrated). Applications are the Project's application resources (Slate, Carbon, widget sets,
    Developer Console, Pilot, Autopilot, Solution Designer, Workflow Lineage / Builder, …) plus Workshop modules
    created from or added to the use case; object and action types come from what those applications reference
    (Workflow Lineage's index and their records) or are added by hand, with status tags, Local and used-elsewhere
    warnings; backing data shows each type's input datasource, writeback and what updates it (Data Lineage);
    other resources list the rest. Metadata (name, description, Markdown documentation, technical and business
    owners, status with a disparity warning) is edited by Use Case Owners / Editors and visible to everyone.
  - Git remotes for Code Repositories (`api/code_git.py`, `/api/git/<repo id>.git`; repository header → Work locally):
    `git clone` / `fetch` / `push` over smart HTTP (`git http-backend`), the password a personal API token (Work
    locally creates one that expires in 7 days). A bare mirror per repository is kept in step with the JSON commit
    store (`git fast-import`; commit ids stay stable); pushed commits become repository commits in order (merge commits
    keep both parents; checks run), new branches are created, deleted ones deleted (not the default), and protected
    branches refuse direct pushes. Text files only (binary bytes are replaced). Template version 3 adds `./gradlew`
    (and `gradlew.bat`): `displayTransformsList`, `datasetPreview --transformId=… [--printMode=table]` and `checks` run
    in the platform on the pushed branch, from the clone's `origin` URL and token.
  - Code Repositories (`/code-repositories`, `api/code_repos.py`): Python transforms use a Foundry-like
    `transforms.api` (`@transform_df(Output(...), x=Input("path or item id"))` or `@transform`, pandas instead of
    Spark); R, Java and SQL transforms are also supported. Git-like: branches (protected ones change only through pull
    requests), commits, tags (naming rule and PR template in the repo's `repoSettings.json`), pull requests with reviews, line comments, impact analysis and
    squash / merge / fast-forward (three-way per file, conflicts block), Reset and Merge. Checks run on every commit
    (compile, load, `test_*` unit tests). Editor: Preview, Test, Build (every output of the open file), File changes,
    SQL scratchpad (SQLite over datasets in backticks), Libraries, new file from template, AIP Assist (explain, find
    bugs, explain error). Transform schedules (a cron expression in a time zone, every N minutes and/or when an input
    changes; retries with a delay; Run now; status, last error and next run) build the default branch's last commit
    and are listed on Build Schedules too. User code runs in a subprocess (`api/code_runner.py`, 300 s limit, secrets
    stripped from its environment). Transform kinds: `@incremental` above `@transform` / `@transform_df` reads only
    the rows appended to its inputs since the last build and appends to the output (a rewritten input, a deleted or
    changed output or a new `semantic_version` runs as a snapshot; "Build as snapshot" forces one); `.sql` files of
    `CREATE TABLE \`/path/out\` AS SELECT …` statements over backticked datasets (SQLite dialect, `api/code_sql.py`);
    media set transforms (`transforms.mediasets` MediaSetInput / MediaSetOutput over Files folders). A build that
    writes no rows to a dataset whose retention policy aborts empty transactions commits nothing.
  - R transforms (the R app `/r`, Platform Apps → R, or New repository → R; `api/code_r.py`, `api/code_r_tools.py`):
    `.transforms/*.yml` specs map dataset aliases to `.R` scripts (runtime `rscript`, `identifier` / `filePath`). Rscript
    comes from `BLUESANDAI_RSCRIPT`, the PATH, or a portable R in the project's `.r/` folder (gitignored; install it per
    user with R's Windows installer: `R-4.x-win.exe /VERYSILENT /CURRENTUSER /TASKS="" /DIR=<project>\.r`). The app
    provides a small `foundry` bridge for `datasets.read_table()`, `datasets.write_table()` and `datasets.upload_files()`.
    Tables travel through CSV and are persisted as Parquet; output aliases name datasets under the repository's Code
    Repositories folder. Packages come from CRAN through Posit Package Manager and from Bioconductor, installed once into
    a shared library (`data/code-envs/r-library/<R version>`) every R transform sees; the site profile sets the mirrors
    before the project's `.Rprofile` runs, so `install.packages()` / `renv::restore()` there work; renv is installed on
    first use and shares a cache. The R app is a workspace over those repositories: file tree and editor, transform
    specs (resolved by Checks), Packages (search CRAN / Bioconductor, install, packages the code uses, renv.lock,
    "Snapshot environment" = `renv::snapshot()` into renv.lock), Run checks, Build, Commit and the outputs of the last
    builds. This single-node runner does not use Spark.
  - SQL Studio (`/sql-studio`, Platform Apps → SQL Studio; `api/sql_studio.py`, router `/api/sql`): Spark SQL parsed
    with sqlglot and run on DuckDB. Data mode reads datasets, Views and Iceberg tables referenced as
    `` `/project/path` ``, `ri.foundry.main.dataset.<id>` or an item id; branches with `` `branch`.`/path` `` or
    `` `/path`.branch_<name> ``; Iceberg metadata tables as `` `/path`.snapshots|files|history|refs|manifests|partitions|entries ``.
    Object mode (read-only) reads object types by RID or API name and many-to-many link types as
    `ri.ontology.main.relation.<id>`, with `DECLARE @v TYPE = value` and object set variables; `SHOW FUNCTIONS [LIKE …]`
    lists functions. The preview shows 1,000 rows (10,000 from the … menu), with a chart and a CSV download; queries stop
    after 120 s. Worksheets are private (`data/sql-studio/worksheets.json`) or saved into a project as a
    `.sqlworksheet` Files item that opens in SQL Studio and follows the project's roles; each save is a version you can
    restore, and unsaved edits (also of the scratchpad) are kept as drafts. The AIP panel writes, explains and fixes
    queries from the editor and the selected schemas. Dataset Preview has a SQL tab (the SQL console) with
    "Open in SQL Studio".
    Writes (`api/sql_writes.py`): CREATE [OR REPLACE] TABLE (columns with NOT NULL / COMMENT, or AS query; USING
    iceberg — the default — or parquet; PARTITIONED BY identity / years / months / days / hours / bucket / truncate;
    TBLPROPERTIES), INSERT INTO / OVERWRITE (VALUES or a query, optional column list), UPDATE … SET … WHERE and
    DELETE FROM … WHERE (one overwrite snapshot), ALTER TABLE (columns, partition fields, write ordering, identifier
    fields, properties, tags and branches), BEGIN; …; COMMIT; blocks (a failure rolls the written tables back to their
    snapshot before the block and trashes the tables it created) and the `/*+ adhoc */` hint. Only Iceberg tables take
    INSERT / UPDATE / DELETE / ALTER. Each write keeps a SQL definition per output (`data/sql-studio/definitions.json`):
    the first is active, later ones become active unless ad hoc, CREATE OR REPLACE replaces them. Dataset Preview →
    Details → Job spec lists them (Active label, Set as active definition, Open in SQL Studio, Build) with a rebuild
    schedule (cron + time zone, run as the user who set it); Data Lineage shows an "SQL definitions" node whose inputs
    are those of every definition, and builds it from the active one.
    Ontology SQL functions (`api/sql_functions.py`): a saved object mode worksheet in a Project → Publish (name, API
    name) releases a read-only query function in the functions registry (1.0.0, 1.1.0, …; breaking signature changes
    bump the major version). DECLARE literals are its inputs (defaults kept), object set variables object set inputs
    (empty: every object); it returns a list of structs, or a list of values for one column, and runs with the
    caller's permissions wherever functions run (Workshop, Actions, Automate, `/api/functions/queries/<apiName>/execute`).
  - Transforms common (`/transforms-common`, Platform Apps → Common; `api/transforms_common.py`, `/api/transforms-common`):
    the local preview tasks in the Task Runner (and the API with a token): `displayTransformsList` lists transform ids
    (`myproject.datasets.examples:compute`), `datasetPreview --transformId=<id> [--printMode=table]
    [--inputFiles=<alias>:<path>] [--outputFiles=<alias>:<path>]` previews one on the platform (nothing is written) and
    returns a link only its author can open for 24 hours (`/transforms-common/previews/<id>`), or prints the first 10
    rows of each dataset. Every Code Repositories build records its environment (transforms version as
    `sparkModuleVersion`, Spark, Java, Scala, Python, engine, repository environment), shown in the Builds app
    (Spark details → Environment) and per repository. "Rerun as debug job" on a failed build reruns its code as a
    preview on the environment of an earlier successful build of the same transform, when that environment is still
    installed, and says whether a version change broke it. The Multi-output design tab compares the two approaches and
    flags single-output transforms that share inputs and multi-output transforms that fail or vary in build time. One
    runtime per language is installed here: there is no adjudication between versions or module pinning.
    Spark UI (`/spark-ui?repo=&job=`): a debug job of a Spark transform runs with Spark's web UI on and saves what its
    REST API reports when the job ends — Jobs, Stages (task metric quantiles, peak execution memory, spills), SQL /
    DataFrame (plans and node metrics), Executors (added / removed) and Environment (every Spark config); the debug
    job's Spark UI button opens it.
  - Containers (`/containers`, Platform Apps → Containers; `api/container_registry.py`, `api/container_runtime.py`,
    `api/sidecar_slot.py`): Docker Artifacts repositories are `.artifacts` Files items in a Project (viewers pull,
    editors push). The registry speaks the Docker Registry HTTP API v2 at `/v2/` (`docker login <host> -u <user>` with a
    personal API token as the password; images are `<host>/<repository slug>/<image>:<tag>`), or takes `docker save`
    archives. Every tag is checked against the image requirements (numeric non-root user, linux/amd64, not `latest`,
    layers under ~10 GB, ports 1024–65535, telemetry /bin/sh + tee); failing images do not run. Sidecars run on Docker:
    `BLUESANDAI_DOCKER=docker | wsl:<distro> | off` (default: docker on the PATH, else Docker Engine in the default WSL
    distribution). With WSL, `docker push` from WSL cannot reach the API (WSL2 NAT), so the app starts a relay on
    127.0.0.1:5005 inside WSL (`BLUESANDAI_REGISTRY_RELAY_PORT`) that bridges to the API through a Windows process
    (`registry_bridge.py`). `transforms.sidecar` (`@sidecar(image, tag, volumes=[Volume("shared")],
    resource_profile=…)`, `transforms-sidecar` in meta.yaml is built in) makes a transform a Spark transform with one
    container next to the driver and one per executor (each Spark task's Python worker): the image comes from the
    Docker repositories added in Settings → Libraries → Artifacts and is `docker load`-ed once; shared volumes are per
    slot folders mounted at `/opt/palantir/sidecars/shared-volumes/<name>`, and in the worker those paths and
    `localhost:<exposed port>` are redirected to its own container. Resource profiles become docker limits. Container
    logs join the build logs; a killed build's containers are removed.
  - Container models (`/container-models`, Platform Apps → Container models; `api/model_assets.py`,
    `api/model_container.py`): Import containerized model creates a model resource (`ri.models.main.model.<id>`) owning
    its own Docker Artifacts repository (its Project's viewers use the model and pull the images, editors push and
    create versions). A model version (semver, major / minor / patch) picks pushed images with their runtime settings
    (listening port, environment variables, arguments, exec command, memory limit, telemetry) and a container model
    adapter: a `palantir_models.ContainerModelAdapter` class (`init_container(container_context)`, `api()`,
    `predict()`) from a Code Repository file on its default branch's last commit. Running a version starts each image
    as a container (sidecar_slot: ports on localhost, one shared empty volume), gives the adapter a
    ContainerizedApplicationContext (`services`: container name → `localhost:<port>`), and stops them afterwards. Test
    a version on the model page with JSON inputs (outputs and container logs shown), or use it in a Python transform
    with `ModelInput("<model rid>", "<version rid>")` (`model.transform(df).<output>`, `transform_write`); the build
    records the version and adds the containers' logs to its log.
  - Linter (`/linter`, Platform Apps → Linter, Control Panel → Linter configuration; `api/linter.py`): sweep schedules
    (resource scope: all Projects or chosen ones; rule scope: presets such as PIPELINE_COST_RULES, then rules added, then
    excluded; every N hours, or triggered; the last 10 sweeps with status and errors) run rules over Pipeline Builder
    schedules and builds, Code Repositories (settings, upgrade pull requests, transforms' source and builds — Spark
    builds record the query plans they wrote, which the non-deterministic and cartesian product rules read), datasets
    and Data Lineage. Recommendations in two modes, Resource Savings (with compute-hours per month estimated from the
    last 30 days) and Pipeline Resilience: filters (resource type, rule, Project, assignee), context (logic, why,
    recommendation, evidence), snooze with a reason and an expiry (snooze expired), assignment (bulk too), and fix
    proposals Linter applies when accepted (protect the default branch, squash-only merges, automatic upgrade merges,
    three retries, a schedule name). Opening one makes it Under investigation; when a later sweep no longer finds it, it
    is resolved and appears in Impact tracking with its estimated and (after a week) verified impact.
  - Preparation [Sunset] (`/preparation`, Dataset Preview → All actions → Clean in Preparation; `api/preparation.py`): a
    `.preparation` Files item (kept in Files › .auto-save until saved) with a starting dataset and a changelog compiled
    to DuckDB steps: trim, empty → null, normalize strings, change case, change type (currency strings to numbers),
    new value for the selected (focused) values or all rows (`/NULL`), extract (indexed substring, regex), normalize
    column names (snake case), rename (Column view, staged then applied), delete columns, remove / keep rows, add column
    and apply expression (Spark SQL; `monotonically_increasing_id()` is the original row order), split. Column stats
    (null, empty, needs trim, case, numeric, distinct, a value histogram to focus on) offer one-click fixes. Clicking a
    change previews the data before it and inserts new changes there; changes that stop applying after Change dataset
    show in red. Save as dataset writes an updating (Update) or one-off dataset; each save keeps its changelog (Restore
    saved version); Duplicate. Project scoping needs the input in the Project or a Project reference
    (`api/project_references.py`); Analyze opens the saved dataset in SQL Studio. Preparations show in Data Lineage.
    Output dataset branches: the header's branch selector (Create branch) picks where Save as dataset writes — a copy
    under `_branches/<branch>/` next to the dataset, as Dataset Preview shows branches; Save to another branch writes
    the result to another branch's copy; Saved versions lists the current branch's saves (Restore switches to it).
  - Recipes [Sunset] (`/recipes`, Dataset Preview → All actions → Create a recipe; `api/recipes.py`, `api/notify.py`):
    monitor a dataset on a schedule (every N hours, weekdays at a time in a time zone, or when the dataset updates) for
    rows matching filters (or every run) and send a preview of up to five columns as an in-app notification and / or
    email to up to 25 recipients; recipients without Viewer access get a link only (success with exceptions). Run
    history (success, success with exceptions, skipped, failed), expiration with reminders to the author (7 days and 1
    day before; Extend / Resume), mute for me, pause for all, the author's notification setting (email, web, none).
    Besides datasets a recipe watches an object type (its objects, "when it updates" follows edits), a time series
    (the points of a series in the last N hours as timestamp / value rows, e.g. value > 90) or a report (Reports →
    Actions → Email on a schedule): the report is rendered with headless Chrome / Edge as its author sees it
    (`api/report_render.py`, a short-lived session; `?print=1` hides the app chrome) and emailed as an attached PDF or
    an in-email image.
  - Peer Manager (`/peer-manager`; `api/peering.py`): peering ontology objects between BluesandAI enrollments. This
    enrollment's platform title and API address; network connections from MPX invite codes (bidirectional, egress
    only, ingress only; requests between enrollments carry the network secret at `/api/peering/remote/*`) and data relay
    File channels (signed payload files in a directory); peer connections between a Project on each side (request →
    the remote approves → the originator activates; enable / disable per side; security = the markings allowed, changes
    approved by the remote); ontology peering (object types added on both sides with imports allowed or blocked,
    mappings of same-typed properties, source data / actions directions); jobs (concurrent exports of each local edit,
    sequential catch-up every minute from the last acknowledgment, imports applied as edits not sent back, Ack jobs,
    awaiting pull / ready to download / empty / failed, filters, health); peer profiles (a hub / spoke pair installed
    with a remote strategy that creates or configures connections). Marking mapping (Settings: each local marking →
    one of the remote's, listed from it; security change requests reach the remote in its ids, marking properties are
    translated on export and an unmapped marking stops the export); join table link types (offered on both sides,
    mapped once both object types are, link pairs sent by sequential jobs when they change and applied as adds /
    removes of the peered pairs); Automate's "Skip peering events" on object conditions ignores edits Peer Manager
    applied.
  - Python transforms, Foundry's current API (New repository → Python; `api/code_pyapi.py`, laid out as
    `transforms-python/` with `build.gradle`, `conda_recipe/meta.yaml`, `src/setup.py`, `src/myproject/pipeline.py`).
    `@transform.using(...)` runs on a single node: inputs read as Polars (`.polars(lazy=True)` scans the Parquet file),
    pandas, Arrow, `.path()` or `.filesystem()` (a Files folder is a dataset without a schema); outputs take
    `write_table()` of Polars / pandas / Arrow / a DuckDB relation / a folder of Parquet files
    (`path_for_write_table`, `put_metadata()`), or files via `filesystem().open()`; several outputs per transform;
    `ctx.duckdb()` registers every input as a lazy view with an `<input>_files()` macro (`read_modes`,
    `sql_from_file`); `.with_resources(cpu_cores, memory_gb | memory_mb)` sets thread limits and a memory limit the
    build is stopped at (a `gpu_type` cannot be built: no GPUs). `@transform.spark.using(...)` runs on real PySpark
    (local mode, `api/pyspark_worker.py` works around Windows' Python worker socket reset): `.dataframe()`,
    `write_dataframe()`, `ctx.spark_session`, `filesystem().files()`, UDFs and RDDs. Also `@lightweight`,
    `transform_pandas` / `transform_polars`, `BooleanParam` / `IntegerParam` / `FloatParam` / `StringParam` (values from
    `repoSettings.json` → `pythonParameters`), `@configure(profile, allowed_run_duration)`, `ctx.abort_job()` (the job
    succeeds and commits nothing), column descriptions / typeclasses (Parquet field metadata, shown in previews), a
    `Pipeline` with `discover_transforms` / `add_transforms` (with a setup.py `transforms.pipelines` entry point only
    the pipeline's transforms build), generated transforms (module-level lists), transform logic level versioning
    (`tllv`, `tllvFiles` in build.gradle; the version is on each build) and logging (INFO and up) in the logs.
    Incremental: read modes `added` / `previous` / `current`, `modify` / `replace` writes, `snapshot_inputs`,
    `strict_append`, `allow_user_deletes` (row hashes are kept so deleted rows don't force a snapshot; retention here
    never removes rows of a current view, so `allow_retention` alone does not tolerate them), folder inputs (new files
    only), outputs aborted on their own make the next build a snapshot. Preview always runs non-incrementally. An
    output the transform never writes gets an empty snapshot (an empty transaction when it is incremental). Aborted
    transactions (`abort()`, `abort_job()`, aborted empty writes) are listed greyed out in the dataset's history.
    `InputSet` / `OutputSet` (the function gets lists), `foundry.transforms.Dataset.get(alias)` (the transform's own
    inputs / outputs by parameter name, path or id; other datasets read by item id; unit tests can patch the module and
    call the transform without arguments), `FoundryDataSidecarFile` / `FoundryDataSidecarFileSystem` (raw files of an
    input / output). Unmarking: `Input(stop_propagating=Markings([...], on_branches=[...]), stop_requiring=OrgMarkings(...))`
    and `Output(sever_permissions=True)` (Spark only) change what the output inherits; a build that would remove a
    marking an input carries needs an administrator. Custom Transforms profiles: repoSettings.json `"sparkProfiles":
    {"NAME": {"spark.sql.files.maxPartitionBytes": "64m"}}` (spark.sql.* settings) for `@configure(profile=["NAME"])`;
    Spark `files()` is partitioned by file size with those settings. Ibis and SQLFrame run over `ctx.duckdb().conn`.
    Data expectations (`api/code_expectations.py`): `Check(E..., name, on_error="FAIL" | "WARN")` on inputs and
    outputs with the whole `transforms.expectations` reference (columns, properties, group by, primary key, schema,
    timestamps, arrays, when / otherwise, foreign values); FAIL stops the build; results show on the build, in the
    Builds app and in Data Health → Expectations. Media sets (`api/code_media.py`): `media_input.transform()` with
    resize, crop, rotate, grayscale, binarize, equalize, rayleigh, image ↔ PDF, slice, OCR (RapidOCR), raw text, form
    fields, table of contents, page sizes, spreadsheets, email body / attachments, and audio / video through the ffmpeg
    of imageio-ffmpeg (transcode, extract audio, chunk, frames, scene frames, waveform); `write()` to a media set,
    `put_dataset_files`, `fast_copy_media_item`, `set_write_mode`; `tile()` (Slippy map tiles of GeoTIFFs, reprojected
    with pyproj), `extractLayoutAwareTextV2` (typed blocks with bounding boxes, tables with their cells, TEXT / MARKDOWN / HTML, ELECTRONIC /
    SCAN / AUTO), `encrypt()` / `decrypt()` of image regions with a Cipher license (`api/cipher.py`, AES-256-CTR, PNG;
    licenses in Control Panel → Cipher licenses),
    `transcribe()` (Whisper tiny / base through transformers, downloaded once; text, timestamps or segments) and
    `generate_image_embeddings()` (CLIP ViT-B/32; SigLIP 2 when installed); Pipeline Builder has the same
    transcription as its "Transcribe audio" Media step. Not available here: NITF tiles (GDAL),
    compute pushdown (BigQuery, Databricks, Snowflake), GPUs (these transforms load but cannot be built), the VS Code
    extension. Bring your own container (`.with_container(container_image, container_tag)`, `api/byoc_slot.py`): the
    image comes from a Docker Artifacts repository in Settings → Libraries and must run as user 5001; during the
    build its container runs on the container runtime with `$USER_WORKING_DIR` (the repository's `src` in
    `user_code`) shared with the transform, whose `os.system` / `subprocess` calls execute inside it (no preview).
    Apache DataFusion is installed (`ctx.read_parquet(my_input.path())`).
  - Python (Spark), Foundry's original API: `transform_df` / `@transform` of a file that imports pyspark (or uses
    `@configure`, or with `repoSettings.json` → `"legacyPythonEngine": "spark"`) run on PySpark — DataFrames in, the
    returned DataFrame out (`transform_df`), `TransformInput.dataframe()` / `TransformOutput.write_dataframe()`,
    `ctx.spark_session`, `filesystem().hadoop_path` for `spark.read.csv(...)`, `pkg_resources.resource_stream` for
    files packaged with the code, `sanitize_schema_for_parquet`. Spark profiles (`@configure(profile=[...])`:
    DRIVER_/EXECUTOR_ memory and cores, NUM_EXECUTORS_n, SHUFFLE_PARTITIONS_*, off-heap fractions, CROSS_JOIN_ENABLED,
    AUTO_BROADCAST_JOIN_DISABLED, ADAPTIVE_*, DYNAMIC_ALLOCATION_*) size the local session; an unknown profile fails the
    checks. `backend=ComputeBackend.VELOX` is accepted and logged (it runs on standard Spark: no native acceleration).
    Incremental on Spark: `dataframe("previous", schema=...)` (empty with that schema on a first build), merge-and-append
    and merge-and-replace; `Input(..., transaction_limit=N)` and `MediaSetInput(..., batch_limit=N)` with
    `@incremental(v2_semantics=True)` read at most N unprocessed transactions / media items per job (a non-APPEND
    transaction after the start fails with `Build2:InvalidTransactionTypeForBatchInputResolution`); the build shows the
    batch and how many transactions are left, and a schedule can re-trigger until the output is up to date. The first
    build of a new branch starts from the default branch's incremental state. Incremental media sets: overwrites and
    deletions stay incremental, a replaced set or a modified transactional output forces a snapshot, a transactionless
    output that would be snapshotted fails. Language models (`palantir_models.transforms` inputs:
    `GenericChatCompletionLanguageModelInput`, `OpenAiGptChatLanguageModelInput`, `AnthropicClaudeLanguageModelInput`,
    `GenericEmbeddingModelInput`, …; `api/code_models.py`) call the platform's models with the build's job token; the
    Model Catalog (`/models`, Platform Apps → Model Catalog) lists them with their resource identifiers and example
    code. Model Studio (`/model-studio`, Platform Apps → Model Studio; `api/model_studio.py`,
    `api/bluesandai_model_studio.py`): a studio has a trainer (regression, classification, time series forecasting)
    and an output model created with it; the configuration wizard maps a training dataset's columns (target,
    features, ignored, timestamp / series id), filters rows, takes an optional test dataset (else a 20% split),
    trainer parameters (evaluation metric, excluded model types, hyperparameters, prediction column, probabilities,
    prediction length, seasonality, frequency) and resources, saved as numbered configuration versions with a
    changelog. A training run is a job in its own process: numpy trainers (ridge / softmax regression, k-nearest
    neighbours, gradient-boosted trees; naive / seasonal / drift / Holt forecasters, picked by backtest) keep the best
    candidate and publish a model version with an experiment (parameters, validation metric, leaderboard); the run list
    shows status, configuration version and the version produced, and the model is flagged out of date when its
    training data changes (or retrains by itself on a new transaction of it, when set). Not AutoGluon (not installed). Experiments &
    Evaluations (`/model-experiments`) aggregates run metrics and dataset-linked evaluation records.
    Models trained in transforms (`/model-assets`, Platform Apps → Models; `api/model_lib.py`, `api/model_assets.py`):
    `palantir_models` is implemented here (no external service) — `ModelAdapter` (`api()` with `pm.Pandas` / `Spark` /
    `Parameter` (type enforced) / `FileSystem` / `NDArray` / `MediaReference` / `Object`, `predict()` or
    `run_inference()`, `load()` / `save()`), `@auto_serialize` with the Dill, CloudPickle, JSON, YAML, PyTorch and Spark
    ML, Hugging Face, TensorFlow / Keras and XGBoost serializers, `ModelStateWriter` / `Reader`; experiments take Plotly
    figures and MLflow logs (`experiment.as_mlflow_run()`: autologging and the Keras callback).
    `ModelOutput("/Project/models/name").publish(adapter, experiment=)` stages the saved files, the API and the adapter's
    source root; when the build succeeds the model (a Files item, type Model) gets a new version on the build's branch
    (a failed build publishes nothing; Preview checks save / load without committing). `ModelInput(path or rid,
    model_version=, branch=, use_sidecar=)` loads the latest version on the branch (or the pinned one) with the
    repository's adapter module or the version's source; `use_sidecar=True` runs it in its own process
    (`api/model_worker.py`); `DistributedInferenceWrapper(model, ctx)` predicts a Spark DataFrame on the executors (each task loads
    the version and predicts its partition in chunks). Experiments (`create_experiment`, `log_param(s)`, stepped `log_metric(s)`, images, Plotly
    figure JSON, tables) and evaluations (`@palantir_models.transforms.evaluation("set")`, `create_evaluation()`,
    subsets by `prefix/name`, the built-in `evaluate()` with the regression / classification evaluators, computed with
    numpy) are committed with the build. The model page shows versions (API, adapter, serializers, source and training
    data), a test run, experiments (compare up to 5, metric charts, parallel coordinates, images, plots, tables) and
    evaluation sets (grouped by version, compare, Run against a chosen version, run on new versions).
    Jupyter Code Workspaces (`/code-workspaces`, Platform Apps → Jupyter; `api/code_workspaces.py`,
    `api/workspace_client.py`): JupyterLab on a RunPod pod (RUNPOD_API_KEY; a GPU type or CPU, a /workspace disk),
    opened through RunPod's proxy with a per-workspace token. A workspace has dataset aliases (read an existing
    dataset, write a new one) and model aliases (an adapter skeleton `<alias>_adapter.py` is written to /workspace);
    the pod installs the platform's client from the public URL (BLUESANDAI_PUBLIC_URL, default
    https://hexa.bluesandai.com) so notebooks use `Dataset.get("alias").read_table()` / `.write_table(df)`
    (`foundry.transforms`) and `ModelOutput("alias").publish(adapter, experiment=)` / `ModelInput("alias")`
    (`palantir_models.code_workspaces`); every .py file of the working directory is packaged with the version. The
    machine bills by the hour: Stop keeps the disk, Terminate deletes it, and a workspace stops by itself after its idle
    time without kernel activity (default 3 minutes, as low as 1, checked every 30 seconds; a running cell is not idle). `public.ps1` publishes the platform at https://hexa.bluesandai.com (Cloudflare
    Tunnel → `api/public_proxy.py` on 8886 → the API on 8000 and the production web on 8887).
    Demo (`api/demo_jkn_models.py`, POST /api/demo/jkn-models, button on the Model Integration hub): Project "Audit
    Risiko Faskes JKN (demo)" with synthetic facility indicators for the 20 risk subcategories, a model trained in the
    Code Repository "risiko-faskes-jkn demo" (with an experiment and an evaluation set) and one in the Model Studio
    "Risiko faskes JKN (demo)", the objective "Prioritas audit faskes JKN (demo)" (metadata, a review check and a
    Recall ≥ 0.6 check, automatic evaluation by facility type and claim volume, the better model released to
    production), the live deployment "Skor risiko faskes (demo)" with the row-wise function `skorRisikoFaskesDemo`, and
    the batch deployment writing "skor_risiko_faskes_bulan_ini (demo)".
    Overviews (`api/model_overview.py`): the Model Integration hub's live counts, the Evaluation Center (each
    objective's automatic evaluation and each model's evaluation sets), Model Developer (adapters in use: kinds,
    serializers, models, API) and the Model Migration Center (code still using foundry_ml in Code Repositories and Code
    Workbooks, a suggested palantir_models rewrite, the replacement model or ignore; there are no dataset-backed models).
    Code Repositories templates (`api/code_model_templates.py`): Model Training (an adapter package, a training
    transform publishing to a ModelOutput with an experiment, inference and evaluation transforms with a ModelInput;
    runs on the sample dataset with numpy) and Model Adapter Library (external and container adapter examples).
    Externally hosted models (Models → Connect externally hosted model; POST /api/model-assets/external): a URL,
    unencrypted connection configuration, credentials sealed with the platform key, and a `pm.ExternalModelAdapter`
    from a Code Repository file (its src root is the version's source); the adapter is loaded once to check it and
    record its API, `init_external(external_context)` gets `base_url`, `connection_config`, `resolved_credentials`.
    New versions change any of them (an empty credential keeps the old one). They run in transforms, test runs and
    live deployments; batch deployments and automatic evaluation refuse them, as in Foundry. No egress policies here.
    Deployments that run (`api/model_deployments.py`): a direct model deployment per model and branch serves the latest
    version and upgrades on a new one; each running deployment is one worker process (starts on the first request after
    an API restart). Endpoints under the environment URL `<host>/api`: POST
    `/api/foundry-ml-live/api/inference/transform/<rid>/v2` (a field per input / output) and the single I/O form
    (`requestData` → `responseData`, objective deployments only); direct deployments cast inputs to the API's types;
    400 / 422 / 503 as documented. Logs and run history (7 days), request metrics, configuration (replicas and
    resources are kept, not enforced). Model functions wrap a live deployment (row-wise for single tabular in / out),
    run through the functions gateway (`/api/functions/queries/<apiName>/execute`, so `FoundryClient().ontology.queries`
    in Python functions) and keep versions; they are listed in the functions registry for Workshop, actions and Automate,
    a row-wise one can take an Ontology object whose properties fill the model's columns, and row-wise ones run as
    Pipeline Builder UDFs.
    Modeling Objectives (`/modeling-objectives`; `api/modeling_objectives.py`, `api/model_evaluation.py`): submissions
    of model versions with custom metadata fields, checks (approvers, approve / reject / comment threads, archive,
    evaluation-based checks on a dashboard metric), archive, staging releases marked as production with history (a
    model API change is flagged), live deployments and batch deployments (input dataset → output dataset, rebuilt on a
    new release) of a release, model inference history datasets, and automatic evaluation: evaluation datasets, the
    binary classification and regression evaluators (metrics and plots: confusion matrix, ROC / TPR / FPR / lift curves,
    distributions, residuals), subsets (one per string value, fixed-width buckets, range cut-offs, multi-field),
    `inference_…` and `metrics_…` datasets per submission, built on submission or on demand, and the evaluation
    dashboard (dataset and transaction, select or search models by metric, subset tabs, pinned metric tabs). Custom
    evaluation libraries (`api/model_evaluators.py`): an `Evaluator` with `apply_spark(df)` in a repository (Model
    Evaluator Library template), described by its docstring (`:display-name:`, `:param`, `:metric`), found at the
    repository's latest tag and pinned to it in the configuration; it runs in its own process on local Spark per subset. Older
    free-text candidates stay as records only. Not here: FoundryConnector, real Velox, the Spark
    details tab of builds and the Pylint PySpark checkers.
  - Python tests and environment: Checks run pytest (fixtures including a session-scoped `spark_session`,
    `pytest.ini` / `--cov` with pytest-cov; only when build.gradle applies `pytest-defaults`; `tasks.pytest { numProcesses
    "N" }` runs them with pytest-xdist), PEP8 (`com.palantir.conda.pep8`, pycodestyle) and Pylint
    (`com.palantir.conda.pylint`, `src/.pylintrc`) style checks that fail Checks, and the Spark anti-pattern linter
    (`com.palantir.transforms.lang.antipattern-linter`, warnings; `api/code_lint.py`); the Checks tab lists the tasks
    (condaPackRun and its stages, pytest, pep8, pylint, antipatternLinter) and every message. They also resolve `conda_recipe/meta.yaml` against this environment and
    published libraries (`api/code_env.py`): Mamba-style errors for build / run Python mismatches, `>=`, ranges for
    python, a space after an operator, unpublished library versions and Python versions past their end of life (the
    support table is in the Libraries panel). Repository environments (`api/code_envs.py`, needs uv): a meta.yaml
    asking for a package this environment lacks (or another version of one), or for Python 3.10 / 3.11, gets its own
    environment built with uv in `data/code-envs/` — on the same Python only the differing packages, layered over the
    platform's; on another Python that interpreter (uv downloads it) with the transforms runtime and every listed
    package. uv solves the requirements (a conflict fails Checks with its explanation); the resolved versions are a lock
    reused until meta.yaml changes, and published library versions are locked per meta.yaml too. Checks, tests,
    previews, builds and the debugger run in it. Libraries panel: "Add from PyPI", and a settings button on a library to
    pin one of its published versions (or go back to the newest); a library whose repository the user cannot see is
    not listed and fails resolve (`ReadRepositoryPermissionDenied`). `condaJars` / `sparkJars '<group>:<name>:<version>'`
    in build.gradle (graphframes, spark-nlp) are resolved from Maven with Ivy and put on the Spark classpath (builds:
    condaJars; tests: both). Repository upgrades (… → Upgrade, or a banner when a branch is behind): an upgrade pull
    request brings the branch to the current Python template version (ci.yml / settings.gradle overwritten,
    gradle.properties / versions.properties merged with the template's keys winning, conda_recipe/, src/ and build.gradle
    untouched); with Settings → "Automatic merge of upgrade PRs" they are opened hourly and merged once their checks
    pass, unless they overwrite files changed in the repository or someone committed to the upgrade branch. The Task
    Runner (… → Task Runner) runs `install` /
    `uninstall --packageSpecs=…` (edit meta.yaml; a new package must resolve with uv), `whoneeds`, `formatCode`
    (Black, `pyproject.toml` [tool.black]), `test` and the
    Java tasks. Every build records Metrics (memory and CPU of its process every 0.5 s against what it requested),
    shown on the build and in the Builds app.
  - Python libraries (New repository → Python Library): packages under `src/`, named by `gradle.properties`
    `condaPackageName`. Tag a commit with an SLS version (`0.1.0`); once its checks pass that version is published.
    A repository that lists the package in its meta.yaml run requirements (pinned, or the newest) gets its code on
    `sys.path` in checks, previews and builds. From outside, a library repository is a conda channel
    (`/api/artifacts/repositories/<id>/contents/release/conda`, Foundry's Artifacts API; noarch packages built from each
    published version, shown in the Libraries panel; use an API token). The Artifacts app (`/artifacts`) lists the libraries, their versions and
    consuming repositories, shared Java code and the Java UDF versions.
  - Sharing Java code between repositories (Palantir's "Share code across repositories"): every commit of a Java
    repository's default branch whose checks pass publishes each Java subproject as a jar, version `0.<n>.0` (n: the
    commit's position in the branch history; older versions are compiled the first time they are needed). A dependent
    repository adds it in Settings → Artifacts (adding one adds its own backing repositories; the caller needs its
    markings) and references it in its subproject's build.gradle —
    `compile 'ri.stemma.main.repository.<repo id>:transforms-java:<version>'` (the Artifacts settings copy the line).
    The jar and what it depends on in turn go on the compile, test and run classpaths of checks, previews and builds.
    A coordinate whose repository is not added, a missing version or a cycle fails the checks with the reason.
    Any other coordinate (`compile 'group:artifact:version'`) is an external Maven artifact (`api/maven.py`): it
    resolves from the Artifact repositories in Settings → Artifacts, then Maven Central (SHA-1 checked, cached in
    `.java/maven`; `BLUESANDAI_MAVEN_CENTRAL=off` turns Central off), with its POM's compile / runtime dependencies
    (parents, properties, dependencyManagement and BOM imports, exclusions; nearest version wins). A dependency Spark
    already ships in the same major version is left to Spark's jar; version ranges are refused (pin a version).
  - Artifact repositories (`/artifact-repositories`, Files → New → Artifact repository; `api/artifact_repos.py`):
    the `.artifacts` repository of Containers also holds Conda, PyPI and Maven packages. Search (format + name,
    version history, size, dates, consumers), Publish (artifact type, Generate token — a personal API token valid a
    day —, parameters, instructions, details; or upload a file from the browser) and Overview (RID, parent folder,
    counts). Clients use `/artifacts/<slug>/conda/<subdir>/…` (PUT a package; a conda channel with repodata.json),
    `/artifacts/<slug>/pypi/` (twine upload; `/pypi/simple/` index for pip / uv) and `/artifacts/<slug>/maven/…`
    (Maven layout PUT / GET, computed maven-metadata.xml and checksums) with Basic auth (a token as password).
    Viewers read, editors publish and recall; artifacts are immutable (no delete: trash the repository). Recall /
    Unrecall (Conda, and PyPI as PEP 592 yanked) takes a recalled version out of the channel and refuses its download.
    A code repository with the Artifact repository in Settings → Artifacts resolves its noarch Conda packages and
    pure-Python wheels in meta.yaml (unpacked onto sys.path) and its Maven artifacts in build.gradle; Search lists
    those repositories as consumers. The Artifacts app recalls published Python library versions the same way.
  - Custom checks (doc 16; `api/code_gradle_tasks.py`): Gradle tasks in a subproject's build.gradle hooked with
    `project.tasks.check.dependsOn <task>` / `tasks.test.dependsOn` / `project.tasks.publish.configure { finalizedBy
    <task> }` run with Checks (no Gradle here: println, `exec { commandLine … }`, `type: Exec` tasks, dependsOn,
    doFirst / doLast and `throw new GradleException(…)` are run; anything else fails the task as not supported). Their
    output goes to the check logs; a failing task fails the checks.
  - Media sets (`/media-sets`, `api/media_sets.py`; Platform Apps → Media Sets): a media set is a Files folder with
    settings, so Pipeline Builder, Code Repositories, Data Connection and folder markings keep working with it. Schema
    (audio, DICOM, document, email, image, spreadsheet, video, or multimodal = any format) and a primary format;
    additional input formats are converted on upload (images with Pillow, audio / video with ffmpeg, DOCX / PPTX / TXT
    to a text-only PDF). An upload to an existing path keeps the older item as a version (version history; its media
    reference keeps rendering); delete is a soft delete (not for sets a build updates). Transaction policies:
    transactionless (uploads readable at once; builds only `modify`) or transactional (uploads go through a transaction,
    one open at a time, ≤ 10,000 items; builds may `replace`). Retention: delete items older than N days and overwritten
    / deleted versions N days after. Paths ≤ 256 characters, items ≤ 50 GB. Previews and metadata per type (PDF pages
    and text, audio waveform, video, spreadsheets, email, DICOM with drag for contrast / exposure and layers via
    pydicom), cached access patterns, and usage metered in compute-seconds per GB with the doc's rates (also in
    Resource Management). Virtual media sets register files of an Amazon S3 connection without copying them (Data
    Connection → Media sets → Virtual media set sync, or `register_media_item` in Python transforms). Files shows a
    media set badge and New → Media set / Make media set; Workshop has a Media preview widget; media references
    everywhere resolve through `/api/media-sets/items/<id>/content`. Code Repositories: MediaSetOutput writes follow
    the media set's policy (transactional default `replace`), `deduplicate_by_path=False` lists older versions,
    `put_dataset_files_and_get_dataframe_of_uploads`, `render_dicom_layer`.
  - Java transforms (New repository → Language template → Java; `api/code_java.py`, `api/java_api/`): Foundry's
    Transforms Java API on real Spark (local mode, from the pyspark jars) with a JDK 17. A project is any folder with
    `src/main/java`; its `PipelineDefiner` (named in `src/main/resources/META-INF/services/…PipelineDefiner`)
    registers transforms with `autoBindFromPackage` (`@Compute` methods with `@Input` / `@Output`) or
    `register(HighLevelTransform / LowLevelTransform.builder()…)`. High-level transforms take and return
    `Dataset<Row>`; low-level ones use `FoundryInput` / `FoundryOutput`: DataFrames or files
    (`ReadOnlyLogicalFileSystem`, `WriteOnlyLogicalFileSystem`, `filesAsDataset()` for Spark tasks; a Files folder is
    read as files), several outputs, and incremental builds — each input reports `APPENDED`, `UPDATED`, `NEW_VIEW` or
    `UNCHANGED`, `readForRange(UNPROCESSED / PROCESSED / ENTIRE_VIEW)`, `write(WriteMode.UPDATE)` appends,
    `IGNORE_INCREMENTAL_DELETES` and `USE_SCHEMA_MODIFICATION_TYPE`. `TransformContext` gives the Spark session and
    parameters (`repoSettings.json` → `javaParameters`, by transform key or `"*"`); `@MaxAllowedDuration("PT2H")`
    stops a job (exactly at the duration, not on a 5-minute poll). Tests in `src/test/java` run with JUnit 5 (or 4),
    AssertJ, Mockito and `SparkSessionExtension` / `SparkSessionResource`. Rows travel between Python and the JVM as
    typed JSON, so Spark never touches Hadoop file I/O. Compiles are cached in `.java/cache`.
  - Java UDFs (Language template → Map UDF Definition/Implementation): YAML definitions in
    `src/main/resources/udfs/definitions` (row map or `FLAT_MAP_UDF`; schemas with arrays, maps, structs and custom
    types; arguments) generate typed classes in `com.palantir.foundry.<name>` (Java tasks → generateUdfResources);
    you write `<Name>MapUdfFactoryImpl` / `<Name>MapUdfImpl`. Examples in `examples.registry` run as tests and show in
    Pipeline Builder. generateEddieLockfile gives each UDF its id; a tagged version whose checks pass is published,
    and Pipeline Builder imports it (Reusables → User-defined functions → Import UDF, Edit version) as a transform
    step that runs on the server in previews and builds. Not supported: async UDFs, and sharing Java code across
    repositories as Maven artifacts.
  - Keyed process UDFs (Language template → Keyed Process UDF; `type: KEYED_PROCESS_UDF` with `keyColumns`, an optional
    `eventTimeColumn` and a `stateSchema`), like Flink's KeyedProcessFunction: records are partitioned by the key
    columns, and `processElement` / `onTimer` see only their key's typed state (`getState`, `updateState`,
    `clearState`) and timers (`ctx.timerService()`: event-time timers fire when the watermark — the latest event time
    minus 1 ms, no out-of-orderness — reaches them, before the next record; processing-time timers when the clock
    does). The Java side is `KeyedRunner` (`api/java_api/.../internal`). In a streaming pipeline the state, timers and
    watermark of each UDF step (node:step) are kept in the job's checkpoint and committed with the input offsets, so
    they carry across micro-batches and restarts (a replay resets them); previews, batch builds and examples start
    empty and fire every event-time timer at the end of the input. A keyed process UDF cannot feed a streaming output
    that also has stateful transforms (deploy validation). Example: SensorWindow (per-sensor one-minute windows).
  - Microsoft Excel (doc 33, Palantir's `transforms-excel-parser`; `api/java_excel/`): Settings → Artifacts → Maven
    libraries → search `transforms-excel-parser` → Add library (adds `transforms-excel-parser-bundle` as a backing
    repository), then `compile 'com.palantir.transforms.excel-parser:transforms-excel-parser:1.155.0'` in
    `transforms-java/build.gradle` (New repository → Java · Excel parser does both). The `com.palantir.transforms.excel`
    API runs on real Apache POI 5.2.3 (so custom code can use `org.apache.poi.ss.usermodel` / `CellReference`):
    `TransformsExcelParser.of(parser)` / `builder().putKeyToParser(key, parser)` reads every file of
    `filesAsDataset()` once for all parsers; `ParseResult.singleResult()`, `dataframeForKey(key)` and `errorDataframe()`
    (file_path, parser_key, error: unopenable or non-Excel files, failed assertions, parser exceptions). `TableParser`
    (sheet selector, header extractor, `stopAtFirstEmptyRow`) with `SimpleHeaderExtractor` (`rowsToSkip`,
    `caseNormalizationOption`), `MultilayerMergedHeaderExtractor` (`topLeftCellName` / `bottomRightCellName`: merged
    multi-row headers joined with `_`) or any `HeaderExtractor` lambda; files with partially overlapping schemas are
    combined (the union of columns, as strings). `FormParser` with `FieldSpec.of(name, CellValue.builder().location(
    Location.of("B1")).addAssertions(AdjacentCellAssertion.left(1, label)))`; `RegexSubstringMatchingSheetSelector`,
    `WorkbookUtils.getValueAsString` (numbers without trailing .0, dates as ISO, formulas by their cached result,
    merged cells), `IncrementalUtils.writeAppendingIfPossible` (APPEND when only files were added, else SNAPSHOT).
    Formats: xls, xlt, xltm, xltx, xlsx, xlsm (xlsb is refused). POI's zip-bomb ratio and max byte array size are
    relaxed. The jars (POI, poi-ooxml, poi-ooxml-lite, xmlbeans, SparseBitSet, curvesapi; the rest ship with Spark) are
    fetched by `setup-java.ps1` or on first use, SHA-1 checked. The Artifacts app lists the library and its consumers.
  - Java toolchain: `.java/` (git-ignored) holds the portable JDK 17 and the JUnit / AssertJ / Mockito jars; pyspark
    is installed in `.venv` (`uv pip install --python .venv/Scripts/python.exe pyspark==3.5.7`). PySpark transforms use
    the same JDK. `setup-java.ps1` installs all of it (Temurin 17 from Adoptium, the jars from Maven Central checked
    against their SHA-1, pyspark with uv; what is already there is kept). Override the JDK with
    `BLUESANDAI_JAVA_HOME`. Builds and previews pass the per-build job token to Java transforms
    (`TransformContext.serviceDiscovery().authorizationHeader()`, or the `BLUESANDAI_API_URL` / `BLUESANDAI_API_TOKEN`
    environment variables), so they call the API as the user who started the build. Outputs go to My Project / Code Repositories / <repo>; builds on other branches go to
    `_branches/<branch>` below it.
  - Pipeline Builder transforms and expressions from docs 14 / 15 (`web/src/lib/pipeline.ts`): Decompress gzip files,
    Decompress tar files (.tar, .tar.gz, .tgz; ustar and GNU long names), Filter files (conditions on file_path,
    file_name, extension, size_bytes), Empty file, Empty media set file, Assign timestamps and watermarks (drops null
    timestamps), Compute if expression absent (a SQL expression computed once per key: builds keep the results in
    the pipeline state `stores` by store id; previews compute every row; null results or a "do not store when"
    condition are not stored), Validate value (IPv4, IPv6, uuid, rid, MIME type, Geohash, H3 index, MGRS, Ontology
    GeoPoint, GeoJSON, media reference, delegated media gid), Array elements satisfy (all / any), Combine arrays
    (concat, union, intersect, difference, cartesian product), Struct / map function (add or update struct field
    by locator, add or update map, is empty struct), Array function Contains null / Elements are distinct / Add /
    Remove / Repeat / Flatten, and the Approximate median aggregation (exact here).
  - External pipelines (New pipeline → Batch → External; Palantir's "External pipelines with Pipeline Builder"):
    compute is pushed down to the source. Each virtual table output's graph compiles into one SQL statement
    (`web/src/lib/externalSql.ts`, a WITH … SELECT chain in the Databricks or Snowflake dialect) that the API runs in
    the warehouse (`POST /api/pipeline/external/run`) as CREATE OR REPLACE TABLE … AS (snapshot) or INSERT INTO
    (append); no rows pass through this server. Build settings → Default compute profile: Databricks serverless (the
    source's SQL warehouse) or a classic cluster id, a Snowflake warehouse (USE WAREHOUSE). What compiles: virtual
    table inputs of the source, joins (inner, left, right, outer, semi, anti, cross; null-safe keys, column
    selection, prefixes), splits, and Select, Drop, Rename, Filter (every condition), Drop duplicates, Sort + Limit,
    Aggregate (group by, rollup, cube; per-aggregation filters), Cast (date formats on Databricks), Add constant
    column, Uppercase / Lowercase / Change case, Trim, Coalesce, Concatenate strings, Arithmetic, Fill nulls, Find and
    replace, Null if, Greatest / least, Substring, String length, Pad, Find position, Regex extract, Conditional
    column, Unpivot, Window function (ranking, ntile, lag / lead, first / last value, sum / mean / count / min / max
    over row frames), Explode into rows (text with a separator), Hash columns and SQL query steps. Anything else
    fails deploy validation with the step and why (pivot: its columns come from the data; incremental inputs, LLMs,
    media, union, UDFs and geospatial as in the doc). Expectations run in the warehouse before the write — one
    SELECT of counts over the output's query (`POST /api/pipeline/external/check`) — and a failing check in abort
    mode stops it; previews still read the tables here.
  - External transforms (doc 02; `transforms.external.systems`, `api/code_repos.py` external endpoints): a Python
    transform decorated with `@external_systems(api=Source("<source rid or API name>"))` receives the source:
    `get_https_connection().url`, `.get_client()` (a requests Session whose calls go through `/api/code-repos/<repo>/
    external/request`: limited to the source's domains, the domain's credentials added there, egress / private link /
    agent proxy policies applied) and `get_secret(name)`. The source must allow imports into code and be added in
    the repository's Settings → External systems; a transform that reads Foundry inputs may only use a source whose
    export controls allow it (Webhooks → source, administrators).
  - Data Connection agents (Data Connection → Agents; `api/dc_agents.py`, `api/bluesandai_agent.py`): an agent is a
    Project resource (`.agent`) with a token shown once; the downloadable agent (`pip install websockets`; `python
    bluesandai_agent.py --url … --token …`, optional `--allow host[:port]` and `--resolve host=ip`) keeps one outbound
    WebSocket to `/api/dc-agents/connect`, reconnects with backoff and sends heartbeats (host, OS, version). An
    egress policy of kind Agent proxy (Network tab) names a host, its ports and the agent: the host resolves to a
    loopback address here (127.77.x.y, like a private link's routing) whose listeners relay each TCP connection
    through the agent, which opens host:port in its network — database drivers, HTTP sources and webhooks alike, TLS
    end to end. Rotating the token disconnects the running agent.
  - Audit Risiko JKN (demo) (`/demo-jkn`, Platform Apps; `api/demo_jkn.py`, `api/demo_jkn_rules.py`): a transparent
    hospital financial audit case. "Buat demo" creates the project "Demo Audit JKN (test)" with fictitious records of
    RSUD Contoh Sejahtera, a private hospital, a specialist clinic and three FKTP (SEP / INA-CBG claims, referrals,
    attendance, bed and procedure logs, prescriptions and dispensing, e-catalogue prices, lab results with their edit
    log, capitation funds and spending, non-capitation claims) and the Python transforms repository "Deteksi Risiko JKN
    - demo": one screening rule per category of BPJS Kesehatan's 20 "Efisiensi Risiko pada Fasilitas Kesehatan" risks
    (capitation misuse, upcoding, cloning, phantom billing, inflated bills, episode splitting, unbundling,
    self-referral, repeat billing, prolonged stay, room charge, procedures not done, treatment without indication,
    readmission, fictitious and reduced drugs, edited lab results…), each writing its findings dataset, unioned into
    temuan_semua, built once so lineage and build history trace every finding to its records. The page shows the count
    and estimated amount at risk per category and every finding with its reason. Planted cases: exactly one or two per
    category, found with no false positives (24 findings).
  - Software Defined Data Integration [Sunset] (HyperAuto V1, `/sddi`, Platform Apps; `api/sddi.py`,
    `api/sddi_template.py`): an SDDI instance ties a database connection (catalog comments, primary and foreign
    keys) to an automatic pipeline generator Code Repository (`transforms-bellhop/src/config/SourceConfig.yaml` and
    `PipelineConfig.yaml`; `pipeline_builder.py` generates the transforms when the repository loads) and raw /
    metadata / output folders. Cockpit: Sync data (search, columns with keys, relations, preview, a shopping cart
    with snapshot / incremental and table types; writes dd_tables / dd_columns / dd_relations, creates or reuses a
    sync per table, copies its view into raw, opens a PR adding the tables), Pipeline generation (display names,
    OBJECT / METADATA / CUSTOMIZATION, dedup comparison columns, change mode deletes, batch union components, cleaning
    libraries incl. custom ones in `function_libraries.py`, the three disable switches — proposed as a PR, merge, then
    a build in stage order: objects / fields / links / diffs → cleaned → enriched → final (sourceName-prefixed
    primary and foreign keys) → renamed "displayName (TABLE)" → BUILD), Ontology changes (object types backed by the
    renamed datasets, foreign-key link types, created in bulk), Migration (a HyperAuto V2 pipeline from the V1
    configuration with what V2 drops listed; Sever turns the repository into a regular one and stops the PRs).
  - Logic Flows [Sunset] (`/logic-flows`, Platform Apps; `api/logic_flows.py`): connected flows — instances of an
    automation with parameters and a JSON configuration, created in a Project (a `.logicflow` Files item), validated
    on create (Validate), not editable (archive and create another), run with Build or on a schedule (cron + time
    zone, as the user who set it; through the Project's resource queue), with run history and logs. Automation:
    Compass Files Lister — the RIDs of an input folder's resources written to `<generated_file_path>/rids.json`
    (default `compass-lister`) in an output code repository through a pull request on a new branch; with
    `merge_when_ready` it is merged once the repository allows it (checks run first). An unchanged listing opens no PR.
  - Pipeline Builder schedules (pipeline → Schedules panel; `api/pipeline_schedules.py`): a trigger is a tree of AND / OR
    conditions over events — at times (cron + time zone), data updated (any or chosen inputs), logic updated, a job
    succeeded (a pipeline's build, optionally of one output) and another schedule ran. An event latches until the
    schedule runs, so an AND fires once all its conditions happened since the last run. A run builds the target
    outputs minus the excluded ones, once per parallel run setup (parameter values over the schedule's; a setup writes
    "name [setup]" outputs with their own state). Outputs with no input-version or logic change since their last
    successful build are skipped unless Force build is on; every build records its logic version and hash, input
    versions and output signatures. Failed builds are retried (count + delay) and a schedule pauses after N failed runs
    in a row until resumed. Run now builds with the schedule's own configuration. History: runs (started, skipped,
    ignored — paused or previous run still in progress — with the reason and builds) and versions (each saved
    definition, recorded by the API, with the fields that changed). Inputs and outputs in the trash show as warnings.
    Build scope and permissions (schedule → Build tab): Project scope (the default) builds only outputs written inside
    the chosen Projects (none chosen: the pipeline's own), whoever edited the schedule; user scope runs as the
    schedule's owner — the last user to create or change it, kept by the API (pausing does not change it) — and builds
    only the outputs they may build. A user-scoped run does not start ("Did not start" in the history) when the owner is
    deactivated, lost Editor on the pipeline or cannot read an input; outputs left out by the scope are listed on the
    run. Adding, changing, pausing, running or deleting a schedule needs Editor on the pipeline, on the Projects it is
    scoped to and on its targets' Projects. Code repository schedules are user-scoped the same way (their builds' job
    token is the owner's).
  - Build Schedules (`/schedules`): every pipeline schedule, searchable and filtered (enabled, disabled, paused,
    failing, warnings, by owner, by scoped Project), with scope and owner, trigger, conditions already met, last and
    next run; turn on / off, run now, resume, history.
  - Health checks (`api/health_checks.py`): dataset checks — freshness, time since last updated (optionally ignoring
    empty transactions), row count, required columns, schema (allow additions or exact match, with types), last build
    status, up to date with inputs — and schedule checks (status: last run failed or paused; duration). Lineage's
    per-dataset rules are checked every two minutes in the background (Data Health → Dataset checks). Monitoring views
    hold dataset checks, schedule checks and stream monitors together and alert through the view's subscriptions;
    a monitor can turn auto-resolve off so its alert stays open until resolved by hand.
    Data freshness checks the newest value of a timestamp column (Timestamp, Date, ISO text or epoch) instead of when
    the dataset was written. Sync checks watch Data Connection syncs and exports: sync status (last run failed) and
    sync freshness (a sync with no successful run within N hours; an export whose dataset changed more than N hours
    ago without being exported). Data Connection (Monitor on a sync or export) and Lineage (Health tab → Alerts in
    Data Health) open Data Health with the check pre-filled.
  - Notification frequency: each subscription sends alerts immediately or as an hourly or daily digest (at an hour in
    a time zone), one email or webhook call with every alert in between; it can skip resolve notifications.
    PagerDuty is always immediate. A digest's waiting alerts can be sent now.
  - Expectations: output expectations and input pre-conditions (source node → Pre-conditions…) either abort the
    build or only warn. Results of recent builds are listed in Data Health → Expectations.
  - Builds (`/builds`, `api/pipeline_builds.py`): every build and streaming job across pipelines, filtered by status,
    pipeline, trigger (manual, schedule, retry, auto-restart, rerun), batch / streaming, branch and time range. A build's
    page compares it with the last successful build (input versions, logic hash with the nodes that changed, parameters,
    row counts per output, durations), downloads its logs as text, reruns it (optionally with an earlier saved logic
    version) and, when it failed, has AI explain the error (Code Repositories' AIP Assist error mode, given the failing
    nodes, errors and logs).
  - Managed compute profile (Build settings): each batch build's allocation follows the last five successful builds —
    five under a minute scale down one step, a build over ten minutes returns to the selected profile, never above
    it (`managedProfile` in `web/src/lib/compute.ts`; the build log says what it chose and why).
  - Proposals: Merge records the branch's versions it brought in; Squash and merge records one version with a summary
    and folds the branch's versions since it was created into it.
  - Resource queues (Resource Management → Resource queues; `api/resource_queues.py`): a queue bundles Projects
    under a vCPU limit (Projects in no queue use the Default queue, 32 vCPUs). Pipeline Builder batch jobs (their
    compute profile's driver + minimum executors), Code Repositories builds (their cpu_cores, default 2) and SQL
    rebuilds ask their Project's queue first and wait — first come, first served — until it has room ("waiting in
    the Project's resource queue" in the build logs); a job bigger than the limit starts when the queue is empty.
    Leases are kept alive while a job runs and expire after 5 minutes without a heartbeat. Administrators create,
    edit and delete queues; the tab shows the vCPUs in use and the running and waiting jobs.
  - Resource Management (`/resource-management`, `api/resource_usage.py`): estimated compute-seconds by pipeline,
    output stream and sync (streaming and data source syncs), per day. Every container counts max(vCPU, GiB / 7.5) × 0.5
    per second: streaming jobs by their streaming profile, batch jobs by driver + minimum executors of the profile they
    ran on, syncs one vCPU per consumer. Builds run on this server's engine, so these are allocations, not measured CPU.
  - Lineage → Node color → Resolved schedule: pick a schedule to colour the inputs it reads, the pipeline (job), the
    intermediate outputs it builds on the way, its target outputs and the outputs it excludes.
  - Dataset Preview (doc 18; `/datasets`, Platform Apps → Dataset Preview; `api/dataset_preview.py`, `api/dataset_reader.py`,
    `web/src/components/dataset/`): one page per dataset — a built Parquet file, a CSV / TSV / JSON file, or a folder of
    them (a raw dataset: Files → New → Dataset, or Dataset Preview → New dataset). Header: path, branch switcher,
    Upload files, Build, All actions (Files, Data Lineage, Pipeline Builder, Input(...) for Code Repositories, Data
    Health, downloads incl. "CSV for Excel" with `;` and a UTF-8 BOM — the FAQ's squeezed columns — Edit schema, Report
    an issue). Information panel: About (created / updated and by what, size, built by, inputs, used by, custom
    metadata), Columns (type, null %, distinct, most common values, min / max / mean, issues), Issues, Schedules. Tabs:
    Preview (sample whose size the header gives; sort, filter, chart and report an issue from a column menu, exclude /
    keep only a cell's value, search columns; filters and sorting run over the whole dataset), History (transactions and
    jobs with a summary; Create branch from a transaction — a copy under `_branches/<branch>/`; raw datasets branch too,
    their files and schema copied, from the header's + button), Details (schema JSON,
    files, job spec, syncs, custom metadata, resource usage per transaction), Health (Data Lineage / Data Health
    checks and their results, schedules), Compare (an older transaction, a branch or another dataset; with a key column
    rows are matched and modified cells shown), Time Travel [Beta] (committed versions as a timeline, ← / →; Single
    version with Refine query — SQL over `dataset` that follows the version; Range: added / removed / modified rows and
    schema changes; Bisect: when a row was added or removed or a cell changed, also from a cell's right-click menu).
    Issues have an assignee and watchers (reporting or commenting watches): the assignee and watchers get an inbox
    notification (and an email when email is set up) when an issue is reported, assigned, commented on, resolved or
    reopened. A dataset over 512 MB is previewed from its first 200,000 rows (Parquet, read from a local copy) or its
    first files / bytes (raw) and flagged "Partial preview"; the full download then points to Files.
    Raw datasets: drag and drop .csv, .tsv, .xls, .xlsm or .xlsx (workbooks become CSV): a new name appends, the same
    name with the same header updates that file; the first upload infers the schema, later ones must parse with it.
    Every upload and schema change records a transaction with the parsed rows. CSV parsing (doc "CSV parsing"): the
    schema's `dataFrameReaderClass` — TextDataFrameReader (`textParserParams`: parser CSV / MULTILINE_CSV / SIMPLE /
    SINGLE_COLUMN, nullValues, fieldDelimiter, recordDelimiter, quoteCharacter, dateFormat as JodaTime patterns,
    skipLines, jaggedRowBehavior, parseErrorBehavior, charsetName, addFilePath(InsteadOfUri), addImportedAt,
    addByteOffset, addRowNumber), DataSourceDataFrameReader (`format` csv with Spark options header, sep, quote, escape,
    multiLine, mode PERMISSIVE / DROPMALFORMED / FAILFAST, nullValue, encoding, …; json; parquet with mergeSchema) or
    ParquetDataFrameReader. Edit schema shows parsing options, columns and types next to a live preview; Save and
    validate refuses a schema rows fail with ("Your dataset failed to validate on N rows"), Save without validating
    keeps it. Data Lineage's dataset nodes open in Dataset Preview. Streaming datasets (`api/stream_datasets.py`): a
    stream archived into a dataset (Streaming → stream → Details → Dataset archive: a Project and an interval; each
    archive with new records is an APPEND transaction) opens with Live (the stream's records, updating) and Archive
    views, a Stream tab (the syncs that write it with their status history over a time period, or the pipeline) and a
    Metrics tab (records ingested, records per checkpoint, lag, checkpoints and failures, checkpoint duration,
    utilization, dropped records; recommended debugging metrics, thresholds, expand) with Troubleshoot and Debug
    mode (step-by-step checks that highlight their chart); Health shows in the Archive view only.
  - Iceberg tables (doc 11; `/iceberg`, Platform Apps → Iceberg Tables; `api/iceberg_catalog.py`, `api/iceberg_rest.py`,
    `api/iceberg_tables.py`, `api/iceberg_maintenance.py`, `api/iceberg_write.py`, `api/code_tables.py`,
    `web/src/components/dataset/iceberg/`): managed Apache Iceberg tables. A table is a Files item (content type
    `application/vnd.apache.iceberg+json`, RID `ri.tables.main.table.<id>`) whose metadata and data files live at its
    storage location (Foundry-managed `data/iceberg/warehouse/<id>`, or a bring-your-own-bucket location). Foundry's
    Iceberg REST catalog is `/api/iceberg` (PyIceberg `uri`, Spark `type rest`): namespaces are Files paths
    (`Project.Folder`), tables are also named by RID or a back-ticked Files path; API tokens or OAuth2 client
    credentials (`/api/iceberg/v1/oauth/tokens`, applications in the Iceberg app, scopes `api:iceberg-read` /
    `api:iceberg-write`); `X-PLTR-Branch` scopes reads and writes to a branch with Foundry's branch isolation (the
    branch's schema, partition spec and sort order in `foundry.branch.*` properties, main untouched; drop / rename /
    multi-table commits / views refused on branches); `X-Iceberg-Access-Delegation: vended-credentials` returns a BYOB
    location's FileIO credentials when it allows vending. Foundry's rules: default properties (30-day snapshot age, one
    previous metadata version, object storage paths), properties users cannot edit (foundry.*, encryption.*, write
    paths), format version 2 (3 with client-side encryption; v2 → v3 upgrades, no downgrade), unsupported column types
    refused (time, nanosecond timestamps, geography / geometry, variant, unknown). Builds are all-or-nothing: a job's
    commits are staged (it sees its own writes) and swapped in together on success; its inputs are pinned when first
    read; a table another writer (a compaction) changed meanwhile fails the commit and the build is retried once.
    Snapshots record the writer (`foundry.user`), the job and the markings of its inputs (`foundry.markings`): a
    table inherits the markings of every retained snapshot until it expires (Stop propagating per marking).
    Virtual tables (`api/virtual_tables.py`, POST /api/virtual-tables): Files items naming a table in a source —
    SnowflakeTable, BigQueryTable, DatabricksTable, IcebergTable (an Iceberg REST catalog connection), FilesTable (a
    folder in S3 or a filesystem source; parquet / csv / jsonl), DeltaTable (Delta Lake through deltalake in an S3 or
    filesystem source: each build commits a new table version) — with
    `ri.tables.main.table.<id>` RIDs. In Python transforms (Foundry-native compute) a TableInput on a virtual table is
    read through its source before the run (`.dataframe(options=...)` on Spark, JDBC partition options repartition
    it; `.pandas()` / `.polars()` / `.arrow()` on a single node); `TableOutput(path, source, Locator(...))` registers
    the virtual table on the first build (its source and location are then fixed: changing them fails the build) and
    what the transform writes replaces the external table after the build (DROP + CREATE + INSERT in a transaction on
    SQL warehouses, an overwrite with schema evolution in an Iceberg catalog, a part file for FilesTable); Data
    Connection → Virtual tables lists them and registers a source's table. Compute
    pushdown (`@transform.snowflake/databricks/bigquery.using`) is not available. Python
    transforms (`transforms.tables`): `TableInput(path or rid)` / `TableOutput(path)` in `@transform.using`
    (IcebergInput / IcebergOutput: `.polars()`, `.pandas()`, `.arrow(row_filter)`, `.table()` the PyIceberg table for
    upserts / deletes / overwrites, `.current_snapshot_id` / `.previous_snapshot_id`, `write_table` — one overwrite
    snapshot, or an append on incremental runs) and `@transform.spark.using` / `@transform` (TableTransformInput /
    Output on the Iceberg Spark runtime 1.9.2 against the catalog: `.dataframe()`, `write_dataframe` — a table
    replace, `.identifier` / `.catalog` for MERGE INTO, UPDATE, DELETE, ALTER TABLE, `CALL system.*`,
    `<identifier>.snapshots`, DataFrameWriterV2). `@incremental(v2_semantics=True).with_table_incremental_options(
    table_read_mode="append_only" | "changelog")`: the snapshots after the one the last build read; append-only falls
    back (or fails with require_incremental) on an overwrite or delete; changelog (Spark) gives `source.changelog([ids])`
    (identifier changelog: INSERT / DELETE / UPDATE_BEFORE / UPDATE_AFTER collapsed across the range; no ids: net
    changes) and `output.apply_changelog(df, keys)` (a MERGE INTO, with the duplicate-key errors of the docs); merge-on-
    read delete files fail changelog scans. Dataset Preview for a table: branch switcher, Preview (row filter, at any
    snapshot), Snapshots (trends of total size / records / files / schema version, every snapshot with type, Foundry
    transaction, totals and deltas, schema version dialog with its changes, attribution, roll back main), History,
    Branches and tags, Details (identifiers, location, storage, partitioning, producer, properties editor, the
    metadata JSON, main branch protection — changes outside the owning job need Owner — and markings), Maintenance
    (tasks: Rewrite data files = compaction as a replace snapshot, Rewrite manifests, Expire snapshots with minimum
    count / age per branch, Remove orphan files outside the disaster recovery window, Custom SQL — CALL procedures,
    ALTER TABLE, INSERT / UPDATE / DELETE through DuckDB and Iceberg row filters; cron schedules; jobs with results;
    permissions mapped to Viewer / Editor / Owner; Foundry's daily orphan sweep). Pipeline Builder reads Iceberg
    tables as inputs (rows in append order, so incremental inputs see appends) and writes a "Foundry Iceberg table"
    output (snapshot → one overwrite snapshot, Always append → an append snapshot, the keyed modes). Data Connection
    syncs into Iceberg (Iceberg app → Data Connection syncs: PostgreSQL, SQL Server, Oracle, Snowflake, JDBC; overwrite
    / append / update by primary key as one overwrite snapshot of the affected files; optional cursor column; a
    changed source schema fails the sync). Control Panel → Iceberg table settings (administrators): Enable Foundry
    Iceberg, storage buckets (S3 / ABFS / GCS / a server directory, FileIO properties, encrypted credentials, access
    delegation), Allow writing Iceberg tables by default to all projects, default storage, client-side encryption,
    disaster recovery lookback, project / namespace overrides (new tables only). Resource Management reports Iceberg
    storage (live files of main's latest snapshot, Foundry-managed storage) and maintenance / sync compute. The
    Iceberg app also has copyable client setups (PyIceberg token / OAuth2, local notebook, Spark, X-PLTR-Branch, a
    connectivity check, Snowflake catalog integration SQL). Gaps are listed in docs/REMAINING.md section 9.
  - Data Lineage (`/lineage`, `api/lineage.py`): one graph derived on request from data sources, pipelines (inputs and
    deployed outputs; deploys are also logged in `data/lineage/deploys.json`), code builds (every output of a
    multi-output Java or Python transform: datasets, file outputs, media sets, and outputs the latest build aborted,
    which keep their edge), object types and the apps on them. Build a graph by search and expand (hidden parents / children counts on each node), multi-select
    with a histogram (types, frequent columns, folders), Find by name or column, node colouring (type, out-of-date,
    build status, time last built, project, row count, schedules, data health, custom). Bottom tabs: Preview, History
    (dataset transactions with rollback: `api/dataset_versions.py` keeps the last 20 writes of every pipeline deploy
    and code build in `data/lineage/versions/`), Code, Build timeline, Data health (monitoring rules in
    `data/lineage/health.json`). Side panels: Properties, Build (selected / out-of-date ancestors / in between, run in
    dependency order), Schedules, Related items. Saved graphs, share links, SVG export. Pipeline Builder opens it
    from the header and node / output menus.
  - Data Connection connectors (`/sources`, `api/datasources.py`, `api/connectors/`): the New data source picker
    lists Foundry's connector catalog (`api/connectors/catalog.json`, generated from Palantir's "Available connectors"
    docs) next to the built-in databases, grouped and searchable. Each connector shows its capabilities (Exploration,
    Batch syncs, Incremental, Table exports, OAuth, Media sets, …) with their Foundry status (GA / Beta), green where this
    server supports them; the info button opens its configuration properties, network domains and docs link.
    Implemented from the catalog: AlloyDB (PostgreSQL protocol), Azure Synapse (SQL Server protocol), Amazon S3 and the
    agent-level filesystem (`files_conn.py`: CSV, TSV, Parquet, JSON and JSON Lines files, or a folder of them as one
    table; `_file_modified` is the incremental cursor, so syncs read only changed files), Amazon DynamoDB, Apache
    CouchDB and Airtable (`records.py`: record APIs with inferred or declared columns). The filesystem source reads
    only below `BLUESANDAI_FILESYSTEM_ROOTS` (default `data/filesystem`) and skips symbolic links.
    Egress policies (`api/network.py`) are checked on every request a connector makes, not only against the
    configured host: connector methods (and the batches their generators yield) run in an egress scope, and each host
    resolved inside it (OAuth token endpoints, instance URLs from a sign-in, redirects, pre-signed storage URLs) must be
    allowed by a policy when enforcement is on. Drivers that resolve names in C (libpq) get the main host check only.
    Every other catalog connector is implemented from its vendor's API docs (forms in `catalog_specs.py`):
    - SaaS apps on a declarative REST base (`rest.py`: auth schemes, paging, retries, "modified since" pushdown) in
      `apps.py`: Act! CRM, Act-On, ActiveCampaign, Adobe Analytics, Adobe Commerce, ADP (mutual TLS), Asana,
      Authorize.Net, Avalara, Azure AD (Microsoft Graph), Azure Data Catalog, Azure DevOps, Basecamp, BigCommerce,
      Blackbaud SKY, Bugzilla, SAP Ariba, SAP Concur, SAP Fieldglass and SAP BusinessObjects BI.
    - Iceberg REST catalog (`iceberg_conn.py`, virtual Iceberg tables): an external catalog (Polaris, Snowflake Open
      Catalog / Horizon, Unity Catalog, AWS Glue with SigV4, Nessie, another platform) through PyIceberg; namespaces
      are schemas, tables stay in the external storage (vended or configured credentials); previews, syncs with the
      cursor range pushed down as an Iceberg row filter, and Pipeline Builder virtual-table reads.
    - OData v2 / v4 (`odata.py`: tables and types from `$metadata`): SAP ERP (Gateway, with the service catalog), SAP
      SLT (ODP services), SAP custom sources, SAP Business One Service Layer, SAP ByDesign, SAP Cloud for Customer, SAP
      SuccessFactors and Acumatica.
    - Oracle NetSuite (`netsuite.py`): SuiteQL and SuiteTalk REST with token-based auth (OAuth 1.0 HMAC-SHA256) or
      OAuth 2.0; SuiteAnalytics Connect over ODBC (needs pyodbc and NetSuite's ODBC driver).
    - Databases (`dbs.py`): Apache Hive (PyHive), Apache Phoenix (phoenixdb — `pip install --no-deps phoenixdb
      requests protobuf` unless SPNEGO is used), SAP HANA / XSA (hdbcli), Apache HBase (REST server), Azure Cosmos DB
      and Azure Table Storage (REST with master key / Shared Key Lite).
    - CRMs (`crm.py`, not in the catalog file): Salesforce (REST API: queryable sObjects read with SOQL, columns from
      describe, SystemModstamp pushdown; OAuth sign-in against the My Domain URL or a connected app's client
      credentials) and HubSpot (CRM API v3: standard and custom objects, properties as columns; private app token or
      OAuth sign-in).
    Table exports into applications (`exports.py`, Exports tab): Salesforce (sObject Collections, 200 records per
    request, allOrNone; upsert by an external ID field), HubSpot (batch create / upsert by a unique property, 100 per
    request), Airtable (10 per request with typecast; upsert with fieldsToMergeOn), ActiveCampaign (contacts upsert
    by email through contact/sync), Act! CRM and Adobe Commerce (products upsert by SKU) create records through their
    write APIs (`Write` on a REST table). Only the full and incremental modes apply (an application cannot be
    truncated); an optional key field makes each row create or update its record. A run is not one transaction:
    records written before a failure stay written and incremental runs continue after them. Columns must be fields a
    record can set (case-insensitive match); read-only and computed fields are refused when the export is created.
    OAuth 2.0 sign-in (`connector_oauth.py`, authorization code + PKCE): connectors whose docs use it (Airtable, Asana,
    Basecamp, Blackbaud, NetSuite, SAP Concur) show a Sign in button; register the shown redirect URL
    (`/api/datasources/oauth/callback`, or `BLUESANDAI_OAUTH_REDIRECT_URL`) with the provider. Tokens stay on the server.
    SAP (`connectors/sap.py`, `sap_tools.py`, following Palantir's SAP connector docs): SAP ERP / SLT / custom sources
    read OData services and add per-entity-set sync filters with the dynamic keywords ([TODAY], [ADDDAY(d,n)], …),
    masking / hashing / hiding of sensitive fields, the /PALANTIR/TIMESTAMP and /PALANTIR/ROWNO columns, and named-user
    sign-in through SAP's OAuth 2.0 server (/sap/bc/sec/oauth2, SOAUTH2). With the Palantir Foundry Connector 2.0 for
    SAP Applications installed, only its publicly documented endpoints are used: resource check, function metadata,
    BAPI write-back (one call, or one per dataset row through parallel_writeback), function modules as tables and SAP
    DMS documents copied into Files (Connections tab → SAP tools; write-back needs exports enabled). HANA information
    views are read from _SYS_BIC.
    Media sets and file exports (`file_transfers.py`, Connections tab of S3 / filesystem connections): copy new or
    changed documents, images, audio and video into Files (My Project / Data Source / Media), and write a dataset to
    the source as Parquet, CSV or JSON Lines. Table exports also go to Act-On (contacts added
    to a list; with the e-mail as key they upsert), ADP (an `event: …` table per supported worker event: each row
    `associateOID` + new value is POSTed to /events/hr/v1/<event>) and Acumatica (the "Contract-based REST API"
    database lists the connection's Export entities; rows are PUT as `{field: {"value": …}}` after signing in at
    /entity/auth/login). Not done: SAP streaming syncs and webhooks (BAPI write-back).
    Delta syncs without the Palantir add-on: an incremental source can use "Delta token" instead of a cursor column
    on OData entity sets that track changes — SAP ODP services (extractors exposed with RODPS_OS_EXPOSE, CDS views
    with change data capture, SLT; `sap:change-tracking="true"` or a DeltaLinksOf<set> set) and OData v4 services.
    The first run is the initial load (`Prefer: odata.track-changes`, a SNAPSHOT), the returned delta link
    (`__delta` / `@odata.deltaLink`) is kept, later runs APPEND only the changes (ODQ_CHANGEMODE / ODQ_ENTITYCNTR
    kept as columns); re-sync starts a new initial load.
- Streaming (`/streaming`, `api/streaming.py`, `api/streaming_sources.py`, following Palantir's streaming resource
  guide; separate from the Node-RED-style device streams and its own SQLite store `data/streaming/`):
  - Ingest streams with push-based ingestion: POST JSON records to the stream proxy URL
    (`/api/streaming/stream-proxy/streams/{id}/views/{view}/jsonRecords`, Bearer stream token). Reset stream (Details)
    clears the records by starting a new view, optionally with a new schema, throughput or configuration.
  - Streaming syncs (Streaming app, or Data Connection → Streaming syncs): Kafka (confluent-kafka), Kinesis and
    SQS / SNS (boto3), Google Pub/Sub (REST pull), AVEVA PI Web API, MQTT (paho-mqtt: ActiveMQ, Solace, IBM MQ,
    RabbitMQ), RabbitMQ AMQP (pika) and IBM MQ (pymqi, optional). Each is a job that polls, writes, then checkpoints
    its position (offsets, sequence numbers, acks); stopped syncs resume from the checkpoint.
  - Streaming profiles (Control Panel → Streaming profiles): Default, High throughput, Large records, Large state and
    the restricted Extra large; profiles combine (largest value wins) and Advanced overrides single settings. A Project
    must reference a profile; restricted ones are imported only in Control Panel, and removing a reference stops jobs.
  - Stream monitoring (Data Health → Monitoring views): records ingested, checkpoint liveness / duration / failures,
    lag, throughput and utilization over 5 or 30 minutes; alerts to email (sent with Resend, see Sign-in below, or
    SMTP), PagerDuty (Events API v2 integration key) or a webhook.
  - Pipeline Builder: a Streaming pipeline can read an ingest stream (Add data → Add a stream → Ingest streams) and
    picks streaming profiles in Build settings → Streaming. Each output is written to an output ingest stream with the
    keys the pipeline propagates (Key by; a running aggregate grouped by the CDC key columns keeps them as its primary
    key, so the output's current view holds the latest aggregate per group). A streaming job that loses its runner or
    the API is restarted from its checkpoint, and the old runner stops once the API marks its build failed.
  - Streaming compute usage (build page): compute-seconds = job manager max(vCPU, GiB / 7.5) × 0.5 × seconds + task
    managers max(vCPU, GiB / 7.5) × 0.5 × seconds × (parallelism + 1), from the streaming compute profile
    (`web/src/lib/compute.ts`; every job and task manager is counted as 1 vCPU).
  - Output monitors (Data Health → Monitoring views; `api/timeseries.py`): a time series sync output writes its
    (series id, timestamp, value) points into the Time Series DB (`data/timeseries/`), and a geotemporal series sync
    sends its observations (series id, timestamp, latitude, longitude, properties; rows without a valid position go to
    the sync's errors) — on every batch build (a snapshot replaces the points) and every streaming micro-batch. Monitor
    them with **Points written to Time Series DB** (resource type Time series sync) and **Geotemporal observations sent**
    (resource type Geotemporal observations) over 5 or 30 minutes, at or below a threshold; the monitor row shows the
    per-minute metrics. Each sync keeps up to `BLUESANDAI_TS_MAX_POINTS` (default 1,000,000) points.
  - Time Series Catalog (`/time-series`): time series and geotemporal series syncs with their series, a chart per
    series (bucketed min / avg / max for long ranges), points written per minute and rejected rows; "Monitor" opens Add
    monitoring rules in Data Health. Map (`/map`): lists the maps (your geotemporal series syncs, then the built-in
    demos) with **New map** (pick a pipeline to add a geotemporal series sync output to); a map shows the sync as tracks on a real-world basemap
    (Streets: OpenStreetMap, Satellite: Esri World Imagery, Dark: CARTO; free tiles, no API key, loaded by the browser),
    with a time slider, per-series toggles and properties of each observation (streaming syncs refresh every 10 s).
  - Geospatial and geotemporal (doc 31; `api/geo.py`, `api/geospatial.py`, `api/code_geo.py`, `web/src/components/map/`):
    - Ontology property types (Ontology Manager → Properties): **Geopoint** (`latitude,longitude` in WGS 84, or a
      geohash, stored as the bottom-left corner of its rectangle), **Geoshape** (a GeoJSON geometry per RFC 7946: not a
      Feature / FeatureCollection / GeometryCollection, WGS 84, closed polygons with counter-clockwise exterior rings and
      no self-intersection; the error says which rule failed) and **Geotemporal series reference** (GTSR: a series ID of
      the geotemporal series sync chosen on the property; at most one per object type, never an array). Objects with
      geopoint / geoshape properties are indexed for geospatial search; a GTSR object is drawn at its latest observation
      (live position and live properties) and its track. Objects show "Show on map" and can be dragged onto a map.
    - Map (`/map`, Platform Apps → Map): saved maps of layers (`data/geo/maps/`, autosaved with their view and basemap),
      next to the geotemporal series syncs and the built-in demos. Data sources (Gaia's left panel): object types →
      Search for objects with the geometric filters All / View / Draw (polygon or circle) / Select (a shape on the map),
      a static range or rolling window over a timestamp / date property, keyword and property filters, live update every
      30 s, at most 5,000 objects; geotemporal series syncs → Tracks and observations search (historic range or live
      feed, refreshed every 10 s, by area); curated sources (below); GeoTIFF / GeoJP2 rasters from Files or an object
      type's media property (≤ 67 MB, warped server-side to Web Mercator with pyproj so they line up); boundaries
      (choropleth): a GeoJSON FeatureCollection in Files — e.g. Mapbox Boundaries exported with `mapbox_id` — coloured
      by count / sum / avg / min / max of an object type's objects joined on a region id; Add objects (with a duplicate
      check: include or exclude objects already on the map); external tile servers (an XYZ URL template drawn above the
      basemap) and feature services (ArcGIS FeatureServer / MapServer layers, OGC API Features collections, GeoJSON URLs,
      read through `POST /api/geo/feature-service` under the egress policies, up to 2,000 features, filtered by a view
      bbox on the server when given). Selecting a GTSR object or a track opens its observation
      log (rolling window, live properties, Zoom to). A shared time slider scrubs tracks.
    - Curated data sources (`/map/admin`, administrators; Gaia's admin application): Enterprise Map Layers backed by an
      AIP Logic function (no required inputs; its output — primary keys or objects — is the layer) or a versioned object
      set (an object type with saved filters), with refresh interval, geo filter property, classification and ACL groups;
      geo searches (title, Tab ID / Template ID, ACL groups) with search templates in YAML (`templates:` with AND / OR /
      NOT, KEYWORD, OBJECT_TYPE, EXACT / CONTAINS / RANGE subqueries and TEXTFIELD / NUMBER / DATE / SELECT inputs).
    - API (`/api/geo`): `validate` and `clean` (geospatial-tools' clean_geometry as a service), `crs` and `reproject`
      (any CRS pyproj knows), `sources`, `objects/search`, `objects/{type}/{pk}/track`, `tracks/search`, `maps`, `emls`,
      `search-templates`, `geo-searches`, `raster/{item}` (+ `/image`), `choropleth`.
    - Pipeline Builder (Geospatial): besides GeoJSON / KML / shapefile parsing, points, distance, geohash, point in
      polygon and bounding box — **Convert coordinate reference system** (geometry or x / y columns between WGS 84 and
      datums within a metre of it, Web Mercator, World Mercator and every UTM zone on WGS 84 / NAD83; checked against
      pyproj), **Geometry area** / **Geometry length** (spherical, m² / m), **Validate geoshape** (optionally fixing
      winding order) and **Create geotemporal series reference** (series ID + the deployed sync's RID, for a GTSR
      property).
    - Python transforms: the legacy `geospatial-tools` library (`api/code_geo.py`) on real PySpark — `@geospatial()`
      (makes the transform a Spark transform; the GEOSPARK profile is accepted), `geospatial_tools.functions`
      (clean_geometry, lat_long_to_geometry, geohash ↔ GeoJSON, buffer, convex_hull, bounding_box / circle, simplify,
      start / end point, centroid, intersection, difference, symmetric_difference, union, distance, length, area,
      contains, intersects, agg_union / agg_intersection / agg_bounding_box, subdivide_explode), `DataFrame.spatial_join`
      / `distance_join` / `knn_join` (grid-cell index, `resolution` like H3's, `library="sedona"` accepted),
      `geospatial_tools.spatial_joins.geopandas_spatial_join` (pandas + shapely STRtree) and
      `geospatial_tools.parsers` (GeoJSON, shapefile with .dbf / .prj reprojection, KML, KMZ). Code Repositories →
      New file from template → Geospatial (legacy). Raster files are read in transforms with Pillow (Rasterio is not
      installed).
  - Demo (`api/timeseries_demo.py`): AIS traffic in Jakarta Bay (`api/ais_sim.py`: container ships and a tanker
    calling at Priok via the anchorage with tug escorts, ships at anchor, Kepulauan Seribu ferries on their WIB
    timetables, night fishing boats on AIS class B, a KPLP patrol; ITU-R M.1371 reporting rates, message loss, GPS
    jitter, no-fix 91/181 and heading 511) and delivery trucks on a loop through Jakarta (geotemporal), vessel speeds
    and port sensors (time series), all named "… (demo)", with three hours of history, a live feed every 10 s and a
    monitoring view "Output monitors (demo)". The vessel positions run through a real streaming pipeline: decoded AIS
    messages are pushed into the ingest stream "AIS positions (demo)", and the streaming pipeline "AIS vessel tracking
    (demo)" keeps messages inside the receiver's coverage, nulls heading 511, decodes nav status and ship type, adds
    km/h and sends them to its geotemporal output (without Files the same cleaning runs in Python). The Map lists the demos as built-in maps: opening
    it loads the demo, or fills the gap since it last sent and keeps it and the streaming job live (a day of data is
    kept). **Load demo data** in the Time Series Catalog reloads it; Remove deletes the syncs, pipeline, streams and view.
  - Not done: Flink internals (job graph, Task Manager state).
- Time series in the Ontology (Palantir's time series docs; `api/ts_engine.py`, `api/ts_ontology.py`, `api/ts_derived.py`,
  `api/ts_alerting.py`, `api/code_foundryts.py`):
  - Time series properties (TSPs): a property of type Time series holds a series ID, a qualified series ID
    (`{"seriesId":…,"syncRid":"ri.time-series-catalog.main.sync.<id>"}` for a TSP backed by several syncs) or a derived
    series (`ri.codex-emu.main.template.<id>`, or `{"templateRid":…,"templateVersion":"0.0.2"}` to pin a version).
    Ontology Manager → Capabilities: Get started (pick the string property, its syncs, standard or sensor object type),
    units and internal interpolation (a standard value or another property), external interpolation (NONE / NEAREST),
    the default TSP, sensor object type configuration (sensor links: root object type, foreign key, sensor name; is
    categorical, units and interpolation properties), time series sync markings (stop inheriting a sync's markings
    when read through the object type), geospatial tracks (latitude / longitude TSPs, drawn on the Map) and "Why is my
    time series failing to load?" (series IDs missing from the syncs). Objects show their time series and their linked
    sensors' series. A TSP needs the object type's markings and, unless severed, every backing sync's.
  - Query engine: interpolation per the docs (LINEAR, NEAREST, PREVIOUS, NEXT, NONE; joins use the union of points when
    every input interpolates, else the intersection of the inputs without interpolation) and Quiver's cards: time series
    property, series ID, derived series, code function (function-backed series), formula (`$A - $B`, `&&`, `@prop`),
    filter, derivative, integral, cumulative / rolling / periodic aggregate, sample, shift, relative, combine, Bollinger
    bands, bounds, DSP filter, segment statistics, linked series aggregation, numeric aggregation, time series search and
    parameters. Every query is metered as 4 compute-seconds + points scanned / 25,000 against the resource that ran it
    (Resource Management → Time series queries).
  - Time Series Catalog (`/time-series`): Home (recently viewed, favorites, most viewed object types), syncs, time series
    object types and derived series. New time series sync: a Parquet dataset's series ID / timestamp (Timestamp or Long in
    s / ms / µs / ns) / value columns with a preview, then advanced settings — build when the dataset updates (checked
    every minute), optimized builds, index view inputs, overwrite series of other syncs (they fail), Spark profiles; the
    sync inherits the dataset's markings. A pipeline's sync keeps its pipeline's mapping. Categorical series hold at
    most 10,000 values. Set up time series (`/time-series/setup`): checkpoints, a sync, then an existing object type or a
    new one created from its backing dataset (one object per row, series ID columns as TSPs; re-index from Capabilities).
  - Derived series (`/time-series/derived`): templated (written against a root object type, resolved for each of its
    objects or their sensors) or single; logic in cards with Set as output; every logic save is a version. The bound
    object type is fixed. Manual saving: put the template RID in a TSP. Automatic saving (sensor object types): sensor
    name, root object scope (≤ 5,000), property mapping and Create / Modify / Delete action types; the Ontology status
    shows what Deploy creates, modifies or deletes; Delete from Ontology removes the sensor objects.
  - Quiver (`/quiver`, Platform Apps → Quiver): analyses of cards over an object (or objects named per card), plots
    overlaying series and shading search intervals, a range, dashboards with object and parameter inputs, and Create
    derived series from any plot. Workshop: Chart XY (time series sets of the selected object, rolling transform), Time
    series metric, Quiver dashboard and Derived series widgets. Publish saves the dashboard as a Files item (its folder's
    permissions apply) with a version per publish, viewed read-only at `/quiver/dashboards/<id>`. Action button cards run
    an Ontology action with defaults from constants or value cards (`$V1`). Event sets (from objects' start / end
    properties, from ranges, time shift, deduplicate) shade plots and segment statistics; a transform table can start
    from a time series card (timestamp, value) or a search / event set card (start, end, title). Visual functions save
    a card and what it depends on as reusable logic (chosen cards become inputs); the Visual function card runs one.
    Table cards (`api/quiver_tables.py` on the Contour engine): transform tables from object set cards, datasets,
    other tables or manual values (filter, derive / group with SQL expressions and $parameter cards, join, enrich,
    set math, sort, …; 50,000 rows, CSV export), charts (bar, line, pie, scatter, histogram, distribution, time
    series, heat grid, pivot), value cards, cross filters (subscribed charts filter the object set and each other) and
    Vega / Vega-Lite plots ($T, $T.column), all on the dashboard; Notepad
    embeds Quiver charts and dashboards; object set searches report to a running drill race.
  - Time series alerting (Automate → Time series condition): batch or streaming (fixed once created), an alert object
    type (any type with the `timeseries:*` type classes; Create new object type installs one), a root object type, logic
    ending in a time series search, a scope and how often effects run. One evaluation job per alert object type reads
    only new data (from the last point minus the default lookback; the first run reads everything, or the first-run read
    limit in days), creates alert objects (ongoing ones have no end time), closes them when the condition clears (or a
    streaming custom recovery condition holds) or the changed logic finds the object normal, and runs the automation's
    effect on new alerts. Job configuration: profiles, fail on any failure, lookback, timeout, schedule (on new data or
    every N minutes), allowed lateness, polling interval, excluded syncs. Evaluation history on the automation.
  - Code Repositories: `foundryts` (`FoundryTS().search.series(ontology('sector') == 'Tech', object_types=[…])
    .map(F.time_extent()).to_dataframe()`, `N.TimeseriesNode`, `F.dsl('a+b')`, `.rolling_aggregate`, `.time_range`,
    `.to_pandas()`), `transforms.timeseries.TimeSeriesInput`, `transforms.objects.ObjectInput`, `timeseries_sdk`
    (`TimeSeries.serialize`) and `functions.api.function`. Function-backed series run a `@function` of a repository's
    default branch (objects arrive with `.<tsp>.to_pandas(all_time=True)`), cached 10 minutes. Queries run with the
    build's job token and are metered against the repository.
- The Ontology's model (Palantir's Ontology overview, Ontologies, Object and link types, Action types, Functions, Interfaces and Ontology design docs; `api/ontology.py`,
  `api/ontology_model.py`, `api/ontology_branches.py`, `api/ontology_explorer.py`):
  - Properties: base types string, integer, long, short, byte, double, float, decimal, boolean, date, timestamp,
    geopoint (`lat,lon`), geoshape (GeoJSON), struct (fields, no nesting, with main fields), vector (≤ 2,048
    dimensions), media, attachment, marking, cipher and time series, any of them as an array (no null elements).
    Ontology Manager → Properties edits each one in a side panel: status (experimental, active, deprecated with reason,
    deadline and replacement, example), visibility (prominent, normal, hidden), required (optionally allowing empty
    arrays; actions enforce it), edit-only (re-imports keep edited values), mandatory control (a marking property whose
    markings users need to see the object), a shared property, a value type, value formatting (number: currency, unit,
    percent, affixes, compact / scientific notation, digits; date and time formats with a time zone; user and RID) with a
    preview, conditional formatting rules (standard comparisons against a value or another property, always, math over
    `{properties}`; colors and alignment), render hints, type classes (`kind:name`), reducers for arrays (the element
    shown where one value is expected, by a struct field) and derived properties (follow up to three link types, then
    count, sum, average, min, max, collect a list or set, approximate cardinality; read-only). Several properties are
    bulk edited at once. Byte, float and short properties cannot be action parameters.
  - Statuses: an active (or promoted) object type cannot be deleted or have its API name or primary key changed;
    active properties, link types, action types, interfaces and shared properties cannot be deleted. Statuses cascade
    from an object type to its properties (experimental, example, deprecated; active on request) and from object
    types and foreign keys to link types. Only ontology owners promote an object type (it becomes prominent); others
    propose it on a branch. Object types also have aliases, groups (Ontology Manager → Groups), visibility and
    protection.
  - Link types: foreign key (one-to-one, many-to-one), join table (many-to-many, stored and generated here, links added
    in Object Views) and backing object type (link objects pointing at both ends), each side with its own display name,
    API name and visibility, and the `hierarchy:parent` type class (Object View breadcrumbs).
  - Shared properties: attached properties inherit their base type, value type, formatting, render hints and
    visibility (type classes are united); edits propagate; deleting one detaches it.
  - Backing datasources (`api/ontology_datasources.py`; Ontology Manager → "From a dataset" and the object type's
    Datasources tab): create an object type from a Parquet dataset in Files (curate columns: include, rename,
    retype; the primary key must be unique and set on every row; map and struct columns are refused; optionally
    generate create / modify / delete actions), map columns to properties, "map all unmapped columns", replace the
    dataset (columns with the same names re-map), detach it, and re-index manually or whenever the dataset updates.
    Schema errors use the indexer's names (FoundryColumnNameNotFound, FieldTypeIncompatibleWithPropertyType,
    PrimaryKeyNotMapped, DuplicatePrimaryKey, UnsupportedColumnType, DatasetAndBranchAlreadyRegistered); edit-only
    properties and properties no column backs keep their edits across re-indexes ("has received edits" is shown).
    One object type per dataset; at most 50,000 rows.
  - Object type metadata: icon and color; API names are 1–100 characters and may not be reserved words (ontology,
    object, property, link, relation, rid, primaryKey, typeId, ontologyObject). Changing a property's base type,
    array-ness or struct fields converts the stored values, or is refused with
    IncompatibleFoundryFieldSchemaForPropertyType and the number of objects that do not fit. Deleting an object type
    first shows its impact (objects, action types, automations, link types, Workshop modules, interface
    implementations, edited properties). A local property converts to a shared property from its editor.
  - Interfaces (Palantir's Interfaces doc; `/ontology/interfaces/<id>`): metadata (API name, icon, status,
    searchable: at most 75 implementing object types, 1,000 when not searchable, and the RID), properties (local or
    shared; required or optional; primary key constraint must / cannot; visibility, render hints, type classes),
    link type constraints (target an interface or an object type, cardinality one or many, required or optional),
    action type constraints (beta: display name, description, API name, required, parameter constraints with type,
    single or list and whether they must be mapped; "add from interface property"), extensions (with a confirmation
    of what is inherited; properties and both kinds of constraints are inherited) and implementations. Implementing
    (from the object type's Interfaces card or the interface's Implementations) maps properties (by type and
    primary key constraint), link type constraints to fitting link types, and action type constraints to action
    types with compatible parameters ("Configure parameters"); saving validates every rule of the doc (required
    mappings, compatible types, one action parameter per constraint, stale mappings). Interface objects list every
    implementation; interface actions act on any implementing type.
  - Value Types (`/value-types`): base type, constraints (enum with case sensitivity, range / length / size, regex
    with substring matching, RID, UUID, unique array elements, element constraints, struct field value types), failure
    message and example. Constraint edits make a new version every consumer uses; one that stored values fail is
    refused unless forced. They constrain properties, shared properties and action parameters.
  - Action types (Palantir's Action types doc; `api/ontology_actions.py`, editor at `/ontology/action-types/<id>`): a
    status, type classes (`actions:generate_uuid`, `hubble-oe:hide-action`) and a version bumped on each save.
    Rule-based actions combine Ontology rules (create, modify, create-or-modify, delete objects; create and delete
    many-to-many links), interface rules (create, modify, delete objects of an interface; interface links), one
    function rule (an Ontology edit function computes the edits), and side effects: notifications (in-platform inbox at
    `/notifications` and email, templated with `{{param}}`), webhooks (writeback before the edits or after) and build
    schedules. Values come from parameters, static values, the current user or time, object properties, a writeback
    webhook's response or the triggered schedule run. Parameters have types (objects and lists of objects,
    interfaces, object types, users, groups, attachments and property types), defaults, allowed values (lists,
    ranges, object filters), visibility, requiredness and disabling overrides by condition, and are laid out in form sections (columns, collapsible, conditionally hidden). Submission
    criteria are AND / OR / NOT trees over parameters, the user (groups, attributes) and objects, each with a failure
    message. Applying, a test run (validate without edits), batch apply, inline edits (a property's Interaction tab binds
    a modify action; double-click a cell), revert of the last run on unchanged objects, the action log (an object type
    of submissions, required per object type with "require action log"), metrics (success, failure categories, p95)
    and monitors with alerts. Legacy create / modify / delete actions still work and convert to rules.
  - Functions (Palantir's Functions doc; `api/functions_registry.py`, `api/code_functions.py`, `/functions`): Python
    `@function`, `@query(api_name=…)` and Ontology edit functions (`edits=[…]`, `FoundryClient().ontology.edits()`) in
    Code Repositories. Tagging a release (or Publish) registers each function at that semantic version, after a
    compatibility check against the previous release (removed functions, changed inputs or output need a major bump;
    strict mode refuses, otherwise it warns). Consumers pin an exact version or a range (`^1.2.0`, `~1.2.0`, `>=1.0.0 <2.0.0`);
    pre-releases are used only when named. Function-backed action rules, Automate's "Run function" effect, Workshop's
    function output widget and the API gateway (`POST /api/functions/queries/<api name>/execute`) call them. Also:
    live preview of a branch's unpublished functions, a run console, per-version timeout, memory and snapshot
    configuration, repository aliases (`functions.aliases.custom("key")`, `functions.aliases.model("alias")` for Model
    Catalog models), usage, metrics, run history and monitors. Object inputs are resolved with the caller's
    permissions; queries see the ontology through `ontology_sdk`.
    The SDK also has aggregation outputs (`group_by("a"[, "b"], granularity="month" | ranges=[Range(…)]).count()` /
    `.sum("p")` → TwoDimensionalAggregation / ThreeDimensionalAggregation, rendered as charts in the run console and
    Workshop), object set operations (union, intersect, subtract, `order_by`, `nearest_neighbors(vector | text, k)`
    with `functions.language_models.embed`), `dict[Object, value]` outputs (function-backed columns in Workshop object
    tables), declared errors (`@function(errors=[TooMany])`: callers get `error_name`), streaming functions
    (`Iterator[str]` outputs; `POST /api/functions/<id>/execute/stream` sends server-sent events as chunks are
    yielded), run telemetry (`span("name")`, `get_logger()`, and every platform call timed: the Performance view
    shows a waterfall, the slowest calls and the logs by level for the last 50 runs), notification outputs
    (`Notification`, `ShortNotification`, `Principal`/`User`/`Group`: a notification rule's content and recipients can
    come from functions), REST API sources (`@function(sources=["Weather"])`, imported per repository on the
    function's Sources tab; `get_source("Weather").get_https_connection().get_client().get("/forecast")` and
    `functions.webhooks.execute(...)`: requests stay on the source's domains, pass the egress policy and the platform
    adds the credentials), GeoPoint / GeoShape / Attachment / MediaItem / Marking types, and `functions.testing`
    (`stub_object`, `StubObjectSet`, `verify_edits`) for unit tests without the platform. Not done: TypeScript
    functions, Python functions as Pipeline Builder steps, branch-scoped releases, Workshop variables from functions,
    snapshot enforcement and the platform SDK inside functions.
  - Ontologies (Ontology Manager → Ontologies, switcher in the header): the default ontology, private (one
    organization) and shared (several) ontologies, ontology roles (discoverer, viewer, editor, owner) for users, groups
    or everyone on an ontology or a resource (no grants: everyone edits), and Protect main. Migrate resources moves
    resources with every connected one (link types, their ends, action types, implemented interfaces, shared
    properties); object types created in a private ontology cannot move to the default one.
  - Branches and proposals (Ontology Manager → Branches, `/ontology/branches/<id>`, `/ontology/proposals`): saving a
    protected resource offers "Create and save to branch". A branch holds branch versions of resources (JSON editor,
    delete on branch, discard), shows main's updates, rebases with per-conflict resolution (main, branch or custom),
    and gets a proposal: reviewers, one task per resource approved or rejected (only editors and owners count; a
    promotion needs an owner), comments, changelog, merge checks (no conflicts, valid resources, every task approved),
    merge and close. Not done: legacy (non-global) branches and Global Branching across other apps.
  - Object Explorer (`/object-explorer`): search an object type or an interface, filters, chained Search Arounds,
    sorting and paging, the exploration view (histograms of aggregatable properties that drill down into filters, and an
    aggregation grouped by a property), compare with a pinned set, saved explorations, CSV export, Open in Workshop and
    bulk actions on the selection. Object Set Service limits apply (in memory up to 100,000 objects, a Search Around of
    at most 10 million, 30 million loaded per query).
  - Ontology search (Palantir's Ontology search docs; `api/ontology_search.py`, `/ontology/search`): keyword queries
    are terms (all must match), "quoted phrases" and `*` / `?` wildcards (a leading wildcard needs the property's
    Leading wildcards hint); filters `regex` (Lucene syntax on the whole value, `"..."` literals, no `^` / `$`, needs
    Regex queries) and `wildcard`, also in Object Explorer; a regex tester. Derived properties (`with_properties` on
    `POST /api/ontology/explorer/search`): count, sum, avg, min, max, distinct count, collect list / set and select
    over a link type, filtered first if wanted, then usable in filters, sorts and aggregations of the same query.
  - Ontology scenarios (Palantir's Ontology scenarios docs; `api/ontology_scenarios.py`, `/ontology/scenarios`):
    what-if sandboxes. Actions applied in a scenario (`POST /api/ontology/scenarios/<id>/actions/<action>/apply`) store
    only what changed; reads in the scenario (search, links, derived properties, action forms) see main with those
    edits on top, so it always sits on the latest main (auto-rebase every 10 minutes records conflicts). Submission
    criteria see the execution context "scenario". Temporary (yours, one idle day) or persisted (shared, review status)
    scenarios; every one is deleted 30 days after creation. Compare runs one aggregation on main and each scenario.
    Merge through an action type with an Apply scenario rule (scenario parameter, object / link type scope) as one
    transaction. Not done: Workshop scenario widgets, OSDK scenario clients, scenario metadata as objects.
  - Object and property security policies (Palantir's Object permissioning docs; `api/ontology_security.py`, the
    object type's Security tab, `/object-permissioning`): an object policy (granular conditions comparing the user's ID,
    groups, organization, markings or attributes with property values or constants, all / any, plus required markings)
    filters which objects a user reads; property policies hide values (read as null, listed in `hidden_properties`).
    Foundry's rules: property policies need an object policy, not the primary key, one policy per property, no NOT
    conditions, owners only. A tester evaluates unsaved policies for any user on a stored or hypothetical object.
    Enforced on reads with sign-in on; not downstream. Not done: restricted views, CBAC, organizations as policy
    controls beyond the user's organization ID, "stop inheriting" datasource markings.
  - Object edits and materializations (Palantir's docs; `api/ontology_edits.py`, `/object-edits`): user edits are kept
    in their own layer, so a re-index resolves them like Object Storage v2 (user edits win: edited values stay, user
    deletions stay deleted, user-created objects keep only user values and survive their row; or "most recent value"
    against a timestamp property, edit-only properties always). Edits toggle, Track user edit history (before / after
    values; turning it off deletes it), schema migrations (drop all, drop / move / cast property edits; deleting or
    retyping an edited property needs one), and materialized datasets in Files (automatic after each edit, or periodic).
    Not done: per-datasource strategies (one datasource per type), Funnel offsets, retention of materialized datasets.
  - Semantic Search page (`/ontology/semantic-search`, on `api/ontology_semantic.py`): a playground for semantic
    (KNN), keyword (BM25) and hybrid (RRF) retrieval with HyDE and query augmentation, each method's rank and the
    selected object (and its media) beside the results; a setup tab to embed a text property and chunk long text
    into a chunk object type with a chunk preview.
  - Vertex (Palantir's Vertex docs; `api/vertex.py`, `/vertex`, `components/vertex/`): system flow graphs (System flow
    layout, icon nodes, curved edges, transactional objects grouped into edges with value labels and widths, histogram
    filters, a series panel, undo / redo) and system graphs of Ontology objects with their links
    resolved live; add objects, Search Around (link types with counts; multi-step with filters, the starting set
    narrowed to what connects), layouts (auto, hierarchy, grid, circular, radial, row, column), layers (color, label,
    size by a property, conditional colors, time series readouts with threshold colors), a What-if panel (Actions run in
    a scenario, the graph's objects compared with main), saved selections, saved styles reused across graphs, saved and read-only
    graphs, graph templates (object parameters with
    Search Around chains), related events (`vertex:event_intent.*` type classes, or a `vertex:event_intent` property
    per object) on a timeline with a time selection, and viewing a graph inside an Ontology scenario. Functions: a
    published function taking the selected objects (one per call, an array or an object set) is a Search Around when
    it returns objects (added with edges kept on the graph) and a layer's derived property when it returns a value
    (`/api/vertex/functions`, `/search-around/function`, `/derived`). A media layer: an image from Files under the
    graph (position, width, opacity) with labelled rectangle annotations, and object types pinned onto it by two
    pixel-coordinate properties. Not done: model-backed Vertex scenarios, drawing annotations with the mouse,
    Workshop embedding, Marketplace.
  - Machinery (Palantir's Machinery docs; `api/machinery.py`, `/machinery`): processes over an object type's state
    property (states, transitions, imported actions / automations with input and output states), a process log object
    type Machinery maintains (from a changelog dataset and from platform edits as they happen: old / new state,
    duration, path, isLatest), process mining (top-x % transition filter, excluded elements, new / existing / unused
    overlay, accept), and monitoring: current and historical counts and durations, Sankey edges, the path explorer,
    the duration distribution, conformance (deviations hidden unless asked) and output objects per state or transition.
    Subprocess hierarchies: a process nested in another through a link type covers the objects linked to its
    parent's objects (the Nested panel adds one; the sidebar shows the tree), and its metrics and output objects can
    focus on the objects under parent objects in chosen parent states (`GET /api/machinery/{id}/hierarchy`,
    `parent_states` on metrics and output). Not done: the Workshop Machinery widget, AIP orchestration, one graph
    showing parent and subprocess together.
  - Foundry Rules (Palantir's Foundry Rules docs; `api/foundry_rules.py`, `/foundry-rules`): workflows (inputs, outputs
    as alert objects and / or Files datasets with permitted and default output values, custom properties, enabled
    boards, editors, reviewers, proposals on or off, a schedule), rules with logic blocks (filter, safe expressions,
    aggregation, join, window, select, union, linked objects) and per-block previews, rule proposals with diffs and
    review by someone other than the author, and runs that replace the rule-made alerts. Not done: time series boards
    (sunset), Contour import, legacy Taurus setup, the Workshop Rule Editor widget, Marketplace.
  - Dynamic Scheduling (Palantir's Dynamic Scheduling docs; `api/dynamic_scheduling.py`, `/dynamic-scheduling`):
    boards pairing a schedule object type (resource foreign key, start, end, fixed duration) with resource rows and a
    save handler action; a Gantt chart with drag and drop (snapped, durations kept), changes staged in an Ontology
    scenario until "Submit changes" merges them; validation rules (HARD / SOFT: no overlap, working hours, at most n
    per day, property match, or a Python function), suggestion slots for a selected puck, a search that auto-assigns
    unassigned pucks, row utilization and per-day header metrics, and a calendar view. Several resource object
    types per puck (`extra_resources`: further foreign keys, each a section of rows — a job on a crew row and a
    vehicle row; a drag onto a row sets that section's key, overlap / per-day / property-match rules and
    suggestions cover every section) and puck styling layers (the Layers tab: a condition on a schedule property or
    on rule violations and a color, first match wins). Not done: the Program Scheduling widget, TypeScript
    suggestion / search functions (built-in logic instead), many-to-many resources, a board editor for the extra
    resources (set through the API), auto-assign for the extra sections.
  - Configured Object Views (Palantir's Object Views docs; `api/object_views.py`, `/object-views`, the tabs on
    `/ontology/objects/<type>/<pk>`): tabs (properties, linked objects with counts, a timeline of dated properties of the
    object and its links, edit history, comments, a Workshop module, a link) in order, each optionally visible only when
    a property equals / does not equal a value or the viewer can see a link; header and panel properties, object set
    panel aggregates, the applications sidebar; versions saved, published (automatically or by hand), previewed and
    restored; comments on objects with @mentions (inbox notifications). Widget tabs over linked objects (the legacy
    Object View widgets): filters on a linked objects tab (value lists of chosen properties narrow the table), a
    chart tab (the linked objects grouped by a property — count, sum, avg, min or max — as bars or a pie) and a
    linked object views tab (a card of properties per linked object). A Quiver dashboard tab shows a published
    dashboard opened for the viewed object (`GET /api/timeseries/quiver-dashboards/{id}?object_type_id=&primary_key=`:
    the dashboard's root object becomes the object and its object set cards of that type hold only it). Not done:
    branching object views, profiles, Marketplace.
  - Ontology export, import and cleanup (Palantir's Ontology Manager docs; `api/ontology_manage.py`,
    `/ontology/advanced`): export an ontology's definitions as JSON; import an edited export with a preview (create /
    update with the changed fields / unchanged), a subset, all-or-nothing validation, or into another ontology as a
    copy with new IDs and rewritten references; the cleanup queue with per-user flags and priorities (past deprecation
    date, trashed or stale datasource, no description, a name pattern such as "(test)", no objects, unused), snooze,
    deprecate, and delete (refused when objects have user edits). Not done: project-based permission migration.
  - Object Monitors [Sunset] (Palantir's Object Monitors docs; `api/object_monitors.py`, `/object-monitors`): monitors
    on a saved exploration or an object type — objects added / removed, metric increased / decreased (with a threshold
    sub-condition), thresholds (activity when crossed), function-backed conditions; realtime evaluation when the input
    and condition allow, otherwise scheduled; subscribers notified (inbox, email) with an optional action on each added
    object; six months of history, expiry at most three months ahead, and migration to Automate.
  - Vulcan (Palantir's Vulcan docs; `api/vulcan.py`, `/vulcan`, three.js): CAD objects found by `vulcan:*` type classes
    (a media property holding a GLB, GLTF, STL, OBJ, PLY or 3MF file in Files, up axis, model unit), a schema check and a
    one-click setup of the annotation / measurement / section plane object types, `vulcan:cad_object` link types and
    rule-based create actions with type-classed parameters; the viewer orbits the model, switches normal / x-ray /
    wireframe, picks and recolors parts, cuts with a section plane, and saves annotations (intent colors),
    measurements (polyline length in the model unit) and section planes through those actions. Not done: DXF
    drawings, LAS / LAZ point clouds, function-driven part coloring and transforms, the Workshop widget.
  - Join table datasets (`api/ontology_link_datasets.py`, link type menu → Join table dataset): a many-to-many link type
    backed by a Files dataset (a column per side's primary key, each mapped once, one link type per dataset),
    "Generate join table" from the current links, re-index on dataset updates, users' added / removed links kept
    across re-indexes, links to missing objects counted.
  - Quiver function cards: published functions on the canvas, fed by values and object set cards.
  - TypeScript v2 functions: `ts-functions/src/*.ts` in a code repository, published with its Python functions and run
    with Node (Client object sets, `createEditBatch`, `WriteableClient` staged writes).
  - Consistent snapshots in function runs (enabled per version, default for function-backed actions): reads are pinned
    to each object type's state at the run's first read of it.
  - Functions on global branches: branched pre-releases towards a version target, used only on their Ontology
    branch, published on main when the branch merges.
  - The platform SDK in Python functions (`foundry_sdk`): users, groups, queries and Palantir models' chat
    completions, media reads (`api/platform_sdk.py`).
  - Registered models: Python functions implementing the ChatCompletion function interface are language models
    every LLM call of the platform can use (`function:<id>`).
  - Python functions as Pipeline Builder UDFs (Reusables → User-defined functions): once per row on the server, the
    result in a new column.
  - Workshop module variables: function widgets write outputs to variables read by other widgets (`$var:name` inputs and
    filter values, `{{name}}` in text).
  - Interfaces as Python function inputs and outputs (interface objects and interface object sets).
  - Staged writes in Python functions (`WriteableClient`, `ontology.staged_writes()`): read-after-write inside the
    run, edits committed together by the function-backed action or discarded on error.
  - Python functions read and upload attachments and media (`Attachment.read()`, `Media.get_media_content()`,
    `ontology.attachments.upload`, `ontology.media.upload_media`).
  - Pipeline Builder object type outputs can register their object type in the Ontology on deploy and implement
    Ontology interfaces (property mapping validated).
  - Workshop widgets can read an interface: the objects of every implementing object type under the interface's
    properties (with the object type as a column).
  - Drill AI agent that queries the data (search, links, aggregations as the user) and is auto-judged against
    expected answers; or plans from the schema only.
  - Team races on validation drills: live timer, scoreboard and judge; participants' paths through Object Explorer
    and object views recorded automatically and turned into drill sessions.
  - Design review history and branch reviews (Ontology design, proposal tab): snapshots when findings change, and a
    branch's findings new / resolved compared with main.
  - Batched execution of function-backed actions: a function taking one list of structs runs once per batch of
    action calls (an entry per call), its edits applied together; up to 10,000 calls (20 when not batched).
  - Incremental re-index: unchanged objects keep their record and updated_at, no write when nothing changed; at most
    `BLUESANDAI_ONTOLOGY_MAX_ROWS` (default 50,000) objects per dataset-backed type.
  - New object type dialog: ontology groups, generated Create / Edit / Delete actions with the users and groups who may
    run them (written as submission criteria), and an optional object security policy.
  - Convert to object-backed (link type menu → Convert to object-backed): a foreign-key or join-table link type becomes
    one backed by a third object type (a property per side's primary key); existing links become backing objects
    with primary key `source|target`.
  - Multi-datasource object types (`api/ontology_mdo.py`, Datasources tab): column-wise MDOs — more datasets keyed by the
    primary key back other properties (one datasource per property, at most 70), objects are the keys of any
    datasource with missing ones null, and users who cannot view a dataset see its properties as null.
  - Mandatory control properties: allowed markings and organizations per property (values outside them are refused),
    always required and hidden by default; users need every marking and one of the organizations; with several
    datasources a control secures only its own datasource's properties.
  - Indexing, overview and object databases (Palantir's Indexing / Overview / Object databases docs;
    `api/ontology_indexing.py`, `/ontology-indexing`, `/ontology-overview`, `/object-databases`): every re-index runs as a
    Funnel-style pipeline (changelog, merge changes, indexing, hydration), incremental when at most half the rows
    changed, full otherwise or on request, live or replacement (schema changed), with OSv2's data restrictions (NaN /
    infinity and empty strings become null, strings over 12 MB, arrays over 100,000 elements or nested arrays fail the
    index); the run log is kept per object type. Not done: streaming pipelines (Funnel streaming), direct datasources.
  - Demo JKN on the Ontology (`api/demo_jkn_ontology.py`, `POST /api/demo/jkn/ontology`, card on `/demo-jkn`):
    Faskes JKN (demo) and Klaim JKN (demo) from the fictitious audit records, with the planted risk categories; regex
    and derived-property searches, the scenarios "Demo: Tunda pembayaran klaim berisiko" and "Demo: Koreksi upcoding ke
    severity I" with a merge action, and security policies (claims under investigation, patient data). Kept, never
    deleted; building again only adds what is missing.
  - Object Views (`/ontology/objects/<type>/<pk>`): key properties (configured header, prominent first, keywords and
    long text sections, formatting), every linked object, interfaces, time series, actions, related Workshop modules,
    Quiver analyses and links, automations and the edit history.
  - Usage (Resource Management → Ontology): query compute per the 2026 model (base 2, Search Around 5, aggregation 5,
    SQL 5, advanced 10, derived property 10, action 18 + 1 per object beyond the first compute-seconds) by query type,
    resource and object type; indexing compute for edits and re-imports; Ontology volume sampled hourly into GB-months.
  - Ontology design (Palantir's Ontology design docs; `api/ontology_design.py`, `/ontology/design`): a design review
    that lints the ontology for the anti-patterns (System Silos, The Kitchen Sink, Department Silos, The God Object
    from sparse properties and a type discriminator, The Golden Hammer, Action Sprawl, The Time Machine, The Misnomer)
    and principles (rule of three, composition over deep hierarchies, normalization and derived properties, naming
    conventions, documentation, link naming), each finding with its resource and what to do; findings can be
    dismissed with the tradeoff's reason; optionally, proposals cannot merge while their branch introduces new
    high-severity findings. The eight design guidelines are scored from the findings. Validation
    drills: quiz-style games or timed drill-downs of real business questions (establish the situation, trace the
    factors, assess the impact; points), sessions per participant (builder, domain expert, new user, AI agent) with
    timer, correctness, help needed, path, searched terms and observed symptoms; results per question and role, the
    symptom → what to review table, people compared with agents, and a leaderboard. "Run with an AI agent" plans a
    path for each question from the schema alone.
  - Not done: Gotham type mapping, Gaia drawing, Marketplace products, restricted views, dataset-backed join tables,
    multiple datasources per object type, writeback datasets, mandatory control allowed-marking sets, struct field
    mappings in interfaces and object security policies.
- Analytics (Palantir's Analytics docs 01–11; status in `docs/REMAINING.md` §21):
  - Fusion (`api/fusion.py`, `api/fusion_formula.py`, `/fusion`): spreadsheets stored as Files items (Projects and
    markings apply) with server-side formulas in Fusion's syntax (single-quoted strings, `==`, AND / OR / NOT, A1,
    A1:B3, Sheet2!A1, `$A$1`): about 230 functions — math, statistics (incl. regression and moments), logic, text,
    dates (`datedif`, `yearfrac`, `workday`), arrays, `sumifs` / `countifs` family, `vlookup` / `hlookup` / `xlookup` / `index` / `match`, `lookup`,
    `lookup_array`, `lookup_distinct`, `lookup_dropdown`, `lookup_schema` on Files datasets (2,000 results),
    `object_lookup` / `object_dropdown` on Ontology objects, `dropdown` / `multidropdown`, `url`, `color`, `tooltip`,
    validations (`column_enum`, `column_not_null`, `column_numeric`, `table_headers`, `table_key`) and Action buttons
    (`action.copy`, `toast`, `submit_to_region`, `serial`, `parallel`, `trigger` / `label`, `apply_action` for
    Ontology actions). Table regions (sort rearranges rows, append, sync to a Parquet dataset rewritten when the
    values change; a whole sheet can sync the same way, its first used row as headers), manual source updates
    (lookups keep the data read at the last "Update sources"), relative references that follow pasted / sorted / inserted rows, locked cells, formats,
    snapshots (automatic every 10 minutes, or named) with restore, templates (opening makes a copy; cell overrides),
    XLSX import, Find and use data (datasets and object types), presentation view and a hidden grid; `ts.*` functions on
    time series syncs (`ts.timeseries("series")`, statistics, scale / shift / time_range / last, derivative, integral)
    with a sparkline in the cell. Live co-editing: other users' cells are outlined and their edits appear within a few
    seconds.
  - Forms [Sunset] (`api/forms.py`, `/forms`): forms stored as Files items with a main sheet and subsheets; simple,
    data-backed (user / object / object property / dataset value dropdowns, objects provider, property display) and
    auto-populating fields (calculation with Fusion formula functions, created at / by, generated primary key,
    template), callouts and attachments; validators (required, regex, range, length) and transforms (hide / show /
    disable / update configuration / change type on all / any / not conditions) evaluated on the server; free and
    parameterized multiplicity (one entry per instance); draft, versions and publish; responses written to a Fusion
    table region (append or update by key) or an Ontology object type, kept in a response log that editors review
    and edit, bulk edit of objects, subscriber notifications, embedding (`/forms/<id>/fill?embedded=true&noHeader=true`,
    URL parameters prefill), respondent links (signed-in users who have one fill the published form without access to its
    Project; expiry, turn off; not for marked forms).
  - Reports [Sunset] (`api/reports.py`, `/reports`): reports stored as Files items — text (Markdown with
    {{parameter}}), tables, bar / line / pie charts, metrics, object tables, images, dividers and page breaks on live
    datasets and object types (the Workshop query engine), parameters with defaults and suggested values driving
    widget filters and title prefixes, reorder / size / hide, duplicate, PDF (headless Chrome), PowerPoint (native
    charts and tables, python-pptx), CSV per widget, Markdown, convert to Notepad or to Contour (parameters, a path
    per data widget, the boards and text on its dashboard); Contour board and Quiver card
    widgets (report parameters drive Contour parameters; Quiver time series plots are drawn in the browser); Recipes can
    email them on a schedule. Editing indicators (`api/presence.py`): Reports, Notepad and Fusion show who else has the
    document open and warn when someone else is editing too; Fusion and Notepad also show where the others are (cell /
    block) and pick up their saves within seconds.
  - Code Workbook [Legacy] (`api/code_workbook.py`, `api/code_workbook_runner.py`, `/code-workbook`): workbooks as
    Files items — graphs of imported datasets and folders of unstructured files (a read-only file system in Python:
    ls / open / path), Python nodes (functions over pandas DataFrames named after their
    inputs; matplotlib figures kept), SQL nodes (DuckDB), manual entry and template nodes (suggested and workbook
    templates with input / column / value parameters), global code, a Python / SQL console in a persistent session
    (names stay defined, node outputs reused while the graph is unchanged; Add to graph), run a node
    with what it needs upstream, Save as dataset with Build, branches with a three-way merge and conflict choices,
    session history (interactive and batch sessions with their resolved environments; compare; pin, with drift reported),
    Contour nodes (a Contour path's result or a board's data, with parameter values), model outputs (a Python node
    returning a model passes the object downstream; Save keeps it in Files as a pickle that other workbooks import), multi-node templates (a node and
    its upstream saved by name, applied in any workbook with its inputs bound), the
    Paths view (every path between two nodes highlighted), a full-screen editor, imported datasets read from a
    chosen branch (or the workbook's branch, falling back to master), the resolved
    environment, copy and paste of a node with its upstream (also into another workbook: imported
    datasets are reused, clashing names renamed in the pasted code), and Export to a Code Repository (one Python
    transform per node).
  - SQL & BI (`api/sql_bi.py`, `/sql-bi`): a PostgreSQL wire-protocol endpoint (127.0.0.1:5433;
    BLUESANDAI_SQL_HOST / BLUESANDAI_SQL_PORT, `off` disables it) for Power BI, Tableau, Excel, Qlik Sense, Report
    Builder and PostgreSQL ODBC / JDBC drivers: any user name, a personal API token as the password, read-only DuckDB
    SQL over the token owner's datasets ("Project"."folder/name" or "/Project/folder/name") and object types
    (ontology."ApiName"), simple and extended query protocol, text and binary results, pg_catalog for drivers' table
    and column browsing; `POST /api/sql-bi/query` (JSON or CSV) for tools without a driver. Cancellation: the
    drivers' cancel (CancelRequest, SQLSTATE 57014), REST `timeout_seconds`, `GET /queries` and
    `DELETE /queries/{id}` (Cancel on the page). TLS with BLUESANDAI_SQL_TLS_CERT / BLUESANDAI_SQL_TLS_KEY
    (BLUESANDAI_SQL_TLS_REQUIRED=1 refuses unencrypted sessions); a Developer Console application's OAuth access token
    also works as the password, limited to the object types in its scopes. Spark SQL: `options=-c dialect=spark`,
    `SET dialect = 'spark'` or "dialect" in REST (translated to DuckDB with sqlglot). Results stream over the protocol
    without a row limit (fetch sizes and DECLARE / FETCH cursors); REST returns at most 1,000,000 rows. Branch: `options=-c branch=<name>`, `SET branch = '<name>'` or
    "branch" in REST reads datasets from that branch, falling back to master.
  - Insight (`/insight`, `api/ontology_explorer.py`): branches (a session scoped to an Ontology scenario through
    `?scenario=` or the branch selector: searches and actions see main plus the scenario's edits; saving workbooks,
    layouts, object sets and lists and Excel export are off, the analysis autosaves in the browser), object set
    references (read-only, live) and copies, publishing a path as an object set (and updating it), static lists
    (`/api/ontology/object-lists`: Save as list, add selected objects, paths starting from a list), and the branch
    taskbar ("Use in every app": the branch for every app's Ontology requests in this tab, shown in the header).
  - Contour (`api/contour.py`, `api/contour_engine.py`, `/analytics`; expressions in DuckDB SQL or, per analysis,
    Contour's Spark SQL translated with sqlglot): analyses stored as Files items — paths that
    start from a dataset, an object type or another path's result and run boards in order (filter with wildcard /
    regex / range conditions, expressions incl. window functions and aggregation, column editor, sort, join, add
    columns, set math, find / replace / obfuscate, unpivot, dedupe; table, histogram, distribution, time series,
    bar / line / pie / scatter chart, heat grid, pivot table, summary statistics, map). Each path compiles to a chain
    of SQL CTEs run by DuckDB on the server. Parameters ($name, multi-value, suggested values), chart-to-chart
    filtering (selections filter downstream boards), "switch to result", dashboards with tabs and text, CSV export
    (100,000 rows), save as dataset with Build (refresh), Export to Pipeline Builder: a path on one dataset becomes
    a new pipeline (the dataset, one SQL step with the path translated from DuckDB to SQLite by sqlglot, an output),
    refused when the translation fails or does not run on SQLite over a sample (UNPIVOT, EXCLUDE / REPLACE columns,
    BY NAME unions) or changes the columns; other paths show their SQL.
  - Notepad (`api/notepad.py`, `api/notepad_engine.py`, `/notepad`): documents in Files with embedded widgets —
    object property and object card (Allow editing: inline edits; Action buttons on cards), object media preview, maps of an object set's geopoints, Contour boards (with
    parameter overrides), Solution Designer diagrams (read-only), the Object property Markdown editor (edits saved through the property's inline edit action),
    Code Workbook nodes (figures or table, run with their upstream), Vertex graphs (read-only, with saved positions and layers; edges in exports), function
    results, LaTeX (KaTeX),
    user mentions (notified on save), anchor and resource links; Lock data / Update data per widget or for all;
    version history (autosaves every 5 minutes, named and endorsed versions, show changes, restore); document links
    and the objects' linked documents; templates with string / number / date / object / object set inputs and preview
    values, value embeds, section generators (nested one level, linked objects), table row generators (text or
    batched function cells), conditional sections, published versions and "New from template"; "Copy for Notepad" in
    Contour, Quiver, Vertex and Code Workbook (Insert → Paste copied widget); generation limits set by admins; envelope
    security (the document's markings bound its content; a markings banner on the page and exports); page
    settings,
    DOCX (python-docx) and Markdown export, print to PDF.
- `unstructured/` — vendored copy of the `unstructured` library (Apache-2.0, see its
  `LICENSE.md`) including our changes: `partition/pdf_image/bluesandai_structuring.py` and edits
  to `partition/pdf.py`, `partition/common/metadata.py`, `partition/utils/constants.py`. The API
  imports it from here; it is not pip-installed.
- `fast-worker/` — Cloud Run service for the Fast tier (`deploy-fast-worker.ps1`): `/parse` extracts the text
  layer, `/chunk` splits a Fast job into RAG chunks by topic (`api/chunking.py`, `api/semantic.py`: LangChain's
  SemanticChunker with multilingual-e5-small, baked into the image). Other tiers split chunks at headings.
  After parsing, the API runs `api/vision_parser.py` on Fast jobs: tables (found from the text layout) and
  figures are cropped from the PDF and read by a small Qwen vision model on OpenRouter
  (`BLUESANDAI_VISION_MODEL`, default `qwen/qwen3.7-flash`; `BLUESANDAI_FAST_VISION=0` turns it off).
- `mineru-worker/` — the MinerU Scientific Parsing worker
  ([MinerU](https://github.com/opendatalab/MinerU)); its own git repo, pushed to the private
  GitHub repo `mfadilhuseiny1/bluesandai-mineru-worker`. In use: Runpod Serverless
  (`Dockerfile.runpod`, built by Runpod from GitHub on each release). Also deployable to Cloud Run
  (`Dockerfile` L4, `Dockerfile.cpu`) with `deploy-mineru-worker.ps1 [-Device cpu]`.
- `docling-worker/` — Cloud Run services for the IBM Docling tier (`layout`): `bluesandai-docling` (one NVIDIA L4) and
  `bluesandai-docling-cpu` (same image, CPU only; `deploy-docling-worker.ps1 -Cpu`). The API sends
  OCR-heavy work (scans, figures) and big or batched work (≥400 pages) to the GPU, small text-only
  PDFs to CPU, which costs nothing between jobs (`_docling_use_gpu` in `api/server.py`).
- `data/` — uploaded files and job results (created on first run).

## Setup (once)

Needs [uv](https://docs.astral.sh/uv/), Node.js and Poppler (`winget install oschwartz10612.Poppler`).

```powershell
uv venv --python 3.12 .venv
uv pip install --python .venv\Scripts\python.exe -r requirements.txt
cd web; npm install; cd ..
```

For Java transforms in Code Repositories: `powershell -ExecutionPolicy Bypass -File setup-java.ps1`.

Put `.env.local` in this folder (git-ignored; keys are listed below and in `api/docai.py`).

## Run

Double-click `start.bat` (or a desktop shortcut to it), or in PowerShell:

```powershell
.\start.ps1
```

It starts the API and the UI only when they are not running yet, waits for PostgreSQL and then until the API
answers, and opens http://localhost:8888. `start.bat` works whatever the PowerShell execution policy is (a plain
`.\start.ps1` is refused under the Windows default). Local only: it never starts the public tunnel (`public.ps1`).
Configuration lives in `.env.local` in this folder.

## Regular snapshots and the debugger

- Regular snapshots (Pipeline Builder → Build settings → Default compute profile → Advanced): an incremental pipeline
  re-processes its inputs in full and replaces its outputs with one SNAPSHOT every N incremental builds, every N
  days or after N APPEND transactions, so small transactions do not pile up. The build page says why it snapshotted.
- Code Repositories debugger (`api/code_debug.py`, `api/code_debug_worker.py`): click a line number for a breakpoint
  (right-click for a condition), press Debug, then step, inspect variables (DataFrames as tables) and run code in the
  paused frame; the "…" menu opens a Python console with the transform's inputs loaded. Each session runs in its own
  process and writes no outputs. It debugs `@transform_df` / `@transform` and `@transform.using` /
  `@transform.spark.using` (Spark: the driver-side compute function; the result lists every output), and works on
  Windows (pause and breakpoints set while running interrupt the main thread without POSIX signals).

## Sign-in, users and markings

`api/auth.py`, managed like Palantir's Control Panel. The first start shows **Set up the platform**: create the first
administrator. After that every page and every `/api` call needs a signed-in user (session cookie, up to 14 days and
ended earlier by the idle timeout), except
the stream proxy, listener URLs and shared links, which carry their own secrets.

- **Control Panel → Users**: profile (first/last name, email, attributes), organization, groups, role (Administrator
  or User), markings, deactivate / reactivate, reset password, sign out everywhere. **Groups**: members and the markings
  they grant. **Organizations**: every user belongs to at most one; an organization is also a marking. **Markings**:
  name, color, who holds them (directly, through a group or the organization). **Sign-in activity**: sign-ins,
  failures, sign-outs and every change to users, groups, organizations and markings.
- **Markings are enforced**: a user must hold every marking on a file, dataset, pipeline or folder, and on the folders
  above it. Items they cannot access are left out of Files, pipeline lists and Data Lineage, and are refused (403).
  Datasets a pipeline deploys inherit the markings of its inputs and of the pipeline. Mark items in Files (details →
  Markings), a pipeline's Details → Access, or Lineage → Access; applying or removing a marking needs holding it.
  Shared links do not open marked items.
- **Account settings** (user menu, bottom left): profile, password (with the policy shown as you type), two-factor
  authentication (authenticator app + recovery codes), the browsers you are signed in on (sign them out), and personal
  API tokens for scripts (`Authorization: Bearer bsai_pat_…`).
- **Forgot password / invitations**: "Forgot password?" on the sign-in page emails a one-time reset link (60 minutes);
  Control Panel → Users → **Invite by email** creates the account and emails a link where the person picks their own
  name and password (7 days). A password an administrator sets must be changed at the next sign-in.
- **Email** (`api/mailer.py`) goes through Resend's API (`RESEND_API_KEY`, `RESEND_FROM` an address on a domain verified
  in Resend; optional `RESEND_REPLY_TO`), as text and HTML; any SMTP server (`BLUESANDAI_SMTP_*`) is the fallback.
  Data Health alert emails use the same. Without email, or when Resend refuses a message, the administrator gets the
  link to pass on (also "Send password reset link" / "Resend invitation" on a user); Control Panel → Security shows
  which provider and sender are in use.
- **Single sign-on** (`api/auth_sso.py`): Google, Microsoft Entra ID, Okta and any OpenID Connect provider (code flow
  with PKCE; the ID token's signature, issuer, audience, expiry and nonce are checked), and SAML 2.0 (signed response or
  assertion, audience, recipient, validity window, InResponseTo). Keys go in `.env.local` — see `.env.example`, which
  also lists each provider's callback URL. A sign-in links to the account with the same email (accepting an
  invitation), or creates one when Security → "Create accounts on first sign-in" is on (optionally only for some email
  domains). Password sign-in can be turned off (single sign-on only; administrators keep their password).
- **Control Panel → Security**: password policy (length, upper / lower case, digits, symbols, common passwords, no
  reuse of the last N, expiry in days), idle timeout (default 60 minutes: the page reports activity and warns a
  minute before signing out; changes through the API count too), session length, two-factor required for
  administrators or everyone (they set it up at the next sign-in before anything else), sign-in attempt limits per
  username and per IP address (also for reset links, invitations and codes; `BLUESANDAI_TRUST_PROXY=1` behind a proxy),
  link lifetimes, single sign-on provisioning and the role everyone gets on new Projects.
- **Project roles** (Files → a Project → Roles): Owner, Editor, Viewer for users, groups or everyone. Viewers open and
  read; Editors also change files, save pipelines, run builds and manage schedules (Build Schedules too); Owners also
  manage roles and delete the Project. A new Project makes its creator Owner and gives everyone the default role
  (Editor; Security setting). Projects without roles (made before roles existed) stay open to everyone as Editors.
  Administrators are Owners of every Project.
- **Markings beyond Files**: ingest streams, streaming syncs, object types (their objects, actions, agents and
  Workshop), vector indexes and code repositories carry markings too (a Markings card on each page). A pipeline's
  output stream inherits the pipeline's markings; a code repository's build outputs inherit the repository's.
  They are checked wherever the resource is reached, not only on its own pages: every object read (listings,
  actions and action types, Logic, Workshop widgets, agents), Data Lineage (transforms of marked repositories,
  object types and streams are hidden, with their edges, node details, code, preview, transactions and rollback),
  the Builds app, health checks, expectations, libraries, UDFs and shared Java code (marked repositories are left
  out), vector store runs and copy targets, and monitoring views (monitors of marked streams, syncs and datasets are
  hidden). Files contents are only read through checked paths (`drive.read_bytes`, `drive.copy_content` — media
  set copies in builds, knowledge and parsing), Views need their markings (Editor to change one), and a rollback
  needs Editor on the dataset's Project.
- **Transforms calling the API**: each Python or Java transform build gets a token for the user who started it (a
  schedule: its creator), valid while it runs — `BLUESANDAI_API_URL` and `BLUESANDAI_API_TOKEN` in Python,
  `ctx.serviceDiscovery().getUris("api")` and `.authorizationHeader()` in Java — with that user's markings and roles.
- The build runner in the web server uses a service token the API hands it with each build.
- Settings: `BLUESANDAI_AUTH=off` turns sign-in off (development); `BLUESANDAI_WEB_ORIGINS` lists the web origins
  allowed to call the API with cookies (default `http://localhost:8888,http://127.0.0.1:8888`);
  `BLUESANDAI_COOKIE_SECURE=1` marks the cookie Secure when served over HTTPS. Users live in `data/auth/auth.sqlite`,
  or in PostgreSQL with `BLUESANDAI_AUTH_STORE=postgres` (schema `bsai_auth` in `BLUESANDAI_DATABASE_URL`; an existing
  auth.sqlite is copied in on the first start). Every setting is listed in `.env.example`.

## Tiers (internal — the UI and API never expose engines, models or our costs)

| Tier | Engine | Customer price/page | Our cost/page |
|---|---|---|---|
| Fast | unstructured `fast` (native PDF text layer, pdfminer) on Cloud Run | $0.001 | ~$0.000004–0.00003 |
| Cost Effective | Google Document AI, Enterprise Document OCR (`api/docai.py`) | `BLUESANDAI_PRICE_COST_EFFECTIVE` | ~$0.0015 |
| MinerU Scientific Parsing (`precision`) | MinerU 4.0.10 `standard` tier (layout, OCR, tables, formulas via its VLM on vLLM) on Runpod Serverless endpoint `<endpoint-id>`: 24 GB GPU (L4 / A5000 / 3090, $0.69/h), max 3 workers, 30 s idle (`mineru-worker/`). Fallback: Cloud Run L4 | $0.005 | ~$0.0003 parsing; ~$0.0005–0.0007 incl. cold starts on a 102-page paper; ~$0.03 per small cold job |
| IBM Docling (`layout`) | Docling (layout model, TableFormer, EasyOCR) on Cloud Run, Singapore: L4 GPU or CPU | $0.014 (shown 280) | GPU ~$0.0003–0.002 + ~$0.20 idle per burst; CPU ~$0.0003–0.002 text pages |
| Agentic | `bluesandai_structuring_lite` (gemini-3.5-flash-lite) | $0.01 | ~$0.0034 |
| Agentic Plus | `bluesandai_structuring` (gemini-3.5-flash) | $0.05 | ~$0.0135 |

Agentic pages the primary model refuses (e.g. Gemini's `RECITATION` copyright filter) go to an
OpenRouter fallback model (`BLUESANDAI_FALLBACK_MODEL`, default `deepseek/deepseek-v4.1-flash`).
Local OCR is never used.

MinerU jobs go to Runpod while `MINERU_RUNPOD_ENDPOINT_ID` and `RUNPOD_API_KEY` are set in
`.env.local` (each 10-page chunk is a queued Runpod job; chunks over 7 MB go as S3 presigned URLs);
remove the endpoint ID to fall back to Cloud Run. To update the Runpod worker, push to the GitHub
repo and create a release. Endpoint settings (execution timeout 3600 s, FlashBoot, CUDA ≥ 12.9,
30 GB disk) are on the endpoint, not in this repo.

Precision shows "Coming soon" until `deploy-mineru-worker.ps1` has written `MINERU_WORKER_URL` and
`MINERU_WORKER_TOKEN` to `.env.local`. The project needs Cloud Run L4 quota in `asia-southeast1`
(Jakarta has no Cloud Run GPUs); instances scale to zero, and a cold start loads the models first. With
`deploy-mineru-worker.ps1 -Device cpu` also run (it writes `MINERU_CPU_WORKER_URL`), jobs under
`MINERU_CPU_MAX_PAGES` (70, `api/server.py`) go to the CPU service instead; job.json's `model`
records which one (`mineru-cpu` / `mineru-gpu` / `mineru-runpod`). CPU routing is currently off
(`MINERU_CPU_WORKER_URL` commented out): table-heavy papers time out on CPU.

Cost Effective shows "Coming soon" until these are filled in `.env.local`:
`GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_DOCAI_PROJECT_ID`, `GOOGLE_DOCAI_LOCATION`,
`GOOGLE_DOCAI_PROCESSOR_ID` (optional `GOOGLE_DOCAI_PROCESSOR_VERSION`) and
`BLUESANDAI_PRICE_COST_EFFECTIVE`. `.env.local` is re-read per request, so no restart is needed.

Internal per-job data — engine per page, tokens, our cost, full error — is in
`data/jobs/<job_id>/job.json` and `result.internal.json`; the API only serves the public view.

## PostgreSQL

Every file, job update, parsed element and RAG chunk is mirrored into the local PostgreSQL
database `bluesandai_parse` (role `bluesandai`), configured by `BLUESANDAI_DATABASE_URL` in
`.env.local`. Tables: `files`, `jobs` (internal engine/cost data in the `internal` jsonb column),
`elements`, `chunks` (with a full-text index), `drive_items`, `vector_ingests`. The source PDFs stay on disk in `data/files/`.

`setup-database.py` created the role and database using the superuser credentials in
`D:\Sadai\Power_SCADA\.env` (no other database is touched); re-run it to rotate the role's
password. On API startup, anything on disk that is missing from the database is copied in.
