#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { configFromEnv, createTenderMcp, VERSION } from "./server.js";

const { server, account } = createTenderMcp(configFromEnv());
await server.connect(new StdioServerTransport());
// stdout carries the protocol, so status goes to stderr
console.error(`tender-mcp ${VERSION} ready${account ? ` (agent wallet ${account.address})` : " (read-only: no TENDER_PRIVATE_KEY set)"}`);
