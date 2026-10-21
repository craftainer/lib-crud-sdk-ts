#!/usr/bin/env node
// `crud-sdk-codegen` bin: writes TypeScript types from a CRUD manifest.
// Needs the optional peer `json-schema-to-typescript`.
import { run } from "./run.ts";

process.exitCode = await run(process.argv.slice(2), { env: process.env });
