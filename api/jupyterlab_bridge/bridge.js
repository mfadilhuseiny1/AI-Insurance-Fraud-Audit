/* The AI assistant's bridge inside JupyterLab's page (api/code_workspace_assist.py). The relay
   (api/code_workspace_vscode.py) puts this script in JupyterLab's pages, with the app exposed as window.jupyterapp
   (page config exposeAppInBrowser). The platform's page that frames JupyterLab (web/src/components/code/JupyterAssist.tsx)
   asks over postMessage — only from the platform's web origins, only as the parent window — and the bridge reads the
   open notebook and the workspace's files, or carries out a change the user approved there; it never acts by itself.

   Cells are named by their nbformat id and read and changed through the live model (unsaved edits included); a cell
   runs through CodeCell.execute and reports the kernel's status — as jupyterlab-ai-commands does
   (github.com/jupyter-ai-contrib/jupyterlab-ai-commands, BSD-3-Clause). A change names the notebook it was proposed for
   (its path), so it lands there even when another tab is in front by then. */
(function () {
  "use strict";
  // the platform's web origins (exact, or a pattern such as "http://*:8888"), filled in by the relay
  var ORIGINS = __BLUESANDAI_ORIGINS__;
  var OUT_TEXT = 3000; // characters kept of one output's text in a notebook read
  var ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
  var parentOrigin = null;

  function allowed(origin) {
    return ORIGINS.some(function (p) {
      if (p.indexOf("*") < 0) return p === origin;
      var parts = p.split("*").map(function (s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      });
      return new RegExp("^" + parts.join("[^/:]+") + "$").test(origin);
    });
  }

  // the app, once started and restored (window.jupyterapp is set right after start)
  var appReady = null;
  function app() {
    if (!appReady) {
      appReady = new Promise(function (resolve, reject) {
        var started = Date.now();
        (function poll() {
          var a = window.jupyterapp;
          if (a && a.shell) {
            Promise.resolve(a.restored).then(function () {
              resolve(a);
            });
            return;
          }
          if (Date.now() - started > 60000) {
            appReady = null;
            reject(new Error("JupyterLab did not start in this page"));
            return;
          }
          setTimeout(poll, 250);
        })();
      });
    }
    return appReady;
  }

  function isNotebook(w) {
    return !!(w && w.content && w.context && w.context.model && w.context.model.cells);
  }

  // the notebook the bridge last opened or changed: JupyterLab's current widget follows keyboard focus, which stays in
  // the platform's page while the user works in the assistant, so a notebook opened from there never becomes current
  var lastPanel = null;

  function shown(w) {
    return isNotebook(w) && !w.isDisposed && w.isVisible;
  }

  // the notebook in front: the current widget when it is a notebook (a file editor's model has no cells), else the one
  // the bridge last worked on if it is still shown, else a notebook shown in the main area
  function notebookPanel(a) {
    var w = a.shell.currentWidget;
    if (isNotebook(w)) return w;
    if (lastPanel && shown(lastPanel)) return lastPanel;
    try {
      for (var m of a.shell.widgets("main")) if (shown(m)) return m;
    } catch (e) {
      /* a shell without widgets(): none */
    }
    return null;
  }

  // the notebook a change was proposed for (its path), else the one in front
  function panelFor(a, path) {
    var p = notebookPanel(a);
    if (path && !(p && p.context.path === path)) {
      p = null;
      try {
        for (var w of a.shell.widgets("main")) {
          if (isNotebook(w) && w.context.path === path) {
            p = w;
            break;
          }
        }
      } catch (e) {
        /* a shell without widgets(): only the one in front */
      }
      if (!p) throw new Error("The notebook " + path + " is not open in JupyterLab any more");
    }
    if (!p) throw new Error("No notebook is open in front in JupyterLab");
    lastPanel = p;
    return p;
  }

  function findIndex(model, id) {
    for (var i = 0; i < model.cells.length; i++) if (model.cells.get(i).id === id) return i;
    return -1;
  }

  function needCell(model, id) {
    var i = findIndex(model, id);
    if (i < 0) throw new Error("No cell with id '" + id + "' in the notebook: read it again for the current ids");
    return i;
  }

  function text(v) {
    return Array.isArray(v) ? v.join("") : v == null ? "" : String(v);
  }

  // a long text keeps its head and its tail (a traceback's cause and a log's last lines)
  function cut(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, Math.floor(n * 0.6)) + "\n… [" + (s.length - n) + " characters cut] …\n" + s.slice(s.length - Math.floor(n * 0.4));
  }

  function dirname(path) {
    var i = path.lastIndexOf("/");
    return i < 0 ? "" : path.slice(0, i);
  }

  function clean(path) {
    return String(path || "").replace(/^\/+|\/+$/g, "");
  }

  // an nbformat cell id (crypto.randomUUID needs a secure context; a LAN address over http is not one)
  function uid() {
    var b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map
      .call(b, function (x) {
        return (x + 0x100).toString(16).slice(1);
      })
      .join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  }

  function outputs(cell, limit) {
    if (cell.type !== "code") return [];
    var outs = cell.sharedModel.toJSON().outputs || [];
    return outs.map(function (o) {
      if (o.output_type === "stream") return { kind: "stream", name: o.name, text: cut(text(o.text), limit) };
      if (o.output_type === "error") {
        return { kind: "error", ename: o.ename, evalue: cut(text(o.evalue), 1000), traceback: cut((o.traceback || []).join("\n").replace(ANSI, ""), limit) };
      }
      var data = o.data || {};
      return {
        kind: o.output_type === "execute_result" ? "result" : "display",
        text: cut(text(data["text/plain"]), limit),
        media: Object.keys(data).filter(function (k) {
          return k !== "text/plain";
        }),
      };
    });
  }

  function cellInfo(model, i, limit) {
    var c = model.cells.get(i);
    return {
      cell_id: c.id,
      n: i + 1,
      type: c.type,
      source: c.sharedModel.getSource(),
      execution_count: c.type === "code" ? c.executionCount : null,
      outputs: outputs(c, limit),
    };
  }

  function selectionOf(nb) {
    var cell = nb.activeCell;
    if (!cell || !cell.editor) return "";
    try {
      var sel = cell.editor.getSelection();
      var a = cell.editor.getOffsetAt(sel.start);
      var b = cell.editor.getOffsetAt(sel.end);
      return cell.model.sharedModel.getSource().slice(Math.min(a, b), Math.max(a, b));
    } catch (e) {
      return "";
    }
  }

  function language(model) {
    try {
      var li = model.getMetadata && model.getMetadata("language_info");
      var ks = model.getMetadata && model.getMetadata("kernelspec");
      return (li && li.name) || (ks && ks.language) || "python";
    } catch (e) {
      return "python";
    }
  }

  function errorCells(model) {
    var out = [];
    for (var i = 0; i < model.cells.length; i++) {
      var c = model.cells.get(i);
      if (c.type !== "code") continue;
      var outs = c.sharedModel.toJSON().outputs || [];
      if (outs.some(function (o) { return o.output_type === "error"; })) out.push(i + 1);
    }
    return out;
  }

  function nothingOpen(a) {
    var w = a.shell.currentWidget;
    return { kind: w ? "other" : "none", title: w && w.title ? w.title.label : "" };
  }

  function snapshot(a, limit) {
    var p = notebookPanel(a);
    if (!p) return nothingOpen(a);
    var nb = p.content;
    var model = p.context.model;
    var cells = [];
    for (var i = 0; i < model.cells.length; i++) cells.push(cellInfo(model, i, limit || OUT_TEXT));
    var sc = p.sessionContext;
    var active = nb.activeCellIndex >= 0 && nb.activeCellIndex < model.cells.length ? model.cells.get(nb.activeCellIndex).id : null;
    return {
      kind: "notebook",
      path: p.context.path,
      name: p.title.label,
      dirty: !!model.dirty,
      language: language(model),
      kernel: sc ? sc.kernelDisplayName : "",
      kernel_status: sc ? sc.kernelDisplayStatus : "",
      has_kernel: !!(sc && sc.session && sc.session.kernel),
      active_cell_id: active,
      selection: cut(selectionOf(nb), 4000),
      cells: cells,
    };
  }

  // the cell in view and active, as after the user clicked it
  function reveal(p, i) {
    var nb = p.content;
    nb.activeCellIndex = i;
    try {
      if (nb.scrollToItem) void nb.scrollToItem(i, "smart");
    } catch (e) {
      /* scrolling is a courtesy */
    }
  }

  function rendered(p, i, value) {
    var w = p.content.widgets[i];
    if (!w || !w.ready) return value;
    return w.ready.then(function () {
      w.rendered = true;
      return value;
    });
  }

  function runCell(a, p, id) {
    var nb = p.content;
    var m = p.context.model;
    var i = needCell(m, id);
    var c = m.cells.get(i);
    if (c.type !== "code") return Promise.resolve({ cell_id: c.id, n: i + 1, status: "no-op", message: "not a code cell" });
    if (!c.sharedModel.getSource().trim()) return Promise.resolve({ cell_id: c.id, n: i + 1, status: "no-op", message: "the cell is empty" });
    var sc = p.sessionContext;
    return Promise.resolve(sc.ready).then(function () {
      if (!sc.session || !sc.session.kernel) {
        return { cell_id: c.id, n: i + 1, status: "error", outputs: [], error: { ename: "MissingKernel", evalue: "No kernel is attached to the notebook" } };
      }
      reveal(p, i);
      var w = nb.widgets[i];
      // CodeCell.execute, reached through the cell widget's class (the page has no module system of its own)
      var CodeCell = w && w.constructor;
      var run =
        CodeCell && typeof CodeCell.execute === "function"
          ? CodeCell.execute(w, sc, { recordTiming: true, deletedCells: m.deletedCells })
          : a.commands.execute("notebook:run-cell");
      return Promise.resolve(run)
        .then(
          function (reply) {
            return reply && reply.content ? reply.content.status : null;
          },
          function () {
            return null; // the outputs say what happened
          },
        )
        .then(function (status) {
          var outs = outputs(c, OUT_TEXT);
          var err = outs.filter(function (o) {
            return o.kind === "error";
          })[0];
          return {
            cell_id: c.id,
            n: i + 1,
            status: err ? "error" : status || "ok",
            execution_count: c.executionCount,
            outputs: outs,
            error: err ? { ename: err.ename, evalue: err.evalue, traceback: err.traceback } : undefined,
          };
        });
    });
  }

  // a free name in the folder: name.ipynb, name-2.ipynb, …
  function freePath(a, dir, base) {
    var prefix = dir ? dir + "/" : "";
    function attempt(k) {
      var path = prefix + base + (k > 1 ? "-" + k : "") + ".ipynb";
      return a.serviceManager.contents.get(path, { content: false }).then(
        function () {
          if (k >= 50) throw new Error("No free file name for " + base + ".ipynb");
          return attempt(k + 1);
        },
        function () {
          return path;
        },
      );
    }
    return attempt(1);
  }

  var OPS = {
    hello: function () {
      return { ok: true };
    },
    snapshot: function (a, args) {
      return snapshot(a, args.limit);
    },
    read_cell: function (a, args) {
      var m = panelFor(a, args.path).context.model;
      return cellInfo(m, needCell(m, args.cell_id), 20000);
    },
    add_cell: function (a, args) {
      var p = panelFor(a, args.path);
      var nb = p.content;
      var m = p.context.model;
      var type = args.cell_type === "markdown" ? "markdown" : "code";
      // a new notebook's one empty cell is used instead of leaving it above the new one
      var onlyEmpty = m.cells.length === 1 && m.cells.get(0).sharedModel.getSource().trim() === "";
      var index;
      if (onlyEmpty) {
        m.sharedModel.deleteCell(0);
        index = 0;
      } else if (m.cells.length === 0) {
        index = 0;
      } else {
        var ref = args.reference_cell_id ? needCell(m, args.reference_cell_id) : nb.activeCellIndex;
        if (ref < 0 || ref >= m.cells.length) ref = m.cells.length - 1;
        index = args.position === "above" ? ref : ref + 1;
      }
      m.sharedModel.insertCell(index, { cell_type: type, source: args.content || "", metadata: type === "code" ? { trusted: true } : {} });
      reveal(p, index);
      var done = { cell_id: m.cells.get(index).id, n: index + 1, replaced_empty: onlyEmpty };
      return type === "markdown" ? rendered(p, index, done) : done;
    },
    edit_cell: function (a, args) {
      var p = panelFor(a, args.path);
      var m = p.context.model;
      var i = needCell(m, args.cell_id);
      var c = m.cells.get(i);
      var before = c.sharedModel.getSource();
      // the source the change was made against: a cell the user edited since is not overwritten unasked
      if (typeof args.expect === "string" && args.expect !== before) {
        return { changed: true, cell_id: c.id, n: i + 1, current: before };
      }
      c.sharedModel.setSource(String(args.content));
      reveal(p, i);
      var done = { cell_id: c.id, n: i + 1, previous: before };
      return c.type === "markdown" ? rendered(p, i, done) : done;
    },
    delete_cell: function (a, args) {
      var p = panelFor(a, args.path);
      var m = p.context.model;
      var i = needCell(m, args.cell_id);
      var gone = m.cells.get(i).sharedModel.toJSON();
      m.sharedModel.deleteCell(i);
      // the cell as it was, for Undo
      return { n: i + 1, index: i, cell: gone };
    },
    restore_cell: function (a, args) {
      var p = panelFor(a, args.path);
      var m = p.context.model;
      var i = Math.max(0, Math.min(Number(args.index) || 0, m.cells.length));
      m.sharedModel.insertCell(i, args.cell);
      reveal(p, i);
      return { cell_id: m.cells.get(i).id, n: i + 1 };
    },
    run_cell: function (a, args) {
      return runCell(a, panelFor(a, args.path), args.cell_id);
    },
    run_all: function (a, args) {
      var p = panelFor(a, args.path);
      var m = p.context.model;
      var start = args.from_cell_id ? needCell(m, args.from_cell_id) : 0;
      var ids = [];
      for (var i = start; i < m.cells.length; i++) {
        var c = m.cells.get(i);
        if (c.type === "code" && c.sharedModel.getSource().trim()) ids.push(c.id);
      }
      var ran = [];
      // the end of a run the user approved: the notebook saved with its outputs (what autosave would do later)
      function saved(result) {
        return Promise.resolve(p.context.save()).then(
          function () {
            return result;
          },
          function () {
            return result;
          },
        );
      }
      function next(k) {
        if (k >= ids.length) return saved({ status: "ok", ran: ran.length, of: ids.length, cells: ran });
        // a cell deleted meanwhile is passed over
        if (findIndex(m, ids[k]) < 0) return next(k + 1);
        return runCell(a, p, ids[k]).then(function (r) {
          ran.push({ n: r.n, status: r.status });
          if (r.status === "error" || r.status === "abort") {
            return saved({ status: r.status, ran: ran.length, of: ids.length, cells: ran, failed: { cell_id: r.cell_id, n: r.n, error: r.error, outputs: r.outputs } });
          }
          return next(k + 1);
        });
      }
      return next(0);
    },
    create_notebook: function (a, args) {
      var cells = (args.cells || []).filter(function (c) {
        return c && typeof c.content === "string";
      });
      if (!cells.length) throw new Error("A new notebook needs its cells");
      var front = notebookPanel(a);
      var dir = args.directory != null && String(args.directory).trim() ? clean(args.directory) : front ? dirname(front.context.path) : "";
      var base = String(args.name || "notebook").replace(/^.*[\\/]/, "").replace(/\.ipynb$/i, "").trim() || "notebook";
      var specs = a.serviceManager.kernelspecs && a.serviceManager.kernelspecs.specs;
      var kernel = front && front.sessionContext && front.sessionContext.session && front.sessionContext.session.kernel;
      var kname = (kernel && kernel.name) || (specs && specs.default) || "python3";
      var spec = specs && specs.kernelspecs ? specs.kernelspecs[kname] : null;
      var lang = (spec && spec.language) || "python";
      var content = {
        cells: cells.map(function (c) {
          var md = c.cell_type === "markdown";
          var cell = { id: uid(), cell_type: md ? "markdown" : "code", metadata: {}, source: c.content };
          if (!md) {
            cell.outputs = [];
            cell.execution_count = null;
          }
          return cell;
        }),
        metadata: { kernelspec: { name: kname, display_name: (spec && spec.display_name) || kname, language: lang }, language_info: { name: lang } },
        nbformat: 4,
        nbformat_minor: 5,
      };
      return freePath(a, dir, base).then(function (path) {
        return a.serviceManager.contents
          .save(path, { type: "notebook", format: "json", content: content })
          .then(function () {
            return a.commands.execute("docmanager:open", { path: path });
          })
          .then(function (w) {
            if (isNotebook(w)) {
              lastPanel = w;
              a.shell.activateById(w.id);
            }
            return Promise.resolve(w && w.context ? w.context.ready : null)
              .then(function () {
                return w && w.sessionContext ? w.sessionContext.ready : null;
              })
              .then(function () {
                // the page hears that the new notebook is in front (its header, its suggestions)
                attach(a);
                notify();
                return { path: path, name: path.split("/").pop(), cells: content.cells.length };
              });
          });
      });
    },
    list_files: function (a, args) {
      var dir = clean(args.path);
      return a.serviceManager.contents.get(dir, { content: true }).then(function (m) {
        if (m.type !== "directory") return { path: m.path, type: m.type, size: m.size };
        var entries = (m.content || []).map(function (e) {
          return { name: e.name, type: e.type, size: e.size, last_modified: e.last_modified };
        });
        return { path: m.path || "/", entries: entries.slice(0, 300), more: Math.max(0, entries.length - 300) };
      });
    },
    read_file: function (a, args) {
      var path = clean(args.path);
      return a.serviceManager.contents.get(path, { type: "file", format: "text", content: true }).then(
        function (m) {
          var all = String(m.content || "");
          var lines = all.split("\n");
          // a short file whole; a long one 200 lines (or `lines`, at most 400) from `start`, and where the rest begins
          var whole = !args.start && !args.lines && lines.length <= 400 && all.length <= 20000;
          var from = whole ? 1 : Math.max(1, Math.min(Number(args.start) || 1, lines.length));
          var count = whole ? lines.length : Math.max(1, Math.min(Number(args.lines) || 200, 400));
          var to = Math.min(lines.length, from + count - 1);
          var out = { path: m.path, size: m.size, lines: lines.length, showing: "lines " + from + "-" + to + " of " + lines.length, text: cut(lines.slice(from - 1, to).join("\n"), 20000) };
          if (to < lines.length) out.rest = "read_file with start=" + (to + 1) + " for the next lines";
          return out;
        },
        function (e) {
          throw new Error(path + " cannot be read as text (" + (e && e.message ? e.message : e) + "): inspect it with a code cell");
        },
      );
    },
    select_cell: function (a, args) {
      var p = panelFor(a, args.path);
      var i = needCell(p.context.model, args.cell_id);
      a.shell.activateById(p.id);
      reveal(p, i);
      return { n: i + 1 };
    },
  };

  function answer(ev, id, ok, value) {
    var out = { bluesandai: "assist-reply", id: id, ok: ok };
    if (ok) out.result = value;
    else out.error = value;
    try {
      ev.source.postMessage(out, ev.origin);
    } catch (e) {
      /* the page went away */
    }
  }

  window.addEventListener("message", function (ev) {
    if (ev.source !== window.parent || !allowed(ev.origin)) return;
    var msg = ev.data;
    if (!msg || msg.bluesandai !== "assist" || typeof msg.op !== "string" || !Object.prototype.hasOwnProperty.call(OPS, msg.op)) return;
    var first = parentOrigin === null;
    parentOrigin = ev.origin;
    app()
      .then(function (a) {
        if (first) hook(a);
        return OPS[msg.op](a, msg.args || {});
      })
      .then(
        function (result) {
          answer(ev, msg.id, true, result);
        },
        function (e) {
          answer(ev, msg.id, false, e && e.message ? e.message : String(e));
        },
      );
  });

  // what is open and where the cursor is, pushed to the page when it changes (its header and suggestions)
  var timer = null;
  var hooked = null;
  function notify() {
    if (!parentOrigin) return;
    clearTimeout(timer);
    timer = setTimeout(function () {
      app().then(function (a) {
        var p = notebookPanel(a);
        var info = nothingOpen(a);
        if (p) {
          var m = p.context.model;
          info = {
            kind: "notebook",
            name: p.title.label,
            path: p.context.path,
            cells: m.cells.length,
            active: p.content.activeCellIndex + 1,
            errors: errorCells(m),
            kernel_status: p.sessionContext ? p.sessionContext.kernelDisplayStatus : "",
            selection: !!selectionOf(p.content),
          };
        }
        try {
          window.parent.postMessage({ bluesandai: "assist-context", context: info }, parentOrigin);
        } catch (e) {
          /* the page went away */
        }
      });
    }, 300);
  }

  function attach(a) {
    var p = notebookPanel(a);
    if (p === hooked) return;
    if (hooked) {
      try {
        hooked.content.activeCellChanged.disconnect(notify);
        hooked.context.model.contentChanged.disconnect(notify);
        if (hooked.sessionContext) hooked.sessionContext.statusChanged.disconnect(notify);
      } catch (e) {
        /* a closed notebook's signals are gone with it */
      }
    }
    hooked = p;
    if (!p) return;
    p.content.activeCellChanged.connect(notify);
    p.context.model.contentChanged.connect(notify);
    if (p.sessionContext) p.sessionContext.statusChanged.connect(notify);
  }

  function hook(a) {
    a.shell.currentChanged.connect(function () {
      attach(a);
      notify();
    });
    attach(a);
    document.addEventListener("selectionchange", notify);
    notify();
  }
})();
