#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
import { main } from '../lib/aidr.mjs';

process.exitCode = await main(process.argv.slice(2));
