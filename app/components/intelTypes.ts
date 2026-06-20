// Shared front-end metadata for the project-intelligence map: node types, the
// display layers, and their default ordering. Labels are looked up from i18n at
// render time; these are the stable keys + canonical English fallbacks.

export type IntelNodeType =
  | "project"
  | "feature"
  | "module"
  | "file"
  | "component"
  | "apiRoute"
  | "dbModel"
  | "service"
  | "externalPackage"
  | "config"
  | "worker"
  | "test"
  | "documentation"
  | "firebaseFunction"
  | "firestoreCollection";

export type IntelLayerId =
  | "overview"
  | "architecture"
  | "code"
  | "feature"
  | "dataFlow"
  | "uiFlow"
  | "risk";

export const NODE_TYPES: IntelNodeType[] = [
  "project",
  "feature",
  "module",
  "apiRoute",
  "firebaseFunction",
  "service",
  "dbModel",
  "firestoreCollection",
  "component",
  "worker",
  "config",
  "test",
  "documentation",
  "file",
  "externalPackage"
];

export const NODE_TYPE_LABEL: Record<IntelNodeType, string> = {
  project: "Project",
  feature: "Feature",
  module: "Module",
  file: "File",
  component: "Component",
  apiRoute: "API route",
  dbModel: "DB model",
  service: "Service",
  externalPackage: "Package",
  config: "Config",
  worker: "Worker",
  test: "Test",
  documentation: "Docs",
  firebaseFunction: "Function",
  firestoreCollection: "Collection"
};

export const LAYERS: IntelLayerId[] = [
  "overview",
  "architecture",
  "feature",
  "dataFlow",
  "uiFlow",
  "code",
  "risk"
];

export const LAYER_LABEL: Record<IntelLayerId, string> = {
  overview: "Overview",
  architecture: "Architecture",
  code: "Code graph",
  feature: "Feature map",
  dataFlow: "Data flow",
  uiFlow: "UI flow",
  risk: "Risk view"
};
