import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build, type InlineConfig } from "vite";

export async function buildWeb(config: InlineConfig = {}) {
  const environment = process.env.NODE_ENV;
  // Vite also reads the API's shared .env; set this before it resolves build configuration.
  process.env.NODE_ENV = "production";
  try {
    return await build(config);
  } finally {
    if (environment === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = environment;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildWeb();
}
