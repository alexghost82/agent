import type { EdgeType, FileRole, LayerId, NodeType } from "../types";

// Map a file's role to the canvas node type it should render as.
export function nodeTypeForRole(role: FileRole): NodeType {
  switch (role) {
    case "config":
      return "config";
    case "route":
      return "apiRoute";
    case "component":
      return "component";
    case "service":
      return "service";
    case "worker":
      return "worker";
    case "test":
      return "test";
    case "doc":
      return "documentation";
    case "schema":
    case "migration":
      return "dbModel";
    default:
      return "file";
  }
}

// Which display layers a node of a given type participates in.
export function layersForNodeType(type: NodeType): LayerId[] {
  switch (type) {
    case "project":
      return ["overview", "architecture", "code", "feature", "dataFlow", "uiFlow", "risk"];
    case "feature":
      return ["overview", "architecture", "feature"];
    case "module":
      return ["architecture", "code", "feature"];
    case "externalPackage":
      return ["overview", "architecture"];
    case "apiRoute":
      return ["architecture", "code", "feature", "dataFlow", "uiFlow"];
    case "service":
      return ["architecture", "code", "feature", "dataFlow"];
    case "dbModel":
      return ["architecture", "code", "dataFlow"];
    case "component":
      return ["architecture", "code", "uiFlow"];
    case "worker":
      return ["architecture", "code", "dataFlow"];
    case "config":
      return ["architecture", "code"];
    case "firebaseFunction":
      return ["overview", "architecture", "dataFlow"];
    case "firestoreCollection":
      return ["overview", "architecture", "dataFlow"];
    case "test":
      return ["code"];
    case "documentation":
      return ["code"];
    case "file":
    default:
      return ["code"];
  }
}

// Classify a resolved file→file import edge into a typed edge + the layers it
// belongs to, based on the roles of its endpoints.
export function classifyEdge(fromRole: FileRole, toRole: FileRole): { type: EdgeType; layers: LayerId[] } {
  // Tests reference their subject.
  if (fromRole === "test") return { type: "tested_by", layers: ["code"] };

  // Backend data flow: route → service → schema/model.
  if (fromRole === "route" && toRole === "service") return { type: "calls", layers: ["code", "architecture", "dataFlow"] };
  if ((fromRole === "service" || fromRole === "route" || fromRole === "worker") && (toRole === "schema" || toRole === "migration")) {
    return { type: "reads_from_db", layers: ["code", "architecture", "dataFlow"] };
  }
  if (fromRole === "service" && toRole === "service") return { type: "calls", layers: ["code", "architecture", "dataFlow"] };

  // UI flow: component → hook/store → (service/route).
  if (fromRole === "component" && (toRole === "hook" || toRole === "store")) {
    return { type: "uses", layers: ["code", "uiFlow"] };
  }
  if ((fromRole === "component" || fromRole === "hook" || fromRole === "store") && (toRole === "service" || toRole === "route")) {
    return { type: "calls", layers: ["code", "uiFlow"] };
  }
  if (fromRole === "component" && toRole === "component") {
    return { type: "renders", layers: ["code", "uiFlow"] };
  }

  // Anything importing a config is "configured_by".
  if (toRole === "config") return { type: "configured_by", layers: ["code", "architecture"] };

  return { type: "imports", layers: ["code"] };
}

// X positions per visual tier (left → right), giving an n8n-style columnar feel.
export const TIER_X: Record<NodeType, number> = {
  project: 0,
  feature: 360,
  module: 720,
  apiRoute: 1080,
  service: 1080,
  component: 1080,
  worker: 1080,
  config: 1080,
  firebaseFunction: 1080,
  dbModel: 1440,
  firestoreCollection: 1440,
  file: 1080,
  test: 1440,
  documentation: 1440,
  externalPackage: 1800
};

export const ROW_GAP = 90;
