/* @osdk/functions for TypeScript v2 functions in BluesandAI (types are compile-time only; see runtime.js). */
"use strict";
const rt = require("./runtime.js");

class UserFacingError extends Error {
  constructor(message) {
    super(message);
    this.name = "UserFacingError";
  }
}

/** An edit batch: create / update / delete objects and link / unlink many-to-many links; getEdits() is returned. */
function createEditBatch() {
  return new rt.EditBatch();
}

module.exports = { createEditBatch, UserFacingError, Edits: {} };
