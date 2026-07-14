// backend/tests/setup.js
"use strict";

const { after } = require("node:test");
const { closeQueueConnections } = require("../utils/queue");

after(async () => {
  try {
    await closeQueueConnections();
  } catch (e) {}
});
