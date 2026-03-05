#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { Command } from "effect/unstable/cli";

import { t3Cli } from "./cli";
import { version } from "../package.json" with { type: "json" };

Command.run(t3Cli, { version }).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
