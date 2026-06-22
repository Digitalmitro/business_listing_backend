"use strict";

const { AsyncLocalStorage } = require("node:async_hooks");

const requestStorage = new AsyncLocalStorage();

function runWithRequestContext(context, callback) {
  return requestStorage.run(Object.freeze({ ...context }), callback);
}

function getRequestContext() {
  return requestStorage.getStore() || {};
}

module.exports = { getRequestContext, runWithRequestContext };
