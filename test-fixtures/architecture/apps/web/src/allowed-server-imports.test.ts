import { readFileSync } from "node:fs";

import Fastify from "fastify";
import pg from "pg";

import "./test/allowed-server-imports";

void readFileSync;
void Fastify;
void pg;
