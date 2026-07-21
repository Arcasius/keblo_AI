"use strict";

const {
  HIPPOCAMPUS_ACTIVATION_MODES
} = require("./HippocampusActivationGate");
const {
  createHippocampusActivationController
} = require("./HippocampusActivationController");
const {
  createHippocampusRuntime
} = require("./HippocampusRuntimeComposition");

module.exports = Object.freeze({
  createHippocampusRuntime,
  createHippocampusActivationController,
  ACTIVATION_MODES: HIPPOCAMPUS_ACTIVATION_MODES
});
