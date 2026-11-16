/* @foundry/ontology-api for TypeScript v1 functions: Objects (search / create / delete), Filters, and every object type
 * by its API name ({type: "object", apiName}, for @Edits(Employee)). See ../v1.js. */
"use strict";
const v1 = require("../v1.js");

module.exports = new Proxy({}, {
  get: (_, name) => {
    if (name === "__esModule") return false;
    if (typeof name !== "string") return undefined;
    if (name === "Objects") return v1.Objects;
    if (name === "Filters") return v1.Filters;
    if (name === "ObjectSet") return v1.V1ObjectSet;
    return { type: "object", apiName: name };
  },
});
