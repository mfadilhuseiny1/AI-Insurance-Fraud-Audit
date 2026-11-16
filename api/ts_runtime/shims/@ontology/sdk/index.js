/* @ontology/sdk: every object type is a descriptor {type: "object", apiName}, resolved by API name at run time; an
 * API-named query (lowerCamelCase, or any name under $Queries) is a query descriptor: client(query).executeFunction(…). */
"use strict";
const rt = require("../../@osdk/functions/runtime.js");

const names = (make) => new Proxy({}, { get: (_, name) => (name === "__esModule" ? false : typeof name === "string" ? make(name) : undefined) });
const objectType = (apiName) => ({ type: "object", apiName });

module.exports = new Proxy({}, {
  get: (_, name) => {
    if (name === "__esModule") return false;
    if (typeof name !== "string") return undefined;
    if (name === "$Queries") return names(rt.query);
    if (name === "$Objects" || name === "$ObjectTypes") return names(objectType);
    // object types are PascalCase API names, queries lowerCamelCase
    return /^[a-z]/.test(name) ? rt.query(name) : objectType(name);
  },
});
