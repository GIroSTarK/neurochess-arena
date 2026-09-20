/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
    {
      name: "api-production-no-test-adapters",
      comment:
        "Scripted providers are injected test fixtures, never production options or fallbacks.",
      severity: "error",
      from: { path: "(^|/)apps/api/src/", pathNot: "\\.test\\.ts$" },
      to: { path: "(^|/)apps/api/test/providers/" },
    },
    {
      name: "no-circular-dependencies",
      comment: "Workspace modules must form an acyclic dependency graph.",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "web-no-server-infrastructure",
      comment:
        "The web app can use shared contracts and chess helpers, but not API or database code.",
      severity: "error",
      from: { path: "(^|/)apps/web/" },
      to: { path: "(^|/)(apps/api|packages/database)/" },
    },
    {
      name: "arena-presentation-no-sandbox",
      comment:
        "Reusable arena, board, and UI components receive data and callbacks from mode adapters.",
      severity: "error",
      from: {
        path: "(^|/)apps/web/src/(arena|board|ui)/",
        pathNot: "\\.test\\.tsx?$",
      },
      to: { path: "(^|/)apps/web/src/(api|game|reference|setup|match)/" },
    },
    {
      name: "ai-match-no-sandbox",
      comment: "The public AI controller cannot depend on Sandbox implementation.",
      severity: "error",
      from: { path: "(^|/)apps/web/src/match/", pathNot: "\\.test\\.tsx?$" },
      to: { path: "(^|/)apps/web/src/(game/|api/client\\.ts$)" },
    },
    {
      name: "ai-setup-no-sandbox",
      comment: "AI setup uses its own API and credential boundary, never Sandbox controllers.",
      severity: "error",
      from: { path: "(^|/)apps/web/src/setup/", pathNot: "\\.test\\.tsx?$" },
      to: { path: "(^|/)apps/web/src/game/" },
    },
    {
      name: "reference-no-sandbox",
      comment:
        "Reference scenarios exercise presentation without Sandbox controllers or HTTP clients.",
      severity: "error",
      from: { path: "(^|/)apps/web/src/reference/", pathNot: "\\.test\\.tsx?$" },
      to: { path: "(^|/)apps/web/src/(api|game)/" },
    },
    {
      name: "api-no-web",
      comment: "The API must not depend on web implementation code.",
      severity: "error",
      from: { path: "(^|/)apps/api/" },
      to: { path: "(^|/)apps/web/" },
    },
    {
      name: "shared-packages-no-apps",
      comment: "Shared packages cannot depend on application entrypoints.",
      severity: "error",
      from: { path: "(^|/)packages/" },
      to: { path: "(^|/)apps/" },
    },
    {
      name: "contracts-remain-a-leaf",
      comment:
        "Transport contracts may use external schema libraries but no product implementation.",
      severity: "error",
      from: { path: "(^|/)packages/contracts/" },
      to: { path: "(^|/)(apps|packages/(?!contracts/))" },
    },
    {
      name: "chess-remains-a-leaf",
      comment:
        "The deterministic chess domain must remain independent from application infrastructure.",
      severity: "error",
      from: { path: "(^|/)packages/chess/" },
      to: { path: "(^|/)(apps|packages/(?!chess/))" },
    },
    {
      name: "chess-engine-is-encapsulated",
      comment: "Consumers must use the chess domain, never the underlying rules engine.",
      severity: "error",
      from: { pathNot: "(^|/)packages/chess/" },
      to: { path: "(^|/)node_modules/chess\\.js/" },
    },
    {
      name: "shared-leaves-no-infrastructure",
      comment: "The chess domain and transport schemas cannot import server infrastructure.",
      severity: "error",
      from: { path: "(^|/)packages/(chess|contracts)/" },
      to: {
        path: "(^|/)node_modules/(fastify|fastify-type-provider-zod|@fastify/[^/]+|pg|pg-[^/]+|postgres|drizzle-orm|drizzle-kit|better-auth|pino)(/|$)",
      },
    },
    {
      name: "shared-leaves-no-node-builtins",
      comment: "Browser-safe shared leaves cannot depend on Node.js infrastructure.",
      severity: "error",
      from: { path: "(^|/)packages/(chess|contracts)/" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "chess-production-no-test-helpers",
      comment: "Position fixtures cannot enter the production chess graph.",
      severity: "error",
      from: { path: "(^|/)packages/chess/src/", pathNot: "\\.test\\.ts$" },
      to: { path: "(^|/)packages/chess/(test/|src/.*\\.test\\.ts$)" },
    },
    {
      name: "database-remains-server-only",
      comment: "Database code cannot depend on applications or browser-facing packages.",
      severity: "error",
      from: { path: "(^|/)packages/database/" },
      to: { path: "(^|/)(apps|packages/(contracts|chess))/" },
    },
    {
      name: "contracts-public-entrypoint-only",
      comment: "Consumers must import the contracts package through its public entrypoint.",
      severity: "error",
      from: { path: "^(?!packages/contracts/)" },
      to: { path: "(^|/)packages/contracts/src/(?!index\\.ts$)" },
    },
    {
      name: "chess-public-entrypoint-only",
      comment: "Consumers must import the chess package through its public entrypoint.",
      severity: "error",
      from: { path: "^(?!packages/chess/)" },
      to: { path: "(^|/)packages/chess/src/(?!index\\.ts$)" },
    },
    {
      name: "database-public-entrypoint-only",
      comment: "Consumers must import the database package through its public entrypoint.",
      severity: "error",
      from: { path: "^(?!packages/database/)" },
      to: { path: "(^|/)packages/database/src/(?!index\\.ts$)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: {
      conditionNames: ["types", "import", "node", "default"],
      exportsFields: ["exports"],
    },
    // Keep external dependency edges visible, including entrypoints in dist.
    // doNotFollow prevents traversing their implementations.
    exclude: { path: "^(apps|packages)/[^/]+/(coverage|dist)/|^coverage/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
