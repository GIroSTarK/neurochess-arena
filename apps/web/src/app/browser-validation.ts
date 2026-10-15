import { z } from "zod";

// Run before schemas are constructed: Zod's JIT capability probe itself violates CSP.
z.config({ jitless: true });
