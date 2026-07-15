#!/usr/bin/env node

import { run } from "../src/launcher.js";

process.exitCode = run(process.argv.slice(2));
