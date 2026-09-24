import { createDatabase } from "@neurochess/database";

import { createAuth } from "./src/auth/service.js";
import { parseApiEnvironment } from "./src/env.js";
import { loadRootEnvironment } from "./src/load-root-environment.js";

loadRootEnvironment();
const environment = parseApiEnvironment(process.env);
export const auth = createAuth(createDatabase(environment.DATABASE_URL), environment);
