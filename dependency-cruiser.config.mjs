/** @type {import('dependency-cruiser').IConfiguration} */
export default {
  forbidden: [
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
    exclude: { path: "(^|/)(coverage|dist|node_modules)/" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
